/**
 * Runtime-owned TencentDB memory service.
 *
 * TdaiCore owns the vendored local store and its lifecycle. This service
 * presents the Host's direct memory facade on top of that store; no plugin,
 * OpenClaw, cloud VectorDB, or ambient home-directory state is involved.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	CompletedTurn,
	EmbeddingService,
	IMemoryStore,
	L1RecordRow,
	Logger,
	MemoryTdaiConfig,
	MemoryRecord as TdaiMemoryRecord,
} from "@bear-harness/tdai-core";
import { buildFtsQuery, createEmbeddingService, TdaiCore } from "@bear-harness/tdai-core";
import type { MemoryMetadata, MemoryProvenance } from "../memory/backend.js";
import type { ModelRegistry } from "../models/registry.js";
import type { ProviderCatalog } from "../providers/catalog.js";
import type {
	TencentDbCoreHit,
	TencentDbCoreImportanceRequest,
	TencentDbCoreInvalidateRequest,
	TencentDbCoreListRequest,
	TencentDbCoreMutationRequest,
	TencentDbCoreNamespaceMigrationRequest,
	TencentDbCoreRecallRequest,
	TencentDbCoreRecord,
	TencentDbCoreRememberRequest,
	TencentDbCoreUpdateRequest,
	TencentDbMemoryCoreFacade,
} from "./tencentdb-backend.js";
import { TencentDbMemoryBackend } from "./tencentdb-backend.js";
import { BearHarnessHostAdapter } from "./tencentdb-host-adapter.js";

type TdaiMetadata = TdaiMemoryRecord["metadata"];

/**
 * Bound applied to a single serialized metadata value before it is stored in
 * Tdai.  Host metadata is deliberately small (scope labels, activity stamps);
 * this keeps one pathological value from ballooning the JSONL/SQLite payload
 * without introducing any schema split between allowed and disallowed keys.
 */
const MAX_METADATA_VALUE_BYTES = 512;

type TdaiEpisodicMetadata = {
	activity_start_time?: string;
	activity_end_time?: string;
} & Record<string, string | number | boolean | null>;

function isMetadataValue(value: unknown): value is string | number | boolean | null {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	return typeof value === "number" && Number.isFinite(value);
}

function toTdaiMetadata(value: MemoryMetadata | undefined): TdaiMetadata {
	const result: TdaiEpisodicMetadata = {};
	if (!value) return result;
	for (const key of Object.keys(value)) {
		const item = value[key];
		if (!isMetadataValue(item)) continue;
		if (typeof item === "string" && Buffer.byteLength(item, "utf8") > MAX_METADATA_VALUE_BYTES) {
			continue;
		}
		result[key] = item;
	}
	return result;
}

function asMetadata(value: unknown): MemoryMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, string | number | boolean | null> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!isMetadataValue(item)) continue;
		if (typeof item === "string" && Buffer.byteLength(item, "utf8") > MAX_METADATA_VALUE_BYTES) {
			continue;
		}
		result[key] = item;
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
const HOST_CONTEXT_PREFIX = "<host_context>\n";
const HOST_CONTEXT_SEPARATOR = "\n</host_context>\n\n<current_user_message>\n";
const CURRENT_USER_MESSAGE_SUFFIX = "\n</current_user_message>";

function unwrapHostFraming(text: string): string {
	if (!text.startsWith(HOST_CONTEXT_PREFIX) || !text.endsWith(CURRENT_USER_MESSAGE_SUFFIX)) {
		return text;
	}
	const separatorIndex = text.indexOf(HOST_CONTEXT_SEPARATOR, HOST_CONTEXT_PREFIX.length);
	if (separatorIndex <= HOST_CONTEXT_PREFIX.length) return text;
	return text.slice(
		separatorIndex + HOST_CONTEXT_SEPARATOR.length,
		-CURRENT_USER_MESSAGE_SUFFIX.length,
	);
}

const DIRECT_MEMORY_SESSION_ID = "direct-memory";

function sourceSessionId(provenance: MemoryProvenance): string {
	return provenance.sourceRef ?? DIRECT_MEMORY_SESSION_ID;
}

