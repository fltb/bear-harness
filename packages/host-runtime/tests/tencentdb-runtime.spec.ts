// @vitest-environment node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EmbeddingService,
	type L1RecordRow,
	LocalEmbeddingService,
	type Logger,
	type MemoryRecord as TdaiMemoryRecord,
	VectorStore,
} from "@bear-harness/tdai-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryBackend, MemoryBankScope, MemoryMetadata } from "../src/memory/backend.js";
import { namespaceFor } from "../src/memory/tencentdb-backend.js";
import { BearHarnessHostAdapter } from "../src/memory/tencentdb-host-adapter.js";
import { TencentDbRuntime } from "../src/memory/tencentdb-runtime.js";
import type { ModelRegistry } from "../src/models/registry.js";
import type { ProviderCatalog } from "../src/providers/catalog.js";

const logger: Logger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

const fakeModel = {
	id: "fake-memory-model",
	provider: "fake-memory-provider",
	api: "openai-completions",
	name: "Fake memory model",
};

const fakeModels = {
	getModel(providerId: string, modelId: string) {
		return providerId === fakeModel.provider && modelId === fakeModel.id ? fakeModel : undefined;
	},
	getAvailable(providerId: string) {
		return Promise.resolve(providerId === fakeModel.provider ? [fakeModel] : []);
	},
	completeSimple: async () => ({
		role: "assistant",
		content: [{ type: "text", text: "fake provider response" }],
	}),
};

const fakeProviders = {
	getModels: async () => fakeModels,
} as unknown as ProviderCatalog;

const fakeModelRegistry = {
	defaults: () => ({
		reply: {
			providerId: fakeModel.provider,
			modelId: fakeModel.id,
		},
		vision: { mode: "auto" },
	}),
} as unknown as ModelRegistry;

const provenance = {
	kind: "explicit" as const,
	piSessionEntryIds: ["pi-session-entry-1"] as const,
	sourceRef: "pi-session-1",
};

const scopeFor = (companionId: string): MemoryBankScope => ({
	installationId: "test-installation",
	userId: "test-user",
	companionId,
});

const runtimes: TencentDbRuntime[] = [];
const roots: string[] = [];

describe("local embedding downloader", () => {
	it("passes the selected endpoint and cancellation signal to model resolution", async () => {
		const signal = new AbortController().signal;
		const onDownloadProgress = vi.fn();
		const onDownloadComplete = vi.fn();
		const resolveModelFile = vi.fn(
			async (
				_model: string,
				options: { onProgress?: (progress: { downloadedSize: number; totalSize: number }) => void },
			) => {
				options.onProgress?.({ downloadedSize: 128, totalSize: 256 });
				return "/cache/model.gguf";
			},
		);
		const service = new LocalEmbeddingService(
			{
				provider: "local",
				modelPath: "hf:test/model/model.gguf",
				dimensions: 768,
				hfEndpoint: "https://hf-mirror.com",
				signal,
				onDownloadProgress,
				onDownloadComplete,
			},
			logger,
			async () =>
				({
					getLlama: async () => ({
						loadModel: async () => ({
							createEmbeddingContext: async () => ({
								getEmbeddingFor: async () => ({ vector: new Float32Array(768) }),
							}),
						}),
					}),
					resolveModelFile,
					LlamaLogLevel: { error: 0 },
				}) as never,
		);

		service.startWarmup();
		await service.waitForReady();
		expect(resolveModelFile).toHaveBeenCalledWith("hf:test/model/model.gguf", {
			endpoints: { huggingFace: "https://hf-mirror.com" },
			signal,
			onProgress: onDownloadProgress,
			cli: false,
			deleteTempFileOnCancel: true,
		});
		expect(onDownloadProgress).toHaveBeenCalledWith({ downloadedSize: 128, totalSize: 256 });
		expect(onDownloadComplete).toHaveBeenCalledOnce();
		expect(service.getDimensions()).toBe(768);
		service.close();
	});
});

it("detects and rebuilds an incomplete vector index even when provider metadata matches", () => {
	const root = createRoot();
	const path = join(root, "incomplete-vectors.db");
	const provider = { provider: "local", model: "test-embedding" };
	const initial = new VectorStore(path, 3, logger);
	expect(initial.init(provider).needsReindex).toBe(false);
	expect(initial.upsertL1(storedMemory("memory-1", "scope-a", "metadata without vector"))).toBe(
		true,
	);
	initial.close();

	const recovered = new VectorStore(path, 3, logger);
	const result = recovered.init(provider);
	expect(result).toMatchObject({
		needsReindex: true,
		reason: "incomplete vector index: L1=0/1, L0=0/0",
	});
	recovered.close();
});

function createRuntime(
	root: string,
	companionId = "role-a",
	memoryConfig?: Parameters<typeof TencentDbRuntime.prototype.constructor>[0]["memoryConfig"],
	onRecordsChanged?: () => void,
): TencentDbRuntime {
	const runtime = new TencentDbRuntime({
		onRecordsChanged,
		dataDir: root,
		providers: fakeProviders,
		models: fakeModelRegistry,
		companionId,
		installationId: "test-installation",
		userId: "test-user",
		logger,
		memoryConfig,
	});
	runtimes.push(runtime);
	return runtime;
}

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-tencentdb-runtime-"));
	roots.push(root);
	return root;
}

async function remember(backend: MemoryBackend, scope: MemoryBankScope, text: string) {
	await backend.open({ scope });
	return backend.remember({ scope, text, provenance, importance: 0.7 });
}

