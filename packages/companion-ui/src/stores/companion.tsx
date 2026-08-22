/**
 * Companion store: the single reactive facade the renderer consumes.
 *
 * Architecture (per the M5 recovery contract in
 * `local://renderer-contract.md`):
 *
 * - QueryClient entries own the Host-backed snapshot and supplementary
 *   projections. The boot snapshot hydrates those entries and events invalidate
 *   or update each entry explicitly.
 * - A `createEffect` + `onCleanup` subscription consumes the event stream and
 *   projects only live/transient state locally. Sequence gaps mark the stream
 *   stale and re-fetch the authoritative snapshot.
 *   Duplicate replay is skipped (the event bus is idempotent by contract).
 * - Every value that crosses the client is validated by a narrow guard in
 *   `stores/ipc.ts`; malformed payloads are dropped, never projected.
 * - `createCompanionStore` requires a fully constructed `CompanionClient`; there
 *   is no supported missing-client or degraded-client mode. Transport and RPC
 *   failures are retained as `errorMetadata` for the initiating component,
 *   while unrecoverable projection/stream failures populate the global `error`.
 *
 * The store is a flat object whose reactive fields are getters into a Solid
 * store proxy, so components read the active Pi timeline and transient
 * streaming state directly. Action failures retain operation metadata without
 * choosing a presentation surface.
 * Supplementary domain APIs (memory/settings/provider/model/commission/artifact)
 * are exposed for the backstage sheets.
 */