export interface TencentDbRuntimeOptions {
	readonly onRecordsChanged?: () => void;
	readonly dataDir: string;
	readonly providers: ProviderCatalog;
	readonly models: ModelRegistry;
	readonly companionId: string;
	readonly installationId: string;
	/** Installation identifier used by the pre-v1 namespace, when it differs from the UUID. */
	readonly legacyInstallationId?: string;
	readonly userId: string;
	readonly logger?: Logger;
	/**
	 * Partial TdaiCore configuration overrides applied on top of the default
	 * full-power configuration (auto capture/extraction/persona/recall/offload
	 * enabled). Product settings inject embedding provider details here.
	 */
	readonly memoryConfig?: DeepPartial<MemoryTdaiConfig>;
}

/** Recursive partial: every nested object's fields become optional. */
export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Merge a partial config onto defaults. Arrays and scalars are replaced, objects merged. */
function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
	if (patch === undefined) return base;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		const current = result[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			current !== null &&
			typeof current === "object" &&
			!Array.isArray(current)
		) {
			result[key] = deepMerge(current, value as DeepPartial<typeof current>);
		} else {
			result[key] = value;
		}
	}
	return result as T;
}

/**
 * Default full-power TdaiCore configuration. Background capabilities are
 * enabled: L0 capture, L1 LLM extraction with dedup, L2 scene, L3 persona,
 * auto-recall, BM25 (zh), daily cleanup, and context offload. Metric reporting
 * is privacy-safe and disabled unless explicitly enabled in `memoryConfig`.
 * Embedding is armed but provider-less by default ("none"), which TdaiCore
 * treats as disabled — hybrid recall degrades to FTS+BM25 until a provider
 * is configured through `memoryConfig`.
 */
const DEFAULT_MEMORY_CONFIG: MemoryTdaiConfig = {
	capture: {
		enabled: true,
		excludeAgents: [],
		l0l1RetentionDays: 30,
		allowAggressiveCleanup: false,
	},
	extraction: { enabled: true, enableDedup: true, maxMemoriesPerSession: 20 },
	persona: { triggerEveryN: 50, maxScenes: 20, backupCount: 3, sceneBackupCount: 10 },
	pipeline: {
		everyNConversations: 5,
		enableWarmup: true,
		l1IdleTimeoutSeconds: 600,
		l2DelayAfterL1Seconds: 10,
		l2MinIntervalSeconds: 900,
		l2MaxIntervalSeconds: 3600,
		sessionActiveWindowHours: 24,
	},
	recall: {
		enabled: true,
		maxResults: 5,
		maxCharsPerMemory: 0,
		maxTotalRecallChars: 0,
		scoreThreshold: 0.3,
		strategy: "hybrid",
		timeoutMs: 5000,
	},
	embedding: {
		enabled: true,
		provider: "none",
		baseUrl: "",
		apiKey: "",
		model: "",
		dimensions: 0,
		sendDimensions: true,
		conflictRecallTopK: 5,
		maxInputChars: 5000,
		timeoutMs: 10000,
		recallTimeoutMs: 2000,
		captureTimeoutMs: 20000,
	},
	storeBackend: "sqlite",
	tcvdb: {
		url: "",
		username: "root",
		apiKey: "",
		database: "",
		alias: "",
		embeddingModel: "",
		embeddingDimensions: 1024,
		timeout: 0,
	},
	bm25: { enabled: true, language: "zh" },
	memoryCleanup: { enabled: true, cleanTime: "03:00" },
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
		enabled: true,
		mode: "local",
		temperature: 0.2,
		forceTriggerThreshold: 4,
		defaultContextWindow: 200000,
		maxPairsPerBatch: 20,
		l2NullThreshold: 4,
		l2TimeoutSeconds: 300,
		mildOffloadRatio: 0.5,
		aggressiveCompressRatio: 0.85,
		mmdMaxTokenRatio: 0.2,
		backendTimeoutMs: 10000,
		offloadRetentionDays: 30,
		logMaxSizeMb: 50,
	},
};

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
		text: unwrapHostFraming(request.text),
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

type NamespaceMigrationState = "copying" | "verified" | "complete";

interface NamespaceMigrationJournal {
	readonly version: 1;
	readonly legacyNamespace: string;
	readonly canonicalNamespace: string;
	readonly records: readonly L1RecordRow[];
	readonly state: NamespaceMigrationState;
}