it("embeds direct memories and recalls paraphrases through the local vector path", async () => {
	const runtime = createRuntime(createRoot());
	const scope = scopeFor("role-a");
	const records = new Map<string, TdaiMemoryRecord>();
	const upsertL1 = vi.fn((record: TdaiMemoryRecord, embedding?: Float32Array) => {
		expect(embedding).toBeInstanceOf(Float32Array);
		expect(embedding?.length).toBe(3);
		records.set(record.id, record);
		return true;
	});
	const searchL1Vector = vi.fn(() => {
		const record = [...records.values()][0];
		if (!record) return [];
		return [
			{
				record_id: record.id,
				content: record.content,
				type: record.type,
				priority: record.priority,
				scene_name: record.scene_name,
				score: 0.91,
				timestamp_str: record.timestamps[0] ?? "",
				timestamp_start: record.timestamps[0] ?? "",
				timestamp_end: record.timestamps[0] ?? "",
				session_key: record.sessionKey,
				session_id: record.sessionId,
				metadata_json: JSON.stringify(record.metadata),
			},
		];
	});
	const store = {
		getCapabilities: () => ({
			vectorSearch: true,
			ftsSearch: false,
			nativeHybridSearch: false,
			sparseVectors: false,
		}),
		isFtsAvailable: () => false,
		queryL1Records: ({ sessionKey }: { sessionKey?: string } = {}) =>
			[...records.values()]
				.filter((record) => sessionKey === undefined || record.sessionKey === sessionKey)
				.map((record) => ({
					record_id: record.id,
					content: record.content,
					type: record.type,
					priority: record.priority,
					scene_name: record.scene_name,
					session_key: record.sessionKey,
					session_id: record.sessionId,
					timestamp_str: record.timestamps[0] ?? "",
					timestamp_start: record.timestamps[0] ?? "",
					timestamp_end: record.timestamps[0] ?? "",
					created_time: record.createdAt,
					updated_time: record.updatedAt,
					metadata_json: JSON.stringify(record.metadata),
				})),
		countL1: () => records.size,
		upsertL1,
		deleteL1: (id: string) => records.delete(id),
		searchL1Vector,
		searchL1Fts: () => [],
	};
	const embed = vi.fn(async () => new Float32Array([0.2, 0.4, 0.8]));
	const embedding: EmbeddingService = {
		embed,
		embedBatch: async (texts) => Promise.all(texts.map((text) => embed(text))),
		getDimensions: () => 3,
		getProviderInfo: () => ({ provider: "local", model: "test" }),
		isReady: () => true,
		startWarmup: () => undefined,
	};
	(
		runtime as unknown as {
			core: {
				getVectorStore(): unknown;
				getEmbeddingService(): EmbeddingService;
				destroy(): Promise<void>;
			};
		}
	).core = {
		getVectorStore: () => store,
		getEmbeddingService: () => embedding,
		destroy: async () => undefined,
	};

	await runtime.backend.open({ scope });
	const created = await remember(
		runtime.backend,
		scope,
		"我在做深度调试时偏好先画时序图，再检查并发竞态",
	);
	const hits = await runtime.backend.recall({
		scope,
		query: "复杂故障定位的优先方法是什么？",
		limit: 5,
	});

	expect(upsertL1).toHaveBeenCalledOnce();
	expect(searchL1Vector).toHaveBeenCalledOnce();
	expect(embed).toHaveBeenCalledWith("复杂故障定位的优先方法是什么？");
	expect(hits).toEqual([
		expect.objectContaining({ record: expect.objectContaining({ id: created.id }) }),
	]);
});

type RuntimeStoreForTest = {
	getCapabilities: () => {
		vectorSearch: boolean;
		ftsSearch: boolean;
		nativeHybridSearch: boolean;
		sparseVectors: boolean;
	};
	queryL1Records: (filter?: { sessionKey?: string }) => L1RecordRow[] | Promise<L1RecordRow[]>;
	upsertL1: (record: TdaiMemoryRecord) => boolean | Promise<boolean>;
};

function runtimeStore(runtime: TencentDbRuntime): RuntimeStoreForTest {
	const core = (runtime as unknown as { core: { getVectorStore(): unknown } }).core;
	const store = core.getVectorStore();
	if (!store) throw new Error("TencentDB runtime did not initialize a local store");
	return store as RuntimeStoreForTest;
}

function storedMemory(
	id: string,
	namespace: string,
	text: string,
	metadata: Record<string, string | number | boolean | null> = {},
): TdaiMemoryRecord {
	return {
		id,
		content: text,
		type: "persona",
		priority: 83,
		scene_name: namespace,
		source_message_ids: ["source-entry-a", "source-entry-b"],
		metadata,
		timestamps: ["2026-08-01T01:02:03.000Z", "2026-08-02T04:05:06.000Z"],
		createdAt: "2026-08-01T01:02:03.000Z",
		updatedAt: "2026-08-02T04:05:06.000Z",
		sessionKey: namespace,
		sessionId: "source-session",
	};
}

