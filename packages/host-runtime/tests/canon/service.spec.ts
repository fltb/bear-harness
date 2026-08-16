// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { CanonHubService } from "../../src/canon/service.js";
import { Database, MIGRATIONS } from "../../src/storage/database.js";
import { EventBus } from "../../src/storage/event-bus.js";
import { companionIdentity, companionPackages } from "../../src/storage/schema.js";

describe("CanonHubService user workflow", () => {
	let root: string;
	let database: Database;
	let service: CanonHubService;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-canon-"));
		database = new Database(join(root, "database"));
		database.migrate(MIGRATIONS);
		database.orm
			.insert(companionPackages)
			.values([
				{ id: "package-a", name: "Character A", version: "1", hash: "hash-a" },
				{ id: "package-b", name: "Character B", version: "1", hash: "hash-b" },
			])
			.run();
		database.orm
			.insert(companionIdentity)
			.values([
				{ id: "character-a", packageId: "package-a", name: "Character A", selfCanon: "A" },
				{ id: "character-b", packageId: "package-b", name: "Character B", selfCanon: "B" },
			])
			.run();
		service = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "cas")),
			new EventBus(database.orm),
		);
	});

	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("imports, chunks, searches, isolates, and removes canon sources", () => {
		const source = service.addSource(
			"character-a",
			"original-story.txt",
			`The observatory opens at midnight.\n\n${"A long remembered scene. ".repeat(100)}`,
		);
		expect(source.logicalName).toBe("original-story.txt");
		expect(source.chunkCount).toBeGreaterThan(1);
		expect(service.listSources("character-a")).toEqual([source]);
		expect(service.listSources("character-b")).toEqual([]);
		expect(service.search("character-a", "observatory midnight")).toHaveLength(1);
		expect(service.search("character-b", "observatory midnight")).toEqual([]);

		service.removeSource("character-a", source.id);
		expect(service.listSources("character-a")).toEqual([]);
		expect(service.search("character-a", "observatory midnight")).toEqual([]);
	});

	it("manages a sourced hierarchy and rejects invalid references and cycles", () => {
		const source = service.addSource("character-a", "canon.txt", "The harbor bell marks dawn.");
		const chunk = service.search("character-a", "harbor bell")[0];
		if (!chunk) throw new Error("expected imported canon chunk");
		const rootModule = service.upsertModule({
			companionId: "character-a",
			kind: "root",
			title: "Original story",
			instructions: "Recall the original story before applying overlays.",
			sourceChunkIds: [chunk.id],
		});
		const child = service.upsertModule({
			companionId: "character-a",
			parentId: rootModule.id,
			kind: "event",
			title: "Harbor dawn",
			instructions: "Use the cited event.",
			sourceChunkIds: [chunk.id],
		});
		const modules = service.listModules("character-a");
		expect(modules.map((module) => module.id)).toEqual(
			expect.arrayContaining([rootModule.id, child.id]),
		);
		expect(modules).toContainEqual(
			expect.objectContaining({ id: child.id, parentId: rootModule.id }),
		);
		expect(() =>
			service.upsertModule({
				companionId: "character-a",
				id: rootModule.id,
				parentId: child.id,
				kind: "root",
				title: "Original story",
				instructions: "cycle",
				sourceChunkIds: [],
			}),
		).toThrow();
		expect(() =>
			service.upsertModule({
				companionId: "character-b",
				kind: "event",
				title: "Foreign citation",
				instructions: "invalid",
				sourceChunkIds: [chunk.id],
			}),
		).toThrow();

		service.deleteModule("character-a", rootModule.id);
		expect(service.listModules("character-a")).toEqual([
			expect.objectContaining({ id: child.id, sourceChunkIds: [chunk.id] }),
		]);
		service.removeSource("character-a", source.id);
	});

	it("syncs package canon idempotently and retrieves Chinese aliases, routed modules, and adjacent context", () => {
		const canon = {
			manifest: {
				version: 1 as const,
				language: "zh-CN",
				sources: [
					{
						id: "volume_one",
						title: "第一卷",
						path: "volume-one.txt",
						kind: "original_text" as const,
					},
				],
				entities: [
					{
						id: "aurora_station",
						kind: "location",
						name: "旧极光站",
						aliases: ["旧站"],
						description: "",
					},
				],
				modules: [
					{
						id: "root",
						kind: "root" as const,
						title: "原作",
						summary: "",
						triggers: [],
						bindings: [],
					},
					{
						id: "storm",
						parent: "root",
						kind: "event" as const,
						title: "风暴夜",
						summary: "",
						triggers: ["风暴"],
						bindings: [{ source: "volume_one", headings: ["风暴夜"] }],
					},
				],
			},
			sources: [
				{
					id: "volume_one",
					title: "第一卷",
					path: "volume-one.txt",
					kind: "original_text" as const,
					content: `# 风暴夜\n\n旧极光站的主灯在风暴里熄灭。\n\n${"守机人逐项核对备用电源。".repeat(180)}`,
				},
			],
		};
		service.syncPackage("character-a", canon);
		service.syncPackage("character-a", canon);
		expect(service.listSources("character-a")).toHaveLength(1);
		expect(service.listModules("character-a")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stableKey: "root", origin: "package" }),
				expect.objectContaining({ stableKey: "storm", sourceChunkIds: expect.any(Array) }),
			]),
		);
		const citations = service.retrieve("character-a", "旧站风暴发生了什么", {
			moduleId: "storm",
			limit: 3,
		});
		expect(citations[0]).toEqual(
			expect.objectContaining({ sourceName: "第一卷", heading: "风暴夜", origin: "package" }),
		);
		expect(citations.some((citation) => citation.adjacent)).toBe(true);
		expect(() =>
			service.removeSource("character-a", service.listSources("character-a")[0]?.id ?? ""),
		).toThrow();
	});
});
