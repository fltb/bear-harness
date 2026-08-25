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
import type * as schema from "./schema.js";

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

/** Localizable reason codes for wire errors. */
export type IpcErrorKind = z.infer<typeof schema.IpcErrorKind>;

/** Error body of a failed wire response. */
export interface IpcError {
	kind: IpcErrorKind;
	reason: string;
}

/** Successful branch of the response envelope. */
export type IpcSuccess<T> = { ok: true; data: T };

/** Failed branch of the response envelope. */
export type IpcFailure = { ok: false; error: IpcError };

/**
 * Wire response envelope — `{ ok: true, data } | { ok: false, error }`,
 * mirroring the `IpcResponse` factory in `./schema.ts`.
 */
export type IpcEnvelope<T> = IpcSuccess<T> | IpcFailure;

/** Empty payload used by command-style RPC responses. */
export type EmptyResponse = z.infer<typeof schema.EmptyResponse>;
export type ResourceKind = z.infer<typeof schema.ResourceKind>;
export type ResourceAccess = z.infer<typeof schema.ResourceAccess>;
export type ResourcePersistence = z.infer<typeof schema.ResourcePersistence>;
export type ResourceState = z.infer<typeof schema.ResourceState>;
export type ResourceRefView = z.infer<typeof schema.ResourceRefView>;
export type ResourceIdRequest = z.infer<typeof schema.ResourceIdRequest>;
export type ConversationResourceRequest = z.infer<typeof schema.ConversationResourceRequest>;
export type ResourcePickRequest = z.infer<typeof schema.ResourcePickRequest>;
export type ResourcePickResponse = z.infer<typeof schema.ResourcePickResponse>;
export type ResourceAttachDroppedRequest = z.infer<typeof schema.ResourceAttachDroppedRequest>;
export type ResourceListRequest = z.infer<typeof schema.ResourceListRequest>;
export type ResourceListResponse = z.infer<typeof schema.ResourceListResponse>;
export type ResourceResolveStateResponse = z.infer<typeof schema.ResourceResolveStateResponse>;
export type ResourceReadRequest = z.infer<typeof schema.ResourceReadRequest>;
export type ResourceReadResponse = z.infer<typeof schema.ResourceReadResponse>;
export type ResourceExtractResponse = z.infer<typeof schema.ResourceExtractResponse>;
export type ResourceListDirectoryRequest = z.infer<typeof schema.ResourceListDirectoryRequest>;
export type ResourceListDirectoryResponse = z.infer<typeof schema.ResourceListDirectoryResponse>;
export type ResourceSearchRequest = z.infer<typeof schema.ResourceSearchRequest>;
export type ResourceSearchResponse = z.infer<typeof schema.ResourceSearchResponse>;
export type MemoryConfigureLocalEmbeddingRequest = z.infer<
	typeof schema.MemoryConfigureLocalEmbeddingRequest
>;
export type MemoryConfigureLocalEmbeddingResponse = z.infer<
	typeof schema.MemoryConfigureLocalEmbeddingResponse
>;

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------
/** Complete nested endpoint metadata registry (`RPC`). */
export type RpcRegistry = typeof schema.RPC;
/** Complete flattened endpoint metadata registry (channel → request/response contract). */
export type ChannelContractRegistry = typeof schema.CHANNEL_CONTRACTS;

/** Type of the request-only registry (channel name → request schema). */
export type RequestSchemaRegistry = typeof schema.REQUEST_SCHEMAS;
/** `RPC` and `CHANNEL_CONTRACTS` carry full endpoint metadata; `REQUEST_SCHEMAS` does not. */
export type Channel = schema.Channel;
export type AnyRpcEndpoint = schema.AnyRpcEndpoint;
export type DeclaredRpcEndpoint = schema.DeclaredRpcEndpoint;
export type RequestOf<E extends AnyRpcEndpoint> = schema.RequestOf<E>;
export type ResponseOf<E extends AnyRpcEndpoint> = schema.ResponseOf<E>;
export type EnvelopeOf<E extends AnyRpcEndpoint> = IpcEnvelope<ResponseOf<E>>;

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------
export type EventSeq = z.infer<typeof schema.EventSeq>;
export type EventKind = z.infer<typeof schema.EventKind>;
export type KnownEventKind = schema.KnownEventKind;
export type OpaqueEventPayload = z.infer<typeof schema.OpaqueEventPayload>;
export type OpaqueDomainEvent = z.infer<typeof schema.OpaqueDomainEvent>;
export type DomainEvent = z.infer<typeof schema.DomainEvent>;
export type KnownDomainEvent = schema.KnownDomainEvent;
export type EventSubscribeRequest = z.infer<typeof schema.EventSubscribeRequest>;
export type EventSubscribeResponse = z.infer<typeof schema.EventSubscribeResponse>;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------
export type SnapshotGetResponse = z.infer<typeof schema.SnapshotResponse>;

