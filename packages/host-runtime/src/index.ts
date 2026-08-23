/**
 * @bear-harness/host-runtime — the instance-scoped companion host.
 *
 * The package owns the canonical database, migrations, domain services,
 * character loading (injected character root), product config inputs, RPC
 * dispatch, and the start/close lifecycle. It has no Electron, browser, or
 * app-shell imports; platform boundaries (credential vault, diagnostics
 * app/reporter) are injected interfaces.
 */

export type { ArtifactRecord } from "./artifacts/index.js";
export { ArtifactStore } from "./artifacts/index.js";
export type {
	CommissionDraftParams,
	CommissionDraftResult,
	CommissionLaunchParams,
	CommissionLaunchResult,
	CommissionListParams,
	CommissionStatus,
	CommissionSummary,
	DraftSummary,
	RunStatus,
	RunSummary,
	TerminalRunStatus,
} from "./commissions/service.js";
export { CommissionService } from "./commissions/service.js";
export type {
	CharacterRuntimeState,
	CompanionHostToolCall,
	CompanionHostToolName,
	CompanionHostToolResult,
} from "./companion/character-behavior.js";
export { CharacterBehaviorService } from "./companion/character-behavior.js";
export type { CharacterDisplay, CharacterPackage } from "./companion/character-loader.js";
// Companion domain
export { CharacterLoader } from "./companion/character-loader.js";
export type { OnboardingStateRow, OnboardingStatus } from "./companion/first-meeting.js";
export { FirstMeetingMachine } from "./companion/first-meeting.js";
export type {
	CharacterOnboardingFlow,
	CharacterOnboardingStep,
	OnboardingStateData,
} from "./companion/onboarding-schema.js";
export type {
	CompanionModelRuntimeSource,
	CompanionRuntimeConfig,
	CompanionState,
} from "./companion/supervisor.js";
export { CompanionSupervisor } from "./companion/supervisor.js";
export type { TurnResult } from "./companion/turn-pipeline.js";
export { TurnPipeline } from "./companion/turn-pipeline.js";
export type {
	AttributeSpec,
	CatalogEntry,
	DiagnosticKind,
	DiagnosticLevel,
	DiagnosticName,
	DiagnosticOrigin,
	DiagnosticRecordV1,
	DiagnosticsPolicy,
	PendingRecord,
	SpanStatus,
} from "./diagnostics/contracts.js";
export {
	DIAGNOSTIC_CATALOG,
	DIAGNOSTICS_POLICY,
	isErrorType,
	MAX_RECORD_BYTES,
	RENDERER_FAULT_KINDS,
	validateAttributes,
	validateRecord,
} from "./diagnostics/contracts.js";
export type { CrashpadApp, CrashpadReporter } from "./diagnostics/crashpad.js";
export type {
	DiagnosticsApp,
	DiagnosticsOptions,
	RemoteTrace,
	SpanHandle,
} from "./diagnostics/index.js";
// Diagnostics (injected app/reporter interfaces; no Electron imports)
export { createDiagnostics, Diagnostics } from "./diagnostics/index.js";
export type { RandomSource, TraceContext } from "./diagnostics/trace.js";
export {
	createSpanId,
	createTraceId,
	formatTraceparent,
	parseTraceparent,
	runInTrace,
} from "./diagnostics/trace.js";
export type { RpcError, RpcHandler, RpcResponse } from "./dispatcher.js";
export { Dispatcher } from "./dispatcher.js";
export type {
	AcpClientHandlers,
	AcpPermissionRequest,
	AcpProcessSpec,
} from "./executors/acp-client.js";
export { AcpRunClient } from "./executors/acp-client.js";
export { AcpExecutorController, ApprovedFileAccess } from "./executors/acp-executor.js";
export type {
	CodexCandidate,
	CodexCandidateStatus,
	CodexConsentRequest,
	CodexProfileCapability,
	CodexRunManifest,
	CodexStatus,
} from "./executors/codex-adapter.js";
export { CodexAdapter } from "./executors/codex-adapter.js";
export type { PiRunManifest } from "./executors/pi-adapter.js";
export { PI_ACP_PROFILE_ID, PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
export type {
	ExecutorCommission,
	ExecutorController,
	ExecutorEvent,
	ExecutorLaunchRequest,
	ExecutorPermissionOption,
	ExecutorPermissionResponse,
	ExecutorProfile,
	ExecutorProfileType,
	ExecutorRun,
} from "./executors/router.js";
// Executors
export { ExecutorRouter } from "./executors/router.js";
export type {
	FsopJournal,
	FsopJournalStatus,
	FsopKind,
	FsopOp,
	FsopPlan,
} from "./fsops/service.js";
export { FileOpsService } from "./fsops/service.js";
export type { CodecGenerator, CodecParser, CodecResult } from "./materials/codec.js";
export { CodecRegistry, codecRegistry, guardCell } from "./materials/codec.js";
export type { MaterialKind, MaterialRef, MaterialState } from "./materials/ingest.js";
// Materials + fsops (services only; no RPC endpoints)
export { IngestService, sanitizeName, sniffKind } from "./materials/ingest.js";
export type {
	MemoryBackend,
	MemoryBackendCapabilities,
	MemoryBackendError,
	MemoryBackendErrorCode,
	MemoryBackendOperation,
	MemoryBankRequest,
	MemoryBankScope,
	MemoryConsolidateRequest,
	MemoryConsolidationResult,
	MemoryDiagnostics,
	MemoryForgetRequest,
	MemoryHit,
	MemoryId,
	MemoryInvalidateRequest,
	MemoryMetadata,
	MemoryMetadataValue,
	MemoryMutationTarget,
	MemoryOpenRequest,
	MemoryProvenance,
	MemoryProvenanceKind,
	MemoryRecallRequest,
	MemoryRecord,
	MemoryRecordStatus,
	MemoryRememberRequest,
	MemorySetImportanceRequest,
	MemoryUpdateRequest,
} from "./memory/backend.js";
export type { HostLocalEmbeddingCandidate, HostSettingsCapabilities } from "./settings/capabilities.js";
export { findHostLocalEmbeddingCandidate, HOST_SETTINGS_CAPABILITIES } from "./settings/capabilities.js";
export type { ModelRecord } from "./models/registry.js";
export { ModelRegistry } from "./models/registry.js";
export type {
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
	OAuthLoginResult,
	ProviderCredentialStatus,
	ProviderInfo,
	ProviderModelCost,
	ProviderModelInfo,
} from "./providers/catalog.js";
// Providers
export { ProviderCatalog } from "./providers/catalog.js";
export type {
	CredentialStatus,
	CredentialVault,
	ProviderCredential,
} from "./providers/credential-store.js";
// Credential boundary
export { CredentialStore } from "./providers/credential-store.js";
export type { HostRuntimeOptions, RuntimeProductConfig } from "./runtime.js";
// Runtime + lifecycle + dispatch
export { createHostRuntime, HostRuntime } from "./runtime.js";
// Storage
export { Database } from "./storage/database.js";
export type { EventListener, HostEvent } from "./storage/event-bus.js";
export { EventBus } from "./storage/event-bus.js";
