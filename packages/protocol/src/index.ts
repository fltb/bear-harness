/**
 * Type-only entry point for the Bear Harness wire contract.
 *
 * Every type here is the inferred static shape of the corresponding schema
 * in `./schema.ts` (the runtime module, imported via
 * `@bear-harness/protocol/schema`). This entry imports nothing at runtime —
 * all exports are erased to an empty module, so type-only consumers never
 * pull in Zod at runtime. Keep the two modules in sync: schema.ts owns
 * the wire contract, index.ts only mirrors its inferred types.
 */

import type { z } from "@bear-harness/schema";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type * as schema from "./schema.js";

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

/** Localizable reason codes for wire errors. */
export type RpcErrorKind = z.infer<typeof schema.RpcErrorKind>;

/** Error body of a failed wire response. */
export interface RpcError {
	kind: RpcErrorKind;
	reason: string;
}

/** Successful branch of the response envelope. */
export type RpcSuccess<T> = { ok: true; data: T };

/** Failed branch of the response envelope. */
export type RpcFailure = { ok: false; error: RpcError };

/**
 * Wire response envelope — `{ ok: true, data } | { ok: false, error }`,
 * mirroring the `RpcResponse` factory in `./schema.ts`.
 */
export type RpcEnvelope<T> = RpcSuccess<T> | RpcFailure;

/** Empty payload used by command-style RPC responses. */
export type EmptyResponse = z.infer<typeof schema.EmptyResponse>;

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------
/** Complete nested endpoint metadata registry (`RPC`). */
export type RpcRegistry = typeof schema.RPC;
/** Complete flattened endpoint metadata registry (channel → request/response contract). */
export type ChannelContractRegistry = typeof schema.CHANNEL_CONTRACTS;

export type Channel = schema.Channel;
export type AnyRpcEndpoint = schema.AnyRpcEndpoint;
export type DeclaredRpcEndpoint = schema.DeclaredRpcEndpoint;
export type RequestOf<E extends AnyRpcEndpoint> = schema.RequestOf<E>;
export type ResponseOf<E extends AnyRpcEndpoint> = schema.ResponseOf<E>;
export type EnvelopeOf<E extends AnyRpcEndpoint> = RpcEnvelope<ResponseOf<E>>;

export type InvalidationNotice = z.infer<typeof schema.InvalidationNotice>;
export type InvalidationBatch = z.infer<typeof schema.InvalidationBatch>;
export type CacheKey = z.infer<typeof schema.CacheKeySchema>;
export type LivePush = z.infer<typeof schema.LivePush>;
export type LivePushBatch = z.infer<typeof schema.LivePushBatch>;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------
export type SnapshotGetResponse = z.infer<typeof schema.SnapshotResponse>;

export type SnapshotGetRequest = z.infer<typeof schema.SnapshotGetRequest>;
export type SnapshotResponse = z.infer<typeof schema.SnapshotResponse>;
export type CompanionDisplayState = z.infer<typeof schema.CompanionDisplayState>;
export type CompanionConversationState = z.infer<typeof schema.CompanionConversationState>;
export type CompanionStateGetRequest = z.infer<typeof schema.CompanionStateGetRequest>;
export type CompanionStateResponse = z.infer<typeof schema.CompanionStateResponse>;
export type CharacterStateRevisions = z.infer<typeof schema.CharacterStateRevisions>;
export type CharacterStateDocument = z.infer<typeof schema.CharacterStateDocument>;
export type CompanionStateChange = z.infer<typeof schema.CompanionStateChange>;
export type CompanionStateUpdateRequest = z.infer<typeof schema.CompanionStateUpdateRequest>;

// ---------------------------------------------------------------------------
// Onboarding (first-meeting FSM)
// ---------------------------------------------------------------------------