afterEach(async () => {
	for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TencentDbRuntime", () => {
	it("starts and closes an idempotent local lifecycle under the product data directory", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");

		expect((await runtime.backend.diagnostics()).state).toBe("closed");
		await runtime.start();
		await runtime.start();
		await runtime.backend.open({ scope });
		const created = await runtime.backend.remember({
			scope,
			text: "local lifecycle memory",
			provenance,
		});

		expect(existsSync(join(root, "memory", "vectors.db"))).toBe(true);
		expect(created.provenance).toEqual(provenance);

		await runtime.close();
		await runtime.close();
		expect((await runtime.backend.diagnostics()).state).toBe("closed");
		await expect(runtime.start()).rejects.toThrow("runtime is closed");

		const reopened = createRuntime(root);
		await reopened.start();
		await reopened.backend.open({ scope });
		await expect(
			reopened.backend.update({ scope, memoryId: created.id, text: "reopened local memory" }),
		).resolves.toMatchObject({ id: created.id, text: "reopened local memory" });
	}, 15_000);

	it("round-trips a directly remembered record through list before and after restart", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		const userText = "remember this exact moment";
		await runtime.start();
		await runtime.backend.open({ scope });

		const created = await runtime.backend.remember({
			scope,
			text: userText,
			provenance,
		});
		expect(created.text).toBe(userText);
		await expect(runtime.backend.list({ scope })).resolves.toEqual([
			expect.objectContaining({ id: created.id, text: created.text }),
		]);

		await runtime.close();
		const reopened = createRuntime(root);
		await reopened.start();
		await reopened.backend.open({ scope });
		await expect(reopened.backend.list({ scope })).resolves.toEqual([
			expect.objectContaining({ id: created.id, text: created.text }),
		]);
	});

	it("round-trips every primitive MemoryMetadata key through the Tdai store", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		await runtime.start();
		await runtime.backend.open({ scope });

		const metadata = {
			scope: "scene",
			activity_start_time: "2026-08-17T09:00:00.000Z",
			activity_end_time: "2026-08-17T10:00:00.000Z",
			rating: 4.5,
			approved: true,
			note: null,
		} satisfies MemoryMetadata;

		const created = await runtime.backend.remember({
			scope,
			text: "metadata round-trip memory",
			provenance,
			importance: 0.7,
			metadata,
		});
		expect(created.metadata).toEqual(metadata);

		// The Tdai store itself persists the whole payload (not only activity
		// timestamps) in the metadata_json column.
		const store = runtimeStore(runtime);
		const rows = (await store.queryL1Records()) as Array<{
			record_id: string;
			metadata_json: string;
		}>;
		const stored = rows.find((row) => row.record_id === created.id);
		expect(stored).toBeDefined();
		expect(JSON.parse(stored!.metadata_json)).toEqual(metadata);

		await expect(runtime.backend.list({ scope })).resolves.toEqual([
			expect.objectContaining({ id: created.id, metadata }),
		]);

		// Survives a restart: the projected record keeps every primitive key.
		await runtime.close();
		const reopened = createRuntime(root);
		await reopened.start();
		await reopened.backend.open({ scope });
		await expect(reopened.backend.list({ scope })).resolves.toEqual([
			expect.objectContaining({ id: created.id, metadata }),
		]);
	});

	it("keeps role namespaces isolated in the local TencentDB store", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		await runtime.start();
		const roleA = scopeFor("role-a");
		const roleB = scopeFor("role-b");

		await remember(runtime.backend, roleA, "alpine role memory");
		await remember(runtime.backend, roleB, "beryl role memory");

		await runtime.backend.open({ scope: roleA });
		const roleAHits = await runtime.backend.recall({ scope: roleA, query: "alpine", limit: 10 });
		await runtime.backend.open({ scope: roleB });
		const roleBHits = await runtime.backend.recall({ scope: roleB, query: "beryl", limit: 10 });

		expect(roleAHits.map((hit) => hit.record.text)).toEqual(["alpine role memory"]);
		expect(roleBHits.map((hit) => hit.record.text)).toEqual(["beryl role memory"]);
		expect(roleAHits.every((hit) => hit.record.scope.companionId === "role-a")).toBe(true);
		expect(roleBHits.every((hit) => hit.record.scope.companionId === "role-b")).toBe(true);
	});

	it("recalls a captured Chinese record for a generic direct-memory query through native FTS", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		await runtime.start();
		await remember(runtime.backend, scope, "用户喜欢在清晨散步，也偏好简洁的回答");

		await runtime.backend.open({ scope });
		const hits = await runtime.backend.recall({
			scope,
			query: "请回忆一下用户喜欢什么样的回答",
			limit: 10,
		});

		expect(hits.map((hit) => hit.record.text)).toEqual(["用户喜欢在清晨散步，也偏好简洁的回答"]);
	});

	it("recalls captures from different conversations in the same companion bank", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		await runtime.start();
		await runtime.backend.open({ scope });
		const distractorScope = scopeFor("role-b");
		for (let index = 0; index < 60; index += 1) {
			await runtime.backend.open({ scope: distractorScope });
			await runtime.backend.remember({
				scope: distractorScope,
				text: `E2E_DIRECT_MEMORY_B distractor ${index}：我们约定暗号是北辰`,
				provenance: {
					kind: "explicit",
					piSessionEntryIds: [`distractor-${index}`],
					sourceRef: `conversation-distractor-${index}`,
				},
			});
		}
		await runtime.backend.open({ scope });

		const first = await runtime.backend.remember(
			{
				scope,
				text: "E2E_DIRECT_MEMORY_A：我们约定暗号是北辰",
				provenance: {
					kind: "explicit",
					piSessionEntryIds: ["entry-a"],
					sourceRef: "conversation-a",
				},
			},
			15_000,
		);
		const second = await runtime.backend.remember({
			scope,
			text: "E2E_DIRECT_MEMORY_B：我们约定暗号是北辰",
			provenance: {
				kind: "explicit",
				piSessionEntryIds: ["entry-b"],
				sourceRef: "conversation-b",
			},
		});

		const firstHits = await runtime.backend.recall({
			scope,
			query: "检查记忆上下文 E2E_DIRECT_MEMORY_A：我们约定暗号是北辰",
			limit: 10,
		});
		expect(firstHits.map((hit) => hit.record.id)).toContain(first.id);
		expect(firstHits.every((hit) => hit.record.scope.companionId === scope.companionId)).toBe(true);
		const secondHits = await runtime.backend.recall({
			scope,
			query: "检查记忆上下文 E2E_DIRECT_MEMORY_B：我们约定暗号是北辰",
			limit: 10,
		});
		expect(secondHits[0]?.record.id).toBe(second.id);
		expect(secondHits.every((hit) => hit.record.scope.companionId === scope.companionId)).toBe(
			true,
		);
		await expect(runtime.backend.list({ scope })).resolves.toEqual([
			expect.objectContaining({ id: first.id }),
			expect.objectContaining({ id: second.id }),
		]);
	});

	it("supports direct remember, update, invalidate, and forget mutations", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		await runtime.start();

		const created = await remember(runtime.backend, scope, "mutable local memory");
		const updated = await runtime.backend.update({
			scope,
			memoryId: created.id,
			text: "updated local memory",
			importance: 0.95,
			metadata: {
				activity_start_time: "2026-08-17T09:00:00.000Z",
				activity_end_time: "2026-08-17T10:00:00.000Z",
			},
		});
		expect(updated).toMatchObject({
			id: created.id,
			text: "updated local memory",
			importance: 0.95,
			status: "active",
			metadata: {
				activity_start_time: "2026-08-17T09:00:00.000Z",
				activity_end_time: "2026-08-17T10:00:00.000Z",
			},
		});

		const invalidated = await runtime.backend.invalidate({
			scope,
			memoryId: created.id,
			replacementMemoryId: "replacement-memory",
			reason: "superseded by the direct edit",
		});
		expect(invalidated).toMatchObject({ id: created.id, status: "invalidated" });
		expect(invalidated.invalidatedAt).toEqual(expect.any(String));

		await runtime.backend.forget({ scope, memoryId: created.id });
		await expect(
			runtime.backend.update({ scope, memoryId: created.id, text: "gone" }),
		).rejects.toThrow("TencentDB memory not found");
	});

	it("does not scan stored text when native retrieval capabilities are unavailable", async () => {
		const root = createRoot();
		const runtime = createRuntime(root);
		const scope = scopeFor("role-a");
		await runtime.start();
		await remember(runtime.backend, scope, "manual substring fallback sentinel");

		const store = runtimeStore(runtime);
		const availableCapabilities = store.getCapabilities();
		const originalGetCapabilities = store.getCapabilities;
		const originalQueryL1Records = store.queryL1Records;
		store.getCapabilities = () => ({
			...availableCapabilities,
			ftsSearch: false,
			nativeHybridSearch: false,
		});
		store.queryL1Records = () => {
			throw new Error("manual substring fallback must not query all records");
		};

		try {
			await runtime.backend.open({ scope });
			await expect(
				runtime.backend.recall({ scope, query: "substring", limit: 10 }),
			).resolves.toEqual([]);
		} finally {
			store.getCapabilities = originalGetCapabilities;
			store.queryL1Records = originalQueryL1Records;
		}
	});

	describe("full-power configuration and memoryConfig injection", () => {
		function coreConfig(runtime: TencentDbRuntime) {
			return (runtime as unknown as { core: { cfg: unknown } }).core.cfg as {
				capture: { enabled: boolean; l0l1RetentionDays: number };
				extraction: { enabled: boolean; enableDedup: boolean };
				persona: { triggerEveryN: number };
				pipeline: {
					everyNConversations: number;
					enableWarmup: boolean;
					l2DelayAfterL1Seconds: number;
				};
				recall: { enabled: boolean; strategy: string; timeoutMs: number };
				embedding: { enabled: boolean; provider: string };
				tcvdb: { embeddingDimensions: number };
				bm25: { enabled: boolean; language: string };
				memoryCleanup: { enabled: boolean };
				report: { enabled: boolean };
				offload: { enabled: boolean };
			};
		}

		it("enables the full TdaiCore pipeline by default", () => {
			const runtime = createRuntime(createRoot());
			const cfg = coreConfig(runtime);
			expect(cfg.capture.enabled).toBe(true);
			expect(cfg.capture.l0l1RetentionDays).toBe(30);
			expect(cfg.extraction.enabled).toBe(true);
			expect(cfg.extraction.enableDedup).toBe(true);
			expect(cfg.persona.triggerEveryN).toBe(50);
			expect(cfg.pipeline.everyNConversations).toBe(5);
			expect(cfg.pipeline.enableWarmup).toBe(true);
			expect(cfg.pipeline.l2DelayAfterL1Seconds).toBe(10);
			expect(cfg.recall.enabled).toBe(true);
			expect(cfg.recall.strategy).toBe("hybrid");
			expect(cfg.recall.timeoutMs).toBe(5000);
			expect(cfg.embedding.enabled).toBe(true);
			expect(cfg.tcvdb.embeddingDimensions).toBe(1024);
			expect(cfg.bm25.enabled).toBe(true);
			expect(cfg.bm25.language).toBe("zh");
			expect(cfg.memoryCleanup.enabled).toBe(true);
			expect(cfg.report.enabled).toBe(false);
			expect(cfg.offload.enabled).toBe(true);
		});

		it("merges memoryConfig overrides onto the defaults", () => {
			const runtime = createRuntime(createRoot(), "role-b", {
				recall: { strategy: "keyword", timeoutMs: 1000 },
				extraction: { enabled: false },
				bm25: { language: "en" },
			});
			const cfg = coreConfig(runtime);
			expect(cfg.recall.strategy).toBe("keyword");
			expect(cfg.recall.timeoutMs).toBe(1000);
			expect(cfg.extraction.enabled).toBe(false);
			expect(cfg.bm25.language).toBe("en");
			// untouched defaults survive the merge
			expect(cfg.capture.enabled).toBe(true);
			expect(cfg.pipeline.everyNConversations).toBe(5);
		});

		it("keeps vector search disabled until an embedding provider is configured", async () => {
			const runtime = createRuntime(createRoot());
			await runtime.start();
			const store = runtimeStore(runtime);
			expect(store.getCapabilities().vectorSearch).toBe(false);
			const native = store.getCapabilities().nativeHybridSearch;
			// hybrid recall without vectors still has the FTS/BM25 path available
			expect(native || store.getCapabilities().ftsSearch).toBe(true);
		});
	});
	describe("automatic extraction pipeline", () => {
		it("flushes an explicit capture through L0 and L1 and returns stored IDs", async () => {
			const originalCompleteSimple = fakeModels.completeSimple;
			fakeModels.completeSimple = async () => ({
				role: "assistant",
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{
								scene_name: "用户说明长期写作偏好",
								message_ids: ["explicit-user-1"],
								memories: [
									{
										content: "用户习惯在午夜写长篇小说",
										type: "persona",
										priority: 80,
										source_message_ids: ["explicit-user-1"],
										metadata: {},
									},
								],
							},
						]),
					},
				],
			});
			try {
				const root = createRoot();
				const runtime = createRuntime(root, "role-a", {
					pipeline: { everyNConversations: 99, enableWarmup: false },
					extraction: { enableDedup: false },
				});
				await runtime.start();
				const timestamp = Date.now() + 1000;
				const result = await runtime.captureExplicitTurn({
					userText: "请记住，我习惯在午夜写长篇小说",
					assistantText: "好。",
					messages: [
						{
							id: "explicit-user-1",
							role: "user",
							content: "请记住，我习惯在午夜写长篇小说",
							timestamp,
						},
					],
					sessionKey: namespaceFor(scopeFor("role-a")),
					sessionId: "explicit-session-1",
					startedAt: timestamp - 1,
				});

				expect(result).toMatchObject({
					status: "stored",
					reason: "memory_stored",
					l0RecordedCount: 1,
					extractedCount: 1,
					storedCount: 1,
					skippedCount: 0,
					failedCount: 0,
					storedRecordIds: [expect.any(String)],
				});
				await runtime.backend.open({ scope: scopeFor("role-a") });
				const records = await runtime.backend.list({ scope: scopeFor("role-a") });
				expect(records).toEqual([
					expect.objectContaining({
						id: result.storedRecordIds[0],
						text: "用户习惯在午夜写长篇小说",
					}),
				]);
				expect(existsSync(join(root, "memory", "conversations"))).toBe(true);
				expect(existsSync(join(root, "memory", "records"))).toBe(true);
			} finally {
				fakeModels.completeSimple = originalCompleteSimple;
			}
		}, 15_000);

		it("returns an explicit reason when the extractor finds no durable memory", async () => {
			const originalCompleteSimple = fakeModels.completeSimple;
			fakeModels.completeSimple = async () => ({
				role: "assistant",
				content: [
					{
						type: "text",
						text: JSON.stringify([
							{
								scene_name: "普通寒暄",
								message_ids: ["empty-user-1"],
								memories: [],
							},
						]),
					},
				],
			});
			try {
				const runtime = createRuntime(createRoot(), "role-a", {
					pipeline: { everyNConversations: 99, enableWarmup: false },
					extraction: { enableDedup: false },
				});
				await runtime.start();
				const timestamp = Date.now() + 1000;
				await expect(
					runtime.captureExplicitTurn({
						userText: "你好",
						assistantText: "你好。",
						messages: [{ id: "empty-user-1", role: "user", content: "你好", timestamp }],
						sessionKey: namespaceFor(scopeFor("role-a")),
						sessionId: "empty-session-1",
						startedAt: timestamp - 1,
					}),
				).resolves.toMatchObject({
					status: "no_extractable_memory",
					reason: "extractor_found_no_durable_memory",
					extractedCount: 0,
					storedCount: 0,
				});
			} finally {
				fakeModels.completeSimple = originalCompleteSimple;
			}
		}, 15_000);

		it("reports an equivalent explicit memory as already known instead of rejecting silently", async () => {
			const originalCompleteSimple = fakeModels.completeSimple;
			fakeModels.completeSimple = async (_model?: unknown, context?: unknown) => {
				const serialized = JSON.stringify(context);
				const newRecordId = serialized.match(/第 1 条新记忆 \(record_id: ([^)]+)\)/)?.[1];
				const text = newRecordId
					? JSON.stringify([
							{
								record_id: newRecordId,
								action: "skip",
								target_ids: [],
							},
						])
					: JSON.stringify([
							{
								scene_name: "用户说明固定饮品偏好",
								message_ids: [],
								memories: [
									{
										content: "用户长期只喝无糖乌龙茶",
										type: "persona",
										priority: 80,
										source_message_ids: [],
										metadata: {},
									},
								],
							},
						]);
				return { role: "assistant", content: [{ type: "text", text }] };
			};
			try {
				const runtime = createRuntime(createRoot(), "role-a", {
					pipeline: { everyNConversations: 99, enableWarmup: false },
					extraction: { enableDedup: true },
				});
				await runtime.start();
				const sessionKey = namespaceFor(scopeFor("role-a"));
				const capture = (id: string, timestamp: number) =>
					runtime.captureExplicitTurn({
						userText: "请记住，我长期只喝无糖乌龙茶",
						assistantText: "好。",
						messages: [
							{
								id,
								role: "user",
								content: "请记住，我长期只喝无糖乌龙茶",
								timestamp,
							},
						],
						sessionKey,
						sessionId: id,
						startedAt: timestamp - 1,
					});

				await expect(capture("known-user-1", Date.now() + 1000)).resolves.toMatchObject({
					status: "stored",
					reason: "memory_stored",
				});
				await expect(capture("known-user-2", Date.now() + 3000)).resolves.toMatchObject({
					status: "already_known",
					reason: "equivalent_memory_already_stored",
					extractedCount: 1,
					storedCount: 0,
					skippedCount: 1,
				});
			} finally {
				fakeModels.completeSimple = originalCompleteSimple;
			}
		}, 15_000);

		it("turns a settled conversation into backend memories via the L1 extractor", async () => {
			const originalCompleteSimple = fakeModels.completeSimple;
			let completeCalls = 0;
			fakeModels.completeSimple = async () => {
				completeCalls += 1;
				return {
					role: "assistant",
					content: [
						{
							type: "text",
							text: JSON.stringify([
								{
									scene_name: "书房",
									message_ids: [],
									memories: [
										{
											content: "用户喜欢在深夜写作",
											type: "preference",
											priority: 0.8,
											source_message_ids: [],
											metadata: {},
										},
									],
								},
							]),
						},
					],
				};
			};
			try {
				const changed = vi.fn();
				const runtime = createRuntime(
					createRoot(),
					"role-a",
					{
						pipeline: { everyNConversations: 1, enableWarmup: false, l1IdleTimeoutSeconds: 1 },
						extraction: { enableDedup: false },
					},
					changed,
				);
				await runtime.start();
				const scope = scopeFor("role-a");
				await runtime.captureTurn({
					userText: "我习惯深夜写东西",
					assistantText: "好的，我记住了。",
					messages: [
						{ role: "user", content: "我习惯深夜写东西", timestamp: Date.now() + 1000 },
						{ role: "assistant", content: "好的，我记住了。", timestamp: Date.now() + 2000 },
					],
					sessionKey: namespaceFor(scope),
					sessionId: "conversation-1",
				});

				// The L1 runner fires on the conversation threshold (1) or the idle
				// timeout; wait for the extracted memory to land in the backend.
				await runtime.backend.open({ scope });
				let records = await runtime.backend.list({ scope });
				const deadline = Date.now() + 10_000;
				while (records.length === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 200));
					records = await runtime.backend.list({ scope });
				}
				expect(records.some((record) => record.text === "用户喜欢在深夜写作")).toBe(true);
				await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2));
				void completeCalls;

				// The extracted memory is recallable through the backend.
				const hits = await runtime.backend.recall({ scope, query: "深夜写作", limit: 5 });
				expect(hits.some(({ record }) => record.text === "用户喜欢在深夜写作")).toBe(true);
			} finally {
				// Restore shared fake so later tests are unaffected.
				fakeModels.completeSimple = originalCompleteSimple;
			}
		}, 15_000);
	});
});