export type SnapshotGetRequest = z.infer<typeof schema.SnapshotGetRequest>;
export type SnapshotResponse = z.infer<typeof schema.SnapshotResponse>;
export type ConversationSnapshot = z.infer<typeof schema.ConversationSnapshot>;
export type MemorySnapshot = z.infer<typeof schema.MemorySnapshot>;
export type CharacterRuntimeState = z.infer<typeof schema.CharacterRuntimeState>;
export type CharacterRuntimeSnapshot = z.infer<typeof schema.CharacterRuntimeSnapshot>;
export type RoleplayState = z.infer<typeof schema.RoleplayState>;
export type RoleplayGetRequest = z.infer<typeof schema.RoleplayGetRequest>;
export type RoleplayTriggerRequest = z.infer<typeof schema.RoleplayTriggerRequest>;
export type RoleplayDismissMediaRequest = z.infer<typeof schema.RoleplayDismissMediaRequest>;
export type RoleplayResponse = z.infer<typeof schema.RoleplayResponse>;
export type RoleplayGetResponse = z.infer<typeof schema.RoleplayResponse>;
export type RoleplayTriggerResponse = z.infer<typeof schema.RoleplayResponse>;
export type RoleplayResetUnlocksRequest = z.infer<typeof schema.RoleplayResetUnlocksRequest>;
export type RoleplayResetUnlocksResponse = z.infer<typeof schema.EmptyResponse>;

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
export type ConversationSelectRequest = z.infer<typeof schema.ConversationSelectRequest>;
export type ConversationActiveGetRequest = z.infer<typeof schema.ConversationActiveGetRequest>;
export type ConversationActiveResponse = z.infer<typeof schema.ConversationActiveResponse>;
export type ConversationSelectResponse = z.infer<typeof schema.ConversationSelectResponse>;
export type PiTimelineEntry = z.infer<typeof schema.PiTimelineEntry>;
export type PiTimeline = z.infer<typeof schema.PiTimeline>;
export type PiSessionId = z.infer<typeof schema.PiSessionId>;
export type PiLiveAssistantMessage = z.infer<typeof schema.PiLiveAssistantMessage>;
export type PiLiveState = z.infer<typeof schema.PiLiveState>;
export type ConversationRenameRequest = z.infer<typeof schema.ConversationRenameRequest>;
export type ConversationRenameResponse = z.infer<typeof schema.EmptyResponse>;
export type ConversationArchiveRequest = z.infer<typeof schema.ConversationArchiveRequest>;
export type ConversationArchiveResponse = z.infer<typeof schema.ConversationActiveResponse>;
export type ConversationDeleteRequest = z.infer<typeof schema.ConversationDeleteRequest>;
export type ConversationDeleteResponse = z.infer<typeof schema.ConversationActiveResponse>;
export type ConversationSearchRequest = z.infer<typeof schema.ConversationSearchRequest>;
export type ConversationSearchResponse = z.infer<typeof schema.ConversationSearchResponse>;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type MessageSendRequest = z.infer<typeof schema.MessageSendRequest>;
export type MessageSendResponse = z.infer<typeof schema.MessageSendResponse>;
export type MessageRegenerateRequest = z.infer<typeof schema.MessageRegenerateRequest>;
export type MessageRegenerateResponse = z.infer<typeof schema.MessageSendResponse>;
export type MessageSwitchVersionResponse = z.infer<typeof schema.EmptyResponse>;
export type MessageEditResponse = z.infer<typeof schema.EmptyResponse>;
export type MessageContinueResponse = z.infer<typeof schema.EmptyResponse>;
export type MessageCorrectResponse = z.infer<typeof schema.EmptyResponse>;
export type MessageAbortResponse = z.infer<typeof schema.EmptyResponse>;
export type MessageSwitchVersionRequest = z.infer<typeof schema.MessageSwitchVersionRequest>;
export type MessageEditRequest = z.infer<typeof schema.MessageEditRequest>;
export type MessageContinueRequest = z.infer<typeof schema.MessageContinueRequest>;
export type MessageCorrectRequest = z.infer<typeof schema.MessageCorrectRequest>;
export type MessageBranchRequest = z.infer<typeof schema.MessageBranchRequest>;
export type MessageBranchResponse = z.infer<typeof schema.MessageBranchResponse>;
export type MessageAbortRequest = z.infer<typeof schema.MessageAbortRequest>;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryScope = z.infer<typeof schema.MemoryScope>;
export type MemoryEntry = z.infer<typeof schema.MemoryEntry>;
export type MemoryCaptureCreatedBy = z.infer<typeof schema.MemoryCaptureCreatedBy>;
export type MemoryCaptureRequest = z.infer<typeof schema.MemoryCaptureRequest>;
export type MemoryCaptureResponse = z.infer<typeof schema.MemoryCaptureResponse>;
export type MemorySearchRequest = z.infer<typeof schema.MemorySearchRequest>;
export type MemorySearchResponse = z.infer<typeof schema.MemorySearchResponse>;
export type MemoryListRequest = z.infer<typeof schema.MemoryListRequest>;
export type MemoryListResponse = z.infer<typeof schema.MemoryListResponse>;
export type MemoryForgetRequest = z.infer<typeof schema.MemoryForgetRequest>;
export type MemoryEditRequest = z.infer<typeof schema.MemoryEditRequest>;
export type MemoryForgetResponse = z.infer<typeof schema.EmptyResponse>;
export type MemoryEditResponse = z.infer<typeof schema.EmptyResponse>;
export type MemoryExcludeRequest = z.infer<typeof schema.MemoryExcludeRequest>;
export type MemoryExcludeResponse = z.infer<typeof schema.EmptyResponse>;
export type MemoryCandidatesListRequest = z.infer<typeof schema.MemoryCandidatesListRequest>;
export type MemoryCandidatesListResponse = z.infer<typeof schema.MemoryCandidatesListResponse>;
export type MemoryCandidateApproveRequest = z.infer<typeof schema.MemoryCandidateApproveRequest>;
export type MemoryCandidateApproveResponse = z.infer<typeof schema.EmptyResponse>;
export type MemoryCandidateRejectRequest = z.infer<typeof schema.MemoryCandidateRejectRequest>;
export type MemoryCandidateRejectResponse = z.infer<typeof schema.EmptyResponse>;

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
// Commission
// ---------------------------------------------------------------------------