import type { CompanionClient } from "@bear-harness/companion-client";
import { i18n, useTranslation } from "@bear-harness/i18n";
import type { KnownDomainEvent, RoleplayState } from "@bear-harness/protocol";
import type {
	LocalEmbeddingCandidate as LocalEmbeddingCandidateSchema,
	MemoryCandidate as MemoryCandidateSchema,
} from "@bear-harness/protocol/schema";
import { parseKnownDomainEvent } from "@bear-harness/protocol/schema";
import type { z } from "@bear-harness/schema";
import { useQueryClient } from "@tanstack/solid-query";
import {
	createContext,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	type Accessor,
	type ParentProps,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { IpcInvocationError } from "../lib/ipc.js";
import {
	type Artifact,
	type ArtifactListData,
	type ArtifactReadData,
	type CanonChunk,
	type CanonModule,
	type CanonModuleKind,
	type CanonSource,
	type CharacterDisplay,
	type CharacterDraft,
	type CharacterDraftFiles,
	type CharacterDraftRevision,
	type CharacterListData,
	type CharacterRuntimeState,
	type CharacterSummary,
	type Commission,
	type CommissionDraftParams,
	type CommissionDraftResult,
	type CommissionLaunchResult,
	type CommissionListData,
	type ConfiguredModel,
	type ConversationSummary,
	type DomainEvent,
	type MemoryCaptureResponse,
	type MemoryListRequest,
	type MemoryPrepareEmbeddingResponse,
	type MemorySearchData,
	type MemoryScope,
	type MemoryEntry,
	type PiTimeline,
	type ModelListData,
	type ModelRouteData,
	type OnboardingData,
	type ProviderInfo,
	type ProviderListData,
	type ProviderLoginResult,
	type RunInfo,
	type RunListData,
	type RunPermissionRequest,
	type SettingsData,
	type SettingsPatch,
	type Snapshot,
	type StoryChange,
	type StoryChangeProposal,
	type StoryChangeScope,
	type StoryListData,
} from "./ipc.js";
import { invoke } from "./ipc.js";
import { createOnboardingStore } from "./onboarding.js";
import { createRpcMutation, createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";

export * from "./ipc.js";
export type { OnboardingStore } from "./onboarding.js";
export { createOnboardingStore } from "./onboarding.js";
/** Inferred wire shape of `memory.candidates.list` items (schema value import). */
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type MemoryCandidateStatus = MemoryCandidate["status"];
export type LocalEmbeddingCandidate = z.infer<typeof LocalEmbeddingCandidateSchema>;

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type PresenceState =
	| "idle"
	| "listening"
	| "thinking"
	| "needs_user"
	| "result_ready"
	| "problem";
export type CompanionErrorSource = "transport" | "domain" | "projection" | "stream";

/** Metadata retained by the store without deciding where an operation is shown. */
export interface CompanionErrorMetadata {
	message: string;
	operation: string;
	source: CompanionErrorSource;
	/** Protocol error kind is retained when the Host returned an RPC failure. */
	kind?: string;
}

function errorMetadata(operation: string, value: unknown): CompanionErrorMetadata {
	return {
		message: messageOf(value),
		operation,
		source: value instanceof IpcInvocationError ? "domain" : "transport",
		...(value instanceof IpcInvocationError ? { kind: value.kind } : {}),
	};
}

function projectionError(
	operation: string,
	value: unknown,
	source: "projection" | "stream",
): CompanionErrorMetadata {
	return {
		message: messageOf(value),
		operation,
		source,
		...(value instanceof IpcInvocationError ? { kind: value.kind } : {}),
	};
}


function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
export class PiTimelineProjectionError extends Error {
	readonly code = "missing_pi_timeline";

	constructor(operation: string) {
		super(`${operation}: conversation projection is missing a valid Pi timeline`);
		this.name = "PiTimelineProjectionError";
	}
}

function requirePiTimeline(timeline: PiTimeline | undefined, operation: string): PiTimeline {
	if (timeline === undefined) throw new PiTimelineProjectionError(operation);
	return timeline;
}
/** Copy decoded bytes into an ArrayBuffer accepted by the DOM BlobPart type. */
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

type RunNeedsUserPayload = Extract<KnownDomainEvent, { kind: "run.needs_user" }>["payload"];

function parseRunPermission(payload: RunNeedsUserPayload): RunPermissionRequest {
	return {
		runId: payload.runId,
		requestId: payload.requestId,
		prompt: payload.prompt,
		options: payload.options,
	};
}

// ---------------------------------------------------------------------------
// Supplementary API surfaces
// ---------------------------------------------------------------------------

export interface SnapshotApi {
	data(): Snapshot | undefined;
	eventSeq(): number;
	loading(): boolean;
	error(): unknown;
	refetch(): void;
	get(): Promise<Snapshot>;
}

export interface EventsApi {
	lastSeq(): number;
	stale(): boolean;
	subscribe(afterSeq: number): Promise<DomainEvent[]>;
}

export interface MemoryApi {
	entries(): MemoryEntry[] | undefined;
	revision(): number;
	search(query: string, scope?: MemoryScope): Promise<MemoryEntry[]>;
	list(params?: MemoryListRequest): Promise<MemoryEntry[]>;
	capture(entryId: string): Promise<MemoryCaptureResponse>;
	localEmbeddingCandidates(): LocalEmbeddingCandidate[] | undefined;
	listLocalEmbeddingCandidates(): Promise<LocalEmbeddingCandidate[]>;
	configureLocalEmbedding(
		provider: "none" | "local",
		candidateId?: string,
	): Promise<{ ready: true }>;
	forget(entryId: string): Promise<void>;
	edit(entryId: string, newText: string): Promise<void>;
	exclude(memoryId: string, excluded: boolean): Promise<void>;
	/** Pending candidates awaiting user confirmation (reactive list). */
	candidates(): MemoryCandidate[] | undefined;
	listCandidates(status?: MemoryCandidate["status"]): Promise<MemoryCandidate[]>;
	approveCandidate(
		candidateId: string,
		editedText?: string,
		decidedScope?: MemoryScope,
	): Promise<void>;
	rejectCandidate(candidateId: string): Promise<void>;
}

export interface SettingsApi {
	data(): SettingsData | undefined;
	get(): Promise<SettingsData>;
	set(settings: SettingsPatch): Promise<void>;
}

export interface ProviderApi {
	providers(): ProviderInfo[];
	list(): Promise<ProviderListData>;
	customUpsert(params: {
		providerId: string;
		name: string;
		baseUrl: string;
		models: Array<{ id: string; name?: string; supportsImages?: boolean }>;
		apiKey?: string;
	}): Promise<void>;
	importPiConfig(configJson: string): Promise<ConfiguredModel[]>;
	overrideBaseUrl(params: { providerId: string; baseUrl: string }): Promise<void>;
	setApiKey(providerId: string, apiKey: string, sessionOnly?: boolean): Promise<void>;
	login(providerId: string): Promise<ProviderLoginResult>;
	loginStatus(providerId: string): Promise<ProviderLoginResult>;
	loginAnswer(providerId: string, answer: string): Promise<ProviderLoginResult>;
	logout(providerId: string): Promise<void>;
}

export interface ModelApi {
	data(): ModelListData;
	models(): ConfiguredModel[];
	selectedValue(): string;
	loading(): boolean;
	error(): unknown;
	refetch(): void;
	list(conversationId?: string): Promise<ModelListData>;
	enable(providerId: string, modelId: string, label?: string): Promise<void>;
	disable(providerId: string, modelId: string): Promise<void>;
	select(conversationId: string, providerId: string, modelId: string): Promise<void>;
	setMultimodalFallback(providerId: string, modelId: string): Promise<void>;
	setDefaultReply(providerId: string, modelId: string): Promise<void>;
	clearDefaultReply(): Promise<void>;
	setVisionAuto(): Promise<void>;
}

export interface CommissionApi {
	commissions(): Commission[];
	list(): Promise<CommissionListData>;
	draft(params: CommissionDraftParams): Promise<CommissionDraftResult>;
	approve(commissionId: string, approvedHash: string): Promise<void>;
	reject(commissionId: string): Promise<void>;
	launch(commissionId: string, executorProfile: string): Promise<CommissionLaunchResult>;
}

export interface RunApi {
	list(): Promise<RunListData>;
	pendingPermissions(): RunPermissionRequest[];
	steer(runId: string, instruction: string): Promise<void>;
	interrupt(runId: string): Promise<RunInfo>;
	resume(runId: string): Promise<RunInfo>;
	cancel(runId: string): Promise<RunInfo>;
	respondPermission(runId: string, requestId: string, optionId: string): Promise<RunInfo>;
}

export interface ArtifactApi {
	artifacts(): Artifact[];
	list(): Promise<ArtifactListData>;
	/** Read a single artifact's bytes as base64 (used for safe inline previews). */
	read(artifactId: string): Promise<ArtifactReadData>;
	/**
	 * Request the host-issued safe artifact URL (`bear-artifact://…` when the
	 * desktop protocol handler is registered, otherwise ""). Never build URLs
	 * from arbitrary paths in the renderer.
	 */
	url(artifactId: string): Promise<string>;
	download(artifactId: string): Promise<void>;
}

export interface StoryApi {
	changes(): StoryChange[];
	proposals(): StoryChangeProposal[];
	list(branchId?: string): Promise<StoryListData>;
	apply(text: string, scope: StoryChangeScope): Promise<void>;
	revert(changeId: string): Promise<void>;
	reset(): Promise<void>;
	resolveProposal(proposalId: string, accept: boolean): Promise<void>;
}

export interface CharacterApi {
	characters(): CharacterSummary[];
	list(): Promise<CharacterListData>;
	activate(characterId: string): Promise<void>;
	import(files: Array<{ path: string; base64: string }>): Promise<void>;
	pluginTrust(characterId?: string): Promise<{
		origin: "official" | "local" | "imported";
		pluginHash: string;
		trusted: boolean;
		pluginsPresent: boolean;
	}>;

	confirmPluginTrust(characterId: string): Promise<void>;
	draftCreate(params?: { basePackageId?: string; locale?: string }): Promise<CharacterDraft>;
	draftGet(id: string): Promise<CharacterDraft>;
	draftPatch(
		id: string,
		expectedRevision: number,
		files: CharacterDraftFiles,
	): Promise<CharacterDraft>;
	draftUploadAssets(
		id: string,
		expectedRevision: number,
		assets: Array<{ path: string; mime: string; base64: string }>,
	): Promise<CharacterDraft>;
	draftListRevisions(id: string): Promise<CharacterDraftRevision[]>;
	draftRestoreRevision(
		id: string,
		expectedRevision: number,
		sourceRevision: number,
	): Promise<CharacterDraft>;
	draftValidate(id: string, expectedRevision: number): Promise<CharacterDraft>;
	draftPublish(id: string, expectedRevision: number): Promise<CharacterDraft>;
}

export interface CanonApi {
	sources(): CanonSource[];
	modules(): CanonModule[];
	listSources(): Promise<void>;
	addSource(logicalName: string, content: string): Promise<void>;
	search(query: string): Promise<CanonChunk[]>;
	removeSource(sourceId: string): Promise<void>;
	listModules(): Promise<void>;
	upsertModule(params: {
		id?: string;
		parentId?: string;
		kind: CanonModuleKind;
		title: string;
		instructions: string;
		sourceChunkIds: string[];
	}): Promise<void>;
	deleteModule(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Flat store contract
// ---------------------------------------------------------------------------

type EmbeddingSettingsValue =
	| SettingsData["memoryVectorService"]
	| SettingsData["modelDownloadMirror"];
function isModelDownloadMirror(
	value: EmbeddingSettingsValue,
): value is SettingsData["modelDownloadMirror"] {
	return Object.prototype.hasOwnProperty.call(value, "endpoint");
}
interface RpcQueryBinding<T> {
	readonly data: T | undefined;
	readonly isPending: boolean;
	readonly error: unknown;
}

interface RpcMutationBinding<T> {
	readonly mutateAsync: (variables: T) => Promise<unknown>;
	readonly isPending: boolean;
	readonly error: unknown;
	readonly isSuccess: boolean;
}

export interface EmbeddingBinding {
	readonly settingsQuery: RpcQueryBinding<{ settings: SettingsData }>;
	readonly catalogQuery: RpcQueryBinding<{ candidates: LocalEmbeddingCandidate[] }>;
	readonly settingsMutation: RpcMutationBinding<EmbeddingSettingsValue>;
	readonly localConfigureMutation: RpcMutationBinding<{
		provider: "none" | "local";
		candidateId?: string;
	}>;
}

export interface CompanionStore {
	readonly loading: boolean;
	/** Only unrecoverable snapshot/projection/stream failures are global. */
	readonly error: string | null;
	/** Last transport/domain failure, retained for the initiating surface. */
	readonly errorMetadata: CompanionErrorMetadata | null;
	readonly onboarding: OnboardingData;
	readonly conversations: ConversationSummary[];
	readonly activeConversationId: string | null;
	readonly activePiTimeline: PiTimeline | undefined;
	readonly pendingUserText: string | undefined;
	readonly streamingAssistantText: string;
	readonly assistantStreaming: boolean;
	readonly runs: RunInfo[];
	readonly presence: PresenceState;
	readonly character: CharacterDisplay | undefined;
	readonly characterRuntimeByConversation: Readonly<Record<string, CharacterRuntimeState>>;
	readonly roleplay: RoleplayState | undefined;
	readonly activeRoleplayMediaId: string | undefined;
	readonly activeAmbientMediaId: string | undefined;
	readonly activeRoleplayChoiceSetId: string | undefined;
	refresh(): Promise<void>;
	selectConversation(id: string, branchId?: string): Promise<void>;
	createConversation(title?: string): Promise<void>;
	renameConversation(id: string, title: string): Promise<void>;
	archiveConversation(id: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	sendMessage(
		text: string,
		attachments?: Array<{ name: string; mime: string; base64: string }>,
	): Promise<void>;
	abort(): Promise<void>;
	triggerRoleplayEvent(eventId: string): Promise<void>;
	dismissRoleplayMedia(): Promise<void>;
	dismissAmbientMedia(): Promise<void>;
	submitOnboarding(stepId: string, answer?: string): Promise<void>;

	/** Boot snapshot + event-bus access (supplementary). */
	readonly snapshot: SnapshotApi;
	readonly events: EventsApi;
	/** Supplementary domain APIs consumed by the backstage sheets. */
	readonly memory: MemoryApi;
	readonly settings: SettingsApi;
	readonly provider: ProviderApi;
	readonly model: ModelApi;
	readonly embedding: EmbeddingBinding;
	readonly run: RunApi;
	readonly artifact: ArtifactApi;
	readonly story: StoryApi;
	readonly characters: CharacterApi;
	readonly canon: CanonApi;
	/** Commission lifecycle APIs consumed by the backstage sheets. */
	readonly commission: CommissionApi;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const CompanionStoreContext = createContext<CompanionStore | undefined>(undefined);

export function DesktopProvider(props: ParentProps<{ store: CompanionStore }>) {
	return (
		<CompanionStoreContext.Provider value={props.store}>
			{props.children}
		</CompanionStoreContext.Provider>
	);
}

export function useCompanionStore(): CompanionStore {
	const store = useContext(CompanionStoreContext);
	if (store === undefined) {
		throw new Error("useCompanionStore must be used within DesktopProvider");
	}
	return store;
}

// ---------------------------------------------------------------------------
// Internal state + presence derivation
// ---------------------------------------------------------------------------

type CompanionProcessState =
	| "starting"
	| "running"
	| "crashed"
	| "unavailable"
	| "stopped"
	| "unknown";
interface CompanionState {
	loading: boolean;
	error: string | null;
	errorMetadata: CompanionErrorMetadata | null;
	activeConversationId: string | null;
	activeBranchId: string | null;
	activePiTimeline: PiTimeline | undefined;
	pendingUserText: string | undefined;
	streamingAssistantText: string;
	assistantStreaming: boolean;
	characterRuntimeByConversation: Record<string, CharacterRuntimeState>;
	companionState: CompanionProcessState;
	sending: boolean;
	lastRunEvent: "adopted" | null;
	pendingRunPermissions: Record<string, RunPermissionRequest>;
	activeRoleplayMediaId: string | undefined;
	activeAmbientMediaId: string | undefined;
	activeRoleplayChoiceSetId: string | undefined;
}

function runTimestamp(run: RunInfo): number {
	const raw = run.startedAt ?? run.completedAt ?? "";
	const time = Date.parse(raw);
	return Number.isNaN(time) ? 0 : time;
}

function latestRun(runs: readonly RunInfo[]): RunInfo | undefined {
	let latest: RunInfo | undefined;
	for (const run of runs) {
		if (latest === undefined || runTimestamp(run) >= runTimestamp(latest)) latest = run;
	}
	return latest;
}

function derivePresence(s: {
	companionState: CompanionProcessState;
	runs: readonly RunInfo[];
	sending: boolean;
	lastRunEvent: "adopted" | null;
}): PresenceState {
	if (s.companionState === "crashed" || s.companionState === "unavailable") return "problem";
	const active = s.runs.filter(
		(run) => run.status === "enqueued" || run.status === "running" || run.status === "needs_user",
	);
	if (active.some((run) => run.status === "needs_user")) return "needs_user";
	if (active.length > 0) return "thinking";
	if (s.sending) return "listening";
	const latest = latestRun(s.runs);
	if (latest !== undefined) {
		if (latest.status === "completed" || s.lastRunEvent === "adopted") return "result_ready";
		if (latest.status === "failed" || latest.status === "forced_termination") return "problem";
	}
	return "idle";
}

/** Content of the last persisted assistant entry in the active Pi timeline. */
function lastAssistantContent(timeline: PiTimeline | undefined): string {
	if (timeline === undefined) return "";
	for (let index = timeline.entries.length - 1; index >= 0; index -= 1) {
		const entry = timeline.entries[index];
		if (entry?.kind === "message" && entry.role === "assistant") return entry.text ?? "";
	}
	return "";
}

/**
 * True when the persisted Pi assistant entry already matches or supersedes
 * the streamed text. Content comparison reconciles stream events with native
 * Pi entry ids without converting either representation.
 */
function persistedProjectionSupersedesStream(
	timeline: PiTimeline | undefined,
	streamingText: string,
): boolean {
	const trimmedText = streamingText.trim();
	if (trimmedText.length === 0) return false;
	const trimmedFinal = lastAssistantContent(timeline).trim();
	return trimmedFinal.length > 0 && trimmedFinal.startsWith(trimmedText);
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

const PENDING_REFETCHES = new Map<() => void, ReturnType<typeof setTimeout>>();

function debouncedRefetch(fn: () => void, ms = 250, key = fn): void {
	const existing = PENDING_REFETCHES.get(key);
	clearTimeout(existing);
	PENDING_REFETCHES.set(
		key,
		setTimeout(() => {
			PENDING_REFETCHES.delete(key);
			fn();
		}, ms),
	);
}

function isStaleOnboardingStep(error: unknown): boolean {
	return error instanceof IpcInvocationError && error.kind === "conflict";
}

/**
 * Build the required-client store. The renderer must inject a
 * `CompanionClient`; callers cannot omit it to request a degraded shell.
 * Transport and RPC errors remain observable through the store's error state.
 *
 * Stores are keyed by client so a component re-render (e.g. a locale change
 * re-running `CompanionRuntime`) never rebuilds the store: rebuilding would
 * drop the event subscription, snapshot cache and all in-flight state.
 */
const COMPANION_STORES = new WeakMap<CompanionClient, CompanionStore>();

export function createCompanionStore(client: CompanionClient): CompanionStore {
	const existing = COMPANION_STORES.get(client);
	if (existing !== undefined) return existing;
	const store = createCompanionStoreInner(client);
	COMPANION_STORES.set(client, store);
	return store;
}

function createCompanionStoreInner(client: CompanionClient): CompanionStore {
	const queryClient = useQueryClient();
	const [t] = useTranslation(undefined, { i18n });
	const [state, setState] = createStore<CompanionState>({
		loading: true,
		error: null,
		errorMetadata: null,
		activeConversationId: null,
		activeBranchId: null,
		activePiTimeline: undefined,
		pendingUserText: undefined,
		streamingAssistantText: "",
		assistantStreaming: false,
		characterRuntimeByConversation: {},
		companionState: "unknown",
		sending: false,
		lastRunEvent: null,
		pendingRunPermissions: {},
		activeRoleplayMediaId: undefined,
		activeAmbientMediaId: undefined,
		activeRoleplayChoiceSetId: undefined,
	});
	const retainOperationError = (operation: string, value: unknown): void => {
		setState("errorMetadata", errorMetadata(operation, value));
	};
	const clearOperationError = (): void => setState("errorMetadata", null);
	const retainProjectionError = (
		operation: string,
		value: unknown,
		source: "projection" | "stream",
	): void => {
		const metadata = projectionError(operation, value, source);
		setState("errorMetadata", metadata);
		setState("error", metadata.message);
	};

	const [lastSeq, setLastSeq] = createSignal(0);
	const [stale, setStale] = createSignal(false);
	const [memoryRevision, setMemoryRevision] = createSignal(0);
	const [memoryProjectionKey, setMemoryProjectionKey] = createSignal<readonly unknown[]>(
		queryKeys.memory,
	);
	const [memoryCandidateStatus, setMemoryCandidateStatus] = createSignal<
		MemoryCandidate["status"] | undefined
	>(undefined);
	const characterRuntimeEventSeq = new Map<string, number>();

	const onboardingStore = createOnboardingStore(client, queryClient);
	const snapshotRequest = async (): Promise<Snapshot> => {
		const snapshot = await invoke(client, () => client.snapshot.get());
		onboardingStore._hydrate(snapshot.onboarding);
		return snapshot;
	};
	const snapshotQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.snapshot,
		request: snapshotRequest,
	});
	const conversationsRequest = () => invoke(client, () => client.conversation.list());
	const memoryKey = (params?: MemoryListRequest): readonly unknown[] =>
		params?.scope === undefined ? queryKeys.memory : queryKeys.memoryProjection(params.scope);
	const conversationsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.conversations,
		request: conversationsRequest,
	});
	const memoryRequest = (params?: MemoryListRequest) =>
		invoke(client, () => client.memory.list(params));
	const memoryQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.memory,
		request: () => memoryRequest(),
		enabled: false,
	});
	const memoryCandidatesRequest = (status?: MemoryCandidate["status"]) =>
		invoke(client, () => client.memory.candidatesList({ status }));
	const memoryCandidatesQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.memoryCandidates(),
		request: () => memoryCandidatesRequest(),
		enabled: false,
	});
	const localEmbeddingCatalogRequest = () =>
		invoke(client, () => client.memory.localEmbeddingCatalog({}));
	const localEmbeddingCatalogQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.localEmbeddingCatalog,
		request: localEmbeddingCatalogRequest,
	});
	const runsRequest = () => invoke(client, () => client.run.list());
	const runsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.runs,
		request: runsRequest,
	});
	const commissionsRequest = () => invoke(client, () => client.commission.list());
	const commissionsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.commissions,
		request: commissionsRequest,
	});
	const artifactsRequest = () => invoke(client, () => client.artifact.list());
	const artifactsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.artifacts,
		request: artifactsRequest,
	});
	const storyChangesRequest = (branchId?: string) =>
		invoke(client, () => client.story.listChanges({ branchId }));
	const storyChangesQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.storyChanges,
		request: () => storyChangesRequest(state.activeBranchId ?? undefined),
	});
	const storyProposalsRequest = (conversationId?: string) =>
		invoke(client, () => client.story.listProposals({ conversationId }));
	const storyProposalsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.storyProposals,
		request: () => storyProposalsRequest(state.activeConversationId ?? undefined),
	});
	const charactersRequest = () => invoke(client, () => client.character.list());
	const charactersQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.characters,
		request: charactersRequest,
	});
	const canonSourcesRequest = () => invoke(client, () => client.canon.listSources());
	const canonSourcesQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.canonSources,
		request: canonSourcesRequest,
	});
	const canonModulesRequest = () => invoke(client, () => client.canon.listModules());
	const canonModulesQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.canonModules,
		request: canonModulesRequest,
	});

	const settingsRequest = () => invoke(client, () => client.settings.get());
	const providersRequest = () => invoke(client, () => client.provider.list());
	const modelPoolRequest = () => invoke(client, () => client.model.poolGet());
	const modelDefaultsRequest = () => invoke(client, () => client.model.defaultsGet());
	const settingsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.settings,
		request: settingsRequest,
	});
	const providersQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.providers,
		request: providersRequest,
	});
	const modelsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.modelPool,
		request: modelPoolRequest,
	});
	const defaultsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.modelDefaults,
		request: modelDefaultsRequest,
	});
	const [modelRouteRevision, setModelRouteRevision] = createSignal(0);
	const currentModelRoute = createMemo<ModelRouteData | undefined>(() => {
		modelRouteRevision();
		const conversationId = state.activeConversationId;
		return conversationId
			? queryClient.getQueryData<ModelRouteData>(queryKeys.modelRoute(conversationId))
			: undefined;
	});
	const settingsPatchMutation = createRpcMutation<SettingsPatch>({
		client: queryClient,
		request: (settings) => invoke(client, () => client.settings.set({ settings })),
		invalidates: [queryKeys.settings],
	});
	const embeddingSettingsMutation = createRpcMutation<EmbeddingSettingsValue>({
		client: queryClient,
		request: (value) => {
			const settings: SettingsPatch = isModelDownloadMirror(value)
				? { modelDownloadMirror: value }
				: { memoryVectorService: value };
			return invoke(client, () => client.settings.set({ settings }));
		},
		invalidates: [queryKeys.settings],
	});
	const localConfigureMutation = createRpcMutation<{
		provider: "none" | "local";
		candidateId?: string;
	}>({
		client: queryClient,
		request: (params) =>
			invoke(client, () =>
				client.memory.configureLocalEmbedding(
					params.provider === "local"
						? { provider: params.provider, candidateId: params.candidateId }
						: { provider: params.provider },
				),
			),
		invalidates: [queryKeys.settings],
	});
	const providerMutation = createRpcMutation<() => Promise<unknown>>({
		client: queryClient,
		request: (request) => request(),
		invalidates: [queryKeys.providers],
	});
	const modelMutation = createRpcMutation<() => Promise<unknown>>({
		client: queryClient,
		request: (request) => request(),
		invalidates: [queryKeys.modelPool],
	});
	const modelDefaultsMutation = createRpcMutation<() => Promise<unknown>>({
		client: queryClient,
		request: (request) => request(),
		invalidates: [queryKeys.modelDefaults],
	});

	let booted = false;
	let conversationSelectionChangedLocally = false;

	// ---- refresh helpers (each re-fetches one domain list) ----

	const refreshSnapshot = () =>
		refreshRpcQuery({ client: queryClient, key: queryKeys.snapshot, request: snapshotRequest });
	const refreshConversations = async (): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.conversations,
			request: conversationsRequest,
		});
	};
	const refreshRuns = async (): Promise<void> => {
		await refreshRpcQuery({ client: queryClient, key: queryKeys.runs, request: runsRequest });
	};
	const refreshMemoryEntries = async (params?: MemoryListRequest): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: memoryKey(params),
			request: () => memoryRequest(params),
		});
		setMemoryRevision((revision) => revision + 1);
	};
	const refreshMemoryCandidates = async (
		status?: MemoryCandidate["status"],
	): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.memoryCandidates(status),
			request: () => memoryCandidatesRequest(status),
		});
		setMemoryRevision((revision) => revision + 1);
	};
	const debouncedRefreshMemoryEntries = (): void => {
		debouncedRefetch(() => void refreshMemoryEntries(), 250, refreshMemoryEntries);
	};
	const debouncedRefreshMemoryCandidates = (): void => {
		debouncedRefetch(() => void refreshMemoryCandidates(), 250, refreshMemoryCandidates);
	};
	const refreshCommissions = async (): Promise<void> => {
		await refreshRpcQuery({ client: queryClient, key: queryKeys.commissions, request: commissionsRequest });
	};
	const refreshArtifacts = async (): Promise<void> => {
		await refreshRpcQuery({ client: queryClient, key: queryKeys.artifacts, request: artifactsRequest });
	};
	const refreshStory = async (branchId?: string): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.storyChanges,
			request: () => storyChangesRequest(branchId ?? state.activeBranchId ?? undefined),
		});
	};
	const refreshStoryProposals = async (conversationId?: string): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.storyProposals,
			request: () =>
				storyProposalsRequest(conversationId ?? state.activeConversationId ?? undefined),
		});
	};
	const refreshCharacters = async (): Promise<void> => {
		await refreshRpcQuery({ client: queryClient, key: queryKeys.characters, request: charactersRequest });
	};
	const refreshCanonSources = async (): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonSources,
			request: canonSourcesRequest,
		});
	};
	const refreshCanonModules = async (): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonModules,
			request: canonModulesRequest,
		});
	};
	const refreshSupplementary = async (): Promise<void> => {
		await Promise.all([
			refreshMemoryEntries(),
			refreshMemoryCandidates(),
			refreshCommissions(),
			refreshRuns(),
			refreshArtifacts(),
			refreshStory(),
			refreshStoryProposals(),
			refreshCharacters(),
			refreshCanonSources(),
			refreshCanonModules(),
		]);
	};

	// ---- snapshot → query-cache hydration ----

	// ---- snapshot → domain hydration ----

	const hydrateFromSnapshot = (snap: Snapshot): void => {
		onboardingStore._hydrate(snap.onboarding);
		const conversation = snap.conversation;
		if (conversation) {
			const snapshotConversationId = conversation.activeConversationId;
			const acceptsActiveProjection =
				!conversationSelectionChangedLocally ||
				snapshotConversationId === state.activeConversationId;
			if (snapshotConversationId !== undefined && acceptsActiveProjection) {
				setState("activeConversationId", snapshotConversationId);
				void refreshRpcQuery({
					client: queryClient,
					key: queryKeys.modelRoute(snapshotConversationId),
					request: () => invoke(client, () => client.model.routeGet({ conversationId: snapshotConversationId })),
				}).then(() => setModelRouteRevision((revision) => revision + 1));
			}
			if (acceptsActiveProjection && conversation.activeBranchId !== undefined) {
				setState("activeBranchId", conversation.activeBranchId);
			}
			if (
				conversationSelectionChangedLocally &&
				snapshotConversationId === state.activeConversationId
			) {
				conversationSelectionChangedLocally = false;
			}
			if (acceptsActiveProjection && conversation.conversations !== undefined) {
				queryClient.setQueryData(queryKeys.conversations, {
					conversations: conversation.conversations,
				});
			}
			if (acceptsActiveProjection && snapshotConversationId !== undefined) {
				try {
					const timeline = requirePiTimeline(conversation.piTimeline, "conversation.snapshot");
					setState("activePiTimeline", timeline);
					if (persistedProjectionSupersedesStream(timeline, state.streamingAssistantText)) {
						setState("streamingAssistantText", "");
						setState("assistantStreaming", false);
					}
				} catch (error) {
					setState("activePiTimeline", undefined);
					retainProjectionError("conversation.snapshot", error, "projection");
				}
			}
		}
		if (snap.memory?.entries !== undefined) {
			queryClient.setQueryData(queryKeys.memory, { entries: snap.memory.entries });
			setMemoryRevision((revision) => revision + 1);
		}
		if (snap.run) queryClient.setQueryData(queryKeys.runs, { runs: snap.run.runs });
		if (snap.commission)
			queryClient.setQueryData(queryKeys.commissions, { commissions: snap.commission.commissions });
		if (snap.artifact)
			queryClient.setQueryData(queryKeys.artifacts, { artifacts: snap.artifact.artifacts });
		if (snap.story) queryClient.setQueryData(queryKeys.storyChanges, { changes: snap.story.changes });
		if (snap.characterRuntime) {
			const incoming = snap.characterRuntime.byConversation;
			const next = { ...state.characterRuntimeByConversation };
			for (const conversationId of Object.keys(next)) {
				const eventSeq = characterRuntimeEventSeq.get(conversationId) ?? 0;
				if (eventSeq <= snap.eventSeq && incoming[conversationId] === undefined) {
					delete next[conversationId];
				}
			}
			for (const [conversationId, runtime] of Object.entries(incoming)) {
				const eventSeq = characterRuntimeEventSeq.get(conversationId) ?? 0;
				if (eventSeq <= snap.eventSeq) {
					next[conversationId] = runtime;
					characterRuntimeEventSeq.delete(conversationId);
				}
			}
			setState("characterRuntimeByConversation", next);
		}
		setLastSeq(Math.max(lastSeq(), snap.eventSeq));
	};

	const snapshotValue = createMemo<Snapshot | undefined>(() => snapshotQuery.data);
	const activeConversations = createMemo<ConversationSummary[]>(
		() => conversationsQuery.data?.conversations ?? snapshotValue()?.conversation?.conversations ?? [],
	);
	const activeRuns = createMemo<RunInfo[]>(() => runsQuery.data?.runs ?? snapshotValue()?.run?.runs ?? []);
	const presence = createMemo<PresenceState>(() =>
		derivePresence({
			companionState: state.companionState,
			runs: activeRuns(),
			sending: state.sending,
			lastRunEvent: state.lastRunEvent,
		}),
	);

	createEffect(() => {
		if (snapshotQuery.isLoading) return;
		const failure = snapshotQuery.error;
		if (failure !== undefined && failure !== null) {
			retainProjectionError("snapshot.get", failure, "projection");
		} else {
			const data = snapshotValue();
			if (data !== undefined) {
				if (
					state.errorMetadata?.source === "projection" ||
					state.errorMetadata?.source === "stream"
				) {
					setState("errorMetadata", null);
					setState("error", null);
				}
				hydrateFromSnapshot(data);
			}
		}
		setState("loading", false);
		setStale(false);
		if (!booted) {
			booted = true;
			void refreshSupplementary().catch((e) => retainOperationError("boot.supplementary", e));
		}
	});

	// ---- event subscription loop ----

	const eventsApi: EventsApi = {
		lastSeq,
		stale,
		subscribe: (afterSeq) =>
			invoke(client, () => client.events.subscribe({ afterSeq })).then((batch) => batch.events),
	};

	const dispatchEvent = (event: DomainEvent): void => {
		const knownEvent: KnownDomainEvent | undefined = parseKnownDomainEvent(event);
		if (!knownEvent) return;
		switch (knownEvent.kind) {
			case "message.user_sent":
				setState("sending", true);
				setState("lastRunEvent", null);
				return;
			case "message_start":
				setState("sending", true);
				setState("assistantStreaming", true);
				return;
			case "message_update": {
				const chunk = knownEvent.payload.text;
				const nextText = chunk.startsWith(state.streamingAssistantText)
					? chunk
					: `${state.streamingAssistantText}${chunk}`;
				// A late delta from a settled Pi turn can arrive after the persisted
				// final assistant projection already matched/superseded the streamed
				// draft. Stream events carry legacy message ids while the projection
				// carries Pi entry ids, so the content comparison is the source of
				// truth: once the projection closes the text, do not resurrect the
				// responding status (the refetch already settled the turn).
				if (
					!state.assistantStreaming &&
					nextText.length > 0 &&
					persistedProjectionSupersedesStream(state.activePiTimeline, nextText)
				) {
					setState("streamingAssistantText", "");
					return;
				}
				setState("assistantStreaming", true);
				setState("streamingAssistantText", nextText);
				return;
			}
			case "message_end": {
				const finalText = knownEvent.payload.text;
				if (finalText !== undefined) setState("streamingAssistantText", finalText);
				setState("sending", false);
				setState("assistantStreaming", false);
				// The final persisted projection supersedes the draft; leave it to
				// the refetch to clear the draft once the committed message lands.
				void refreshSnapshot();
				void refreshActiveConversationProjection().catch((error) =>
					retainProjectionError("conversation.refreshProjection", error, "projection"),
				);
				return;
			}
			case "message.assistant_committed": {
				// Stream events carry the legacy DB message id, while Pi sessions
				// project entry ids; the snapshot is the reconciliation source and
				// clears the draft by content (see hydrateFromSnapshot).
				setState("sending", false);
				setState("assistantStreaming", false);
				void refreshSnapshot();
				void refreshActiveConversationProjection().catch((error) =>
					retainProjectionError("conversation.refreshProjection", error, "projection"),
				);
				return;
			}
			case "message.aborted":
				setState("sending", false);
				setState("assistantStreaming", false);
				setState("streamingAssistantText", "");
				return;
			case "character.scene_changed":
			case "character.visual_state_changed": {
				const { conversationId, sceneId, visualState } = knownEvent.payload;
				if (conversationId !== undefined && sceneId !== undefined && visualState !== undefined) {
					characterRuntimeEventSeq.set(conversationId, knownEvent.seq);
					setState("characterRuntimeByConversation", conversationId, { sceneId, visualState });
				}
				return;
			}
			case "roleplay.media_presented": {
				const { conversationId, mediaId } = knownEvent.payload;
				if (conversationId !== state.activeConversationId) return;
				const media = mediaId
					? snapshotValue()?.character?.roleplay.media.find((entry) => entry.id === mediaId)
					: undefined;
				if (media !== undefined) {
					if (media.presentation === "ambient") setState("activeAmbientMediaId", media.id);
					else setState("activeRoleplayMediaId", media.id);
				}
				return;
			}
			case "roleplay.media_dismissed": {
				const { conversationId, mediaId } = knownEvent.payload;
				if (conversationId !== state.activeConversationId) return;
				if (state.activeAmbientMediaId === mediaId) setState("activeAmbientMediaId", undefined);
				if (state.activeRoleplayMediaId === mediaId) setState("activeRoleplayMediaId", undefined);
				return;
			}
			case "roleplay.choices_presented":
				setState("activeRoleplayChoiceSetId", knownEvent.payload.choiceSetId);
				return;
			case "conversation.created": {
				debouncedRefetch(refreshConversations);
				return;
			}
			case "model.selected": {
				const conversationId = knownEvent.payload.conversationId;
				if (conversationId) void refreshModelRoute(conversationId);
				return;
			}
			case "model.defaults_changed":
				void refreshModelDefaults();
				return;
			case "model.enabled":
			case "model.disabled":
				void refreshModelPool();
				return;
			case "conversation.branched": {
				const branchId = knownEvent.payload.branchId;
				if (branchId) setState("activeBranchId", branchId);
				void refreshSnapshot();
				return;
			}
			case "onboarding.state_changed":
			case "onboarding.reset":
				onboardingStore._applyEvent(knownEvent);
				return;
			case "companion.state_changed": {
				const next = knownEvent.payload.state;
				setState(
					"companionState",
					next === "running" || next === "crashed" || next === "unavailable" || next === "stopped"
						? next
						: "unknown",
				);
				if (next === "crashed" || next === "unavailable") void refreshSnapshot();
				return;
			}
			case "run.needs_user": {
				const permission = parseRunPermission(knownEvent.payload);
				setState("pendingRunPermissions", permission.runId, permission);
				debouncedRefetch(refreshRuns);
				return;
			}
			case "run.result_adopted":
				setState("lastRunEvent", "adopted");
				debouncedRefetch(refreshRuns);
				return;
			default:
				break;
		}
		const kind = knownEvent.kind;
		if (kind.startsWith("message.") || kind.startsWith("conversation.")) {
			void refreshSnapshot();
		} else if (kind.startsWith("onboarding.")) {
			onboardingStore._applyEvent(knownEvent);
		} else if (kind.startsWith("model.")) {
			void refreshModelPool();
			void refreshModelDefaults();
			if (state.activeConversationId) void refreshModelRoute(state.activeConversationId);
		} else if (kind.startsWith("memory.")) {
			debouncedRefreshMemoryEntries();
			debouncedRefreshMemoryCandidates();
		} else if (kind.startsWith("commission.")) {
			debouncedRefetch(refreshCommissions);
		} else if (kind.startsWith("run.")) {
			const runId =
				"runId" in knownEvent.payload && typeof knownEvent.payload.runId === "string"
					? knownEvent.payload.runId
					: undefined;
			if (
				runId &&
				(kind === "run.resumed" ||
					kind === "run.completed" ||
					kind === "run.cancelled" ||
					kind === "run.interrupted")
			) {
				const { [runId]: _resolved, ...remaining } = state.pendingRunPermissions;
				setState("pendingRunPermissions", remaining);
			}
			debouncedRefetch(refreshRuns);
		} else if (kind.startsWith("artifact.")) {
			debouncedRefetch(refreshArtifacts);
		} else if (kind.startsWith("story.")) {
			debouncedRefetch(refreshStory);
			debouncedRefetch(refreshStoryProposals);
		} else if (kind.startsWith("character.")) {
			debouncedRefetch(refreshCharacters);
			void refreshSnapshot();
		} else if (kind.startsWith("roleplay.")) {
			void refreshSnapshot();
		} else if (kind.startsWith("settings.")) {
			void queryClient.invalidateQueries(
				{ queryKey: queryKeys.settings },
				{ cancelRefetch: false },
			);
		}
		// Other kinds (evidence.collected, codex.*, fsops.*, diagnostics.* …)
		// are intentionally ignored: they do not invalidate projected state.
	};

	createEffect(() => {
		if (
			snapshotQuery.isLoading ||
			(snapshotQuery.error !== undefined && snapshotQuery.error !== null)
		)
			return;
		const data = snapshotValue();
		if (data === undefined) return;
		let cancelled = false;
		onCleanup(() => {
			cancelled = true;
		});
		void (async () => {
			let afterSeq = data.eventSeq;
			while (!cancelled) {
				let batch: DomainEvent[];
				try {
					batch = await eventsApi.subscribe(afterSeq);
				} catch (error) {
					if (cancelled) return;
					retainProjectionError("events.subscribe", error, "stream");
					setStale(true);
					void refreshSnapshot();
					return;
				}
				if (cancelled) return;
				if (batch.length === 0) return;
				const first = batch[0];
				if (first === undefined) continue;
				if (first.seq > afterSeq + 1) {
					// Gap: the projection is untrustworthy — re-sync from the snapshot.
					retainProjectionError("events.sequence_gap", new Error("event sequence gap"), "stream");
					setStale(true);
					void refreshSnapshot();
					return;
				}
				if (first.seq <= afterSeq) return;
				let cursor = afterSeq;
				for (const event of batch) {
					if (event.seq !== cursor + 1) {
						// A malformed row may have been omitted from a replay batch.
						// Validate every boundary so a later event cannot look contiguous.
						retainProjectionError("events.sequence_gap", new Error("event sequence gap"), "stream");
						setStale(true);
						void refreshSnapshot();
						return;
					}
					dispatchEvent(event);
					cursor = event.seq;
				}
				afterSeq = cursor;
				setLastSeq(afterSeq);
			}
		})();
	});

	// ---- presence derivation ----

	// presence is a named selector over live state and the query-backed run list.

	// ---- actions ----

	const requireActiveConversation = (): string => {
		const id = state.activeConversationId;
		if (id === null) throw new Error(t("messages.noActiveConversationError"));
		return id;
	};
	const setConversationProjection = (projection: {
		activeConversationId?: string;
		activeBranchId?: string | null;
		piTimeline?: PiTimeline;
	}): void => {
		const snapshotProjection = {
			...projection,
			activeBranchId: projection.activeBranchId ?? undefined,
		};
		queryClient.setQueryData<Snapshot | undefined>(queryKeys.snapshot, (current) =>
			current
				? { ...current, conversation: { ...current.conversation, ...snapshotProjection } }
				: current,
		);
	};
	const refreshActiveConversationProjection = async (): Promise<void> => {
		const conversationId = state.activeConversationId;
		if (conversationId === null) return;
		const projection = await invoke(client, () =>
			client.conversation.select({
				id: conversationId,
				...(state.activeBranchId !== null ? { branchId: state.activeBranchId } : {}),
			}),
		);
		if (!projection) return;
		if (state.activeConversationId !== conversationId) return;
		const timeline = requirePiTimeline(projection.piTimeline, "conversation.refresh");
		setState("activeBranchId", projection.activeBranchId ?? null);
		setState("activePiTimeline", timeline);
		setConversationProjection({
			activeConversationId: projection.activeConversationId,
			activeBranchId: projection.activeBranchId ?? null,
			piTimeline: timeline,
		});
		setState("streamingAssistantText", "");
		setState("assistantStreaming", false);
	};

	const snapshotApi: SnapshotApi = {
		data: snapshotValue,
		eventSeq: () => snapshotValue()?.eventSeq ?? 0,
		loading: () => snapshotQuery.isLoading,
		error: () => snapshotQuery.error,
		refetch: () => {
			void refreshSnapshot();
		},
		get: snapshotRequest,
	};

	const activeMemoryEntries = createMemo<MemoryEntry[] | undefined>(() => {
		memoryRevision();
		const key = memoryProjectionKey();
		return key === queryKeys.memory
			? memoryQuery.data?.entries
			: queryClient.getQueryData<MemorySearchData>(key)?.entries;
	});
	const activeMemoryCandidates = createMemo<MemoryCandidate[] | undefined>(() => {
		memoryRevision();
		const status = memoryCandidateStatus();
		return status === undefined
			? memoryCandidatesQuery.data?.candidates
			: queryClient.getQueryData<{ candidates: MemoryCandidate[] }>(
					queryKeys.memoryCandidates(status),
				)?.candidates;
	});
	const localEmbeddingCandidates = createMemo<LocalEmbeddingCandidate[] | undefined>(
		() => localEmbeddingCatalogQuery.data?.candidates,
	);
	const memoryApi: MemoryApi = {
	entries: activeMemoryEntries,
	revision: memoryRevision,
	list: async (params) => {
		const key = memoryKey(params);
		setMemoryProjectionKey(key);
		const data = await refreshRpcQuery({
			client: queryClient,
			key,
			request: () => memoryRequest(params),
		});
		setMemoryRevision((revision) => revision + 1);
		return data.entries;
	},
	search: async (query, scope) => {
		const key = queryKeys.memoryProjection(scope, query);
		setMemoryProjectionKey(key);
		const data = await refreshRpcQuery({
			client: queryClient,
			key,
			request: () => invoke(client, () => client.memory.search({ query, scope })),
		});
		setMemoryRevision((revision) => revision + 1);
		return data.entries;
	},
		capture: async (entryId) => {
			try {
				const conversationId = requireActiveConversation();
				const result = await invoke(client, () =>
					client.memory.capture({ conversationId, entryId }),
				);
				setMemoryRevision((revision) => revision + 1);
				clearOperationError();
				await refreshMemoryEntries();
				return result;
			} catch (e) {
				retainOperationError("memory.capture", e);
				throw e;
			}
		},
		localEmbeddingCandidates,
		listLocalEmbeddingCandidates: async () => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.localEmbeddingCatalog,
				request: localEmbeddingCatalogRequest,
			});
			return data.candidates;
		},
		configureLocalEmbedding: async (provider, candidateId) => {
			try {
				const result = (await localConfigureMutation.mutateAsync({
					provider,
					...(provider === "local" && candidateId ? { candidateId } : {}),
				})) as { ready: true };
				clearOperationError();
				await refreshRpcQuery({
					client: queryClient,
					key: queryKeys.settings,
					request: settingsRequest,
				});
				return result;
			} catch (error) {
				retainOperationError("memory.configureLocalEmbedding", error);
				throw error;
			}
		},
		forget: async (entryId) => {
			await invoke(client, () => client.memory.forget({ entryId }));
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryEntries();
		},
		edit: async (entryId, newText) => {
			await invoke(client, () => client.memory.edit({ entryId, newText }));
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryEntries();
		},
		exclude: async (memoryId, excluded) => {
			await invoke(client, () => client.memory.exclude({ memoryId, excluded }));
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryEntries();
		},
		candidates: activeMemoryCandidates,
		listCandidates: async (status) => {
			setMemoryCandidateStatus(status);
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.memoryCandidates(status),
				request: () => memoryCandidatesRequest(status),
			});
			setMemoryRevision((revision) => revision + 1);
			return data.candidates;
		},
		approveCandidate: async (candidateId, editedText, decidedScope) => {
			await invoke(client, () =>
				client.memory.candidateApprove({ candidateId, editedText, decidedScope }),
			);
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryCandidates();
			debouncedRefreshMemoryEntries();
		},
		rejectCandidate: async (candidateId) => {
			await invoke(client, () => client.memory.candidateReject({ candidateId }));
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryCandidates();
			debouncedRefreshMemoryEntries();
		},
	};

	const settingsApi: SettingsApi = {
		data: () => settingsQuery.data?.settings,
		get: async () => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.settings,
				request: settingsRequest,
			});
			return data.settings;
		},
		set: async (settings) => {
			await settingsPatchMutation.mutateAsync(settings);
		},
	};
	const refreshModelPool = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.modelPool,
			request: modelPoolRequest,
		});
	const refreshModelDefaults = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.modelDefaults,
			request: modelDefaultsRequest,
		});
	const refreshModelRoute = (conversationId: string) =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.modelRoute(conversationId),
			request: () => invoke(client, () => client.model.routeGet({ conversationId })),
		}).then((data) => {
			setModelRouteRevision((revision) => revision + 1);
			return data;
		});

	const providerApi: ProviderApi = {
		providers: () => providersQuery.data?.providers ?? [],
		list: () =>
			refreshRpcQuery({
				client: queryClient,
				key: queryKeys.providers,
				request: providersRequest,
			}),
		customUpsert: async (params) => {
			await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.customUpsert(params)),
			);
		},
		importPiConfig: async (configJson) => {
			const result = (await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.importPiConfig({ configJson })),
			)) as { models: ConfiguredModel[] };
			await refreshModelPool();
			return result.models;
		},
		overrideBaseUrl: async (params) => {
			await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.overrideBaseUrl(params)),
			);
		},
		setApiKey: async (providerId, apiKey, sessionOnly) => {
			await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.setApiKey({ providerId, apiKey, sessionOnly })),
			);
		},
		login: (providerId) =>
			invoke(client, () => client.provider.login({ providerId, authType: "oauth" })),
		loginStatus: (providerId) => invoke(client, () => client.provider.loginStatus({ providerId })),
		loginAnswer: (providerId, answer) =>
			invoke(client, () => client.provider.loginAnswer({ providerId, answer })),
		logout: async (providerId) => {
			await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.logout({ providerId })),
			);
		},
	};

	const modelData = createMemo<ModelListData>(() => {
		const models = modelsQuery.data?.models ?? [];
		const defaults = defaultsQuery.data ?? { vision: { mode: "auto" as const } };
		const selected = currentModelRoute()?.selected;
		const multimodalFallback =
			defaults.vision.mode === "manual"
				? defaults.vision.route
				: models.find((model) => model.supportsImages);
		return {
			models,
			defaults,
			...(selected ? { selected } : {}),
			...(multimodalFallback
				? {
						multimodalFallback: {
							providerId: multimodalFallback.providerId,
							modelId: multimodalFallback.modelId,
						},
					}
				: {}),
		};
	});
	const selectedModelValue = createMemo(() => {
		const route = currentModelRoute()?.selected;
		return route ? `${route.providerId}:${route.modelId}` : "";
	});
	const modelApi: ModelApi = {
		data: modelData,
		models: () => modelsQuery.data?.models ?? [],
		selectedValue: selectedModelValue,
		loading: () => modelsQuery.isFetching || defaultsQuery.isFetching,
		error: () => modelsQuery.error ?? defaultsQuery.error,
		refetch: () => {
			void refreshModelPool();
			void refreshModelDefaults();
			if (state.activeConversationId) void refreshModelRoute(state.activeConversationId);
		},
		list: (conversationId) => {
			return Promise.all([
				refreshModelPool(),
				refreshModelDefaults(),
				...(conversationId ? [refreshModelRoute(conversationId)] : []),
			]).then(() => modelApi.data());
		},
		enable: async (providerId, modelId, label) => {
			await modelMutation.mutateAsync(() =>
				invoke(client, () => client.model.enable({ providerId, modelId, label })),
			);
			await Promise.all([refreshModelPool(), refreshModelDefaults()]);
		},
		disable: async (providerId, modelId) => {
			await modelMutation.mutateAsync(() =>
				invoke(client, () => client.model.disable({ providerId, modelId })),
			);
			await Promise.all([refreshModelPool(), refreshModelDefaults()]);
		},
		select: async (conversationId, providerId, modelId) => {
			await invoke(client, () =>
				client.model.routeSet({
					conversationId,
					selected: { providerId, modelId },
				}),
			);
			await refreshModelRoute(conversationId);
		},
		setMultimodalFallback: async (providerId, modelId) => {
			await modelDefaultsMutation.mutateAsync(() =>
				invoke(client, () =>
					client.model.defaultsSetVision({
						mode: "manual",
						route: { providerId, modelId },
					}),
				),
			);
			await refreshModelDefaults();
		},
		setDefaultReply: async (providerId, modelId) => {
			await modelDefaultsMutation.mutateAsync(() =>
				invoke(client, () => client.model.defaultsSetReply({ reply: { providerId, modelId } })),
			);
			await refreshModelDefaults();
		},
		clearDefaultReply: async () => {
			await modelDefaultsMutation.mutateAsync(() =>
				invoke(client, () => client.model.defaultsSetReply({ reply: null })),
			);
			await refreshModelDefaults();
		},
		setVisionAuto: async () => {
			await modelDefaultsMutation.mutateAsync(() =>
				invoke(client, () => client.model.defaultsSetVision({ mode: "auto" })),
			);
			await refreshModelDefaults();
		},
	};

	const activeCommissions = createMemo<Commission[]>(() => commissionsQuery.data?.commissions ?? []);
	const commissionApi: CommissionApi = {
		commissions: activeCommissions,
		list: async () => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.commissions,
				request: commissionsRequest,
			});
			return data;
		},
		draft: async (params) => {
			const data = await invoke(client, () => client.commission.draft(params));
			void refreshCommissions();
			return data;
		},
		approve: async (commissionId, approvedHash) => {
			await invoke(client, () => client.commission.approve({ commissionId, approvedHash }));
			void refreshCommissions();
		},
		reject: async (commissionId) => {
			await invoke(client, () => client.commission.reject({ commissionId }));
			void refreshCommissions();
		},
		launch: async (commissionId, executorProfile) => {
			const data = await invoke(client, () =>
				client.commission.launch({ commissionId, executorProfile }),
			);
			void refreshCommissions();
			void refreshRuns();
			return data;
		},
	};

	const runApi: RunApi = {
		list: async () => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.runs,
				request: runsRequest,
			});
			return data;
		},
		pendingPermissions: () => Object.values(state.pendingRunPermissions),
		steer: async (runId, instruction) => {
			await invoke(client, () => client.run.steer({ runId, instruction }));
		},
		interrupt: async (runId) => {
			const data = await invoke(client, () => client.run.interrupt({ runId }));
			void refreshRuns();
			void refreshCommissions();
			return data;
		},
		resume: async (runId) => {
			const data = await invoke(client, () => client.run.resume({ runId }));
			void refreshRuns();
			void refreshCommissions();
			return data;
		},
		cancel: async (runId) => {
			const data = await invoke(client, () => client.run.cancel({ runId }));
			const { [runId]: _permission, ...remaining } = state.pendingRunPermissions;
			setState("pendingRunPermissions", remaining);
			void refreshRuns();
			void refreshCommissions();
			return data;
		},
		respondPermission: async (runId, requestId, optionId) => {
			const data = await invoke(client, () =>
				client.run.respondPermission({ runId, requestId, optionId }),
			);
			const { [runId]: _permission, ...remaining } = state.pendingRunPermissions;
			setState("pendingRunPermissions", remaining);
			void refreshRuns();
			void refreshCommissions();
			return data;
		},
	};

	const activeArtifacts = createMemo<Artifact[]>(() => artifactsQuery.data?.artifacts ?? []);
	const artifactApi: ArtifactApi = {
		artifacts: activeArtifacts,
		list: async () => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.artifacts,
				request: artifactsRequest,
			});
			return data;
		},
		read: async (artifactId) => {
			const data = await invoke(client, () => client.artifact.read({ artifactId }));
			return data;
		},
		url: async (artifactId) => {
			const { url } = await invoke(client, () => client.artifact.url({ artifactId }));
			return url;
		},
		download: async (artifactId) => {
			const data = await invoke(client, () => client.artifact.read({ artifactId }));
			const bytes = Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0));
			const url = URL.createObjectURL(new Blob([copyToArrayBuffer(bytes)], { type: data.mime }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = data.logicalName;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		},
	};

	const activeStoryChanges = createMemo<StoryChange[]>(() => storyChangesQuery.data?.changes ?? []);
	const activeStoryProposals = createMemo<StoryChangeProposal[]>(() =>
		(storyProposalsQuery.data?.proposals ?? []).filter(
			(proposal) => proposal.conversationId === state.activeConversationId,
		),
	);
	const storyApi: StoryApi = {
		changes: activeStoryChanges,
		proposals: activeStoryProposals,
		list: async (branchId) => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.storyChanges,
				request: () => storyChangesRequest(branchId),
			});
			return data;
		},
		apply: async (text, scope) => {
			await invoke(client, () =>
				client.story.applyChange({
					text,
					scope,
					conversationId: state.activeConversationId ?? undefined,
					branchId: state.activeBranchId ?? undefined,
				}),
			);
			await refreshStory();
		},
		revert: async (changeId) => {
			await invoke(client, () =>
				client.story.revertChange({
					changeId,
					conversationId: state.activeConversationId ?? undefined,
				}),
			);
			await refreshStory();
		},
		reset: async () => {
			await invoke(client, () =>
				client.story.reset({
					conversationId: state.activeConversationId ?? undefined,
					branchId: state.activeBranchId ?? undefined,
				}),
			);
			await refreshStory();
		},
		resolveProposal: async (proposalId, accept) => {
			await invoke(client, () => client.story.resolveProposal({ proposalId, accept }));
			await Promise.all([refreshStory(), refreshStoryProposals()]);
		},
	};

	const activeCharacters = createMemo<CharacterSummary[]>(() => charactersQuery.data?.characters ?? []);
	const characterApi: CharacterApi = {
		characters: activeCharacters,
		list: async () => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.characters,
				request: charactersRequest,
			});
			return data;
		},
		activate: async (characterId) => {
			await invoke(client, () => client.character.activate({ characterId }));
			conversationSelectionChangedLocally = true;
			setState("activeConversationId", null);
			setState("activeRoleplayMediaId", undefined);
			setState("activeAmbientMediaId", undefined);
			setState("activeRoleplayChoiceSetId", undefined);
			setState("activeBranchId", null);
			await Promise.all([
				onboardingStore.resync(),
				refreshCharacters(),
				refreshConversations(),
				refreshSnapshot(),
			]);
		},
		import: async (files) => {
			await invoke(client, () => client.character.import({ files }));
			await refreshCharacters();
		},
		pluginTrust: async (characterId) => {
			const { trust } = await invoke(client, () =>
				client.character.pluginTrustGet({ characterId }),
			);
			return trust;
		},
		confirmPluginTrust: async (characterId) => {
			await invoke(client, () => client.character.pluginTrustConfirm({ characterId }));
		},
		draftCreate: async (params = {}) => {
			const { draft } = await invoke(client, () => client.character.draftCreate(params));
			return draft;
		},
		draftGet: async (id) => {
			const { draft } = await invoke(client, () => client.character.draftGet({ id }));
			return draft;
		},
		draftPatch: async (id, expectedRevision, files) => {
			const { draft } = await invoke(client, () =>
				client.character.draftPatch({ id, expectedRevision, files }),
			);
			return draft;
		},
		draftUploadAssets: async (id, expectedRevision, assets) => {
			const { draft } = await invoke(client, () =>
				client.character.draftUploadAssets({ id, expectedRevision, assets }),
			);
			return draft;
		},
		draftListRevisions: async (id) => {
			const { revisions } = await invoke(client, () => client.character.draftListRevisions({ id }));
			return revisions;
		},
		draftRestoreRevision: async (id, expectedRevision, sourceRevision) => {
			const { draft } = await invoke(client, () =>
				client.character.draftRestoreRevision({ id, expectedRevision, sourceRevision }),
			);
			return draft;
		},
		draftValidate: async (id, expectedRevision) => {
			const { draft } = await invoke(client, () =>
				client.character.draftValidate({ id, expectedRevision }),
			);
			return draft;
		},
		draftPublish: async (id, expectedRevision) => {
			const { draft } = await invoke(client, () =>
				client.character.draftPublish({ id, expectedRevision }),
			);
			conversationSelectionChangedLocally = true;
			setState("activeConversationId", null);
			setState("activeBranchId", null);
			await Promise.all([
				onboardingStore.resync(),
				refreshCharacters(),
				refreshConversations(),
				refreshSnapshot(),
			]);
			return draft;
		},
	};
	const activeCanonSources = createMemo<CanonSource[]>(() => canonSourcesQuery.data?.sources ?? []);
	const activeCanonModules = createMemo<CanonModule[]>(() => canonModulesQuery.data?.modules ?? []);
	const canonApi: CanonApi = {
		sources: activeCanonSources,
		modules: activeCanonModules,
		listSources: async () => {
			await refreshCanonSources();
		},
		addSource: async (logicalName, content) => {
			await invoke(client, () => client.canon.addSource({ logicalName, content }));
			await refreshCanonSources();
		},
		search: async (query) => {
			const { chunks } = await invoke(client, () => client.canon.search({ query }));
			return chunks;
		},
		removeSource: async (sourceId) => {
			await invoke(client, () => client.canon.removeSource({ sourceId }));
			await refreshCanonSources();
		},
		listModules: async () => {
			await refreshCanonModules();
		},
		upsertModule: async (params) => {
			await invoke(client, () => client.canon.upsertModule(params));
			await refreshCanonModules();
		},
		deleteModule: async (id) => {
			await invoke(client, () => client.canon.deleteModule({ id }));
			await refreshCanonModules();
		},
	};
	const trackApi = <T extends object>(name: string, api: T): T =>
		new Proxy(api, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					try {
						const result = value.apply(target, args);
						if (typeof result?.then === "function") {
							return result.catch((cause: unknown) => {
								retainOperationError(`${name}.${String(property)}`, cause);
								throw cause;
							});
						}
						return result;
					} catch (cause) {
						retainOperationError(`${name}.${String(property)}`, cause);
						throw cause;
					}
				};
			},
		});
	const embeddingBinding: EmbeddingBinding = {
		settingsQuery,
		catalogQuery: localEmbeddingCatalogQuery,
		settingsMutation: embeddingSettingsMutation,
		localConfigureMutation,
	};
	const trackedMemoryApi = trackApi("memory", memoryApi);
	const trackedSettingsApi = trackApi("settings", settingsApi);
	const trackedProviderApi = trackApi("provider", providerApi);
	const trackedModelApi = trackApi("model", modelApi);
	const trackedCommissionApi = trackApi("commission", commissionApi);
	const trackedRunApi = trackApi("run", runApi);
	const trackedArtifactApi = trackApi("artifact", artifactApi);
	const trackedStoryApi = trackApi("story", storyApi);
	const trackedCharacterApi = trackApi("character", characterApi);
	const trackedCanonApi = trackApi("canon", canonApi);

	return {
		get loading() {
			return state.loading;
		},
		get error() {
			return state.error;
		},
		get errorMetadata() {
			return state.errorMetadata;
		},
		get onboarding() {
			return onboardingStore.data();
		},
		get conversations() {
			return activeConversations();
		},
		get activeConversationId() {
			return state.activeConversationId;
		},
		get activePiTimeline() {
			return state.activePiTimeline;
		},
		get pendingUserText() {
			return state.pendingUserText;
		},
		get streamingAssistantText() {
			return state.streamingAssistantText;
		},
		get assistantStreaming() {
			return state.assistantStreaming;
		},
		get runs() {
			return activeRuns();
		},
		get presence() {
			return presence();
		},

		refresh: async () => {
			setState("loading", true);
			try {
				await Promise.all([refreshConversations(), refreshSnapshot()]);
				if (
					snapshotQuery.error === undefined &&
					(state.errorMetadata?.source === "projection" || state.errorMetadata?.source === "stream")
				) {
					setState("error", null);
					setState("errorMetadata", null);
				}
			} catch (e) {
				retainOperationError("refresh.conversations", e);
			} finally {
				setState("loading", false);
			}
			try {
				await refreshSupplementary();
			} catch (e) {
				retainOperationError("refresh.supplementary", e);
			}
		},

		selectConversation: async (id, branchId) => {
			try {
				const projection = await invoke(client, () => client.conversation.select({ id, branchId }));
				const timeline = requirePiTimeline(projection.piTimeline, "conversation.select");
				conversationSelectionChangedLocally = true;
				setState("activeConversationId", projection.activeConversationId);
				setState("activeRoleplayMediaId", undefined);
				setState("activeAmbientMediaId", undefined);
				setState("activeRoleplayChoiceSetId", undefined);
				setState("activeBranchId", projection.activeBranchId ?? null);
				setState("activePiTimeline", timeline);
				setConversationProjection({
					activeConversationId: projection.activeConversationId,
					activeBranchId: projection.activeBranchId ?? null,
					piTimeline: timeline,
				});
				clearOperationError();
				void refreshStoryProposals();
			} catch (e) {
				if (e instanceof PiTimelineProjectionError) {
					setState("activePiTimeline", undefined);
					setConversationProjection({ piTimeline: undefined });
					retainProjectionError("conversation.select", e, "projection");
				} else {
					retainOperationError("conversation.select", e);
				}
			}
		},

		createConversation: async (title) => {
			try {
				const result = await invoke(client, () => client.conversation.create({ title }));
				const projection = await invoke(client, () =>
					client.conversation.select({ id: result.id }),
				);
				const timeline = requirePiTimeline(
					projection.piTimeline,
					"conversation.create.select",
				);
				conversationSelectionChangedLocally = true;
				setState("activeConversationId", projection.activeConversationId);
				setState("activeBranchId", projection.activeBranchId ?? null);
				setState("activePiTimeline", timeline);
				setConversationProjection({
					activeConversationId: projection.activeConversationId,
					activeBranchId: projection.activeBranchId ?? null,
					piTimeline: timeline,
				});
				clearOperationError();
				await Promise.all([refreshConversations(), refreshModelRoute(result.id)]);
			} catch (e) {
				retainOperationError("conversation.create", e);
			}
		},

		renameConversation: async (id, title) => {
			await invoke(client, () => client.conversation.rename({ id, title }));
			await refreshConversations();
		},

		archiveConversation: async (id) => {
			await invoke(client, () => client.conversation.archive({ id, archived: true }));
			if (state.activeConversationId === id) {
				conversationSelectionChangedLocally = true;
				setState("activeConversationId", null);
				setState("activeRoleplayMediaId", undefined);
				setState("activeAmbientMediaId", undefined);
				setState("activeRoleplayChoiceSetId", undefined);
				setState("activeBranchId", null);
				setState("activePiTimeline", undefined);
				setConversationProjection({ activeConversationId: undefined, activeBranchId: null, piTimeline: undefined });
			}
			await refreshConversations();
		},

		deleteConversation: async (id) => {
			await invoke(client, () => client.conversation.delete({ id }));
			if (state.activeConversationId === id) {
				conversationSelectionChangedLocally = true;
				setState("activeConversationId", null);
				setState("activeRoleplayMediaId", undefined);
				setState("activeAmbientMediaId", undefined);
				setState("activeRoleplayChoiceSetId", undefined);
				setState("activePiTimeline", undefined);
				setState("activeBranchId", null);
				setConversationProjection({ activeConversationId: undefined, activeBranchId: null, piTimeline: undefined });
			}
			await refreshConversations();
		},

		sendMessage: async (text, attachments) => {
			setState("pendingUserText", text);
			setState("streamingAssistantText", "");
			setState("assistantStreaming", true);
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.send({ conversationId, text, attachments }));
				await refreshSnapshot();
				setState("pendingUserText", undefined);
				clearOperationError();
			} catch (e) {
				setState("assistantStreaming", false);
				retainOperationError("message.send", e);
			}
		},


		abort: async () => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.abort({ conversationId }));
				setState("sending", false);
				clearOperationError();
			} catch (e) {
				retainOperationError("message.abort", e);
			}
		},

		triggerRoleplayEvent: async (eventId) => {
			const conversationId = requireActiveConversation();
			await invoke(client, () =>
				client.roleplay.trigger({ conversationId, eventId, dedupeKey: crypto.randomUUID() }),
			);
			setState("activeRoleplayChoiceSetId", undefined);
			await refreshSnapshot();
		},
		dismissRoleplayMedia: async () => {
			try {
				const conversationId = requireActiveConversation();
				const mediaId = state.activeRoleplayMediaId;
				if (mediaId === undefined) return;
				await invoke(client, () => client.roleplay.dismissMedia({ conversationId, mediaId }));
				if (
					state.activeConversationId === conversationId &&
					state.activeRoleplayMediaId === mediaId
				)
					setState("activeRoleplayMediaId", undefined);
				clearOperationError();
			} catch (e) {
				retainOperationError("roleplay.dismissMedia", e);
			}
		},
		dismissAmbientMedia: async () => {
			try {
				const conversationId = requireActiveConversation();
				const mediaId = state.activeAmbientMediaId;
				if (mediaId === undefined) return;
				await invoke(client, () => client.roleplay.dismissMedia({ conversationId, mediaId }));
				if (state.activeConversationId === conversationId && state.activeAmbientMediaId === mediaId)
					setState("activeAmbientMediaId", undefined);
				clearOperationError();
			} catch (e) {
				retainOperationError("roleplay.dismissMedia", e);
			}
		},
		submitOnboarding: async (stepId, answer) => {
			try {
				await onboardingStore.submit(stepId, answer);
				await onboardingStore.resync();
				clearOperationError();
			} catch (error) {
				if (isStaleOnboardingStep(error)) {
					try {
						await onboardingStore.resync();
						clearOperationError();
					} catch (resyncError) {
						retainOperationError("onboarding.resync", resyncError);
					}
					return;
				}
				retainOperationError("onboarding.submit", error);
			}
		},

		get character() {
			return snapshotValue()?.character;
		},
		get characterRuntimeByConversation() {
			return state.characterRuntimeByConversation;
		},
		get roleplay() {
			return snapshotValue()?.roleplay;
		},
		get activeRoleplayMediaId() {
			return state.activeRoleplayMediaId;
		},
		get activeAmbientMediaId() {
			return state.activeAmbientMediaId;
		},
		get activeRoleplayChoiceSetId() {
			return state.activeRoleplayChoiceSetId;
		},
		get snapshot() {
			return snapshotApi;
		},
		get embedding() {
			return embeddingBinding;
		},
		get events() {
			return eventsApi;
		},
		get memory() {
			return trackedMemoryApi;
		},
		get settings() {
			return trackedSettingsApi;
		},
		get provider() {
			return trackedProviderApi;
		},
		get model() {
			return trackedModelApi;
		},
		get commission() {
			return trackedCommissionApi;
		},
		get run() {
			return trackedRunApi;
		},
		get artifact() {
			return trackedArtifactApi;
		},
		get story() {
			return trackedStoryApi;
		},
		get characters() {
			return trackedCharacterApi;
		},
		get canon() {
			return trackedCanonApi;
		},
	};
}
