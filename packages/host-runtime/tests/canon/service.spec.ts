// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { CanonHubService } from "../../src/canon/service.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../../src/storage/database.js";
import { InvalidationHub } from "../../src/storage/invalidation-hub.js";

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
	let invalidations: InvalidationHub;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-canon-"));
		database = new CompanionDatabase(join(root, "runtime.db"), "character-a");
		database.initialize(COMPANION_SCHEMA_SQL);
		database.ensureRuntimeIdentity();
		invalidations = new InvalidationHub();
		service = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "cas")),
			invalidations,
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

	it("keeps short Chinese keywords beside long names and ranks relevant passages first", () => {
		service.addSource("character-a", "inn.txt", "白熊客栈在坡上。");
		service.addSource("character-a", "rooms.txt", "厨房与书房之间是短走廊。");
		const rows = service.retrieve("character-a", "白熊客栈 厨房 书房", {
			limit: 1,
			includeAdjacent: false,
		});
		expect(rows).toEqual([
			expect.objectContaining({
				sourceName: "rooms.txt",
				content: expect.stringContaining("短走廊"),
			}),
		]);
		expect(service.retrieve("character-b", "白熊客栈 厨房 书房")).toEqual([]);
		expect(service.search("character-a", "厨房")[0]?.sourceName).toBe("rooms.txt");
	});

	it("persists embeddings and retrieves semantic matches when lexical search misses", async () => {
		const vectorService = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "vector-cas")),
			invalidations,
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
			invalidations,
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
			invalidations,
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
			invalidations,
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
					new InvalidationHub(),
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

	it("syncs documents idempotently, refreshes changed text and preserves user sources", async () => {
		const personal = service.addSource("character-a", "notes.txt", "Personal observatory notes.");
		const canon = {
			sources: [
				{
					id: "canon/volume.md",
					path: "canon/volume.md",
					title: "第一卷",
					content: "# 风暴夜\n\n旧极光站的主灯在风暴里熄灭。",
				},
			],
		};
		service.syncPackage("character-a", canon);
		const first = service.listSources("character-a");
		service.syncPackage("character-a", canon);
		expect(service.listSources("character-a")).toEqual(first);
		expect(service.retrieve("character-a", "风暴")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sourceName: "第一卷", origin: "package" }),
			]),
		);
		expect(service.retrieve("character-b", "风暴")).toEqual([]);
		await expect(service.retrieveHybrid("character-a", "unrelated-word")).resolves.toEqual([]);
		const packaged = first.find((source) => source.origin === "package");
		expect(() => service.removeSource("character-a", packaged?.id ?? "")).toThrow();
		service.syncPackage("character-a", {
			sources: [{ ...canon.sources[0], content: "# 天亮\n\n主灯在清晨重新点亮。" }],
		});
		expect(service.retrieve("character-a", "风暴")).toEqual([]);
		expect(service.retrieve("character-a", "清晨").length).toBeGreaterThan(0);
		service.syncPackage("character-a", { sources: [] });
		expect(service.listSources("character-a")).toEqual([personal]);
	});
});

describe("Canon indexing lifecycle", () => {
	it("awaits readiness, retries failures, and does not resurrect a deleted source", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-canon-lifecycle-"));
		const database = new CompanionDatabase(join(root, "runtime.db"), "role");
		database.initialize(COMPANION_SCHEMA_SQL);
		database.ensureRuntimeIdentity();
		let ready!: () => void;
		const readiness = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let fail = true;
		let calls = 0;
		let entered!: () => void;
		let release!: () => void;
		let delayed: Promise<void> | undefined;
		const service = new CanonHubService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "cas")),
			new InvalidationHub(),
			async () => {
				await readiness;
				return {
					isReady: () => true,
					getDimensions: () => 2,
					getProviderInfo: () => ({ provider: "test", model: "semantic" }),
					embed: async () => {
						calls++;
						if (fail) throw new Error("provider failed");
						if (delayed) {
							entered();
							await delayed;
						}
						return new Float32Array([1, 0]);
					},
				};
			},
			database,
		);
		try {
			service.addSource("role", "a.txt", "The moon is visible.");
			expect(calls).toBe(0);
			ready();
			await expect(service.searchHybrid("role", "lunar")).rejects.toThrow("provider failed");
			fail = false;
			await expect(service.searchHybrid("role", "lunar")).resolves.toEqual([
				expect.objectContaining({ sourceName: "a.txt" }),
			]);
			expect(service.search("role", "lunar")).toEqual([]);
			const begun = new Promise<void>((resolve) => {
				entered = resolve;
			});
			delayed = new Promise<void>((resolve) => {
				release = resolve;
			});
			const source = service.addSource("role", "b.txt", "A removable reference.");
			await begun;
			service.removeSource("role", source.id);
			release();
			await service.indexPending("role");
			expect(
				database.connection.prepare("SELECT count(*) AS n FROM canon_chunk_vectors").get(),
			).toMatchObject({ n: 1 });
			await expect(service.searchHybrid("other", "lunar")).resolves.toEqual([]);
		} finally {
			await service.close();
			database.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