// ============================
// BearHarness tool-call loop (pi-ai runtime)
// ============================

type ToolModels = {
	getModel: (providerId: string, modelId: string) => unknown;
	getAvailable: (providerId: string) => Promise<unknown[]>;
	complete: (model: unknown, context: Context) => Promise<AssistantMessage>;
	completeSimple: (model: unknown, context: Context) => Promise<AssistantMessage>;
};

function fakeAssistant(content: unknown[], stopReason: string, text?: string) {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }, ...content] : content,
		api: "openai-completions",
		provider: fakeModel.provider,
		model: fakeModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createToolRunner(models: ToolModels, workspaceDir: string) {
	const adapter = new BearHarnessHostAdapter({
		dataDir: workspaceDir,
		workspaceDir,
		userId: "test-user",
		companionId: "role-a",
		providers: {
			getModels: async () => models,
		} as unknown as ProviderCatalog,
		models: fakeModelRegistry,
		logger,
	});
	return adapter.getLLMRunnerFactory().createRunner({
		enableTools: true,
		modelRef: `${fakeModel.provider}/${fakeModel.id}`,
	});
}

function toolModels(complete: ToolModels["complete"], extra?: Partial<ToolModels>): ToolModels {
	return {
		getModel: (providerId, modelId) =>
			providerId === fakeModel.provider && modelId === fakeModel.id ? fakeModel : undefined,
		getAvailable: (providerId) =>
			Promise.resolve(providerId === fakeModel.provider ? [fakeModel] : []),
		complete,
		completeSimple: async () => fakeAssistant([], "stop", "unused"),
		...extra,
	};
}

