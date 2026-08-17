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

// ---------------------------------------------------------------------------
// Channel registry
// ---------------------------------------------------------------------------

/** Type of the runtime request-schema registry (channel name → schema). */
export type RequestSchemaRegistry = typeof schema.REQUEST_SCHEMAS;
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
export type DomainEvent = z.infer<typeof schema.DomainEvent>;
export type EventSubscribeRequest = z.infer<typeof schema.EventSubscribeRequest>;
export type EventSubscribeResponse = z.infer<typeof schema.EventSubscribeResponse>;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type SnapshotGetRequest = z.infer<typeof schema.SnapshotGetRequest>;
export type SnapshotResponse = z.infer<typeof schema.SnapshotResponse>;
export type ConversationSnapshot = z.infer<typeof schema.ConversationSnapshot>;
export type MemorySnapshot = z.infer<typeof schema.MemorySnapshot>;
export type CharacterRuntimeState = z.infer<typeof schema.CharacterRuntimeState>;
export type CharacterRuntimeSnapshot = z.infer<typeof schema.CharacterRuntimeSnapshot>;
export type RoleplayState = z.infer<typeof schema.RoleplayState>;
export type RoleplayGetRequest = z.infer<typeof schema.RoleplayGetRequest>;
export type RoleplayTriggerRequest = z.infer<typeof schema.RoleplayTriggerRequest>;
export type RoleplayResponse = z.infer<typeof schema.RoleplayResponse>;

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
export type CharacterDraft = z.infer<typeof schema.CharacterDraft>;
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
export type CharacterDraftValidateRequest = z.infer<typeof schema.CharacterDraftValidateRequest>;
export type CharacterDraftPublishRequest = z.infer<typeof schema.CharacterDraftPublishRequest>;
export type CharacterDraftResponse = z.infer<typeof schema.CharacterDraftResponse>;
export type CharacterDraftPublishResponse = z.infer<typeof schema.CharacterDraftPublishResponse>;
export type OnboardingResponse = z.infer<typeof schema.OnboardingResponse>;
export type OnboardingStateData = z.infer<typeof schema.OnboardingStateData>;

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export type ConversationId = z.infer<typeof schema.ConversationId>;
export type BranchId = z.infer<typeof schema.BranchId>;
export type MessageId = z.infer<typeof schema.MessageId>;
export type MessageVersionId = z.infer<typeof schema.MessageVersionId>;
export type ConversationSummary = z.infer<typeof schema.ConversationSummary>;
export type ConversationListRequest = z.infer<typeof schema.ConversationListRequest>;
export type ConversationListResponse = z.infer<typeof schema.ConversationListResponse>;
export type ConversationCreateRequest = z.infer<typeof schema.ConversationCreateRequest>;
export type ConversationCreateResponse = z.infer<typeof schema.ConversationCreateResponse>;
export type ConversationSelectRequest = z.infer<typeof schema.ConversationSelectRequest>;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type MessageRole = z.infer<typeof schema.MessageRole>;
export type MessageVersion = z.infer<typeof schema.MessageVersion>;
export type Message = z.infer<typeof schema.Message>;
export type MessageSendRequest = z.infer<typeof schema.MessageSendRequest>;
export type MessageSendResponse = z.infer<typeof schema.MessageSendResponse>;
export type MessageRegenerateRequest = z.infer<typeof schema.MessageRegenerateRequest>;
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
export type MemoryCandidate = z.infer<typeof schema.MemoryCandidate>;
export type MemoryEntry = z.infer<typeof schema.MemoryEntry>;
export type MemoryListCandidatesRequest = z.infer<typeof schema.MemoryListCandidatesRequest>;
export type MemoryListCandidatesResponse = z.infer<typeof schema.MemoryListCandidatesResponse>;
export type MemoryApprovalDecision = z.infer<typeof schema.MemoryApprovalDecision>;
export type MemoryDecideCandidateRequest = z.infer<typeof schema.MemoryDecideCandidateRequest>;
export type MemorySearchRequest = z.infer<typeof schema.MemorySearchRequest>;
export type MemorySearchResponse = z.infer<typeof schema.MemorySearchResponse>;
export type MemoryListRequest = z.infer<typeof schema.MemoryListRequest>;
export type MemoryPinRequest = z.infer<typeof schema.MemoryPinRequest>;
export type MemoryForgetRequest = z.infer<typeof schema.MemoryForgetRequest>;
export type MemoryExcludeRequest = z.infer<typeof schema.MemoryExcludeRequest>;
export type MemoryEditRequest = z.infer<typeof schema.MemoryEditRequest>;