export type OnboardingStatus = z.infer<typeof schema.OnboardingStatus>;
export type OnboardingGetRequest = z.infer<typeof schema.OnboardingGetRequest>;
export type OnboardingSubmitRequest = z.infer<typeof schema.OnboardingSubmitRequest>;
export type CharacterGetRequest = z.infer<typeof schema.CharacterGetRequest>;
export type CharacterSummary = z.infer<typeof schema.CharacterSummary>;
export type CharacterListRequest = z.infer<typeof schema.CharacterListRequest>;
export type CharacterListResponse = z.infer<typeof schema.CharacterListResponse>;
export type CharacterResponse = z.infer<typeof schema.CharacterResponse>;
export type CharacterDisplay = z.infer<typeof schema.CharacterDisplay>;
export type CharacterTheme = z.infer<typeof schema.CharacterTheme>;
export type CharacterOnboardingFlow = z.infer<typeof schema.CharacterOnboardingFlow>;
export type CharacterActivateRequest = z.infer<typeof schema.CharacterActivateRequest>;
export type CharacterPrompt = z.infer<typeof schema.CharacterPrompt>;
export type CharacterPackageDocument = z.infer<typeof schema.CharacterPackageDocument>;
export type CharacterPackageGetRequest = z.infer<typeof schema.CharacterPackageGetRequest>;
export type CharacterPackageUpdateRequest = z.infer<typeof schema.CharacterPackageUpdateRequest>;
export type CharacterPackageResponse = z.infer<typeof schema.CharacterPackageResponse>;
export type CharacterPackageRevealRequest = z.infer<typeof schema.CharacterPackageRevealRequest>;
export type CharacterPackageRevealResponse = z.infer<typeof schema.CharacterPackageRevealResponse>;
export type CharacterDeletionStatusGetRequest = z.infer<
	typeof schema.CharacterDeletionStatusGetRequest
>;
export type CharacterDeletionStatus = z.infer<typeof schema.CharacterDeletionStatus>;
export type CharacterDeletionStatusResponse = z.infer<
	typeof schema.CharacterDeletionStatusResponse
>;
export type CharacterDeleteRequest = z.infer<typeof schema.CharacterDeleteRequest>;
export type CharacterRuntimeDeleteResponse = z.infer<typeof schema.CharacterRuntimeDeleteResponse>;
export type CharacterPackageDeleteResponse = z.infer<typeof schema.CharacterPackageDeleteResponse>;
export type CharacterDraft = z.infer<typeof schema.CharacterDraft>;
export type CharacterGetResponse = z.infer<typeof schema.CharacterResponse>;
export type CharacterActivateResponse = z.infer<typeof schema.CharacterResponse>;
export type CharacterImportRequest = z.infer<typeof schema.CharacterImportRequest>;
export type CharacterImportResponse = z.infer<typeof schema.CharacterResponse>;
export type CharacterPluginTrustGetRequest = z.infer<typeof schema.CharacterPluginTrustGetRequest>;
export type CharacterPluginTrustGetResponse = z.infer<typeof schema.CharacterPluginTrustResponse>;
export type CharacterPluginTrustConfirmRequest = z.infer<
	typeof schema.CharacterPluginTrustConfirmRequest
>;
export type CharacterPluginTrustConfirmResponse = z.infer<
	typeof schema.CharacterPluginTrustResponse
>;
export type CharacterDraftCreateRequest = z.infer<typeof schema.CharacterDraftCreateRequest>;
export type CharacterDraftGetRequest = z.infer<typeof schema.CharacterDraftGetRequest>;
export type CharacterDraftPatchRequest = z.infer<typeof schema.CharacterDraftPatchRequest>;
export type CharacterDraftRevision = z.infer<typeof schema.CharacterDraftRevision>;
export type CharacterDraftListRevisionsRequest = z.infer<
	typeof schema.CharacterDraftListRevisionsRequest
>;
export type CharacterDraftListRevisionsResponse = z.infer<
	typeof schema.CharacterDraftListRevisionsResponse
>;
export type CharacterDraftRestoreRevisionRequest = z.infer<
	typeof schema.CharacterDraftRestoreRevisionRequest
>;
export type CharacterDraftUploadAssetsRequest = z.infer<
	typeof schema.CharacterDraftUploadAssetsRequest
