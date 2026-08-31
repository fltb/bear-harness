/**
 * Public host-neutral entry point for TencentDB Agent Memory core.
 *
 * Upstream source: @tencentdb-agent-memory/memory-tencentdb@0.3.6 (MIT).
 * This package intentionally exports no host registration or adapter shell.
 */
export { TdaiCore } from "./core/tdai-core.js";
export type { TdaiCoreOptions } from "./core/tdai-core.js";
export { buildFtsQuery } from "./core/store/sqlite.js";
export { parseConfig } from "./config.js";
export { VectorStore } from "./core/store/sqlite.js";
export { TcvdbMemoryStore } from "./core/store/tcvdb.js";
export { createStoreBundle } from "./core/store/factory.js";
export {
	LocalEmbeddingService,
	OpenAIEmbeddingService,
	NoopEmbeddingService,
	EmbeddingNotReadyError,
	createEmbeddingService,
} from "./core/store/embedding.js";
export { createPipeline, initDataDirectories, initStores, resetStores } from "./utils/pipeline-factory.js";
export { NativeCapabilities, nativeCapabilities } from "./native/capabilities.js";
export type {
	JiebaInstance,
	LlamaGpuBackend,
	LlamaModule,
	NativeCapabilityId,
	NativeCapabilityStatus,
} from "./native/capabilities.js";
export type { TcvdbMemoryStoreConfig } from "./core/store/tcvdb.js";
export type { StoreBundle } from "./core/store/factory.js";
export type {
	PipelineFactoryOptions,
	PipelineInstance,
	PipelineLogger,
	StoreInitResult as PipelineStoreInitResult,
} from "./utils/pipeline-factory.js";

export type {
	CaptureConfig,
	ExtractionConfig,
	PersonaConfig,
	PipelineTriggerConfig,
	RecallConfig,
	EmbeddingConfig,
	MemoryCleanupConfig,
	BM25Config,
	TcvdbConfig,
	StoreBackend,
	ReportConfig,
	StandaloneLLMOverrideConfig,
	OffloadConfig,
	MemoryTdaiConfig,
} from "./config.js";
export type {
	Logger,
	RuntimeContext,
	LLMRunParams,
	LLMRunner,
	LLMRunnerCreateOptions,
	LLMRunnerFactory,
	HostAdapter,
	CompletedTurn,
	RecallResult,
	CaptureResult,
	MemorySearchParams,
	ConversationSearchParams,
	IndexingStatus,
	DeferredIndexingRecord,
	IndexingStatusCallback,
	ReindexResult,
} from "./core/types.js";
export type {
	MemoryRecord,
	EmbeddingProviderInfo,
	StoreLogger,
	L1SearchResult,
	L1FtsResult,
	L1QueryFilter,
	L1RecordRow,
	L0Record,
	L0SearchResult,
	L0FtsResult,
	L0QueryRow,
	L0SessionGroup,
	StoreInitResult,
	StoreCapabilities,
	ProfileRecord,
	ProfileSyncRecord,
	MaybePromise,
	IMemoryStore,
	IEmbeddingService,
} from "./core/store/types.js";
export type {
	OpenAIEmbeddingConfig,
	LocalEmbeddingConfig,
	EmbeddingConfig as StoreEmbeddingConfig,
	EmbeddingCallOptions,
	EmbeddingService,
	ImportLlamaFn,
} from "./core/store/embedding.js";