function recoveryRequired(message: string, cause?: unknown): Error {
	const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
		readonly code: "recovery_required";
		readonly retryable: false;
	};
	Object.defineProperties(error, {
		code: { value: "recovery_required", enumerable: true },
		retryable: { value: false, enumerable: true },
	});
	return error;
}

function migrationKey(legacyNamespace: string, canonicalNamespace: string): string {
	return createHash("sha256")
		.update(legacyNamespace)
		.update("\0")
		.update(canonicalNamespace)
		.digest("hex");
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, canonicalJson(item)]),
	);
}

function comparableRow(row: L1RecordRow): Record<string, unknown> {
	return {
		record_id: row.record_id,
		content: row.content,
		type: row.type,
		priority: row.priority,
		session_id: row.session_id,
		timestamp_str: row.timestamp_str,
		timestamp_start: row.timestamp_start,
		timestamp_end: row.timestamp_end,
		created_time: row.created_time,
		updated_time: row.updated_time,
		metadata: canonicalJson(parseJson(row.metadata_json)),
	};
}

function rowsMatch(left: L1RecordRow, right: L1RecordRow): boolean {
	return JSON.stringify(comparableRow(left)) === JSON.stringify(comparableRow(right));
}

function migratedStoreRecord(row: L1RecordRow, canonicalNamespace: string): TdaiMemoryRecord {
	const metadata = parseJson(row.metadata_json);
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw recoveryRequired(
			`TencentDB namespace migration cannot preserve metadata for memory ${row.record_id}`,
		);
	}
	return {
		id: row.record_id,
		content: row.content,
		type: row.type as TdaiMemoryRecord["type"],
		priority: row.priority,
		scene_name: canonicalNamespace,
		source_message_ids: [],
		metadata: metadata as TdaiMetadata,
		timestamps: [row.timestamp_str, row.timestamp_start, row.timestamp_end],
		createdAt: row.created_time,
		updatedAt: row.updated_time,
		sessionKey: canonicalNamespace,
		sessionId: row.session_id,
	};
}

function isL1RecordRow(value: unknown): value is L1RecordRow {
	if (!value || typeof value !== "object") return false;
	const row = value as Partial<L1RecordRow>;
	return (
		typeof row.record_id === "string" &&
		typeof row.content === "string" &&
		typeof row.type === "string" &&
		typeof row.priority === "number" &&
		Number.isFinite(row.priority) &&
		typeof row.scene_name === "string" &&
		typeof row.session_key === "string" &&
		typeof row.session_id === "string" &&
		typeof row.timestamp_str === "string" &&
		typeof row.timestamp_start === "string" &&
		typeof row.timestamp_end === "string" &&
		typeof row.created_time === "string" &&
		typeof row.updated_time === "string" &&
		typeof row.metadata_json === "string"
	);
}

function isMigrationJournal(value: unknown): value is NamespaceMigrationJournal {
	if (!value || typeof value !== "object") return false;
	const journal = value as Partial<NamespaceMigrationJournal>;
	return (
		journal.version === 1 &&
		typeof journal.legacyNamespace === "string" &&
		typeof journal.canonicalNamespace === "string" &&
		Array.isArray(journal.records) &&
		journal.records.every(isL1RecordRow) &&
		(journal.state === "copying" || journal.state === "verified" || journal.state === "complete")
	);
}

function abortMigrationIfRequested(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("TencentDB memory operation aborted");
}

class TdaiDirectMemoryFacade implements TencentDbMemoryCoreFacade {
	private readonly migrations = new Map<string, Promise<void>>();

	constructor(
		private readonly store: () => IMemoryStore | undefined,
		private readonly migrationJournalDir: string,
	) {}

	private requireStore(): IMemoryStore {
		const store = this.store();
		if (!store) throw new Error("TencentDB memory runtime is not started");
		return store;
	}

	async migrateNamespace(request: TencentDbCoreNamespaceMigrationRequest): Promise<void> {
		abortMigrationIfRequested(request.signal);
		if (request.legacyNamespace === request.canonicalNamespace) return;
		const key = migrationKey(request.legacyNamespace, request.canonicalNamespace);
		const existing = this.migrations.get(key);
		if (existing) return existing;
		const migration = this.runNamespaceMigration(request, key).finally(() => {
			this.migrations.delete(key);
		});
		this.migrations.set(key, migration);
		return migration;
	}

