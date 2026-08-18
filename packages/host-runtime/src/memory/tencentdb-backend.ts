/**
 * Cyber Bear's provider-neutral boundary for the local TencentDB memory core.
 *
 * The core is deliberately injected. This file knows only the small CRUD
 * facade needed by the host memory contract; it does not construct a core,
 * select a host adapter, or depend on a plugin runtime.
 */

import type {
	MemoryBackend,
	MemoryBackendCapabilities,
	MemoryBankScope,
	MemoryDiagnostics,
	MemoryForgetRequest,
	MemoryHit,
	MemoryInvalidateRequest,
	MemoryListRequest,
	MemoryMetadata,
	MemoryOpenRequest,
	MemoryRecallRequest,
	MemoryRecord,
	MemoryRememberRequest,
	MemorySetImportanceRequest,
	MemoryUpdateRequest,
} from "./backend.js";

/** Record shape used by the injected core; the host adds its bank scope. */
export type TencentDbCoreRecord = Omit<MemoryRecord, "scope">;

export interface TencentDbCoreHit {
	readonly record: TencentDbCoreRecord;
	readonly score: number;
}

export interface TencentDbCoreRememberRequest {
	readonly namespace: string;
	readonly text: string;
	readonly provenance: MemoryRememberRequest["provenance"];
	readonly importance?: number;
	readonly metadata?: MemoryMetadata;
	readonly signal?: AbortSignal;
}

export interface TencentDbCoreRecallRequest {
	readonly namespace: string;
	readonly query: string;
	readonly limit?: number;
	readonly minScore?: number;
	readonly signal?: AbortSignal;
}
export interface TencentDbCoreListRequest {
	readonly namespace: string;
	readonly limit?: number;
	readonly signal?: AbortSignal;
}

export interface TencentDbCoreUpdateRequest {
	readonly namespace: string;
	readonly memoryId: string;
	readonly text?: string;
	readonly importance?: number;
	readonly metadata?: MemoryMetadata;
	readonly signal?: AbortSignal;
}

export interface TencentDbCoreMutationRequest {
	readonly namespace: string;
	readonly memoryId: string;
	readonly signal?: AbortSignal;
}

export interface TencentDbCoreInvalidateRequest extends TencentDbCoreMutationRequest {
	readonly replacementMemoryId?: string;
	readonly reason?: string;
}

export interface TencentDbCoreImportanceRequest extends TencentDbCoreMutationRequest {
	readonly importance: number;
}

/**
 * The only core API the host adapter relies on. A real TdaiCore-compatible
 * implementation and deterministic test doubles can both satisfy this shape.
 */
export interface TencentDbMemoryCoreFacade {
	remember(request: TencentDbCoreRememberRequest): Promise<TencentDbCoreRecord>;
	recall(request: TencentDbCoreRecallRequest): Promise<readonly TencentDbCoreHit[]>;
	list(request: TencentDbCoreListRequest): Promise<readonly TencentDbCoreRecord[]>;
	update(request: TencentDbCoreUpdateRequest): Promise<TencentDbCoreRecord>;
	forget(request: TencentDbCoreMutationRequest): Promise<void>;
	invalidate(request: TencentDbCoreInvalidateRequest): Promise<TencentDbCoreRecord>;
	setImportance(request: TencentDbCoreImportanceRequest): Promise<TencentDbCoreRecord>;
}

const CAPABILITIES: MemoryBackendCapabilities = Object.freeze({
	semanticRecall: true,
	update: true,
	forget: true,
	invalidate: true,
	importance: true,
	diagnostics: true,
	consolidation: false,
});

type Operation =
	| "open"
	| "close"
	| "remember"
	| "recall"
	| "list"
	| "update"
	| "forget"
	| "invalidate"
	| "set_importance"
	| "diagnostics";
type DataOperation =
	| "remember"
	| "recall"
	| "list"
	| "update"
	| "forget"
	| "invalidate"
	| "set_importance";

function abortIfRequested(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("TencentDB memory operation aborted");
	}
}

function backendError(
	code: "closed" | "invalid_scope" | "invalid_input",
	operation: Operation,
	message: string,
): Error & {
	readonly code: typeof code;
	readonly operation: Operation;
	readonly retryable: false;
} {
	const error = new Error(message) as Error & {
		readonly code: typeof code;
		readonly operation: Operation;
		readonly retryable: false;
	};
	Object.defineProperties(error, {
		code: { value: code, enumerable: true },
		operation: { value: operation, enumerable: true },
		retryable: { value: false, enumerable: true },
	});
	return error;
}

function validateScope(scope: MemoryBankScope, operation: Operation): void {
	if (
		!scope.installationId.trim() ||
		!scope.userId.trim() ||
		!scope.companionId.trim() ||
		scope.installationId.includes(":") ||
		scope.userId.includes(":") ||
		scope.companionId.includes(":")
	) {
		throw backendError(
			"invalid_scope",
			operation,
			"installationId, userId, and companionId must be non-empty and must not contain ':'",
		);
	}
}

