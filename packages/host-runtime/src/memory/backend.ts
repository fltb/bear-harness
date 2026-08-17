/**
 * Host-facing contract for a pluggable long-term memory provider.
 *
 * The Host owns the bank identity and policy. A provider only stores and
 * retrieves durable memory records in the bank it is opened for; it does not
 * own sessions, conversations, or product workflow state. Every record keeps
 * the Pi session entry IDs that gave it its provenance.
 */

/** Opaque identity returned by the memory provider. */
export type MemoryId = string;

/**
 * The private bank in which a companion's durable memories live.
 *
 * All three components are required so a provider cannot accidentally merge
 * records belonging to different installations, users, or companions.
 */
export interface MemoryBankScope {
	readonly installationId: string;
	readonly userId: string;
	readonly companionId: string;
}

/** How a durable memory entered the bank. */
export type MemoryProvenanceKind = "explicit" | "inferred" | "imported";

/**
 * Source information is intentionally part of the durable record, rather than
 * an implementation detail of a particular provider. The non-empty tuple
 * keeps a link to at least one Pi session entry on every memory.
 */
export interface MemoryProvenance {
	readonly kind: MemoryProvenanceKind;
	readonly piSessionEntryIds: readonly [string, ...string[]];
	readonly sourceRef?: string;
	readonly sourceHash?: string;
}

/** JSON-like values allowed in provider-neutral memory metadata. */
export type MemoryMetadataValue = string | number | boolean | null;
export type MemoryMetadata = Readonly<Record<string, MemoryMetadataValue>>;

/** Lifecycle visible to callers after a record has been invalidated. */
export type MemoryRecordStatus = "active" | "invalidated";

/** A durable memory as identified by the backend that owns it. */
export interface MemoryRecord {
	readonly id: MemoryId;
	readonly scope: MemoryBankScope;
	readonly text: string;
	readonly provenance: MemoryProvenance;
	readonly importance: number;
	readonly status: MemoryRecordStatus;
	readonly metadata: MemoryMetadata;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastAccessedAt?: string;
	readonly invalidatedAt?: string;
}

/** A semantic-recall result, ordered by rank and scored by the provider. */
export interface MemoryHit {
	readonly record: MemoryRecord;
	readonly score: number;
	readonly rank: number;
}

/** Operations for which a typed backend error can be reported. */
export type MemoryBackendOperation =
	| "open"
	| "close"
	| "remember"
	| "recall"
	| "update"
	| "forget"
	| "invalidate"
	| "set_importance"
	| "diagnostics"
	| "consolidate";

/** Stable, provider-neutral error categories. */
export type MemoryBackendErrorCode =
	| "invalid_scope"
	| "invalid_input"
	| "closed"
	| "not_found"
	| "unsupported"
	| "unavailable"
	| "conflict"
	| "timeout"
	| "failed";

/**
 * Error shape rejected by backend operations. Implementations may throw an
 * Error carrying this data, but callers can rely on these fields without
 * depending on a provider's error class.
 */
export interface MemoryBackendError {
	readonly code: MemoryBackendErrorCode;
	readonly operation: MemoryBackendOperation;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: MemoryMetadata;
}

/** Capability advertisement for optional or provider-limited operations. */
export interface MemoryBackendCapabilities {
	readonly semanticRecall: boolean;
	readonly update: boolean;
	readonly forget: boolean;
	readonly invalidate: boolean;
	readonly importance: boolean;
	readonly diagnostics: boolean;
	readonly consolidation: boolean;
}

/** Common fields carried by every bank-scoped operation. */
export interface MemoryBankRequest {
	readonly scope: MemoryBankScope;
	readonly signal?: AbortSignal;
}

/** Open a bank before using its records. */
export interface MemoryOpenRequest {
	readonly scope: MemoryBankScope;
	readonly signal?: AbortSignal;
}

/** Add a new durable memory. The source metadata is required. */
export interface MemoryRememberRequest extends MemoryBankRequest {
	readonly text: string;
	readonly provenance: MemoryProvenance;
	readonly importance?: number;
	readonly metadata?: MemoryMetadata;
}

/** Semantic retrieval request. */
export interface MemoryRecallRequest extends MemoryBankRequest {
	readonly query: string;
	readonly limit?: number;
	readonly minScore?: number;
}

/** A backend ID is required for every mutation. */
export interface MemoryMutationTarget extends MemoryBankRequest {
	readonly memoryId: MemoryId;
}

/** Update mutable fields while retaining the record's provenance. */
export interface MemoryUpdateRequest extends MemoryMutationTarget {
	readonly text?: string;
	readonly importance?: number;
	readonly metadata?: MemoryMetadata;
}

/** Permanently remove one backend-owned memory ID. */
export type MemoryForgetRequest = MemoryMutationTarget;

/**
 * Mark one backend-owned memory ID as no longer eligible for recall.
 *
 * When present, `replacementMemoryId` is the provider-owned `MemoryId` of
 * the durable replacement memory. It is not a Host metadata row or Host
 * metadata identifier; providers may use it to preserve a native revision
 * chain. Both memory IDs belong to the request's bank scope.
 */
export interface MemoryInvalidateRequest extends MemoryMutationTarget {
	readonly replacementMemoryId?: MemoryId;
	readonly reason?: string;
}

/** Set the provider-neutral importance value for one memory ID. */
export interface MemorySetImportanceRequest extends MemoryMutationTarget {
	readonly importance: number;
}

/** Optional provider-side maintenance request. */
export interface MemoryConsolidateRequest extends MemoryBankRequest {
	readonly memoryIds?: readonly MemoryId[];
	readonly maxRecords?: number;
}

/** Result of optional provider-side consolidation. */
export interface MemoryConsolidationResult {
	readonly inspected: number;
	readonly records: readonly MemoryRecord[];
}

/** Provider health and storage diagnostics. */
export interface MemoryDiagnostics {
	readonly state: "open" | "closed" | "degraded" | "unavailable";
	readonly checkedAt: string;
	readonly capabilities: MemoryBackendCapabilities;
	readonly scope?: MemoryBankScope;
	readonly recordCount?: number;
	readonly error?: MemoryBackendError;
}

/**
 * Node-host-facing long-term memory boundary.
 *
 * Session data remains outside this interface. Methods reject with a typed
 * MemoryBackendError shape on failure; no provider-specific API is required.
 */
export interface MemoryBackend {
	readonly capabilities: MemoryBackendCapabilities;

	open(request: MemoryOpenRequest): Promise<void>;
	close(signal?: AbortSignal): Promise<void>;

	remember(request: MemoryRememberRequest): Promise<MemoryRecord>;
	recall(request: MemoryRecallRequest): Promise<readonly MemoryHit[]>;
	update(request: MemoryUpdateRequest): Promise<MemoryRecord>;
	forget(request: MemoryForgetRequest): Promise<void>;
	invalidate(request: MemoryInvalidateRequest): Promise<MemoryRecord>;
	setImportance(request: MemorySetImportanceRequest): Promise<MemoryRecord>;
	diagnostics(signal?: AbortSignal): Promise<MemoryDiagnostics>;

	readonly consolidate?: (
		request: MemoryConsolidateRequest,
	) => Promise<MemoryConsolidationResult>;
}