>;
export type CharacterDraftCreateResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type CharacterDraftGetResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type CharacterDraftPatchResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type CharacterDraftUploadAssetsResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type CharacterDraftRestoreRevisionResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type CharacterDraftValidateResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type CharacterDraftValidateRequest = z.infer<typeof schema.CharacterDraftValidateRequest>;
export type CharacterDraftPublishRequest = z.infer<typeof schema.CharacterDraftPublishRequest>;
export type CharacterDraftResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type OnboardingGetResponse = z.infer<typeof schema.OnboardingResponse>;
export type OnboardingSubmitResponse = z.infer<typeof schema.OnboardingResponse>;
export type CharacterDraftPublishResponse = z.infer<typeof schema.CharacterDraftPublishResponse>;
export type OnboardingResponse = z.infer<typeof schema.OnboardingResponse>;
export type OnboardingStateData = z.infer<typeof schema.OnboardingStateData>;

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export type ConversationId = z.infer<typeof schema.ConversationId>;
export type ConversationSummary = z.infer<typeof schema.ConversationSummary>;
export type ConversationListRequest = z.infer<typeof schema.ConversationListRequest>;
export type ConversationListResponse = z.infer<typeof schema.ConversationListResponse>;
export type ConversationCreateRequest = z.infer<typeof schema.ConversationCreateRequest>;
export type ConversationCreateResponse = z.infer<typeof schema.ConversationCreateResponse>;
export type ConversationOpenRequest = z.infer<typeof schema.ConversationOpenRequest>;
export type ConversationOpenResponse = z.infer<typeof schema.ConversationOpenResponse>;
export type ConversationDetail = z.infer<typeof schema.ConversationDetail>;
export type CharacterMedia = z.infer<typeof schema.CharacterMedia>;
export type PiMessageChoices = z.infer<typeof schema.PiMessageChoices>;
export type PiSessionEntry = SessionEntry;
export type PiAgentMessage = AgentMessage;
export type PiAgentSessionEvent = AgentSessionEvent;
export type PiLiveSnapshot = z.infer<typeof schema.PiLiveSnapshot>;
export type ConversationHistoryRequest = z.infer<typeof schema.ConversationHistoryRequest>;
export type ConversationHistoryResponse = z.infer<typeof schema.ConversationHistoryResponse>;
export type ConversationRenameRequest = z.infer<typeof schema.ConversationRenameRequest>;
export type ConversationRenameResponse = z.infer<typeof schema.EmptyResponse>;
export type ConversationArchiveRequest = z.infer<typeof schema.ConversationArchiveRequest>;
export type ConversationArchiveResponse = z.infer<typeof schema.EmptyResponse>;
export type ConversationDeleteRequest = z.infer<typeof schema.ConversationDeleteRequest>;
export type ConversationDeleteResponse = z.infer<typeof schema.EmptyResponse>;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type MessageSendRequest = z.infer<typeof schema.MessageSendRequest>;
export type MessageSendResponse = z.infer<typeof schema.MessageSendResponse>;
export type MessageRegenerateRequest = z.infer<typeof schema.MessageRegenerateRequest>;
export type MessageRegenerateResponse = ResponseOf<typeof schema.RPC.message.regenerate>;
export type MessageSwitchVersionResponse = ResponseOf<typeof schema.RPC.message.switchVersion>;
export type MessageEditResponse = ResponseOf<typeof schema.RPC.message.edit>;
export type MessageContinueResponse = ResponseOf<typeof schema.RPC.message.continue>;
export type MessageAbortResponse = ResponseOf<typeof schema.RPC.message.abort>;
export type MessageSwitchVersionRequest = z.infer<typeof schema.MessageSwitchVersionRequest>;
export type MessageEditRequest = z.infer<typeof schema.MessageEditRequest>;
export type MessageContinueRequest = z.infer<typeof schema.MessageContinueRequest>;
export type MessageBranchRequest = z.infer<typeof schema.MessageBranchRequest>;
export type MessageBranchResponse = z.infer<typeof schema.MessageBranchResponse>;
export type MessageAbortRequest = z.infer<typeof schema.MessageAbortRequest>;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryConfigureLocalEmbeddingRequest = z.infer<
	typeof schema.MemoryConfigureLocalEmbeddingRequest