	private async runNamespaceMigration(
		request: TencentDbCoreNamespaceMigrationRequest,
		key: string,
	): Promise<void> {
		const store = this.requireStore();
		const journalPath = join(this.migrationJournalDir, `${key}.json`);
		let journal = await this.readMigrationJournal(journalPath);
		if (journal) {
			if (
				journal.legacyNamespace !== request.legacyNamespace ||
				journal.canonicalNamespace !== request.canonicalNamespace
			) {
				throw recoveryRequired(
					`TencentDB namespace migration journal identity mismatch at ${journalPath}`,
				);
			}
			if (journal.state === "complete") return;
		} else {
			abortMigrationIfRequested(request.signal);
			const [legacyRows, canonicalRows] = await Promise.all([
				store.queryL1Records({ sessionKey: request.legacyNamespace }),
				store.queryL1Records({ sessionKey: request.canonicalNamespace }),
			]);
			const canonicalById = new Map(canonicalRows.map((row) => [row.record_id, row]));
			for (const legacyRow of legacyRows) {
				const canonicalRow = canonicalById.get(legacyRow.record_id);
				if (canonicalRow && !rowsMatch(legacyRow, canonicalRow)) {
					throw recoveryRequired(
						`TencentDB namespace migration conflict for memory ${legacyRow.record_id}`,
					);
				}
			}
			journal = {
				version: 1,
				legacyNamespace: request.legacyNamespace,
				canonicalNamespace: request.canonicalNamespace,
				records: legacyRows,
				state: "copying",
			};
			await this.writeMigrationJournal(journalPath, journal);
		}

		abortMigrationIfRequested(request.signal);
		const canonicalRows = await store.queryL1Records({
			sessionKey: request.canonicalNamespace,
		});
		const canonicalById = new Map(canonicalRows.map((row) => [row.record_id, row]));
		for (const sourceRow of journal.records) {
			abortMigrationIfRequested(request.signal);
			const existing = canonicalById.get(sourceRow.record_id);
			if (existing) {
				if (!rowsMatch(sourceRow, existing)) {
					throw recoveryRequired(
						`TencentDB namespace migration conflict for memory ${sourceRow.record_id}`,
					);
				}
				continue;
			}

			/*
			 * SQLite's record_id is the primary key, but its generic upsert deliberately
			 * leaves session_key, session_id, and created_time unchanged on conflict.
			 * A namespace move therefore has to remove the legacy row before inserting
			 * the canonical projection. The journal is already durable at this point,
			 * so a crash between these operations is recoverable on the next attempt.
			 */
			const rowsWithId = (await store.queryL1Records()).filter(
				(row) => row.record_id === sourceRow.record_id,
			);
			if (rowsWithId.length > 1) {
				throw recoveryRequired(
					`TencentDB namespace migration conflict for memory ${sourceRow.record_id}`,
				);
			}
			const current = rowsWithId[0];
			if (current) {
				if (current.session_key !== request.legacyNamespace || !rowsMatch(sourceRow, current)) {
					throw recoveryRequired(
						`TencentDB namespace migration conflict for memory ${sourceRow.record_id}`,
					);
				}
				if (!(await store.deleteL1(sourceRow.record_id))) {
					throw recoveryRequired(
						`TencentDB namespace migration copy failed for memory ${sourceRow.record_id}`,
					);
				}
			}

			abortMigrationIfRequested(request.signal);
			if (!(await store.upsertL1(migratedStoreRecord(sourceRow, request.canonicalNamespace)))) {
				throw recoveryRequired(
					`TencentDB namespace migration copy failed for memory ${sourceRow.record_id}`,
				);
			}
			const copiedRows = await store.queryL1Records({
				sessionKey: request.canonicalNamespace,
			});
			const copied = copiedRows.find((row) => row.record_id === sourceRow.record_id);
			if (!copied || !rowsMatch(sourceRow, copied)) {
				throw recoveryRequired(
					`TencentDB namespace migration verification failed for memory ${sourceRow.record_id}`,
				);
			}
			canonicalById.set(copied.record_id, copied);
		}

		journal = { ...journal, state: "verified" };
		await this.writeMigrationJournal(journalPath, journal);
		const remainingLegacy = await store.queryL1Records({ sessionKey: request.legacyNamespace });
		if (remainingLegacy.length > 0) {
			throw recoveryRequired(
				"TencentDB namespace migration requires a namespace-safe legacy delete",
			);
		}
		journal = { ...journal, state: "complete" };
		await this.writeMigrationJournal(journalPath, journal);
	}

