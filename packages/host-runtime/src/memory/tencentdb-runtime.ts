import type {
	CompletedTurn,
	EmbeddingService,
	Logger,
	MemoryTdaiConfig,
	RecallResult,
} from "@bear-harness/tdai-core";
import { createEmbeddingService, TdaiCore } from "@bear-harness/tdai-core";
import type { ModelRegistry } from "../models/registry.js";
import type { ProviderCatalog } from "../providers/catalog.js";
import { BearHarnessHostAdapter } from "./tencentdb-host-adapter.js";

export interface TencentDbRuntimeOptions {
	readonly dataDir: string;
	readonly providers: ProviderCatalog;
	readonly models: ModelRegistry;
	readonly companionId: string;
	readonly installationId: string;
	readonly userId: string;
	readonly logger?: Logger;
	readonly memoryConfig?: DeepPartial<MemoryTdaiConfig>;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function namespaceFor(scope: {
	installationId: string;
	userId: string;
	companionId: string;
}): string {
	return `memory:v1:${scope.installationId}:${scope.userId}:${scope.companionId}`;
}

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
	if (patch === undefined) return base;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		const current = result[key];
		result[key] =
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			current !== null &&
			typeof current === "object" &&
			!Array.isArray(current)
				? deepMerge(current, value as DeepPartial<typeof current>)
				: value;
	}
	return result as T;
}

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
	llm: { enabled: false, baseUrl: "", apiKey: "", model: "", maxTokens: 0, timeoutMs: 0 },
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

/** Thin Pi-to-TDAI adapter. TDAI remains the only relationship-memory authority. */
export class TencentDbRuntime {
	private readonly core: TdaiCore;
	private started = false;
	private startPromise?: Promise<void>;
	private closed = false;

	constructor(options: TencentDbRuntimeOptions) {
		const dataDir = options.dataDir;
		const adapter = new BearHarnessHostAdapter({
			dataDir,
			workspaceDir: dataDir,
			userId: options.userId,
			companionId: options.companionId,
			providers: options.providers,
			models: options.models,
			logger: options.logger,
		});
		const config = deepMerge(DEFAULT_MEMORY_CONFIG, options.memoryConfig);
		this.core = new TdaiCore({
			hostAdapter: adapter,
			config,
			instanceId: `${options.installationId}:${options.userId}:${options.companionId}`,
		});
	}

	recall(userText: string, sessionKey: string): Promise<RecallResult> {
		return this.core.handleBeforeRecall(userText, sessionKey);
	}
	async captureTurn(turn: CompletedTurn): Promise<void> {
		await this.core.handleTurnCommitted(turn);
	}
	async flush(sessionKey: string): Promise<void> {
		await this.core.handleSessionEnd(sessionKey);
	}
	searchMemories(query: string, limit = 5) {
		return this.core.searchMemories({ query, limit });
	}
	searchConversations(query: string, sessionKey: string, limit = 5) {
		return this.core.searchConversations({ query, sessionKey, limit });
	}
	getEmbeddingService(): EmbeddingService | undefined {
		return this.started && !this.closed ? this.core.getEmbeddingService() : undefined;
	}
	async start(): Promise<void> {
		if (this.closed) throw new Error("TencentDB memory runtime is closed");
		if (this.started) return;
		if (this.startPromise) return this.startPromise;
		const promise = (async () => {
			await this.core.initialize();
			await this.core.waitForStoresReady();
			this.started = true;
		})();
		this.startPromise = promise;
		try {
			await promise;
		} finally {
			if (this.startPromise === promise) this.startPromise = undefined;
		}
	}

	isStarted(): boolean {
		return this.started;
	}

	async close(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("TencentDB memory runtime close aborted");
		if (this.closed) return;
		this.closed = true;
		await this.startPromise?.catch(() => undefined);
		await this.core.destroy();
	}
}

export async function validateLocalEmbedding(options: {
	modelPath: string;
	dimensions: number;
	hfEndpoint: string;
	signal?: AbortSignal;
	onProgress?: (progress: { downloadedSize: number; totalSize: number }) => void;
	onPhase?: (phase: "validating" | "activating") => void;
	timeoutMs?: number;
	logger?: Logger;
}): Promise<{ ready: true }> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("local embedding preparation timed out")),
		options.timeoutMs ?? 30 * 60_000,
	);
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	const candidate = createEmbeddingService(
		{
			provider: "local",
			modelPath: options.modelPath,
			dimensions: options.dimensions,
			hfEndpoint: options.hfEndpoint,
			signal,
			onDownloadProgress: options.onProgress,
			onDownloadComplete: () => options.onPhase?.("validating"),
		},
		options.logger,
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
		if (probe.length !== options.dimensions) throw new Error("local embedding dimension mismatch");
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
	return { ready: true };
}

export async function validateRemoteEmbedding(options: {
	baseUrl: string;
	apiKey: string;
	model: string;
	dimensions: number;
	timeoutMs?: number;
	logger?: Logger;
}): Promise<{ ready: true }> {
	const candidate = createEmbeddingService(
		{
			provider: "remote",
			baseUrl: options.baseUrl,
			apiKey: options.apiKey,
			model: options.model,
			dimensions: options.dimensions,
			timeoutMs: options.timeoutMs ?? 10_000,
		},
		options.logger,
	);
	try {
		const probe = await candidate.embed("semantic memory readiness probe", {
			timeoutMs: options.timeoutMs ?? 10_000,
		});
		if (probe.length !== options.dimensions) throw new Error("dimension mismatch");
	} catch {
		throw { kind: "unavailable", reason: "remote_embedding_validation_failed" };
	} finally {
		await candidate.close?.();
	}
	return { ready: true };
}