>;
export type MemoryConfigureLocalEmbeddingResponse = z.infer<
	typeof schema.MemoryConfigureLocalEmbeddingResponse
>;

export type CanonListSourcesRequest = z.infer<typeof schema.CanonListSourcesRequest>;
export type CanonListSourcesResponse = z.infer<typeof schema.CanonListSourcesResponse>;
export type CanonAddSourceRequest = z.infer<typeof schema.CanonAddSourceRequest>;
export type CanonAddSourceResponse = z.infer<typeof schema.CanonAddSourceResponse>;
export type CanonSearchRequest = z.infer<typeof schema.CanonSearchRequest>;
export type CanonSearchResponse = z.infer<typeof schema.CanonSearchResponse>;
export type CanonRemoveSourceRequest = z.infer<typeof schema.CanonRemoveSourceRequest>;
export type CanonRemoveSourceResponse = z.infer<typeof schema.EmptyResponse>;
export type CanonListModulesRequest = z.infer<typeof schema.CanonListModulesRequest>;
export type CanonListModulesResponse = z.infer<typeof schema.CanonListModulesResponse>;
export type CanonUpsertModuleRequest = z.infer<typeof schema.CanonUpsertModuleRequest>;
export type CanonUpsertModuleResponse = z.infer<typeof schema.CanonUpsertModuleResponse>;
export type CanonDeleteModuleRequest = z.infer<typeof schema.CanonDeleteModuleRequest>;
export type CanonDeleteModuleResponse = z.infer<typeof schema.EmptyResponse>;

export type CanonSource = z.infer<typeof schema.CanonSource>;
export type CanonChunk = z.infer<typeof schema.CanonChunk>;
export type CanonModuleKind = z.infer<typeof schema.CanonModuleKind>;
export type CanonModule = z.infer<typeof schema.CanonModule>;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderInfo = z.infer<typeof schema.ProviderInfo>;
export type ProviderListRequest = z.infer<typeof schema.ProviderListRequest>;
export type ProviderListResponse = z.infer<typeof schema.ProviderListResponse>;
export type ProviderSetApiKeyRequest = z.infer<typeof schema.ProviderSetApiKeyRequest>;
export type ProviderLoginRequest = z.infer<typeof schema.ProviderLoginRequest>;
export type ProviderLoginResponse = z.infer<typeof schema.ProviderLoginResponse>;
export type ProviderLoginCancelRequest = z.infer<typeof schema.ProviderLoginCancelRequest>;
export type ProviderLoginCancelResponse = z.infer<typeof schema.ProviderLoginCancelResponse>;
export type ProviderLoginStatusRequest = z.infer<typeof schema.ProviderLoginStatusRequest>;
export type ProviderLoginAnswerRequest = z.infer<typeof schema.ProviderLoginAnswerRequest>;
export type ProviderLogoutRequest = z.infer<typeof schema.ProviderLogoutRequest>;
export type ProviderRemoveRequest = z.infer<typeof schema.ProviderRemoveRequest>;
export type ProviderCustomUpsertRequest = z.infer<typeof schema.ProviderCustomUpsertRequest>;
export type ProviderCustomUpsertResponse = z.infer<typeof schema.EmptyResponse>;
export type ProviderLoginStatusResponse = z.infer<typeof schema.ProviderLoginResponse>;
export type ProviderLoginAnswerResponse = z.infer<typeof schema.ProviderLoginResponse>;
export type ProviderLogoutResponse = z.infer<typeof schema.EmptyResponse>;
export type ProviderRemoveResponse = z.infer<typeof schema.EmptyResponse>;
export type ProviderSetApiKeyResponse = z.infer<typeof schema.EmptyResponse>;
export type ProviderImportPiConfigRequest = z.infer<typeof schema.ProviderImportPiConfigRequest>;
export type ProviderImportPiConfigResponse = z.infer<typeof schema.ProviderImportPiConfigResponse>;
export type ProviderOverrideBaseUrlRequest = z.infer<typeof schema.ProviderOverrideBaseUrlRequest>;
export type ProviderOverrideBaseUrlResponse = z.infer<typeof schema.EmptyResponse>;