	private async readMigrationJournal(path: string): Promise<NamespaceMigrationJournal | undefined> {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!isMigrationJournal(parsed)) {
				throw recoveryRequired(`TencentDB namespace migration journal is invalid at ${path}`);
			}
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if ((error as { code?: unknown }).code === "recovery_required") throw error;
			throw recoveryRequired(
				`TencentDB namespace migration journal cannot be read at ${path}`,
				error,
			);
		}
	}

	private async writeMigrationJournal(
		path: string,
		journal: NamespaceMigrationJournal,
	): Promise<void> {
		try {
			await mkdir(this.migrationJournalDir, { recursive: true });
			const temporaryPath = `${path}.${randomUUID()}.tmp`;
			await writeFile(temporaryPath, `${JSON.stringify(journal)}\n`, {
				encoding: "utf8",
				flag: "wx",
			});
			await rename(temporaryPath, path);
		} catch (error) {
			throw recoveryRequired(
				`TencentDB namespace migration journal cannot be written at ${path}`,
				error,
			);
		}
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
		if (capabilities.nativeHybridSearch && store.searchL1Hybrid) {
			// Native search is global, while the Host bank is namespace-scoped.
			// Expand the candidate window to include every persisted record before
			// applying the namespace filter; a fixed top-K can hide a newly
			// captured record behind older records from other banks.
			try {
				const totalRecords = await store.countL1();
				const topK = Math.max(request.limit ?? 5, 50, totalRecords);
				nativeHits = await store.searchL1Hybrid({ query: request.query, topK });
			} catch {
				// A native provider can be temporarily unavailable.  The local FTS
				// index remains a valid recall path when it is available.
				nativeHits = [];
			}
		}
		// Native hybrid search may return only records from another Host bank
		// (or no records at all).  Do not let that global result suppress the
		// namespace-scoped FTS path for the active role.
		if (
			capabilities.ftsSearch &&
			store.isFtsAvailable() &&
			(nativeHits.length === 0 || !nativeHits.some((hit) => hit.session_key === request.namespace))
		) {
			try {
				const ftsQuery = buildFtsQuery(request.query);
				if (ftsQuery) {
					const totalRecords = await store.countL1();
					const topK = Math.max(request.limit ?? 5, 50, totalRecords);
					nativeHits = await store.searchL1Fts(ftsQuery, topK);
				}
			} catch {
				nativeHits = [];
			}
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
	async list(request: TencentDbCoreListRequest): Promise<readonly TencentDbCoreRecord[]> {
		const rows = await this.requireStore().queryL1Records({ sessionKey: request.namespace });
		const records = rows.map((row) => coreFromRow(row));
		return request.limit === undefined ? records : records.slice(0, request.limit);
	}

	async update(request: TencentDbCoreUpdateRequest): Promise<TencentDbCoreRecord> {
		const current = await this.find(request.namespace, request.memoryId);
		const updated: TencentDbCoreRecord = {
			...current,
			text: request.text ?? current.text,
			importance:
				request.importance === undefined ? current.importance : clampImportance(request.importance),
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
		if (!(await this.requireStore().deleteL1(request.memoryId)))
			throw new Error("TencentDB memory delete failed");
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
	private core: TdaiCore;
	private config: MemoryTdaiConfig;
	private readonly createCore: (config: MemoryTdaiConfig) => TdaiCore;
	private embeddingServiceFactory = createEmbeddingService;
	private readonly logger?: Logger;
	private started = false;
	private closed = false;

	constructor(options: TencentDbRuntimeOptions) {
		const dataDir = join(options.dataDir, "memory");
		const adapter = new BearHarnessHostAdapter({
			dataDir,
			workspaceDir: dataDir,
			userId: options.userId,
			companionId: options.companionId,
			providers: options.providers,
			models: options.models,
			logger: options.logger,
		});
		this.createCore = (config) => {
			const core = new TdaiCore({
				onRecordsChanged: () => {
					if (!this.closed && this.core === core) options.onRecordsChanged?.();
				},
				hostAdapter: adapter,
				config,
				instanceId: `${options.installationId}:${options.userId}:${options.companionId}`,
			});
			return core;
		};
		this.config = deepMerge(DEFAULT_MEMORY_CONFIG, options.memoryConfig);
		this.logger = options.logger;
		this.core = this.createCore(this.config);
		const facade = new TdaiDirectMemoryFacade(
			() => this.core.getVectorStore(),
			join(dataDir, "namespace-migrations"),
		);
		this.backend = new TencentDbMemoryBackend(facade, {
			legacyInstallationId: options.legacyInstallationId,
		});
	}

	/**
	 * Feed one settled conversation turn into the TdaiCore capture pipeline
	 * (L0 record → L1 extraction scheduling). The caller is responsible for
	 * error handling; this is a side channel and never throws into the turn
	 * settlement path.
	 */
	async captureTurn(turn: CompletedTurn): Promise<void> {
		await this.core.handleTurnCommitted(turn);
	}

	/**
	 * Stable recall context (persona + scene navigation) for one turn, or
	 * undefined when TdaiCore produced none.
	 */
	async systemContext(query: string, sessionKey: string): Promise<string | undefined> {
		const result = await this.core.handleBeforeRecall(query, sessionKey);
		return result.appendSystemContext;
	}

	/** Shared, Host-owned embedding provider for non-memory semantic indexes. */
	getEmbeddingService(): EmbeddingService | undefined {
		if (!this.started || this.closed) return undefined;
		return this.core.getEmbeddingService();
	}

	async start(): Promise<void> {
		if (this.closed) throw new Error("TencentDB memory runtime is closed");
		if (this.started) return;
		await this.core.initialize();
		await this.core.waitForStoresReady();
		// TdaiCore starts store initialization asynchronously; this call is the
		// documented readiness gate used by its public operations.
		await this.core.handleBeforeRecall("", "memory-runtime");
		this.started = true;
	}

	/**
	 * Prepare the configured local embedding service and wait for the selected
	 * model to finish downloading and loading as an explicit Host-owned boundary.
	 */
	async prepareLocalEmbedding(timeoutMs = 120_000): Promise<{ ready: true }> {
		if (this.closed) throw { kind: "unavailable", reason: "memory_runtime_closed" };
		const embedding = this.config.embedding;
		if (embedding.provider !== "local" || embedding.enabled === false) {
			throw { kind: "conflict", reason: "local_embedding_not_configured" };
		}
		try {
			await this.start();
		} catch {
			throw { kind: "unavailable", reason: "local_embedding_runtime_start_failed" };
		}
		const service = this.core.getEmbeddingService();
		if (!service) throw { kind: "unavailable", reason: "local_embedding_service_unavailable" };
		if (!service.isReady()) {
			service.startWarmup();
			const readinessService = service as EmbeddingService & {
				waitForReady?: () => Promise<void>;
			};
			if (!readinessService.waitForReady) {
				throw { kind: "unavailable", reason: "local_embedding_readiness_unavailable" };
			}
			const timeout = Promise.withResolvers<void>();
			const timer = setTimeout(timeout.resolve, timeoutMs);
			try {
				await Promise.race([readinessService.waitForReady(), timeout.promise]);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw {
					kind: "unavailable",
					reason: `local_embedding_model_prepare_failed: ${detail.slice(0, 500)}`,
				};
			} finally {
				clearTimeout(timer);
			}
		}
		if (!service.isReady()) {
			throw { kind: "unavailable", reason: "local_embedding_model_not_ready" };
		}
		return { ready: true };
	}
	/** Prepare and verify a candidate before replacing the active store configuration. */
	async configureLocalEmbedding(options: {
		modelPath: string;
		dimensions: number;
		hfEndpoint: string;
		signal?: AbortSignal;
		onProgress?: (progress: { downloadedSize: number; totalSize: number }) => void;
		onPhase?: (phase: "validating" | "activating") => void;
		timeoutMs?: number;
	}): Promise<{ ready: true }> {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error("local embedding preparation timed out")),
			options.timeoutMs ?? 30 * 60_000,
		);
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal;
		const candidate = this.embeddingServiceFactory(
			{
				provider: "local",
				modelPath: options.modelPath,
				dimensions: options.dimensions,
				hfEndpoint: options.hfEndpoint,
				signal,
				onDownloadProgress: options.onProgress,
				onDownloadComplete: () => options.onPhase?.("validating"),
			},
			this.logger,
		);
		try {
			signal.throwIfAborted();
			candidate.startWarmup();
			const readiness = candidate as EmbeddingService & { waitForReady?: () => Promise<void> };
			if (!readiness.waitForReady)
				throw { kind: "unavailable", reason: "local_embedding_readiness_unavailable" };
			await readiness.waitForReady();
			signal.throwIfAborted();
			const probe = await candidate.embed("semantic memory readiness probe");
			signal.throwIfAborted();
			if (probe.length !== options.dimensions) {
				throw new Error(
					`local embedding dimension mismatch: expected ${options.dimensions}, received ${probe.length}`,
				);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw {
				kind: "unavailable",
				reason: `local_embedding_model_prepare_failed: ${detail.slice(0, 500)}`,
			};
		} finally {
			clearTimeout(timer);
			await candidate.close?.();
		}
		signal.throwIfAborted();
		options.onPhase?.("activating");
		return this.replaceEmbeddingConfig({
			enabled: true,
			provider: "local",
			dimensions: options.dimensions,
			modelPath: options.modelPath,
			hfEndpoint: options.hfEndpoint,
		});
	}

	/** Probe a remote endpoint before replacing the active embedding configuration. */
	async configureRemoteEmbedding(options: {
		baseUrl: string;
		apiKey: string;
		model: string;
		dimensions: number;
		timeoutMs?: number;
	}): Promise<{ ready: true }> {
		const candidate = this.embeddingServiceFactory(
			{
				provider: "remote",
				baseUrl: options.baseUrl,
				apiKey: options.apiKey,
				model: options.model,
				dimensions: options.dimensions,
				timeoutMs: options.timeoutMs ?? 10_000,
			},
			this.logger,
		);
		try {
			const probe = await candidate.embed("semantic memory readiness probe", {
				timeoutMs: options.timeoutMs ?? 10_000,
			});
			if (probe.length !== options.dimensions) {
				throw new Error("dimension mismatch");
			}
		} catch {
			throw { kind: "unavailable", reason: "remote_embedding_validation_failed" };
		} finally {
			await candidate.close?.();
		}
		return this.replaceEmbeddingConfig({
			enabled: true,
			provider: "remote",
			baseUrl: options.baseUrl,
			apiKey: options.apiKey,
			model: options.model,
			dimensions: options.dimensions,
		});
	}

	/** Disable local embeddings without replacing an already provider-less core. */
	async disableLocalEmbedding(): Promise<void> {
		if (this.config.embedding.provider === "none" && this.config.embedding.modelPath === undefined)
			return;
		await this.replaceEmbeddingConfig({ enabled: true, provider: "none", modelPath: undefined });
	}

	private async replaceEmbeddingConfig(
		embedding: Pick<MemoryTdaiConfig["embedding"], "enabled" | "provider"> & {
			dimensions?: number;
			modelPath?: string;
			hfEndpoint?: string;
			baseUrl?: string;
			apiKey?: string;
			model?: string;
		},
	): Promise<{ ready: true }> {
		if (this.closed) throw { kind: "unavailable", reason: "memory_runtime_closed" };
		const previousConfig = this.config;
		const nextConfig = deepMerge(this.config, { embedding });
		try {
			await this.core.reconfigureEmbedding(nextConfig.embedding);
			this.config = nextConfig;
			if (embedding.provider === "local") await this.prepareLocalEmbedding();
			return { ready: true };
		} catch (error) {
			await this.core.reconfigureEmbedding(previousConfig.embedding).catch(() => undefined);
			this.config = previousConfig;
			throw error;
		}
	}

	async close(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("TencentDB memory runtime close aborted");
		if (this.closed) return;
		this.closed = true;
		await this.backend.close(signal);
		await this.core.destroy();
	}
}