export type ActionDraft = z.infer<typeof schema.ActionDraft>;
export type Commission = z.infer<typeof schema.Commission>;
export type CommissionListRequest = z.infer<typeof schema.CommissionListRequest>;
export type CommissionListResponse = z.infer<typeof schema.CommissionListResponse>;
export type CommissionDraftRequest = z.infer<typeof schema.CommissionDraftRequest>;
export type CommissionDraftResponse = z.infer<typeof schema.CommissionDraftResponse>;
export type CommissionApproveRequest = z.infer<typeof schema.CommissionApproveRequest>;
export type CommissionLaunchRequest = z.infer<typeof schema.CommissionLaunchRequest>;
export type CommissionLaunchResponse = z.infer<typeof schema.CommissionLaunchResponse>;
export type CommissionApproveResponse = z.infer<typeof schema.EmptyResponse>;
export type CommissionRejectRequest = z.infer<typeof schema.CommissionRejectRequest>;
export type CommissionRejectResponse = z.infer<typeof schema.EmptyResponse>;
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
export type Run = z.infer<typeof schema.Run>;
export type RunListRequest = z.infer<typeof schema.RunListRequest>;
export type RunListResponse = z.infer<typeof schema.RunListResponse>;
export type RunResponse = z.infer<typeof schema.RunResponse>;
export type ArtifactListResponse = z.infer<typeof schema.ArtifactListResponse>;
export type ArtifactReadRequest = z.infer<typeof schema.ArtifactReadRequest>;
export type ArtifactReadResponse = z.infer<typeof schema.ArtifactReadResponse>;
export type ArtifactUrlRequest = z.infer<typeof schema.ArtifactUrlRequest>;
export type ArtifactUrlResponse = z.infer<typeof schema.ArtifactUrlResponse>;

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export type Artifact = z.infer<typeof schema.Artifact>;
export type ArtifactListRequest = z.infer<typeof schema.ArtifactListRequest>;

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