function toolResultText(results: readonly ToolResultMessage[], index: number): string {
	const part = results[index]?.content.find((candidate) => candidate.type === "text");
	return part && part.type === "text" ? part.text : "";
}

function jsonError(payloadText: string): string {
	const payload = JSON.parse(payloadText) as unknown;
	if (payload && typeof payload === "object" && "error" in payload) {
		const error = payload.error;
		return typeof error === "string" ? error : "";
	}
	return "";
}

describe("BearHarnessLLMRunner tool loop", () => {
	it("executes a sandboxed tool call and feeds the result back into the loop", async () => {
		const root = createRoot();
		writeFileSync(join(root, "note.txt"), "hello from the sandbox", "utf-8");
		const observed: Context[] = [];
		const complete = vi.fn(async (_model: unknown, context: Context) => {
			observed.push(context);
			if (observed.length === 1) {
				return fakeAssistant(
					[
						{
							type: "toolCall",
							id: "call_1",
							name: "read_file",
							arguments: { path: "note.txt" },
						},
					],
					"toolUse",
				);
			}
			return fakeAssistant([], "stop", "contents read");
		});
		const runner = createToolRunner(toolModels(complete), root);

		const result = await runner.run({
			taskId: "test-tool-loop",
			prompt: "Read note.txt",
			workspaceDir: root,
		});

		expect(result).toBe("contents read");
		expect(complete).toHaveBeenCalledTimes(2);
		const toolResults = observed[1]?.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read_file",
			isError: false,
		});
		expect(toolResults[0]?.content).toEqual([{ type: "text", text: "hello from the sandbox" }]);
		// The assistant message carrying the tool call stays in the history.
		expect(
			observed[1]?.messages.some(
				(message) =>
					message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
			),
		).toBe(true);
	});

	it("rejects read_file and write_to_file paths that escape the workspace sandbox", async () => {
		const root = createRoot();
		const observed: Context[] = [];
		const complete = vi.fn(async (_model: unknown, context: Context) => {
			observed.push(context);
			if (observed.length === 1) {
				return fakeAssistant(
					[
						{
							type: "toolCall",
							id: "call_esc_read",
							name: "read_file",
							arguments: { path: "../../outside.txt" },
						},
						{
							type: "toolCall",
							id: "call_esc_write",
							name: "write_to_file",
							arguments: { path: "../escape.txt", content: "nope" },
						},
					],
					"toolUse",
				);
			}
			return fakeAssistant([], "stop", "done");
		});
		const runner = createToolRunner(toolModels(complete), root);

		const result = await runner.run({
			taskId: "test-tool-escape",
			prompt: "Read and write outside the sandbox",
			workspaceDir: root,
		});

		expect(result).toBe("done");
		const toolResults = observed[1]?.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(2);
		expect(jsonError(toolResultText(toolResults ?? [], 0))).toContain("escapes workspace boundary");
		expect(jsonError(toolResultText(toolResults ?? [], 1))).toContain("escapes workspace boundary");
		// The escape attempt must not have created a file outside the sandbox.
		expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
	});

	it("writes inside the workspace and replaces an existing substring", async () => {
		const root = createRoot();
		writeFileSync(join(root, "draft.txt"), "the old text", "utf-8");
		const observed: Context[] = [];
		type FakeToolCall = {
			type: "toolCall";
			id: string;
			name: string;
			arguments: Record<string, unknown>;
		};
		const callBatches: FakeToolCall[][] = [
			[
				{
					type: "toolCall",
					id: "call_write",
					name: "write_to_file",
					arguments: { path: "sub/new.txt", content: "first draft" },
				},
			],
			[
				{
					type: "toolCall",
					id: "call_replace",
					name: "replace_in_file",
					arguments: { path: "draft.txt", old_str: "old", new_str: "new" },
				},
			],
		];
		const complete = vi.fn(async (_model: unknown, context: Context) => {
			observed.push(context);
			if (observed.length <= callBatches.length) {
				return fakeAssistant(callBatches[observed.length - 1] ?? [], "toolUse");
			}
			return fakeAssistant([], "stop", "all done");
		});
		const runner = createToolRunner(toolModels(complete), root);

		const result = await runner.run({
			taskId: "test-tool-write",
			prompt: "Write and replace files",
			workspaceDir: root,
		});

		expect(result).toBe("all done");
		expect(complete).toHaveBeenCalledTimes(3);
		expect(readFileSync(join(root, "sub", "new.txt"), "utf-8")).toBe("first draft");
		expect(readFileSync(join(root, "draft.txt"), "utf-8")).toBe("the new text");
		expect(observed[1]?.messages.some((m) => m.role === "toolResult" && m.isError)).toBe(false);
	});

	it("stops the loop after MAX_TOOL_ITERATIONS and returns accumulated text", async () => {
		const root = createRoot();
		const complete = vi.fn(async (_model: unknown) =>
			fakeAssistant(
				[
					{
						type: "toolCall",
						id: "call_loop",
						name: "read_file",
						arguments: { path: "missing.txt" },
					},
				],
				"toolUse",
			),
		);
		const runner = createToolRunner(toolModels(complete), root);

		const result = await runner.run({
			taskId: "test-tool-limit",
			prompt: "loop forever",
			workspaceDir: root,
		});

		expect(complete).toHaveBeenCalledTimes(20);
		expect(result).toBe("");
	});

	it("keeps the non-tools path on completeSimple without tools", async () => {
		const root = createRoot();
		const completeSimple = vi.fn(async () => fakeAssistant([], "stop", "plain text answer"));
		const adapter = new BearHarnessHostAdapter({
			dataDir: root,
			workspaceDir: root,
			userId: "test-user",
			companionId: "role-a",
			providers: {
				getModels: async () =>
					toolModels(
						async () => {
							throw new Error("complete must not be used for text-only runs");
						},
						{ completeSimple },
					),
			} as unknown as ProviderCatalog,
			models: fakeModelRegistry,
			logger,
		});
		const runner = adapter
			.getLLMRunnerFactory()
			.createRunner({ modelRef: `${fakeModel.provider}/${fakeModel.id}` });

		const result = await runner.run({
			taskId: "test-text-only",
			prompt: "Answer plainly",
		});

		expect(result).toBe("plain text answer");
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});
});