// ---------------------------------------------------------------------------
// Configured models
// ---------------------------------------------------------------------------

export type ModelRoute = z.infer<typeof schema.ModelRoute>;
export type ConfiguredModel = z.infer<typeof schema.ConfiguredModel>;
export type ModelPoolGetRequest = z.infer<typeof schema.ModelPoolGetRequest>;
export type ModelPoolGetResponse = z.infer<typeof schema.ModelPoolGetResponse>;
export type ModelDefaultsGetRequest = z.infer<typeof schema.ModelDefaultsGetRequest>;
export type ModelDefaultsGetResponse = z.infer<typeof schema.ModelDefaultsGetResponse>;
export type ModelDefaultsSetReplyRequest = z.infer<typeof schema.ModelDefaultsSetReplyRequest>;
export type ModelDefaultsSetReplyResponse = z.infer<typeof schema.ModelDefaultsSetReplyResponse>;
export type ModelDefaultsSetVisionRequest = z.infer<typeof schema.ModelDefaultsSetVisionRequest>;
export type ModelDefaultsSetVisionResponse = z.infer<typeof schema.ModelDefaultsSetVisionResponse>;
export type SystemModelDefaultsGetRequest = z.infer<typeof schema.SystemModelDefaultsGetRequest>;
export type SystemModelDefaultsGetResponse = z.infer<typeof schema.SystemModelDefaultsGetResponse>;
export type SystemModelDefaultsSetRequest = z.infer<typeof schema.SystemModelDefaultsSetRequest>;
export type SystemModelDefaultsSetResponse = z.infer<typeof schema.SystemModelDefaultsSetResponse>;
export type ModelDefaultsInitializeRequest = z.infer<typeof schema.ModelDefaultsInitializeRequest>;
export type ModelDefaultsInitializeResponse = z.infer<
	typeof schema.ModelDefaultsInitializeResponse
>;
export type ModelDefaultsCompleteOnboardingRequest = z.infer<
	typeof schema.ModelDefaultsCompleteOnboardingRequest
>;
export type ModelDefaultsCompleteOnboardingResponse = z.infer<
	typeof schema.ModelDefaultsCompleteOnboardingResponse
>;
export type ModelRouteGetRequest = z.infer<typeof schema.ModelRouteGetRequest>;
export type ModelRouteGetResponse = z.infer<typeof schema.ModelRouteGetResponse>;
export type ModelRouteSetRequest = z.infer<typeof schema.ModelRouteSetRequest>;
export type ModelRouteSetResponse = z.infer<typeof schema.ModelRouteSetResponse>;
export type VisionModelDefault = z.infer<typeof schema.VisionModelDefault>;
export type ModelEnableRequest = z.infer<typeof schema.ModelEnableRequest>;
export type ModelEnableResponse = z.infer<typeof schema.ModelEnableResponse>;
export type ModelDisableRequest = z.infer<typeof schema.ModelDisableRequest>;
export type ModelDisableResponse = z.infer<typeof schema.EmptyResponse>;

// ---------------------------------------------------------------------------
// External agents
// ---------------------------------------------------------------------------

export type ExternalAgentCandidate = z.infer<typeof schema.ExternalAgentCandidate>;
export type ExternalAgentDiscoverCodexRequest = z.infer<
	typeof schema.ExternalAgentDiscoverCodexRequest
>;
export type ExternalAgentDiscoverCodexResponse = z.infer<
	typeof schema.ExternalAgentDiscoverCodexResponse
>;
export type ExternalAgentConnectCodexRequest = z.infer<
	typeof schema.ExternalAgentConnectCodexRequest
>;
export type ExternalAgentConnectCodexResponse = z.infer<
	typeof schema.ExternalAgentConnectCodexResponse
