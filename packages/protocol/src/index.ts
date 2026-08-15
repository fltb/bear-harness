/**
 * Type-only entry point for the Bear Harness wire contract.
 *
 * Every type here is the inferred static shape of the corresponding schema
 * in `./schema.ts` (the runtime module, imported via
 * `@bear-harness/protocol/schema`). This entry imports nothing at runtime —
 * all exports are erased to an empty module — so type-only consumers never
 * pull in TypeBox at runtime. Keep the two modules in sync: schema.ts owns
 * the wire contract, index.ts only mirrors its inferred types.
 */

import type { Static } from "typebox";
import type * as schema from "./schema.js";

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

/** Localizable reason codes for wire errors. */
export type IpcErrorKind = Static<typeof schema.IpcErrorKind>;

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

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export type EventSeq = Static<typeof schema.EventSeq>;
export type DomainEvent = Static<typeof schema.DomainEvent>;
export type EventSubscribeRequest = Static<typeof schema.EventSubscribeRequest>;
export type EventSubscribeResponse = Static<typeof schema.EventSubscribeResponse>;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type SnapshotGetRequest = Static<typeof schema.SnapshotGetRequest>;
export type SnapshotResponse = Static<typeof schema.SnapshotResponse>;

// ---------------------------------------------------------------------------
// Onboarding (first-meeting FSM)
// ---------------------------------------------------------------------------

export type OnboardingStatus = Static<typeof schema.OnboardingStatus>;
export type OnboardingGetRequest = Static<typeof schema.OnboardingGetRequest>;
export type OnboardingSubmitRequest = Static<typeof schema.OnboardingSubmitRequest>;
export type CharacterGetRequest = Static<typeof schema.CharacterGetRequest>;
export type OnboardingResponse = Static<typeof schema.OnboardingResponse>;
export type OnboardingStateData = Static<typeof schema.OnboardingStateData>;

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export type ConversationId = Static<typeof schema.ConversationId>;
export type BranchId = Static<typeof schema.BranchId>;
export type MessageId = Static<typeof schema.MessageId>;
export type MessageVersionId = Static<typeof schema.MessageVersionId>;
export type ConversationSummary = Static<typeof schema.ConversationSummary>;
export type ConversationListRequest = Static<typeof schema.ConversationListRequest>;
export type ConversationListResponse = Static<typeof schema.ConversationListResponse>;
export type ConversationCreateRequest = Static<typeof schema.ConversationCreateRequest>;
export type ConversationCreateResponse = Static<typeof schema.ConversationCreateResponse>;
export type ConversationSelectRequest = Static<typeof schema.ConversationSelectRequest>;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export type MessageRole = Static<typeof schema.MessageRole>;
export type MessageVersion = Static<typeof schema.MessageVersion>;
export type Message = Static<typeof schema.Message>;
export type MessageSendRequest = Static<typeof schema.MessageSendRequest>;
export type MessageSendResponse = Static<typeof schema.MessageSendResponse>;
export type MessageRegenerateRequest = Static<typeof schema.MessageRegenerateRequest>;
export type MessageSwitchVersionRequest = Static<typeof schema.MessageSwitchVersionRequest>;
export type MessageEditRequest = Static<typeof schema.MessageEditRequest>;
export type MessageContinueRequest = Static<typeof schema.MessageContinueRequest>;
export type MessageCorrectRequest = Static<typeof schema.MessageCorrectRequest>;
export type MessageBranchRequest = Static<typeof schema.MessageBranchRequest>;
export type MessageBranchResponse = Static<typeof schema.MessageBranchResponse>;
export type MessageAbortRequest = Static<typeof schema.MessageAbortRequest>;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryScope = Static<typeof schema.MemoryScope>;
export type MemoryCandidate = Static<typeof schema.MemoryCandidate>;
export type MemoryEntry = Static<typeof schema.MemoryEntry>;
export type MemoryListCandidatesRequest = Static<typeof schema.MemoryListCandidatesRequest>;
export type MemoryListCandidatesResponse = Static<typeof schema.MemoryListCandidatesResponse>;
export type MemoryApprovalDecision = Static<typeof schema.MemoryApprovalDecision>;
export type MemoryDecideCandidateRequest = Static<typeof schema.MemoryDecideCandidateRequest>;
export type MemorySearchRequest = Static<typeof schema.MemorySearchRequest>;
export type MemorySearchResponse = Static<typeof schema.MemorySearchResponse>;
export type MemoryListRequest = Static<typeof schema.MemoryListRequest>;
export type MemoryPinRequest = Static<typeof schema.MemoryPinRequest>;
export type MemoryForgetRequest = Static<typeof schema.MemoryForgetRequest>;
export type MemoryExcludeRequest = Static<typeof schema.MemoryExcludeRequest>;
export type MemoryEditRequest = Static<typeof schema.MemoryEditRequest>;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderInfo = Static<typeof schema.ProviderInfo>;
export type ProviderListRequest = Static<typeof schema.ProviderListRequest>;
export type ProviderListResponse = Static<typeof schema.ProviderListResponse>;
export type ProviderSetApiKeyRequest = Static<typeof schema.ProviderSetApiKeyRequest>;
export type ProviderLoginRequest = Static<typeof schema.ProviderLoginRequest>;
export type ProviderLoginResponse = Static<typeof schema.ProviderLoginResponse>;
export type ProviderLogoutRequest = Static<typeof schema.ProviderLogoutRequest>;

// ---------------------------------------------------------------------------
// Voice Stack
// ---------------------------------------------------------------------------

export type VoiceStack = Static<typeof schema.VoiceStack>;
export type VoiceStackListRequest = Static<typeof schema.VoiceStackListRequest>;
export type VoiceStackListResponse = Static<typeof schema.VoiceStackListResponse>;
export type VoiceStackSwitchRequest = Static<typeof schema.VoiceStackSwitchRequest>;

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

export type ActionDraft = Static<typeof schema.ActionDraft>;
export type Commission = Static<typeof schema.Commission>;
export type CommissionListRequest = Static<typeof schema.CommissionListRequest>;
export type CommissionListResponse = Static<typeof schema.CommissionListResponse>;
export type CommissionDraftRequest = Static<typeof schema.CommissionDraftRequest>;
export type CommissionDraftResponse = Static<typeof schema.CommissionDraftResponse>;
export type CommissionApproveRequest = Static<typeof schema.CommissionApproveRequest>;
export type CommissionLaunchRequest = Static<typeof schema.CommissionLaunchRequest>;
export type RunSteerRequest = Static<typeof schema.RunSteerRequest>;
export type RunCancelRequest = Static<typeof schema.RunCancelRequest>;
export type RunRespondPermissionRequest = Static<typeof schema.RunRespondPermissionRequest>;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunStatus = Static<typeof schema.RunStatus>;
export type Run = Static<typeof schema.Run>;
export type RunListRequest = Static<typeof schema.RunListRequest>;
export type RunListResponse = Static<typeof schema.RunListResponse>;

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export type Artifact = Static<typeof schema.Artifact>;
export type ArtifactListRequest = Static<typeof schema.ArtifactListRequest>;
export type ArtifactListResponse = Static<typeof schema.ArtifactListResponse>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type SettingsData = Static<typeof schema.SettingsData>;
export type SettingsGetRequest = Static<typeof schema.SettingsGetRequest>;
export type SettingsResponse = Static<typeof schema.SettingsResponse>;
export type SettingsSetRequest = Static<typeof schema.SettingsSetRequest>;