// ============================
// Local embedding warmup
// ============================

describe("TencentDbRuntime.prepareLocalEmbedding", () => {
	function prepareEmbeddingCore(runtime: TencentDbRuntime) {
		return (
			runtime as unknown as {
				core: { getEmbeddingService(): unknown };
			}
		).core as unknown as {
			getEmbeddingService():
				| {
						isReady(): boolean;
						startWarmup(): void;
						waitForReady?: () => Promise<void>;
				  }
				| undefined;
		};
	}

	it("waits for a configured local embedding service to become ready", async () => {
		const runtime = createRuntime(createRoot(), "role-a", {
			embedding: { provider: "local", enabled: true },
		});
		const warmupStarted = Promise.withResolvers<void>();
		const modelLoaded = Promise.withResolvers<void>();
		let ready = false;
		const service = {
			isReady: vi.fn(() => ready),
			startWarmup: vi.fn(() => warmupStarted.resolve()),
			waitForReady: vi.fn(async () => {
				await modelLoaded.promise;
				ready = true;
			}),
		};
		prepareEmbeddingCore(runtime).getEmbeddingService = () => service;

		const preparation = runtime.prepareLocalEmbedding(1_000);
		await warmupStarted.promise;
		let settled = false;
		void preparation.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		modelLoaded.resolve();
		await expect(preparation).resolves.toEqual({ ready: true });
		expect(service.startWarmup).toHaveBeenCalledOnce();
		expect(service.waitForReady).toHaveBeenCalledOnce();
	});

	it("preserves the embedding service receiver while waiting for readiness", async () => {
		const runtime = createRuntime(createRoot(), "role-a", {
			embedding: { provider: "local", enabled: true },
		});
		let ready = false;
		let receiver: unknown;
		const waitForReady = vi.fn(function (this: unknown) {
			receiver = this;
			ready = true;
			return Promise.resolve();
		});
		const service = {
			isReady: vi.fn(() => ready),
			startWarmup: vi.fn(),
			waitForReady,
		};
		prepareEmbeddingCore(runtime).getEmbeddingService = () => service;

		await expect(runtime.prepareLocalEmbedding(1_000)).resolves.toEqual({ ready: true });
		expect(receiver).toBe(service);
	});

	it("throws the structured unavailable reason when the local service is absent", async () => {
		const runtime = createRuntime(createRoot(), "role-a", {
			embedding: { provider: "local", enabled: true },
		});
		prepareEmbeddingCore(runtime).getEmbeddingService = () => undefined;

		await expect(runtime.prepareLocalEmbedding(0)).rejects.toEqual({
			kind: "unavailable",
			reason: "local_embedding_service_unavailable",
		});
	});

	it("throws the structured not-ready reason when model preparation times out", async () => {
		const runtime = createRuntime(createRoot(), "role-a", {
			embedding: { provider: "local", enabled: true },
		});
		const service = {
			isReady: vi.fn(() => false),
			startWarmup: vi.fn(),
			waitForReady: vi.fn(() => new Promise<void>(() => undefined)),
		};
		prepareEmbeddingCore(runtime).getEmbeddingService = () => service;

		await expect(runtime.prepareLocalEmbedding(0)).rejects.toEqual({
			kind: "unavailable",
			reason: "local_embedding_model_not_ready",
		});
		expect(service.startWarmup).toHaveBeenCalledOnce();
	});

	it("verifies a candidate before reconfiguring the active store", async () => {
		const runtime = createRuntime(createRoot(), "role-a");
		const events: string[] = [];
		const localService = {
			isReady: vi.fn(() => true),
			startWarmup: vi.fn(),
			waitForReady: vi.fn(async () => undefined),
		};
		const core = {
			reconfigureEmbedding: vi.fn(async () => {
				events.push("reconfigure");
			}),
			getEmbeddingService: vi.fn(() => localService),
			reindexAll: vi.fn(async () => {
				events.push("reindex");
				return { l1Count: 0, l0Count: 0, complete: true };
			}),
			destroy: vi.fn(async () => undefined),
		};
		const internals = runtime as unknown as {
			core: typeof core;
			started: boolean;
			embeddingServiceFactory: () => {
				isReady(): boolean;
				startWarmup(): void;
				waitForReady(): Promise<void>;
				embed(text: string): Promise<Float32Array>;
				embedBatch(): Promise<Float32Array[]>;
				getDimensions(): number;
				getProviderInfo(): { provider: string; model: string };
				close(): void;
			};
		};
		internals.core = core;
		internals.started = true;
		internals.embeddingServiceFactory = () => ({
			...localService,
			embed: vi.fn(async () => {
				events.push("probe");
				return new Float32Array(768);
			}),
			embedBatch: vi.fn(async () => []),
			getDimensions: () => 768,
			getProviderInfo: () => ({ provider: "local", model: "test" }),
			close: vi.fn(),
		});

		await expect(
			runtime.configureLocalEmbedding({
				modelPath: "hf:test/model.gguf",
				dimensions: 768,
				hfEndpoint: "https://huggingface.co",
			}),
		).resolves.toEqual({ ready: true });
		expect(core.reconfigureEmbedding).toHaveBeenCalledOnce();
		expect(core.getEmbeddingService).toHaveBeenCalledOnce();
		expect(core.reindexAll).toHaveBeenCalledOnce();
		expect(events).toEqual(["probe", "reconfigure", "reindex"]);
	});

	it("does not activate a candidate when cancellation arrives during validation", async () => {
		const runtime = createRuntime(createRoot(), "role-a");
		const abort = new AbortController();
		const core = { reconfigureEmbedding: vi.fn(), destroy: vi.fn() };
		const close = vi.fn();
		const internals = runtime as unknown as {
			core: typeof core;
			embeddingServiceFactory: () => EmbeddingService & { waitForReady(): Promise<void> };
		};
		internals.core = core;
		internals.embeddingServiceFactory = () => ({
			isReady: () => true,
			startWarmup: () => undefined,
			waitForReady: async () => undefined,
			embed: async () => {
				abort.abort();
				return new Float32Array(768);
			},
			embedBatch: async () => [],
			getDimensions: () => 768,
			getProviderInfo: () => ({ provider: "local", model: "test" }),
			close,
		});
		await expect(
			runtime.configureLocalEmbedding({
				modelPath: "hf:test/model.gguf",
				dimensions: 768,
				hfEndpoint: "https://huggingface.co",
				signal: abort.signal,
			}),
		).rejects.toMatchObject({ kind: "unavailable" });
		expect(core.reconfigureEmbedding).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it("rejects a custom model with the wrong dimensions before touching the active store", async () => {
		const runtime = createRuntime(createRoot(), "role-a");
		const core = {
			reconfigureEmbedding: vi.fn(async () => undefined),
			getEmbeddingService: vi.fn(),
			destroy: vi.fn(async () => undefined),
		};
		const internals = runtime as unknown as {
			core: typeof core;
			started: boolean;
			embeddingServiceFactory: () => EmbeddingService & { waitForReady(): Promise<void> };
		};
		internals.core = core;
		internals.started = true;
		internals.embeddingServiceFactory = () => ({
			isReady: () => true,
			startWarmup: () => undefined,
			waitForReady: async () => undefined,
			embed: async () => new Float32Array(512),
			embedBatch: async () => [],
			getDimensions: () => 768,
			getProviderInfo: () => ({ provider: "local", model: "wrong-dimensions" }),
			close: () => undefined,
		});

		await expect(
			runtime.configureLocalEmbedding({
				modelPath: "hf:test/wrong.gguf",
				dimensions: 768,
				hfEndpoint: "https://hf-mirror.com",
			}),
		).rejects.toMatchObject({
			kind: "unavailable",
			reason: expect.stringContaining("expected 768, received 512"),
		});
		expect(core.reconfigureEmbedding).not.toHaveBeenCalled();
	});
});
