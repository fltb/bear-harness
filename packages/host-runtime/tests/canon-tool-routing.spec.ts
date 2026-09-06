// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import type { LoadedCanonPackage } from "../src/canon/package-schema.js";
import { CanonHubService } from "../src/canon/service.js";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { registerHostTools } from "../src/companion/host-tool-register.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../src/storage/database.js";
import { InvalidationHub } from "../src/storage/invalidation-hub.js";

const fixture: LoadedCanonPackage = {
	manifest: {
		language: "en-US",
		sources: [
			{ id: "archive", title: "Historical notes", path: "archive.md", kind: "reference" },
			{ id: "current", title: "Current account", path: "current.md", kind: "reference" },
		],
		entities: [{ id: "bear", kind: "character", name: "Bear", aliases: ["巨熊"], description: "" }],
		modules: [
			{
				id: "current",
				kind: "root",
				title: "Current",
				summary: "",
				triggers: [],
				bindings: [{ source: "current", headings: ["Identity"] }],
			},
			{ id: "empty", kind: "root", title: "Empty", summary: "", triggers: [], bindings: [] },
		],
	},
	sources: [
		{
			id: "archive",
			title: "Historical notes",
			path: "archive.md",
			kind: "reference",
			content: Array.from({ length: 40 }, (_, index) => `## Old ${index}\n\nBear`).join("\n\n"),
		},
		{
			id: "current",
			title: "Current account",
			path: "current.md",
			kind: "reference",
			content: `## Identity\n\nBear lives near a river. ${"The river flows north. ".repeat(100)}\n\n## Unrelated\n\nBear alternate costume.`,
		},
	],
};

describe("scoped Canon tool search", () => {
	let root: string;
	let database: CompanionDatabase;
	let canon: CanonHubService;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-canon-tool-"));
		database = new CompanionDatabase(join(root, "runtime.db"), "jizhou");
		database.initialize(COMPANION_SCHEMA_SQL);
		database.ensureRuntimeIdentity();
		canon = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "cas")),
			new InvalidationHub(),
		);
		canon.syncPackage("jizhou", fixture);
	});
	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("scopes before ranking limits so a rare current account is not crowded out by historical hits", () => {
		const rows = canon.retrieve("jizhou", "巨熊", {
			moduleId: "current",
			limit: 1,
			includeAdjacent: false,
		});
		expect(rows).toEqual([
			expect.objectContaining({ sourceName: "Current account", heading: "Identity" }),
		]);
		expect(canon.retrieve("jizhou", "Bear", { moduleId: "missing" })).toEqual([]);
		expect(canon.retrieve("jizhou", "Bear", { moduleId: "empty" })).toEqual([]);
		expect(canon.retrieve("other", "Bear", { moduleId: "current" })).toEqual([]);
	});

	it("routes a package module through the actual Host tool and rejects misspellings", async () => {
		const loaded = new CharacterLoader(
			resolve(import.meta.dirname, "../../../config/characters"),
		).load("jizhou");
		if (!loaded) throw new Error("Shipped package required");
		const tools = registerHostTools({
			character: () => ({ ...loaded, canon: fixture }),
			canon: async (query, limit, moduleId) =>
				canon.retrieve("jizhou", query, { limit, moduleId, includeAdjacent: false }),
		} as Parameters<typeof registerHostTools>[0]);
		expect(
			(await tools.host_canon?.execute("query", { query: "巨熊", moduleId: "current", limit: 1 }))
				?.details,
		).toMatchObject({
			ok: true,
			data: [expect.objectContaining({ sourceName: "Current account" })],
		});
		expect(
			(await tools.host_canon?.execute("invalid", { query: "Bear", moduleId: "curent" }))?.details,
		).toMatchObject({ ok: false, code: "canon_module_not_found" });
	});

	it("distinguishes an empty search from a failed search in native tool details", async () => {
		const available = registerHostTools({
			canon: async () => [],
		} as never);
		const unavailable = registerHostTools({
			canon: async () => {
				throw { reason: "canon_unavailable", message: "Canon index could not be opened." };
			},
		} as never);
		const empty = await available.host_canon?.execute("empty", { query: "absent" });
		const failed = await unavailable.host_canon?.execute("failed", { query: "absent" });
		expect(empty?.details).toMatchObject({ ok: true, data: [] });
		expect(failed).toMatchObject({
			content: [{ type: "text", text: "Canon index could not be opened." }],
			details: {
				ok: false,
				code: "canon_unavailable",
				message: "Canon index could not be opened.",
			},
		});
	});
});