>;
export type ExternalAgentStatusRequest = z.infer<typeof schema.ExternalAgentStatusRequest>;
export type ExternalAgentStatusResponse = z.infer<typeof schema.ExternalAgentStatusResponse>;
export type RunSteerRequest = z.infer<typeof schema.RunSteerRequest>;
export type RunCancelRequest = z.infer<typeof schema.RunCancelRequest>;
export type RunRespondPermissionRequest = z.infer<typeof schema.RunRespondPermissionRequest>;
export type RunSteerResponse = z.infer<typeof schema.EmptyResponse>;
export type RunInterruptRequest = z.infer<typeof schema.RunInterruptRequest>;
export type RunInterruptResponse = z.infer<typeof schema.RunResponse>;
export type RunResumeRequest = z.infer<typeof schema.RunResumeRequest>;
export type RunResumeResponse = z.infer<typeof schema.RunResponse>;
export type RunCancelResponse = z.infer<typeof schema.RunResponse>;
export type RunRespondPermissionResponse = z.infer<typeof schema.RunResponse>;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunStatus = z.infer<typeof schema.RunStatus>;
export type ArtifactStatus = z.infer<typeof schema.ArtifactStatus>;
export type RunEvidenceSummary = z.infer<typeof schema.RunEvidenceSummary>;
export type RunPermission = z.infer<typeof schema.RunPermission>;
export type Run = z.infer<typeof schema.Run>;
export type RunListRequest = z.infer<typeof schema.RunListRequest>;
export type RunListResponse = z.infer<typeof schema.RunListResponse>;
export type RunResponse = z.infer<typeof schema.RunResponse>;
export type ArtifactSummary = z.infer<typeof schema.ArtifactSummary>;
export type ArtifactIdentity = z.infer<typeof schema.ArtifactIdentity>;
export type ArtifactReadRequest = z.infer<typeof schema.ArtifactReadRequest>;
export type ArtifactReadResponse = z.infer<typeof schema.ArtifactReadResponse>;
export type ArtifactActionRequest = z.infer<typeof schema.ArtifactActionRequest>;
export type ArtifactActionResponse = z.infer<typeof schema.ArtifactActionResponse>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type SettingsData = z.infer<typeof schema.SettingsData>;
export type SettingsGetRequest = z.infer<typeof schema.SettingsGetRequest>;
export type SettingsResponse = z.infer<typeof schema.SettingsResponse>;
export type SettingsPatch = z.infer<typeof schema.SettingsPatch>;
export type SettingsSetRequest = z.infer<typeof schema.SettingsSetRequest>;
export type SettingsGetResponse = z.infer<typeof schema.SettingsResponse>;
export type SettingsSetResponse = z.infer<typeof schema.SettingsResponse>;
export type SettingsCapabilities = z.infer<typeof schema.SettingsCapabilitiesGetResponse>;
export type SettingsCapabilitiesGetRequest = z.infer<typeof schema.SettingsCapabilitiesGetRequest>;
export type SettingsCapabilitiesGetResponse = z.infer<
	typeof schema.SettingsCapabilitiesGetResponse
>;
export type NetworkProxyModeCapability = z.infer<typeof schema.NetworkProxyModeCapability>;
export type MemoryVectorProviderCapability = z.infer<typeof schema.MemoryVectorProviderCapability>;
export type MemoryVectorPresetCapability = z.infer<typeof schema.MemoryVectorPresetCapability>;
export type LocalEmbeddingCandidate = z.infer<typeof schema.LocalEmbeddingCandidate>;
export type UpdateCheckRequest = z.infer<typeof schema.UpdateCheckRequest>;
export type UpdateCheckResponse = z.infer<typeof schema.UpdateCheckResponse>;
export type UpdateDiscardRequest = z.infer<typeof schema.UpdateDiscardRequest>;
export type UpdateDiscardResponse = z.infer<typeof schema.UpdateDiscardResponse>;
export type UpdateApplyRequest = z.infer<typeof schema.UpdateApplyRequest>;
export type UpdateApplyResponse = z.infer<typeof schema.UpdateApplyResponse>;
export type AuditListRequest = z.infer<typeof schema.AuditListRequest>;
export type AuditListResponse = z.infer<typeof schema.AuditListResponse>;
export type AuditExportRequest = z.infer<typeof schema.AuditExportRequest>;
export type AuditExportResponse = z.infer<typeof schema.AuditExportResponse>;
