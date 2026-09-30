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
	sources: [
		{
			id: "archive",
			title: "Historical notes",
			path: "archive.md",
			content: Array.from({ length: 40 }, (_, index) => `## Old ${index}\n\nBear`).join("\n\n"),
		},
		{
			id: "current",
			title: "Current account",
			path: "current.md",
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

	it("searches reference text and isolates character ownership", () => {
		const rows = canon.retrieve("jizhou", "river", { limit: 1, includeAdjacent: false });
		expect(rows).toEqual([
			expect.objectContaining({ sourceName: "Current account", heading: "Identity" }),
		]);
		expect(canon.retrieve("other", "river")).toEqual([]);
	});
	it("returns document excerpts through the native Host tool", async () => {
		const loaded = new CharacterLoader(resolve(import.meta.dirname, "./fixtures/characters")).load(
			"jizhou",
		);
		if (!loaded) throw new Error("Shipped package required");
		const tools = registerHostTools({
			character: () => loaded,
			canon: async (query, limit) =>
				canon.retrieve("jizhou", query, { limit, includeAdjacent: false }),
		} as Parameters<typeof registerHostTools>[0]);
		expect(
			(await tools.host_canon?.execute("query", { query: "river", limit: 1 }))?.details,
		).toMatchObject({
			ok: true,
			data: [expect.objectContaining({ sourceName: "Current account" })],
		});
		expect(
			(await tools.host_canon?.execute("obsolete", { query: "river", moduleId: "current" }))
				?.details,
		).toMatchObject({ ok: false });
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
