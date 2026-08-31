// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { CanonHubService } from "../../src/canon/service.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../../src/storage/database.js";
import { EventBus } from "../../src/storage/event-bus.js";

function vectorMetadata(database: CompanionDatabase, key: "dimensions" | "fingerprint"): string {
	const row = database.connection
		.prepare("SELECT value FROM canon_vector_meta WHERE key = ?")
		.get(key) as { value: string } | undefined;
	if (!row) throw new Error(`missing Canon vector metadata: ${key}`);
	return row.value;
}

function storedEmbedding(database: CompanionDatabase): number[] {
	const row = database.connection.prepare("SELECT embedding FROM canon_chunks LIMIT 1").get() as
		| { embedding: Buffer | null }
		| undefined;
	if (!row?.embedding) return [];
	const bytes = Uint8Array.from(row.embedding);
	return Array.from(new Float32Array(bytes.buffer));
}

describe("CanonHubService user workflow", () => {
	let root: string;
	let database: CompanionDatabase;
	let service: CanonHubService;
	let eventBus: EventBus;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-canon-"));
		database = new CompanionDatabase(join(root, "runtime.db"), "character-a");
		database.initialize(COMPANION_SCHEMA_SQL);
		database.ensureRuntimeIdentity();
		eventBus = new EventBus(database.orm);
		service = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "cas")),
			eventBus,
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

	it("persists embeddings and retrieves semantic matches when lexical search misses", async () => {
		const vectorService = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "vector-cas")),
			eventBus,
			() => ({
				isReady: () => true,
				getDimensions: () => 2,
				getProviderInfo: () => ({ provider: "remote-a", model: "embedding-a" }),
				embed: async (text: string) =>
					new Float32Array(
						/lunar|moon/i.test(text) ? [1, 0] : /harbor|sea/i.test(text) ? [0, 1] : [0, 0],
					),
			}),
			database,
		);
		vectorService.addSource(
			"character-a",
			"semantic.txt",
			"The moon rises above the observatory.\n\nThe harbor bell marks dawn.",
		);
		await vectorService.indexPending("character-a");
		expect(
			database.orm.all<{ embeddingLength: number }>(
				"SELECT length(embedding) AS embeddingLength FROM canon_chunks",
			),
		).toEqual([{ embeddingLength: 8 }]);
		expect(
			database.connection.prepare("SELECT chunk_id FROM canon_chunk_vectors").all() as Array<{
				chunk_id: string;
			}>,
		).toHaveLength(1);
		expect(
			database.connection
				.prepare("SELECT value FROM canon_vector_meta WHERE key = 'dimensions'")
				.get() as { value: string },
		).toEqual({ value: "2" });
		const firstFingerprint = vectorMetadata(database, "fingerprint");
		expect(firstFingerprint).toMatch(/^[0-9a-f]{64}$/);

		expect(vectorService.search("character-a", "lunar")).toEqual([]);
		await expect(vectorService.searchHybrid("character-a", "lunar")).resolves.toEqual([
			expect.objectContaining({ content: expect.stringContaining("moon rises") }),
		]);

		const sameDimensionModelChange = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "same-dimension-model-cas")),
			eventBus,
			() => ({
				isReady: () => true,
				getDimensions: () => 2,
				getProviderInfo: () => ({ provider: "remote-a", model: "embedding-b" }),
				embed: async () => new Float32Array([0, 1]),
			}),
			database,
		);
		await sameDimensionModelChange.indexPending("character-a");
		const modelChangeFingerprint = vectorMetadata(database, "fingerprint");
		expect(modelChangeFingerprint).not.toBe(firstFingerprint);
		expect(storedEmbedding(database)).toEqual([0, 1]);

		const sameDimensionProviderChange = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "same-dimension-provider-cas")),
			eventBus,
			() => ({
				isReady: () => true,
				getDimensions: () => 2,
				getProviderInfo: () => ({ provider: "remote-b", model: "embedding-b" }),
				embed: async () => new Float32Array([0.5, 0.5]),
			}),
			database,
		);
		await sameDimensionProviderChange.indexPending("character-a");
		expect(vectorMetadata(database, "fingerprint")).not.toBe(modelChangeFingerprint);
		expect(storedEmbedding(database)).toEqual([0.5, 0.5]);

		const reconfiguredService = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "reconfigured-cas")),
			eventBus,
			() => ({
				isReady: () => true,
				getDimensions: () => 3,
				getProviderInfo: () => ({ provider: "remote-b", model: "embedding-b" }),
				embed: async () => new Float32Array([1, 0, 0]),
			}),
			database,
		);
		await reconfiguredService.indexPending("character-a");
		expect(
			database.connection
				.prepare("SELECT value FROM canon_vector_meta WHERE key = 'dimensions'")
				.get() as { value: string },
		).toEqual({ value: "3" });
		expect(storedEmbedding(database)).toEqual([1, 0, 0]);
	});

	it("keeps vector invalidation physically isolated between character databases", async () => {
		const roleA = new CompanionDatabase(join(root, "companions", "a", "runtime.db"), "role-a");
		const roleB = new CompanionDatabase(join(root, "companions", "b", "runtime.db"), "role-b");
		try {
			for (const role of [roleA, roleB]) {
				role.initialize(COMPANION_SCHEMA_SQL);
				role.ensureRuntimeIdentity();
			}
			const createRoleService = (
				role: CompanionDatabase,
				roleId: string,
				provider: string,
				vector: readonly number[],
			) =>
				new CanonHubService(
					role.orm,
					new ArtifactStore(role.orm, join(root, "companions", roleId, "artifacts")),
					new EventBus(role.orm),
					() => ({
						isReady: () => true,
						getDimensions: () => vector.length,
						getProviderInfo: () => ({ provider, model: "shared-dimension-model" }),
						embed: async () => new Float32Array(vector),
					}),
					role,
				);
			const serviceA = createRoleService(roleA, "a", "provider-a", [1, 0]);
			const serviceB = createRoleService(roleB, "b", "provider-b", [0, 1]);
			serviceA.addSource("role-a", "a.txt", "Character A canon.");
			serviceB.addSource("role-b", "b.txt", "Character B canon.");
			await Promise.all([serviceA.indexPending("role-a"), serviceB.indexPending("role-b")]);
			const roleBFingerprint = vectorMetadata(roleB, "fingerprint");
			const roleBEmbedding = storedEmbedding(roleB);

			await createRoleService(roleA, "a", "provider-a-v2", [0.5, 0.5]).indexPending("role-a");

			expect(vectorMetadata(roleB, "fingerprint")).toBe(roleBFingerprint);
			expect(storedEmbedding(roleB)).toEqual(roleBEmbedding);
			expect(
				roleB.connection.prepare("SELECT chunk_id FROM canon_chunk_vectors").all(),
			).toHaveLength(1);
		} finally {
			roleA.close();
			roleB.close();
		}
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

	it("syncs package canon idempotently and retrieves Chinese aliases, routed modules, and adjacent context", async () => {
		const canon = {
			manifest: {
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
					{
						id: "dawn",
						parent: "root",
						kind: "event" as const,
						title: "天亮",
						summary: "",
						triggers: ["天亮"],
						bindings: [{ source: "volume_one", headings: ["天亮"] }],
					},
				],
			},
			sources: [
				{
					id: "volume_one",
					title: "第一卷",
					path: "volume-one.txt",
					kind: "original_text" as const,
					content: `# 风暴夜\n\n旧极光站的主灯在风暴里熄灭。\n\n${"守机人逐项核对备用电源。".repeat(180)}\n\n## 天亮\n\n主灯在清晨重新点亮。`,
				},
			],
		};
		service.syncPackage("character-a", canon);
		service.syncPackage("character-a", canon);
		expect(eventBus.after(0)).toEqual([
			expect.objectContaining({
				kind: "canon.package_synced",
				payload: { companionId: "character-a" },
			}),
		]);
		expect(service.listSources("character-a")).toHaveLength(1);
		expect(service.listModules("character-a")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stableKey: "root", origin: "package" }),
				expect.objectContaining({ stableKey: "storm", sourceChunkIds: expect.any(Array) }),
				expect.objectContaining({ stableKey: "dawn", sourceChunkIds: expect.any(Array) }),
			]),
		);
		const packageModules = service.listModules("character-a");
		const stormRefs = packageModules.find((module) => module.stableKey === "storm")?.sourceChunkIds;
		const dawnRefs = packageModules.find((module) => module.stableKey === "dawn")?.sourceChunkIds;
		expect(stormRefs?.length).toBeGreaterThan(0);
		expect(dawnRefs?.length).toBeGreaterThan(0);
		expect(stormRefs).not.toEqual(dawnRefs);
		const citations = service.retrieve("character-a", "旧站风暴发生了什么", {
			moduleId: "storm",
			limit: 3,
		});
		expect(citations[0]).toEqual(
			expect.objectContaining({ sourceName: "第一卷", heading: "风暴夜", origin: "package" }),
		);
		expect(citations.some((citation) => citation.adjacent)).toBe(true);
		const explicitModule = await service.retrieveHybrid("character-a", "完全不相干的检索词", {
			moduleId: "storm",
		});
		expect(explicitModule).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ heading: "风暴夜", content: expect.stringContaining("主灯") }),
			]),
		);
		expect(explicitModule.every((chunk) => chunk.heading === "风暴夜")).toBe(true);
		expect(() =>
			service.removeSource("character-a", service.listSources("character-a")[0]?.id ?? ""),
		).toThrow();
	});
});