export function namespaceFor(scope: MemoryBankScope): string {
	return `cyber-bear:${scope.installationId}:${scope.userId}:${scope.companionId}`;
}

function sameScope(left: MemoryBankScope, right: MemoryBankScope): boolean {
	return (
		left.installationId === right.installationId &&
		left.userId === right.userId &&
		left.companionId === right.companionId
	);
}

/** MemoryBackend implementation backed by an injected TencentDB core facade. */
export class TencentDbMemoryBackend implements MemoryBackend {
	readonly capabilities = CAPABILITIES;

	private openedScope?: MemoryBankScope;

	constructor(private readonly core: TencentDbMemoryCoreFacade) {}

	async open(request: MemoryOpenRequest): Promise<void> {
		abortIfRequested(request.signal);
		validateScope(request.scope, "open");
		this.openedScope = { ...request.scope };
	}

	async close(signal?: AbortSignal): Promise<void> {
		abortIfRequested(signal);
		this.openedScope = undefined;
	}

	async remember(request: MemoryRememberRequest): Promise<MemoryRecord> {
		const namespace = this.openNamespace(request.scope, request.signal, "remember");
		const record = await this.core.remember({
			namespace,
			text: request.text,
			provenance: request.provenance,
			importance: request.importance,
			metadata: request.metadata,
			signal: request.signal,
		});
		return this.withScope(record, request.scope);
	}

	async recall(request: MemoryRecallRequest): Promise<readonly MemoryHit[]> {
		const namespace = this.openNamespace(request.scope, request.signal, "recall");
		const hits = await this.core.recall({
			namespace,
			query: request.query,
			limit: request.limit,
			minScore: request.minScore,
			signal: request.signal,
		});
		return hits.map((hit, index) => ({
			record: this.withScope(hit.record, request.scope),
			score: hit.score,
			rank: index + 1,
		}));
	}
	async list(request: MemoryListRequest): Promise<readonly MemoryRecord[]> {
		const namespace = this.openNamespace(request.scope, request.signal, "list");
		const records = await this.core.list({
			namespace,
			limit: request.limit,
			signal: request.signal,
		});
		return records.map((record) => this.withScope(record, request.scope));
	}

	async update(request: MemoryUpdateRequest): Promise<MemoryRecord> {
		const namespace = this.openNamespace(request.scope, request.signal, "update");
		const record = await this.core.update({
			namespace,
			memoryId: request.memoryId,
			text: request.text,
			importance: request.importance,
			metadata: request.metadata,
			signal: request.signal,
		});
		return this.withScope(record, request.scope);
	}

	async forget(request: MemoryForgetRequest): Promise<void> {
		const namespace = this.openNamespace(request.scope, request.signal, "forget");
		await this.core.forget({ namespace, memoryId: request.memoryId, signal: request.signal });
	}

	async invalidate(request: MemoryInvalidateRequest): Promise<MemoryRecord> {
		const namespace = this.openNamespace(request.scope, request.signal, "invalidate");
		const record = await this.core.invalidate({
			namespace,
			memoryId: request.memoryId,
			replacementMemoryId: request.replacementMemoryId,
			reason: request.reason,
			signal: request.signal,
		});
		return this.withScope(record, request.scope);
	}

	async setImportance(request: MemorySetImportanceRequest): Promise<MemoryRecord> {
		const namespace = this.openNamespace(request.scope, request.signal, "set_importance");
		const record = await this.core.setImportance({
			namespace,
			memoryId: request.memoryId,
			importance: request.importance,
			signal: request.signal,
		});
		return this.withScope(record, request.scope);
	}

	async diagnostics(signal?: AbortSignal): Promise<MemoryDiagnostics> {
		abortIfRequested(signal);
		return {
			state: this.openedScope ? "open" : "closed",
			checkedAt: new Date().toISOString(),
			capabilities: this.capabilities,
			scope: this.openedScope,
		};
	}

	private openNamespace(
		scope: MemoryBankScope,
		signal: AbortSignal | undefined,
		operation: DataOperation,
	): string {
		abortIfRequested(signal);
		validateScope(scope, operation);
		if (!this.openedScope) {
			throw backendError("closed", operation, "TencentDB memory backend is not open");
		}
		if (!sameScope(this.openedScope, scope)) {
			throw backendError(
				"invalid_scope",
				operation,
				"operation scope differs from the opened memory bank",
			);
		}
		return namespaceFor(scope);
	}

	private withScope(record: TencentDbCoreRecord, scope: MemoryBankScope): MemoryRecord {
		return { ...record, scope };
	}
}
