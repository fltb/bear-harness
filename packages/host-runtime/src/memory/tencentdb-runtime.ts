/**
 * Runtime-owned TencentDB memory service.
 *
 * TdaiCore owns the vendored local store and its lifecycle. This service
 * presents the Host's direct memory facade on top of that store; no plugin,
 * OpenClaw, cloud VectorDB, or ambient home-directory state is involved.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TdaiCore } from "@bear-harness/tdai-core";
import type { Logger, MemoryTdaiConfig } from "@bear-harness/tdai-core";
import type {
	MemoryMetadata,
	MemoryProvenance,
} from "../memory/backend.js";
import type {
	TencentDbCoreHit,
	TencentDbCoreImportanceRequest,
	TencentDbCoreInvalidateRequest,
	TencentDbCoreMutationRequest,
	TencentDbCoreRecallRequest,
	TencentDbCoreRecord,
	TencentDbCoreRememberRequest,
	TencentDbCoreUpdateRequest,
	TencentDbMemoryCoreFacade,
} from "./tencentdb-backend.js";
import { TencentDbMemoryBackend } from "./tencentdb-backend.js";
import { CyberBearHostAdapter } from "./tencentdb-host-adapter.js";
import type { ModelRegistry } from "../models/registry.js";
import type { ProviderCatalog } from "../providers/catalog.js";
import type { IMemoryStore, L1RecordRow, MemoryRecord as TdaiMemoryRecord } from "@bear-harness/tdai-core";

type TdaiMetadata = TdaiMemoryRecord["metadata"];

type TdaiEpisodicMetadata = {
	activity_start_time?: string;
	activity_end_time?: string;
};

function toTdaiMetadata(value: MemoryMetadata | undefined): TdaiMetadata {
	const result: TdaiEpisodicMetadata = {};
	if (typeof value?.activity_start_time === "string") {
		result.activity_start_time = value.activity_start_time;
	}
	if (typeof value?.activity_end_time === "string") {
		result.activity_end_time = value.activity_end_time;
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asMetadata(value: unknown): MemoryMetadata {
	if (!isRecord(value)) return {};
	const result: Record<string, string> = {};
	for (const key of ["activity_start_time", "activity_end_time"]) {
		const item = value[key];
		if (typeof item === "string") result[key] = item;
	}
	return result;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function importedProvenance(recordId: string): MemoryProvenance {
	return {
		kind: "imported",
		piSessionEntryIds: [recordId],
	};
}

const DIRECT_MEMORY_SESSION_ID = "direct-memory";

function sourceSessionId(provenance: MemoryProvenance): string {
	return provenance.sourceRef ?? DIRECT_MEMORY_SESSION_ID;
}

export interface TencentDbRuntimeOptions {
	readonly dataDir: string;
	readonly providers: ProviderCatalog;
	readonly models: ModelRegistry;
	readonly companionId: string;
	readonly installationId: string;
	readonly userId: string;
	readonly logger?: Logger;
}

function clampImportance(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

function now(): string {
	return new Date().toISOString();
}

function coreRecord(
	request: TencentDbCoreRememberRequest,
	metadata: MemoryMetadata,
): TencentDbCoreRecord {
	const timestamp = now();
	return {
		id: randomUUID(),
		text: request.text,
		provenance: request.provenance,
		importance: clampImportance(request.importance ?? 0.5),
		status: "active",
		metadata,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function toStoreRecord(record: TencentDbCoreRecord, namespace: string): TdaiMemoryRecord {
	return {
		id: record.id,
		content: record.text,
		type: "persona",
		priority: Math.round(clampImportance(record.importance) * 100),
		scene_name: namespace,
		source_message_ids: [...record.provenance.piSessionEntryIds],
		metadata: toTdaiMetadata(record.metadata),
		timestamps: [record.createdAt, record.updatedAt],
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		sessionKey: namespace,
		sessionId: sourceSessionId(record.provenance),
	};
}

function coreFromRow(row: L1RecordRow): TencentDbCoreRecord {
	return {
		id: row.record_id,
		text: row.content,
		importance: clampImportance(row.priority / 100),
		provenance: importedProvenance(row.record_id),
		status: "active",
		metadata: asMetadata(parseJson(row.metadata_json)),
		createdAt: row.created_time,
		updatedAt: row.updated_time,
	};
}

class TdaiDirectMemoryFacade implements TencentDbMemoryCoreFacade {
	constructor(private readonly store: () => IMemoryStore | undefined) {}

	private requireStore(): IMemoryStore {
		const store = this.store();
		if (!store) throw new Error("TencentDB memory runtime is not started");
		return store;
	}

	private async find(namespace: string, memoryId: string): Promise<TencentDbCoreRecord> {
		const rows = await this.requireStore().queryL1Records({ sessionKey: namespace });
		const row = rows.find((candidate) => candidate.record_id === memoryId);
		if (!row) throw new Error(`TencentDB memory not found: ${memoryId}`);
		return coreFromRow(row);
	}

	async remember(request: TencentDbCoreRememberRequest): Promise<TencentDbCoreRecord> {
		const record = coreRecord(request, request.metadata ?? {});
		const ok = await this.requireStore().upsertL1(toStoreRecord(record, request.namespace));
		if (!ok) throw new Error("TencentDB memory write failed");
		return record;
	}

	async recall(request: TencentDbCoreRecallRequest): Promise<readonly TencentDbCoreHit[]> {
		const store = this.requireStore();
		const topK = Math.max(request.limit ?? 5, 50);
		const capabilities = store.getCapabilities();
		type NativeHit = {
			readonly record_id: string;
			readonly content: string;
			readonly type: string;
			readonly priority: number;
			readonly scene_name: string;
			readonly score: number;
			readonly timestamp_str: string;
			readonly timestamp_start: string;
			readonly timestamp_end: string;
			readonly session_key: string;
			readonly session_id: string;
			readonly metadata_json: string;
		};
		let nativeHits: NativeHit[] = [];
		try {
			if (capabilities.nativeHybridSearch && store.searchL1Hybrid) {
				nativeHits = await store.searchL1Hybrid({ query: request.query, topK });
			} else if (capabilities.ftsSearch && store.isFtsAvailable()) {
				nativeHits = await store.searchL1Fts(request.query, topK);
			}
		} catch {
			return [];
		}
		const rows = nativeHits
			.filter((hit) => hit.session_key === request.namespace)
			.map((hit) => ({
				row: {
					record_id: hit.record_id,
					content: hit.content,
					type: hit.type,
					priority: hit.priority,
					scene_name: hit.scene_name,
					session_key: hit.session_key,
					session_id: hit.session_id,
					timestamp_str: hit.timestamp_str,
					timestamp_start: hit.timestamp_start,
					timestamp_end: hit.timestamp_end,
					created_time: hit.timestamp_str,
					updated_time: hit.timestamp_str,
					metadata_json: hit.metadata_json,
				} satisfies L1RecordRow,
				score: hit.score,
			}));
		return rows
			.map(({ row, score }) => ({ record: coreFromRow(row), score }))
			.filter(({ record, score }) => record.status === "active" && score >= (request.minScore ?? 0))
			.slice(0, request.limit ?? 5);
	}

	async update(request: TencentDbCoreUpdateRequest): Promise<TencentDbCoreRecord> {
		const current = await this.find(request.namespace, request.memoryId);
		const updated: TencentDbCoreRecord = {
			...current,
			text: request.text ?? current.text,
			importance: request.importance === undefined ? current.importance : clampImportance(request.importance),
			metadata: request.metadata ?? current.metadata,
			updatedAt: now(),
		};
		if (!(await this.requireStore().upsertL1(toStoreRecord(updated, request.namespace)))) {
			throw new Error("TencentDB memory update failed");
		}
		return updated;
	}

	async forget(request: TencentDbCoreMutationRequest): Promise<void> {
		await this.find(request.namespace, request.memoryId);
		if (!(await this.requireStore().deleteL1(request.memoryId))) throw new Error("TencentDB memory delete failed");
	}

	async invalidate(request: TencentDbCoreInvalidateRequest): Promise<TencentDbCoreRecord> {
		const current = await this.find(request.namespace, request.memoryId);
		const invalidatedAt = now();
		const updated: TencentDbCoreRecord = {
			...current,
			status: "invalidated",
			updatedAt: invalidatedAt,
			invalidatedAt,
			metadata: current.metadata,
		};
		if (!(await this.requireStore().upsertL1(toStoreRecord(updated, request.namespace)))) {
			throw new Error("TencentDB memory invalidation failed");
		}
		return updated;
	}

	async setImportance(request: TencentDbCoreImportanceRequest): Promise<TencentDbCoreRecord> {
		return this.update(request);
	}
}

export class TencentDbRuntime {
	readonly backend: TencentDbMemoryBackend;
	private readonly core: TdaiCore;
	private started = false;
	private closed = false;

	constructor(options: TencentDbRuntimeOptions) {
		const dataDir = join(options.dataDir, "memory");
		const adapter = new CyberBearHostAdapter({
			dataDir,
			workspaceDir: dataDir,
			userId: options.userId,
			companionId: options.companionId,
			providers: options.providers,
			models: options.models,
			logger: options.logger,
		});
		const config: MemoryTdaiConfig = {
			capture: {
				enabled: false,
				excludeAgents: [],
				l0l1RetentionDays: 0,
				allowAggressiveCleanup: false,
			},
			extraction: { enabled: false, enableDedup: false, maxMemoriesPerSession: 0 },
			persona: { triggerEveryN: 0, maxScenes: 0, backupCount: 0, sceneBackupCount: 0 },
			pipeline: {
				everyNConversations: 0,
				enableWarmup: false,
				l1IdleTimeoutSeconds: 0,
				l2DelayAfterL1Seconds: 0,
				l2MinIntervalSeconds: 0,
				l2MaxIntervalSeconds: 0,
				sessionActiveWindowHours: 0,
			},
			recall: {
				enabled: false,
				maxResults: 0,
				maxCharsPerMemory: 0,
				maxTotalRecallChars: 0,
				scoreThreshold: 0,
				strategy: "keyword",
				timeoutMs: 0,
			},
			embedding: {
				enabled: false,
				provider: "none",
				baseUrl: "",
				apiKey: "",
				model: "",
				dimensions: 0,
				sendDimensions: false,
				conflictRecallTopK: 0,
				maxInputChars: 0,
				timeoutMs: 0,
			},
			storeBackend: "sqlite",
			tcvdb: {
				url: "",
				username: "root",
				apiKey: "",
				database: "",
				alias: "",
				embeddingModel: "",
				timeout: 0,
			},
			bm25: { enabled: false, language: "en" },
			memoryCleanup: { enabled: false, cleanTime: "03:00" },
			report: { enabled: false, type: "local" },
			llm: {
				enabled: false,
				baseUrl: "",
				apiKey: "",
				model: "",
				maxTokens: 0,
				timeoutMs: 0,
			},
			offload: {
				enabled: false,
				mode: "collect",
				temperature: 0,
				forceTriggerThreshold: 0,
				defaultContextWindow: 0,
				maxPairsPerBatch: 0,
				l2NullThreshold: 0,
				l2TimeoutSeconds: 0,
				mildOffloadRatio: 0,
				aggressiveCompressRatio: 0,
				mmdMaxTokenRatio: 0,
				backendTimeoutMs: 0,
				offloadRetentionDays: 0,
				logMaxSizeMb: 0,
			},
		};
		this.core = new TdaiCore({
			hostAdapter: adapter,
			config,
			instanceId: `${options.installationId}:${options.userId}:${options.companionId}`,
		});
		const facade = new TdaiDirectMemoryFacade(() => this.core.getVectorStore());
		this.backend = new TencentDbMemoryBackend(facade);
	}

	async start(): Promise<void> {
		if (this.closed) throw new Error("TencentDB memory runtime is closed");
		if (this.started) return;
		await this.core.initialize();
		// TdaiCore starts store initialization asynchronously; this call is the
		// documented readiness gate used by its public operations.
		await this.core.handleBeforeRecall("", "memory-runtime");
		this.started = true;
	}

	async close(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("TencentDB memory runtime close aborted");
		if (this.closed) return;
		this.closed = true;
		await this.backend.close(signal);
		await this.core.destroy();
	}
}