export type CanonSource = z.infer<typeof schema.CanonSource>;
export type CanonChunk = z.infer<typeof schema.CanonChunk>;
export type CanonModuleKind = z.infer<typeof schema.CanonModuleKind>;
export type CanonModule = z.infer<typeof schema.CanonModule>;

// ---------------------------------------------------------------------------
// Story archive
// ---------------------------------------------------------------------------

export type StoryChangeScope = z.infer<typeof schema.StoryChangeScope>;
export type StoryChangeSource = z.infer<typeof schema.StoryChangeSource>;
export type StoryChange = z.infer<typeof schema.StoryChange>;
export type StoryListChangesRequest = z.infer<typeof schema.StoryListChangesRequest>;
export type StoryListChangesResponse = z.infer<typeof schema.StoryListChangesResponse>;
export type StoryApplyChangeRequest = z.infer<typeof schema.StoryApplyChangeRequest>;
export type StoryApplyChangeResponse = z.infer<typeof schema.StoryApplyChangeResponse>;
export type StoryRevertChangeRequest = z.infer<typeof schema.StoryRevertChangeRequest>;
export type StoryResetRequest = z.infer<typeof schema.StoryResetRequest>;
export type StoryResetResponse = z.infer<typeof schema.StoryResetResponse>;
export type StoryChangeProposal = z.infer<typeof schema.StoryChangeProposal>;
export type StoryListProposalsRequest = z.infer<typeof schema.StoryListProposalsRequest>;
export type StoryListProposalsResponse = z.infer<typeof schema.StoryListProposalsResponse>;
export type StoryResolveProposalRequest = z.infer<typeof schema.StoryResolveProposalRequest>;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderInfo = z.infer<typeof schema.ProviderInfo>;
export type ProviderListRequest = z.infer<typeof schema.ProviderListRequest>;
export type ProviderListResponse = z.infer<typeof schema.ProviderListResponse>;
export type ProviderSetApiKeyRequest = z.infer<typeof schema.ProviderSetApiKeyRequest>;
export type ProviderLoginRequest = z.infer<typeof schema.ProviderLoginRequest>;
export type ProviderLoginResponse = z.infer<typeof schema.ProviderLoginResponse>;
export type ProviderLoginStatusRequest = z.infer<typeof schema.ProviderLoginStatusRequest>;
export type ProviderLoginAnswerRequest = z.infer<typeof schema.ProviderLoginAnswerRequest>;
export type ProviderLogoutRequest = z.infer<typeof schema.ProviderLogoutRequest>;

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
export type RunSteerRequest = z.infer<typeof schema.RunSteerRequest>;
export type RunCancelRequest = z.infer<typeof schema.RunCancelRequest>;
export type RunRespondPermissionRequest = z.infer<typeof schema.RunRespondPermissionRequest>;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunStatus = z.infer<typeof schema.RunStatus>;
export type Run = z.infer<typeof schema.Run>;
export type RunListRequest = z.infer<typeof schema.RunListRequest>;
export type RunListResponse = z.infer<typeof schema.RunListResponse>;
export type RunResponse = z.infer<typeof schema.RunResponse>;

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export type Artifact = z.infer<typeof schema.Artifact>;
export type ArtifactListRequest = z.infer<typeof schema.ArtifactListRequest>;
export type ArtifactListResponse = z.infer<typeof schema.ArtifactListResponse>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type SettingsData = z.infer<typeof schema.SettingsData>;
export type SettingsGetRequest = z.infer<typeof schema.SettingsGetRequest>;
export type SettingsResponse = z.infer<typeof schema.SettingsResponse>;
export type SettingsPatch = z.infer<typeof schema.SettingsPatch>;
export type SettingsSetRequest = z.infer<typeof schema.SettingsSetRequest>;
