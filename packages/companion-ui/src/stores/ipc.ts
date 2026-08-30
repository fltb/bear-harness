/**
 * Wire model types, guards and the client call helper.
 *
 * The injected `CompanionClient` (from `@bear-harness/companion-client`)
 * exposes one async function per IPC channel. A reachable call resolves to
 * the raw `{ ok: true, data } | { ok: false, error: { kind, reason } }`
 * envelope; transport failures (including timeout/cancellation) reject the
 * promise instead. Envelope unwrapping lives in `../lib/ipc.ts` (`unwrap`,
 * owned by the component layer), and `invoke` exposes `Promise<T>` to stores.
 *
 * The model types mirror the wire contract of the host IPC schemas. They
 * are mirrored (not imported) so the package never pulls schema validation into the
 * page, and every value that crosses the client is validated by a narrow
 * guard before it is allowed into reactive state — hostile or malformed
 * payloads are dropped, never projected.
 */

import type { CompanionClient } from "@bear-harness/companion-client";
import type * as Wire from "@bear-harness/protocol";
import type { IpcEnvelope } from "@bear-harness/protocol";
import { unwrap } from "../lib/ipc.js";

// ---------------------------------------------------------------------------
// Client call helper
// ---------------------------------------------------------------------------

/**
 * Call a required client method and unwrap its RPC envelope. An RPC failure
 * resolves as an envelope and is converted to a user-facing rejection;
 * transport failures reject directly and are preserved. There is no
 * missing-client or degraded-client mode.
 */
export async function invoke<T>(
	_client: CompanionClient,
	call: () => Promise<IpcEnvelope<T>>,
): Promise<T> {
	return unwrap(await call());
}
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read a string field off a domain event payload, defensively. */
export function payloadString(payload: unknown, key: string): string | undefined {
	if (!isRecord(payload)) return undefined;
	const value = payload[key];
	return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Domain models mirror the shared @bear-harness/protocol wire contract.
// ---------------------------------------------------------------------------

export type OnboardingStatus = Wire.OnboardingStatus;
export type OnboardingStateData = Wire.OnboardingStateData;
export type OnboardingData = Wire.OnboardingResponse;
export type ConversationSummary = Wire.ConversationSummary;
export type PiLiveState = Wire.PiLiveState;
export type PiTimeline = Wire.PiTimeline;
export type PiTimelineEntry = Wire.PiTimelineEntry;
export type ConversationListData = Wire.ConversationListResponse;
export type ConversationSelectResponse = Wire.ConversationSelectResponse;
export type ConversationActiveResponse = Wire.ConversationActiveResponse;
export type ConversationCreateResult = Wire.ConversationCreateResponse;
export type CharacterStateDocument = Wire.CharacterStateDocument;
export type CompanionStateSnapshot = Wire.CompanionStateSnapshot;
export type CompanionStatePatchOperation = Wire.CompanionStatePatchOperation;
export type CanonSource = Wire.CanonSource;
export type CanonChunk = Wire.CanonChunk;
export type CanonModuleKind = Wire.CanonModuleKind;
export type CanonModule = Wire.CanonModule;
export type MessageSendResult = Wire.MessageSendResponse;
export type MemoryScope = Wire.MemoryScope;
export type MemoryEntry = Wire.MemoryEntry;
export type MemoryCaptureCreatedBy = Wire.MemoryCaptureCreatedBy;
export type MemoryCaptureRequest = Wire.MemoryCaptureRequest;
export type MemoryCaptureResponse = Wire.MemoryCaptureResponse;
export type MemoryPrepareEmbeddingResponse = { ready: true };
export type MemorySearchData = Wire.MemorySearchResponse;
export type MemoryListRequest = Wire.MemoryListRequest;
export type MemoryListData = Wire.MemoryListResponse;
export type MemoryForgetRequest = Wire.MemoryForgetRequest;
export type MemoryEditRequest = Wire.MemoryEditRequest;
export type ProviderInfo = Wire.ProviderInfo;
export type ProviderAuthType = ProviderInfo["authMethods"][number]["type"];
export type ProviderCredentialStatus = ProviderInfo["credentialStatus"];
export type ProviderModel = ProviderInfo["availableModels"][number];
export type ProviderListData = Wire.ProviderListResponse;
export type ProviderLoginResult = Wire.ProviderLoginResponse;
export type ConfiguredModel = Wire.ConfiguredModel;
export type ModelRoute = Wire.ModelRoute;
export type ModelPoolData = Wire.ModelPoolGetResponse;
export type ModelDefaultsData = Wire.ModelDefaultsGetResponse;
export type ModelRouteData = Wire.ModelRouteGetResponse;
export type ModelListData = ModelPoolData & {
	selected?: ModelRoute;
	multimodalFallback?: ModelRoute;
	defaults: ModelDefaultsData;
};
export type RunStatus = Wire.RunStatus;
export type RunInfo = Wire.Run;
export type RunListData = Wire.RunListResponse;
export type ExternalAgentStatusData = Wire.ExternalAgentStatusResponse;
export type ExternalAgentCandidate = Wire.ExternalAgentDiscoverCodexResponse["candidates"][number];
export interface RunPermissionOption {
	optionId: string;
	kind: string;
	name: string;
}
export interface RunPermissionRequest {
	runId: string;
	requestId: string;
	prompt: string;
	options: RunPermissionOption[];
}
export type SettingsData = Wire.SettingsData;
export type SettingsPatch = Wire.SettingsPatch;
export type SettingsCapabilities = Wire.SettingsCapabilities;

/** Wire shape of `settings.get` — the data sits under a `settings` key. */
export type SettingsResponseData = Wire.SettingsResponse;

// ---------------------------------------------------------------------------
// Snapshot + events
// ---------------------------------------------------------------------------

export type DomainEvent = Wire.DomainEvent;
export type EventBatch = Wire.EventSubscribeResponse;

export type ConversationSnapshot = Wire.ConversationSnapshot;
export type MemorySnapshot = Wire.MemorySnapshot;
export type SceneDisplay = Wire.CharacterDisplay["scenes"][number];
export type CharacterOnboardingStep = Wire.CharacterOnboardingFlow["steps"][number];
export type CharacterOnboardingAcknowledgeStep = Extract<
	CharacterOnboardingStep,
	{ kind: "acknowledge" }
>;
export type CharacterOnboardingTextStep = Extract<CharacterOnboardingStep, { kind: "text" }>;
export type CharacterOnboardingChoiceStep = Extract<CharacterOnboardingStep, { kind: "choice" }>;
export type CharacterOnboardingFlow = Wire.CharacterOnboardingFlow;
export type CharacterTheme = Wire.CharacterTheme;
export type CharacterDisplay = Wire.CharacterDisplay;
export type CharacterSummary = Wire.CharacterSummary;
export type CharacterListData = Wire.CharacterListResponse;
export type CharacterPackageDocument = Wire.CharacterPackageDocument;
export type CharacterDraft = Wire.CharacterDraft;
export type CharacterDraftFiles = Wire.CharacterDraft["files"];
export type CharacterDraftRevision = Wire.CharacterDraftRevision;
export type Snapshot = Wire.SnapshotResponse;
