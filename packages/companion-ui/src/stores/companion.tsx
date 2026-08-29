import { waitForEventReconnect } from "../lib/host-event-reconnect.js";
/**
 * Companion store: the single reactive facade the renderer consumes.
 *
 * Architecture (per the M5 recovery contract in
 * `local://renderer-contract.md`):
 *
 * - QueryClient entries own the Host-backed snapshot and supplementary
 *   projections. The boot snapshot hydrates those entries and events invalidate
 *   or update each entry explicitly.
 * - An owned event-stream subscription invalidates Query projections. Sequence gaps mark the stream
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
 * Supplementary domain APIs are exposed for backstage settings and authoring.
 */

import {
	type CompanionClient,
	isMutationResponse,
	responseRevision,
	withResponseRevision,
} from "@bear-harness/companion-client";
import { i18n, useTranslation } from "@bear-harness/i18n";
import type { KnownDomainEvent, RoleplayState } from "@bear-harness/protocol";
import type {
	EmbeddingDownloadState,
	MemoryCandidate as MemoryCandidateSchema,
} from "@bear-harness/protocol/schema";
import { parseKnownDomainEvent } from "@bear-harness/protocol/schema";
import type { z } from "@bear-harness/schema";
import { isCancelledError, useQueryClient } from "@tanstack/solid-query";
import {
	type Accessor,
	createContext,
	createMemo,
	createSignal,
	onCleanup,
	type ParentProps,
	untrack,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { IpcInvocationError } from "../lib/ipc.js";
import {
	type CanonChunk,
	type CanonModule,
	type CanonModuleKind,
	type CanonSource,
	type CharacterDisplay,
	type CharacterDraft,
	type CharacterDraftFiles,
	type CharacterDraftRevision,
	type CharacterListData,
	type CharacterPackageDocument,
	type CharacterRuntimeState,
	type CharacterStatePatchOperation,
	type CharacterStateSnapshot,
	type CharacterSummary,
	type ConfiguredModel,
	type ConversationActiveResponse,
	type ConversationSelectResponse,
	type ConversationSummary,
	type DomainEvent,
	invoke,
	type MemoryCaptureResponse,
	type MemoryEntry,
	type MemoryListRequest,
	type MemoryPrepareEmbeddingResponse,
	type MemoryScope,
	type MemorySearchData,
	type ModelListData,
	type ModelRouteData,
	type OnboardingData,
	type PiLiveState,
	type PiTimeline,
	type PiTimelineEntry,
	type ProviderInfo,
	type ProviderListData,
	type ProviderLoginResult,
	type RunInfo,
	type RunListData,
	type RunPermissionRequest,
	type SettingsCapabilities,
	type SettingsData,
	type SettingsPatch,
	type Snapshot,
} from "./ipc.js";
import { withRpcMutations } from "./mutation-client.js";
import { createOnboardingStore } from "./onboarding.js";
import { commitQueryValue, invalidateCommittedQueries, readQueryValue } from "./query-sync.js";
import { createRpcMutation, createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";
import { affectedQueries } from "./sync-dependencies.js";

export * from "./ipc.js";
export type { OnboardingStore } from "./onboarding.js";
export { createOnboardingStore } from "./onboarding.js";
/** Inferred wire shape of `memory.candidates.list` items (schema value import). */
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type MemoryCandidateStatus = MemoryCandidate["status"];
export type LocalEmbeddingCandidate = SettingsCapabilities["localEmbeddingCandidates"][number];

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
}

export interface QueryView<T> {
	data(): T | undefined;
	loading(): boolean;
	error(): unknown;
}

export interface MemoryApi {
	observeList(
		scope: Accessor<MemoryScope>,
		query: Accessor<string>,
		characterId?: Accessor<string | undefined>,
	): QueryView<{ entries: MemoryEntry[] }>;
	observeCandidates(
		characterId: Accessor<string | undefined>,
		status?: MemoryCandidate["status"],
	): QueryView<{ candidates: MemoryCandidate[] }>;
	listState(
		scope?: MemoryScope,
		query?: string,
		characterId?: string,
	): { entries: MemoryEntry[]; loading: boolean; error: string | null };
	candidateState(
		status?: MemoryCandidate["status"],
		characterId?: string,
	): { candidates: MemoryCandidate[]; loading: boolean; error: string | null };
	entries(): MemoryEntry[] | undefined;
	revision(): number;
	search(query: string, scope?: MemoryScope, characterId?: string): Promise<MemoryEntry[]>;
	list(params?: MemoryListRequest): Promise<MemoryEntry[]>;
	capture(entryId: string): Promise<MemoryCaptureResponse>;
	configureLocalEmbedding(
		provider: "none" | "local",
		candidateId?: string,
		customPath?: string,
	): Promise<{ ready: true }>;
	forget(entryId: string, characterId?: string): Promise<void>;
	edit(entryId: string, newText: string, characterId?: string): Promise<void>;
	exclude(memoryId: string, excluded: boolean, characterId?: string): Promise<void>;
	/** Pending candidates awaiting user confirmation (reactive list). */
	candidates(): MemoryCandidate[] | undefined;
	listCandidates(
		status?: MemoryCandidate["status"],
		characterId?: string,
	): Promise<MemoryCandidate[]>;
	approveCandidate(
		candidateId: string,
		editedText?: string,
		decidedScope?: MemoryScope,
		characterId?: string,
	): Promise<void>;
	rejectCandidate(candidateId: string, characterId?: string): Promise<void>;
}

export interface SettingsApi {
	data(characterId?: string): SettingsData | undefined;
	get(characterId?: string): Promise<SettingsData>;
	set(settings: SettingsPatch, characterId?: string): Promise<void>;
}

export interface ProviderApi {
	loginState(providerId: string): ProviderLoginResult | undefined;
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
	loginCancel(providerId: string): Promise<void>;
	logout(providerId: string): Promise<void>;
	remove(providerId: string): Promise<void>;
}

export interface ModelApi {
	data(): ModelListData;
	models(): ConfiguredModel[];
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

export interface RunApi {
	list(): Promise<RunListData>;
	pendingPermissions(): RunPermissionRequest[];
	steer(runId: string, instruction: string): Promise<void>;
	interrupt(runId: string): Promise<RunInfo>;
	resume(runId: string): Promise<RunInfo>;
	cancel(runId: string): Promise<RunInfo>;
	respondPermission(runId: string, requestId: string, optionId: string): Promise<RunInfo>;
}

export interface ExternalAgentApi {
	status(): Promise<import("./ipc.js").ExternalAgentStatusData>;
	discover(): Promise<import("./ipc.js").ExternalAgentCandidate[]>;
	connect(params: {
		canonicalPath: string;
		version: string;
		sha256: string;
		codexHome: string;
	}): Promise<void>;
}

export interface AttachmentApi {
	readData(
		params: Parameters<AttachmentApi["read"]>[0],
	): Awaited<ReturnType<AttachmentApi["read"]>> | undefined;
	list(
		conversationId: string,
		attachmentId?: string,
	): Promise<import("@bear-harness/protocol").ConversationAttachmentSummary[]>;
	data(
		conversationId: string,
		attachmentId: string,
	): import("@bear-harness/protocol").ConversationAttachmentSummary | undefined;
	observeUploads(conversationId: Accessor<string | null>): QueryView<{
		uploads: Array<{
			uploadId: string;
			name: string;
			kind: "file" | "folder";
			receivedBytes: number;
			totalBytes: number;
			fileCount: number;
		}>;
	}>;

	startUpload(params: {
		conversationId: string;
		kind: "file" | "folder";
		name: string;
		entries: Array<{
			entryKind: "file" | "directory";
			relativePath: string;
			mime?: string;
			bytes?: number;
		}>;
	}): Promise<{ uploadId: string }>;
	appendChunk(params: {
		conversationId: string;
		uploadId: string;
		fileIndex: number;
		offset: number;
		base64: string;
	}): Promise<void>;
	completeUpload(params: { conversationId: string; uploadId: string }): Promise<{
		attachment: {
			id: string;
			name: string;
			kind: "file" | "folder" | "generated";
			bytes: number;
			fileCount: number;
		};
	}>;
	cancelUpload(params: { conversationId: string; uploadId: string }): Promise<void>;
	discard(conversationId: string, attachmentId: string): Promise<void>;
	read(params: {
		mode: "semantic";
		conversationId: string;
		attachmentId: string;
		relativePath?: string;
		query?: string;
		cursor?: string;
	}): Promise<{
		mode: "semantic";
		files?: Array<{
			relativePath: string;
			entryKind: "file" | "directory" | "symlink";
			mime?: string;
			bytes?: number;
			readable: boolean;
			error?: string;
		}>;
		content?: string;
		hits?: Array<{ relativePath: string; excerpt: string }>;
		error?: string;
		nextCursor?: string;
	}>;
	readBytes(params: {
		mode: "bytes";
		conversationId: string;
		attachmentId: string;
		relativePath?: string;
		offset: number;
		length: number;
	}): Promise<{
		mode: "bytes";
		relativePath: string;
		mime: string;
		base64: string;
		nextOffset: number;
		eof: boolean;
	}>;
	url(params: {
		conversationId: string;
		attachmentId: string;
		relativePath?: string;
		operation: "preview" | "download";
	}): Promise<string>;
}

export interface CharacterApi {
	observeTrust(
		characterId: Accessor<string>,
	): QueryView<{ trust: Awaited<ReturnType<CharacterApi["pluginTrust"]>> }>;
	observePackage(
		characterId: Accessor<string | undefined>,
	): QueryView<{ package: CharacterPackageDocument }>;
	packageData(characterId: string): CharacterPackageDocument | undefined;
	pluginTrustData(
		characterId: string,
	): Awaited<ReturnType<CharacterApi["pluginTrust"]>> | undefined;
	characters(): CharacterSummary[];
	list(): Promise<CharacterListData>;
	activate(characterId: string): Promise<void>;
	import(files: Array<{ path: string; base64: string }>): Promise<void>;
	pluginTrust(characterId: string): Promise<{
		origin: "official" | "local" | "imported";
		pluginHash: string;
		trusted: boolean;
		pluginsPresent: boolean;
	}>;

	confirmPluginTrust(characterId: string): Promise<void>;
	packageGet(characterId: string): Promise<CharacterPackageDocument>;
	packageUpdate(
		characterId: string,
		yaml: string,
		expectedSha256: string,
	): Promise<CharacterPackageDocument>;
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
	searchResults(query: string): CanonChunk[];
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
	| SettingsData["modelDownloadSource"];
function isModelDownloadSource(
	value: EmbeddingSettingsValue,
): value is SettingsData["modelDownloadSource"] {
	return Object.hasOwn(value, "type");
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
	downloadState(): EmbeddingDownloadState;
	cancelDownload(): Promise<unknown>;
	readonly settingsQuery: RpcQueryBinding<{ settings: SettingsData }>;
	readonly capabilitiesQuery: RpcQueryBinding<SettingsCapabilities>;
	readonly settingsMutation: RpcMutationBinding<EmbeddingSettingsValue>;
	readonly localConfigureMutation: RpcMutationBinding<{
		provider: "none" | "local";
		candidateId?: string;
		customPath?: string;
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
	readonly archivedConversations: ConversationSummary[];
	readonly activeConversationId: string | null;
	readonly activePiTimeline: PiTimeline | undefined;
	readonly activePiLiveState: PiLiveState | undefined;
	readonly runs: RunInfo[];
	readonly presence: PresenceState;
	readonly character: CharacterDisplay | undefined;
	readonly characterRuntimeByConversation: Readonly<Record<string, CharacterRuntimeState>>;
	readonly characterState: CharacterStateSnapshot | undefined;
	readonly roleplay: RoleplayState | undefined;
	readonly activeRoleplayMediaId: string | undefined;
	readonly activeAmbientMediaId: string | undefined;
	readonly activeRoleplayChoiceSetId: string | undefined;
	refresh(): Promise<void>;
	loadOlderMessages(): Promise<void>;
	selectConversation(id: string): Promise<void>;
	createConversation(title?: string): Promise<void>;
	createConversationFromEntry(entryId: string): Promise<void>;
	renameConversation(id: string, title: string): Promise<void>;
	archiveConversation(id: string): Promise<void>;
	restoreConversation(id: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	patchCharacterState(operations: CharacterStatePatchOperation[]): Promise<void>;
	sendMessage(text: string, attachmentIds?: string[]): Promise<void>;
	regenerateMessage(entryId: string): Promise<void>;
	editMessage(entryId: string, text: string): Promise<void>;
	correctMessage(entryId: string, presetId: string, detail?: string): Promise<void>;
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
	readonly attachments: AttachmentApi;
	readonly run: RunApi;
	readonly externalAgent: ExternalAgentApi;
	readonly characters: CharacterApi;
	readonly canon: CanonApi;
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
	| "starting"
	| "unknown";
interface CompanionState {
	loading: boolean;
	error: string | null;
	errorMetadata: CompanionErrorMetadata | null;
	sending: boolean;
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
		if (latest.status === "completed") return "result_ready";
		if (latest.status === "failed" || latest.status === "forced_termination") return "problem";
	}
	return "idle";
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

const PENDING_REFETCHES = new Set<() => void>();
function coalescedRefetch(fn: () => void, key = fn): void {
	if (PENDING_REFETCHES.has(key)) return;
	PENDING_REFETCHES.add(key);
	queueMicrotask(() => {
		PENDING_REFETCHES.delete(key);
		fn();
	});
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
	const store = untrack(() => createCompanionStoreInner(client));
	COMPANION_STORES.set(client, store);
	return store;
}

function createCompanionStoreInner(client: CompanionClient): CompanionStore {
	const queryClient = useQueryClient();
	client = withRpcMutations(client, queryClient);
	// Notification only: canonical values remain exclusively in QueryClient.
	const [cacheRevision, setCacheRevision] = createSignal(0);
	onCleanup(
		queryClient.getQueryCache().subscribe((event) => {
			if (event.type === "updated" || event.type === "removed")
				setCacheRevision((value) => value + 1);
		}),
	);
	// Prevent auto-refetch from overwriting authoritative mutation results.
	// The active-get endpoint is a read-only snapshot; mutation responses are
	// the authoritative source and are committed directly to this key.
	queryClient.setQueryDefaults(queryKeys.activeConversation, { staleTime: Infinity });
	const [t] = useTranslation(undefined, { i18n });
	const [state, setState] = createStore<CompanionState>({
		loading: false,
		error: null,
		errorMetadata: null,
		sending: false,
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
		if (isCancelledError(value)) return;
		const metadata = projectionError(operation, value, source);
		setState("errorMetadata", metadata);
		setState("error", metadata.message);
	};

	const [lastSeq, setLastSeq] = createSignal(0);
	const [stale, setStale] = createSignal(false);
	const [memoryRevision, setMemoryRevision] = createSignal(0);
	const [memoryProjectionKey, setMemoryProjectionKey] = createSignal<readonly unknown[]>();
	const [memoryCandidateProjectionKey, setMemoryCandidateProjectionKey] =
		createSignal<readonly unknown[]>();
	const currentCharacterId = createMemo<string | undefined>(() => {
		cacheRevision();
		return (
			queryClient
				.getQueryData<CharacterListData>(queryKeys.characters)
				?.characters.find((character) => character.active)?.id ??
			queryClient.getQueryData<Snapshot>(queryKeys.snapshot)?.character?.id
		);
	});

	const onboardingStore = createOnboardingStore(client, queryClient);
	const snapshotRequest = async (): Promise<Snapshot> => {
		const snapshot = await readQueryValue(queryClient, queryKeys.snapshot, () =>
			invoke(client, () => client.snapshot.get()),
		);
		const {
			onboarding: _onboarding,
			memory: _memory,
			run: _run,
			model: _model,
			settings: _settings,
			provider: _provider,
			conversation: _conversation,
			...owned
		} = snapshot;
		const projection = withResponseRevision(owned, responseRevision(snapshot));
		commitQueryValue(queryClient, queryKeys.snapshot, projection);
		onboardingStore._hydrate(snapshot.onboarding);
		hydrateFromSnapshot(snapshot, true);
		startEventReplay(snapshot.eventSeq);
		return projection;
	};
	const snapshotQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.snapshot,
		request: snapshotRequest,
	});
	const conversationsRequest = () => invoke(client, () => client.conversation.list({}));
	const archivedConversationsRequest = () =>
		invoke(client, () => client.conversation.list({ archived: true }));
	const activeConversationRequest = () => invoke(client, () => client.conversation.activeGet({}));
	const memoryKey = (params?: MemoryListRequest): readonly unknown[] =>
		queryKeys.memoryProjection(
			params?.scope,
			undefined,
			params?.characterId ?? currentCharacterId(),
		);
	const conversationsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.conversations,
		request: conversationsRequest,
	});
	const archivedConversationsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.archivedConversations,
		request: archivedConversationsRequest,
	});
	const activeConversationQuery = createRpcQuery<ConversationActiveResponse>({
		client: queryClient,
		key: queryKeys.activeConversation,
		request: activeConversationRequest,
	});
	const timelinePrefixes = new Map<string, { startOffset: number; entries: PiTimelineEntry[] }>();
	const withLoadedTimelinePrefix = (
		projection: ConversationSelectResponse,
	): ConversationSelectResponse => {
		const prefix = timelinePrefixes.get(projection.id);
		const projectedStart = projection.piTimeline.startOffset ?? 0;
		if (!prefix || prefix.startOffset >= projectedStart) return projection;
		const ids = new Set(prefix.entries.map((entry) => entry.id));
		return {
			...projection,
			piTimeline: {
				...projection.piTimeline,
				entries: [
					...prefix.entries,
					...projection.piTimeline.entries.filter((entry) => !ids.has(entry.id)),
				],
				startOffset: prefix.startOffset,
				hasMoreBefore: prefix.startOffset > 0,
			},
		};
	};
	const activeProjection = createMemo<ConversationSelectResponse | undefined>(() => {
		cacheRevision();
		void activeConversationQuery.data;
		return queryClient.getQueryData<ConversationActiveResponse>(queryKeys.activeConversation)
			?.conversation;
	});
	const currentActiveConversationId = (): string | null =>
		activeProjection()?.activeConversationId ?? null;
	const activeConversationId = createMemo(currentActiveConversationId);
	const memoryRequest = (params?: MemoryListRequest) =>
		invoke(client, () => {
			const characterId =
				params?.characterId ?? activeCharacters().find((character) => character.active)?.id;
			return client.memory.list({ ...params, ...(characterId ? { characterId } : {}) });
		});
	const memoryQuery = createRpcQuery({
		client: queryClient,
		key: () => memoryKey(),
		request: (key) => memoryRequest({ ...(key[2] ? { characterId: key[2] as string } : {}) }),
		enabled: () => currentCharacterId() !== undefined,
	});
	const memoryCandidatesRequest = (status?: MemoryCandidate["status"], characterId?: string) =>
		invoke(client, () => {
			const targetCharacterId =
				characterId ?? activeCharacters().find((character) => character.active)?.id;
			return client.memory.candidatesList({
				status,
				...(targetCharacterId ? { characterId: targetCharacterId } : {}),
			});
		});
	const memoryCandidatesQuery = createRpcQuery({
		client: queryClient,
		key: () => queryKeys.memoryCandidates(undefined, currentCharacterId()),
		request: (key) => memoryCandidatesRequest(undefined, key[2] as string | undefined),
		enabled: () => currentCharacterId() !== undefined,
	});
	const runsRequest = () => invoke(client, () => client.run.list());
	const runsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.runs,
		request: runsRequest,
	});
	const charactersRequest = () => invoke(client, () => client.character.list());
	const charactersQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.characters,
		request: charactersRequest,
	});
	const canonSourcesRequest = (characterId = currentCharacterId()) =>
		invoke(client, () => client.canon.listSources({ characterId }));
	const canonSourcesQuery = createRpcQuery({
		client: queryClient,
		key: () => queryKeys.canonSources(currentCharacterId()),
		request: (key) => canonSourcesRequest(key[2] as string | undefined),
	});
	const canonModulesRequest = (characterId = currentCharacterId()) =>
		invoke(client, () => client.canon.listModules({ characterId }));
	const canonModulesQuery = createRpcQuery({
		client: queryClient,
		key: () => queryKeys.canonModules(currentCharacterId()),
		request: (key) => canonModulesRequest(key[2] as string | undefined),
	});

	const downloadRequest = () =>
		invoke(client, () => client.memory.localEmbeddingDownloadStatus({}));
	const downloadQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.embeddingDownload,
		request: downloadRequest,
	});
	const downloadState = (): EmbeddingDownloadState =>
		downloadQuery.data ?? { status: "idle", downloadedBytes: 0 };
	const settingsRequest = () => invoke(client, () => client.settings.get());
	const providersRequest = () => invoke(client, () => client.provider.list());
	const modelPoolRequest = () => invoke(client, () => client.model.poolGet());
	const modelDefaultsRequest = () => invoke(client, () => client.model.defaultsGet());
	const settingsCapabilitiesRequest = () =>
		invoke(client, () => client.settings.capabilitiesGet({}));
	const settingsCapabilitiesQuery = createRpcQuery<SettingsCapabilities>({
		client: queryClient,
		key: queryKeys.settingsCapabilities,
		request: settingsCapabilitiesRequest,
	});
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
	const modelRouteQuery = createRpcQuery<ModelRouteData | undefined>({
		client: queryClient,
		key: () => queryKeys.modelRoute(activeConversationId() ?? ""),
		request: (key) =>
			!key[2]
				? Promise.resolve(undefined)
				: invoke(client, () => client.model.routeGet({ conversationId: key[2] as string })),
		enabled: () => activeConversationId() !== null,
	});
	const currentModelRoute = (): ModelRouteData | undefined => {
		void modelRouteQuery.data;
		const conversationId = currentActiveConversationId();
		return conversationId === null
			? undefined
			: queryClient.getQueryData<ModelRouteData>(queryKeys.modelRoute(conversationId));
	};
	const settingsPatchMutation = createRpcMutation<SettingsPatch>({
		client: queryClient,
		request: (settings) => invoke(client, () => client.settings.set({ settings })),
		invalidates: [queryKeys.settings],
	});
	const embeddingSettingsMutation = createRpcMutation<EmbeddingSettingsValue>({
		client: queryClient,
		request: (value) => {
			const settings: SettingsPatch = isModelDownloadSource(value)
				? { modelDownloadSource: value }
				: { memoryVectorService: value };
			return invoke(client, () => client.settings.set({ settings }));
		},
		invalidates: [queryKeys.settings],
	});
	const localConfigureMutation = createRpcMutation<{
		provider: "none" | "local";
		candidateId?: string;
		customPath?: string;
	}>({
		client: queryClient,
		request: (params) =>
			invoke(client, () =>
				client.memory.configureLocalEmbedding(
					params.provider === "local"
						? {
								provider: params.provider,
								...(params.candidateId ? { candidateId: params.candidateId } : {}),
								...(params.customPath ? { customPath: params.customPath } : {}),
							}
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
	const selectConversationMutation = createRpcMutation<{ id: string }>({
		client: queryClient,
		request: ({ id }) => invoke(client, () => client.conversation.select({ id })),
		invalidates: [],
	});
	const createConversationMutation = createRpcMutation<{ title?: string }>({
		client: queryClient,
		request: ({ title }) => invoke(client, () => client.conversation.create({ title })),
		invalidates: [],
	});
	const archiveConversationMutation = createRpcMutation<{ id: string }>({
		client: queryClient,
		request: ({ id }) => invoke(client, () => client.conversation.archive({ id, archived: true })),
		invalidates: [],
	});
	const deleteConversationMutation = createRpcMutation<{ id: string }>({
		client: queryClient,
		request: ({ id }) => invoke(client, () => client.conversation.delete({ id })),
		invalidates: [],
	});

	// ---- refresh helpers (each re-fetches one domain list) ----

	const refreshSnapshot = () =>
		refreshRpcQuery({ client: queryClient, key: queryKeys.snapshot, request: snapshotRequest });
	const refreshPresentationSnapshot = (operation: string): void => {
		const refresh = () => {
			void refreshSnapshot().catch((error) =>
				retainProjectionError(operation, error, "projection"),
			);
		};
		refresh();
		// Presentation events are the wake-up signal for a committed Host
		// projection. Keep one event-driven trailing read so a notification
		// delivered while an older snapshot request is in flight cannot leave
		// the renderer permanently one revision behind.
		coalescedRefetch(refresh, refreshSnapshot);
	};
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
		const scoped = { ...params, characterId: params?.characterId ?? currentCharacterId() };
		await refreshRpcQuery({
			client: queryClient,
			key: memoryKey(scoped),
			request: () => memoryRequest(scoped),
		});
		setMemoryRevision((revision) => revision + 1);
	};
	const refreshMemoryCandidates = async (status?: MemoryCandidate["status"]): Promise<void> => {
		const characterId = currentCharacterId();
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.memoryCandidates(status, characterId),
			request: () => memoryCandidatesRequest(status, characterId),
		});
		setMemoryRevision((revision) => revision + 1);
	};
	const debouncedRefreshMemoryEntries = (): void => {
		coalescedRefetch(() => {
			void refreshMemoryEntries().catch((error) =>
				retainProjectionError("memory", error, "projection"),
			);
		}, refreshMemoryEntries);
	};
	const debouncedRefreshMemoryCandidates = (): void => {
		coalescedRefetch(() => {
			void refreshMemoryCandidates().catch((error) =>
				retainProjectionError("memory", error, "projection"),
			);
		}, refreshMemoryCandidates);
	};
	const refreshCharacters = async (): Promise<void> => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.characters,
			request: charactersRequest,
		});
	};
	const refreshCanonSources = async (): Promise<void> => {
		const characterId = currentCharacterId();
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonSources(characterId),
			request: () => canonSourcesRequest(characterId),
		});
	};
	const refreshCanonModules = async (): Promise<void> => {
		const characterId = currentCharacterId();
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonModules(characterId),
			request: () => canonModulesRequest(characterId),
		});
	};
	const refreshSupplementary = async (): Promise<void> => {
		await Promise.all([
			refreshMemoryEntries(),
			refreshMemoryCandidates(),
			refreshRuns(),
			refreshCharacters(),
			refreshCanonSources(),
			refreshCanonModules(),
		]);
	};
	const invalidateConversationList = (): Promise<void> =>
		queryClient.invalidateQueries(
			{ queryKey: queryKeys.conversations, refetchType: "all" },
			{ cancelRefetch: false },
		);
	const invalidateActiveConversation = (): Promise<void> =>
		queryClient.invalidateQueries(
			{ queryKey: queryKeys.activeConversation, refetchType: "all" },
			{ cancelRefetch: false },
		);
	const invalidateActiveConversationQueries = (): Promise<void> => {
		const conversationId = activeConversationId();
		const keys =
			conversationId === null
				? []
				: [
						queryClient.invalidateQueries(
							{ queryKey: queryKeys.modelRoute(conversationId) },
							{ cancelRefetch: false },
						),
					];
		return Promise.all([invalidateActiveConversation(), ...keys]).then(() => undefined);
	};
	const invalidateDerivedConversationQueries = (
		projection: ConversationSelectResponse | undefined,
	): Promise<void> => {
		const conversationId = projection?.activeConversationId;
		if (conversationId === undefined) return Promise.resolve();
		return Promise.all([
			queryClient.invalidateQueries(
				{ queryKey: queryKeys.modelRoute(conversationId) },
				{ cancelRefetch: false },
			),
		]).then(() => undefined);
	};

	// ---- snapshot → query-cache hydration ----

	// ---- snapshot → domain hydration ----

	const hydrateFromSnapshot = (snap: Snapshot, seedQueries: boolean): void => {
		onboardingStore._hydrate(snap.onboarding);
		if (seedQueries && snap.memory?.entries !== undefined) {
			commitQueryValue(
				queryClient,
				queryKeys.memoryProjection(
					undefined,
					undefined,
					snap.character?.id ?? currentCharacterId(),
				),
				withResponseRevision({ entries: snap.memory.entries }, responseRevision(snap)),
			);
			setMemoryRevision((revision) => revision + 1);
		}
		if (seedQueries && snap.run)
			commitQueryValue(
				queryClient,
				queryKeys.runs,
				withResponseRevision({ runs: snap.run.runs }, responseRevision(snap)),
			);
	};
	const snapshotValue = (): Snapshot | undefined => {
		void snapshotQuery.data;
		return queryClient.getQueryData<Snapshot>(queryKeys.snapshot);
	};
	const currentPresentation = createMemo(() => {
		const presentation = snapshotValue()?.presentation;
		return presentation?.conversationId === currentActiveConversationId()
			? presentation
			: undefined;
	});

	const activeConversations = (): ConversationSummary[] => {
		void conversationsQuery.data;
		return (
			queryClient.getQueryData<{ conversations: ConversationSummary[] }>(queryKeys.conversations)
				?.conversations ?? []
		);
	};
	const archivedConversations = (): ConversationSummary[] => {
		void archivedConversationsQuery.data;
		return (
			queryClient.getQueryData<{ conversations: ConversationSummary[] }>(
				queryKeys.archivedConversations,
			)?.conversations ?? []
		);
	};
	const activeRuns = (): RunInfo[] => {
		void runsQuery.data;
		return queryClient.getQueryData<RunListData>(queryKeys.runs)?.runs ?? [];
	};
	const presence = createMemo<PresenceState>(() =>
		derivePresence({
			companionState: snapshotValue()?.presentation?.companionState ?? "unknown",
			runs: activeRuns(),
			sending: state.sending || (activeProjection()?.piLiveState?.isStreaming ?? false),
		}),
	);

	// ---- event subscription loop ----

	const eventsApi: EventsApi = {
		lastSeq,
		stale,
	};

	const dispatchEvent = (event: DomainEvent): void => {
		const knownEvent: KnownDomainEvent | undefined = parseKnownDomainEvent(event);
		if (!knownEvent) return;
		switch (knownEvent.kind) {
			case "sync.invalidated":
				invalidateCommittedQueries(
					queryClient,
					knownEvent.payload.sync,
					affectedQueries(knownEvent.payload.sources),
				);
				return;
			case "conversationAttachment.upload_changed":
				void queryClient.invalidateQueries(
					{ queryKey: ["attachments"], refetchType: "all" },
					{ cancelRefetch: false },
				);
				return;
			case "provider.login_changed":
				void providerApi
					.loginStatus(knownEvent.payload.providerId)
					.then(async (state) => {
						if (state.status === "completed")
							await Promise.all([providerApi.list(), refreshModelPool(), refreshModelDefaults()]);
					})
					.catch((error) => retainOperationError("provider.loginStatus", error));
				return;
			case "memory.embedding_download_changed":
				void refreshRpcQuery({
					client: queryClient,
					key: queryKeys.embeddingDownload,
					request: downloadRequest,
				}).catch((error) => retainOperationError("embedding.downloadStatus", error));
				return;
			case "pi.session.changed": {
				const { conversationId, sessionId } = knownEvent.payload;
				// Scoped projection refresh only: the payload carries no message
				// content, and a late notification for a session that is no
				// longer current must never overwrite the active page.
				void refreshConversationProjection(conversationId, sessionId).catch((error) =>
					retainProjectionError("background.read", error, "projection"),
				);
				return;
			}
			case "character.scene_changed":
			case "character.visual_state_changed":
			case "roleplay.media_presented":
			case "roleplay.media_dismissed":
			case "roleplay.choices_presented":
			case "roleplay.choices_dismissed":
				refreshPresentationSnapshot("snapshot.presentation");
				return;
			case "conversation.selected":
				void invalidateActiveConversationQueries();
				return;
			case "conversation.created":
				void invalidateConversationList();
				return;
			case "conversation.renamed": {
				void invalidateConversationList();
				if (knownEvent.payload.conversationId === currentActiveConversationId()) {
					void invalidateActiveConversationQueries();
				}
				return;
			}
			case "conversation.archived":
			case "conversation.deleted":
				void invalidateConversationList();
				void invalidateActiveConversationQueries();
				return;
			case "model.selected": {
				const conversationId = knownEvent.payload.conversationId;
				if (conversationId)
					void refreshModelRoute(conversationId).catch((error) =>
						retainProjectionError("background.read", error, "projection"),
					);
				return;
			}
			case "model.defaults_changed":
				void refreshModelDefaults().catch((error) =>
					retainProjectionError("background.read", error, "projection"),
				);
				return;
			case "model.enabled":
			case "model.disabled":
				void refreshModelPool().catch((error) =>
					retainProjectionError("background.read", error, "projection"),
				);
				return;
			case "conversation.branched":
				void invalidateActiveConversationQueries();
				return;
			case "onboarding.state_changed":
			case "onboarding.reset":
				onboardingStore._applyEvent(knownEvent);
				return;
			case "companion.state_changed":
			case "run.needs_user":
				void refreshSnapshot().catch((error) =>
					retainProjectionError("snapshot.presentation", error, "projection"),
				);
				coalescedRefetch(() => {
					void refreshRuns().catch((error) => retainProjectionError("runs", error, "projection"));
				}, refreshRuns);
				return;
			default:
				break;
		}
		const kind = knownEvent.kind;
		if (kind.startsWith("onboarding.")) {
			onboardingStore._applyEvent(knownEvent);
		} else if (kind.startsWith("model.")) {
			void refreshModelPool().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			void refreshModelDefaults().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			if (activeConversationId() !== null)
				void refreshModelRoute(activeConversationId() as string).catch((error) =>
					retainProjectionError("background.read", error, "projection"),
				);
		} else if (kind.startsWith("memory.")) {
			debouncedRefreshMemoryEntries();
			debouncedRefreshMemoryCandidates();
		} else if (kind.startsWith("run.")) {
			void refreshSnapshot().catch((error) =>
				retainProjectionError("snapshot.permissions", error, "projection"),
			);
			coalescedRefetch(() => {
				void refreshRuns().catch((error) => retainProjectionError("runs", error, "projection"));
			}, refreshRuns);
		} else if (kind.startsWith("character.")) {
			coalescedRefetch(() => {
				void refreshCharacters().catch((error) =>
					retainProjectionError("characters", error, "projection"),
				);
			}, refreshCharacters);
			void refreshSnapshot().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
		} else if (kind.startsWith("roleplay.")) {
			void refreshSnapshot().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
		} else if (kind.startsWith("settings.")) {
			void queryClient.invalidateQueries(
				{ queryKey: queryKeys.settings },
				{ cancelRefetch: false },
			);
		}
		// Other kinds (evidence.collected, codex.*, fsops.*, diagnostics.* …)
		// are intentionally ignored: they do not invalidate projected state.
	};

	let eventReplayTask: Promise<void> | undefined;
	let cancelEventReplay = (): void => {};
	/**
	 * Recover from a subscribe failure or sequence gap: re-read the
	 * authoritative active projection (plan §6.1.5), resync the snapshot, and
	 * return the new subscribe cursor.
	 */
	const recoverFromEventGap = async (): Promise<number> => {
		try {
			await refreshActiveConversationProjection();
			const snapshot = await snapshotRequest();
			const sync = responseRevision(snapshot);
			if (sync) invalidateCommittedQueries(queryClient, sync, () => true);
			// Reconnect restores every cached projection, not only the visible page.
			await queryClient.invalidateQueries(
				{ refetchType: "all" },
				{ cancelRefetch: false, throwOnError: true },
			);
			setStale(false);
			if (state.errorMetadata?.source === "stream") {
				setState("error", null);
				setState("errorMetadata", null);
			}
			return snapshot.eventSeq;
		} catch (error) {
			setStale(true);
			retainProjectionError("events.gap_recovery", error, "stream");
			throw error;
		}
	};

	/**
	 * Re-entrant event replay. A gap or subscribe failure recovers the active
	 * projection and restarts the subscription from the snapshot cursor; the
	 * task slot is cleared in `finally` so a later snapshot can restart it.
	 */
	function startEventReplay(afterSeq: number): void {
		if (eventReplayTask !== undefined) return;
		setLastSeq(afterSeq);
		let cancelled = false;
		const controller = new AbortController();
		cancelEventReplay = () => {
			cancelled = true;
			controller.abort();
		};
		const recover = async (): Promise<number> => {
			while (!cancelled) {
				try {
					return await recoverFromEventGap();
				} catch {
					await waitForEventReconnect(controller.signal);
				}
			}
			return lastSeq();
		};
		eventReplayTask = (async () => {
			try {
				let cursor = afterSeq;
				let stream = client.events.stream(cursor, controller.signal)[Symbol.asyncIterator]();
				while (!cancelled) {
					let batch: DomainEvent[];
					try {
						const result = await stream.next();
						if (result.done) return;
						batch = result.value;
					} catch (error) {
						if (cancelled) return;
						retainProjectionError("events.subscribe", error, "stream");
						await waitForEventReconnect(controller.signal);
						if (cancelled) return;
						setStale(true);
						await stream.return?.();
						cursor = await recover();
						stream = client.events.stream(cursor, controller.signal)[Symbol.asyncIterator]();
						if (cancelled) return;
						setLastSeq(cursor);
						continue;
					}
					if (cancelled) return;
					if (batch.length === 0) {
						continue;
					}
					let next = cursor;
					let gap = false;
					for (const event of batch) {
						// Replay is idempotent; only a forward jump is a missing event.
						if (event.seq <= next) continue;
						if (event.seq !== next + 1) {
							gap = true;
							break;
						}
						dispatchEvent(event);
						next = event.seq;
					}
					if (gap) {
						retainProjectionError("events.sequence_gap", new Error("event sequence gap"), "stream");
						setStale(true);
						await stream.return?.();
						cursor = await recover();
						stream = client.events.stream(cursor, controller.signal)[Symbol.asyncIterator]();
						if (cancelled) return;
						setLastSeq(cursor);
						continue;
					}
					cursor = next;
					setLastSeq(cursor);
				}
			} finally {
				eventReplayTask = undefined;
			}
		})();
		void eventReplayTask.catch((error) => {
			retainProjectionError("events.replay", error, "stream");
		});
	}
	onCleanup(() => cancelEventReplay());

	// ---- presence derivation ----

	// presence is a named selector over live state and the query-backed run list.

	// ---- actions ----

	const requireActiveConversation = (): string => {
		const id = currentActiveConversationId();
		if (id === null) throw new Error(t("messages.noActiveConversationError"));
		return id;
	};
	const writeActiveProjection = (projection: ConversationSelectResponse | undefined): void => {
		const projected = projection ? withLoadedTimelinePrefix(projection) : undefined;
		const activeResponse: ConversationActiveResponse = projection
			? { conversation: projected }
			: {};
		commitQueryValue(
			queryClient,
			queryKeys.activeConversation,
			withResponseRevision(activeResponse, responseRevision(projection)),
		);
	};
	const refreshActiveConversationProjection = async (): Promise<void> => {
		const response = await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.activeConversation,
			request: activeConversationRequest,
		});
		if (response.conversation !== undefined)
			requirePiTimeline(response.conversation.piTimeline, "conversation.refresh");
	};
	/**
	 * Scoped refresh for one `pi.session.changed` notification. The captured
	 * `{conversationId, sessionId}` identity gates the shared active key: a
	 * late notification for a session that is no longer current (switched
	 * away, regenerated) must not overwrite the active page. The scoped cache
	 * is only written when the response still targets the captured
	 * conversation, and the event carries no message content.
	 */
	const refreshConversationProjection = async (
		conversationId: string,
		sessionId: string,
	): Promise<void> => {
		let projection: ConversationSelectResponse | undefined;
		try {
			const response = await invoke(client, () => client.conversation.activeGet({}));
			projection = response.conversation;
		} catch (error) {
			retainProjectionError("conversation.refreshProjection", error, "projection");
			return;
		}
		if (projection === undefined) return;
		requirePiTimeline(projection.piTimeline, "conversation.refreshProjection");
		if (projection.activeConversationId !== conversationId) return;
		if (projection.piSessionId !== sessionId || currentActiveConversationId() !== conversationId) {
			return;
		}
		writeActiveProjection(projection);
	};

	const snapshotApi: SnapshotApi = {
		data: snapshotValue,
		eventSeq: () => snapshotValue()?.eventSeq ?? 0,
		loading: () => snapshotQuery.isLoading,
		error: () => snapshotQuery.error,
		refetch: () => {
			void refreshSnapshot().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
		},
		get: snapshotRequest,
	};

	const activeMemoryEntries = createMemo<MemoryEntry[] | undefined>(() => {
		cacheRevision();
		void memoryQuery.data;
		const selected = memoryProjectionKey();
		const key = selected?.[2] === (currentCharacterId() ?? null) ? selected : memoryKey();
		return queryClient.getQueryData<MemorySearchData>(key)?.entries;
	});
	const activeMemoryCandidates = createMemo<MemoryCandidate[] | undefined>(() => {
		cacheRevision();
		void memoryCandidatesQuery.data;
		return queryClient.getQueryData<{ candidates: MemoryCandidate[] }>(
			memoryCandidateProjectionKey()?.[2] === (currentCharacterId() ?? null)
				? memoryCandidateProjectionKey()!
				: queryKeys.memoryCandidates(undefined, currentCharacterId()),
		)?.candidates;
	});
	const memoryApi: MemoryApi = {
		observeList: (scope, text, characterId) => {
			const query = createRpcQuery({
				client: queryClient,
				key: () =>
					queryKeys.memoryProjection(
						scope(),
						text().trim() || undefined,
						characterId?.() ?? currentCharacterId(),
					),
				request: (key) => {
					const [, , id, requestedScope, requestedText] = key as [
						string,
						string,
						string | null,
						MemoryScope,
						string | null,
					];
					return invoke(client, () =>
						requestedText
							? client.memory.search({
									query: requestedText,
									scope: requestedScope,
									...(id ? { characterId: id } : {}),
								})
							: client.memory.list({ scope: requestedScope, ...(id ? { characterId: id } : {}) }),
					);
				},
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		observeCandidates: (characterId, status) => {
			const query = createRpcQuery({
				client: queryClient,
				key: () => queryKeys.memoryCandidates(status, characterId() ?? currentCharacterId()),
				request: (key) => memoryCandidatesRequest(status, key[2] as string | undefined),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		listState: (scope, query, characterId) => {
			cacheRevision();
			const state = queryClient.getQueryState<MemorySearchData>(
				queryKeys.memoryProjection(scope, query || undefined, characterId ?? currentCharacterId()),
			);
			return {
				entries: state?.data?.entries ?? [],
				loading: state?.fetchStatus === "fetching",
				error: state?.error ? messageOf(state.error) : null,
			};
		},
		candidateState: (status, characterId) => {
			cacheRevision();
			const state = queryClient.getQueryState<{ candidates: MemoryCandidate[] }>(
				queryKeys.memoryCandidates(status, characterId ?? currentCharacterId()),
			);
			return {
				candidates: state?.data?.candidates ?? [],
				loading: state?.fetchStatus === "fetching",
				error: state?.error ? messageOf(state.error) : null,
			};
		},
		entries: activeMemoryEntries,
		revision: memoryRevision,
		list: async (params) => {
			const scopedParams = { ...params, characterId: params?.characterId ?? currentCharacterId() };
			const key = memoryKey(scopedParams);
			setMemoryProjectionKey(key);
			const data = await refreshRpcQuery({
				client: queryClient,
				key,
				request: () => memoryRequest(scopedParams),
			});
			setMemoryRevision((revision) => revision + 1);
			return data.entries;
		},
		search: async (query, scope, characterId) => {
			const targetCharacterId = characterId ?? currentCharacterId();
			const key = queryKeys.memoryProjection(scope, query, targetCharacterId);
			setMemoryProjectionKey(key);
			const data = await refreshRpcQuery({
				client: queryClient,
				key,
				request: () =>
					invoke(client, () => {
						return client.memory.search({
							query,
							scope,
							...(targetCharacterId ? { characterId: targetCharacterId } : {}),
						});
					}),
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
				// The durable mutation already succeeded. A projection refresh can
				// race the Host's committed memory event; it must never turn a saved
				// memory back into an apparent capture failure.
				void refreshMemoryEntries().catch((error) =>
					retainProjectionError("memory.capture", error, "projection"),
				);
				return result;
			} catch (e) {
				retainOperationError("memory.capture", e);
				throw e;
			}
		},
		configureLocalEmbedding: async (provider, candidateId, customPath) => {
			try {
				const result = (await localConfigureMutation.mutateAsync({
					provider,
					...(provider === "local" && candidateId ? { candidateId } : {}),
					...(provider === "local" && customPath ? { customPath } : {}),
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
		forget: async (entryId, characterId) => {
			await invoke(client, () => {
				const targetCharacterId =
					characterId ?? activeCharacters().find((character) => character.active)?.id;
				return client.memory.forget({
					entryId,
					...(targetCharacterId ? { characterId: targetCharacterId } : {}),
				});
			});
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryEntries();
		},
		edit: async (entryId, newText, characterId) => {
			await invoke(client, () => {
				const targetCharacterId =
					characterId ?? activeCharacters().find((character) => character.active)?.id;
				return client.memory.edit({
					entryId,
					newText,
					...(targetCharacterId ? { characterId: targetCharacterId } : {}),
				});
			});
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryEntries();
		},
		exclude: async (memoryId, excluded, characterId) => {
			await invoke(client, () => {
				const targetCharacterId =
					characterId ?? activeCharacters().find((character) => character.active)?.id;
				return client.memory.exclude({
					memoryId,
					excluded,
					...(targetCharacterId ? { characterId: targetCharacterId } : {}),
				});
			});
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryEntries();
		},
		candidates: activeMemoryCandidates,
		listCandidates: async (status, characterId) => {
			const targetCharacterId = characterId ?? currentCharacterId();
			const key = queryKeys.memoryCandidates(status, targetCharacterId);
			setMemoryCandidateProjectionKey(key);
			const data = await refreshRpcQuery({
				client: queryClient,
				key,
				request: () => memoryCandidatesRequest(status, targetCharacterId),
			});
			setMemoryRevision((revision) => revision + 1);
			return data.candidates;
		},
		approveCandidate: async (candidateId, editedText, decidedScope, characterId) => {
			await invoke(client, () => {
				const targetCharacterId =
					characterId ?? activeCharacters().find((character) => character.active)?.id;
				return client.memory.candidateApprove({
					candidateId,
					editedText,
					decidedScope,
					...(targetCharacterId ? { characterId: targetCharacterId } : {}),
				});
			});
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryCandidates();
			debouncedRefreshMemoryEntries();
		},
		rejectCandidate: async (candidateId, characterId) => {
			await invoke(client, () => {
				const targetCharacterId =
					characterId ?? activeCharacters().find((character) => character.active)?.id;
				return client.memory.candidateReject({
					candidateId,
					...(targetCharacterId ? { characterId: targetCharacterId } : {}),
				});
			});
			setMemoryRevision((revision) => revision + 1);
			debouncedRefreshMemoryCandidates();
			debouncedRefreshMemoryEntries();
		},
	};

	const settingsApi: SettingsApi = {
		data: (characterId) => {
			cacheRevision();
			return characterId
				? queryClient.getQueryData<{ settings: SettingsData }>([
						"settings",
						"character",
						characterId,
					])?.settings
				: settingsQuery.data?.settings;
		},
		get: async (characterId) => {
			if (characterId) {
				const { settings } = await refreshRpcQuery({
					client: queryClient,
					key: ["settings", "character", characterId],
					request: () => invoke(client, () => client.settings.get({ characterId })),
				});
				return settings;
			}
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.settings,
				request: settingsRequest,
			});
			return data.settings;
		},
		set: async (settings, characterId) => {
			if (characterId) {
				await invoke(client, () => client.settings.set({ characterId, settings }));
				await settingsApi.get(characterId);
				return;
			}
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
	const refreshModelRoute = async (conversationId: string): Promise<ModelRouteData> => {
		const route = await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.modelRoute(conversationId),
			request: () => invoke(client, () => client.model.routeGet({ conversationId })),
		});
		return route;
	};

	const oauthMutation = createRpcMutation<() => Promise<unknown>>({
		client: queryClient,
		request: (action) => action(),
		invalidates: [],
	});
	const providerApi: ProviderApi = {
		loginState: (id) => {
			cacheRevision();
			return queryClient.getQueryData<ProviderLoginResult>(queryKeys.providerLogin(id));
		},
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
		login: async (providerId) => {
			const receipt = await oauthMutation.mutateAsync(() =>
				invoke(client, () => client.provider.login({ providerId, authType: "oauth" })),
			);
			void providerApi
				.loginStatus(providerId)
				.catch((error) => retainOperationError("provider.loginStatus", error));
			return receipt as ProviderLoginResult;
		},
		loginStatus: (providerId) =>
			refreshRpcQuery({
				client: queryClient,
				key: queryKeys.providerLogin(providerId),
				request: () => invoke(client, () => client.provider.loginStatus({ providerId })),
			}),
		loginAnswer: async (providerId, answer) => {
			await oauthMutation.mutateAsync(() =>
				invoke(client, () => client.provider.loginAnswer({ providerId, answer })),
			);
			return providerApi.loginStatus(providerId);
		},
		loginCancel: async (providerId) => {
			await oauthMutation.mutateAsync(() =>
				invoke(client, () => client.provider.loginCancel({ providerId })),
			);
			await providerApi.loginStatus(providerId);
		},
		logout: async (providerId) => {
			await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.logout({ providerId })),
			);
			queryClient.removeQueries({ queryKey: queryKeys.providerLogin(providerId), exact: true });
		},
		remove: async (providerId) => {
			await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.remove({ providerId })),
			);
			queryClient.removeQueries({ queryKey: queryKeys.providerLogin(providerId), exact: true });
			await Promise.all([
				refreshRpcQuery({
					client: queryClient,
					key: queryKeys.providers,
					request: providersRequest,
				}),
				refreshModelPool(),
				refreshModelDefaults(),
				...(activeConversationId() !== null
					? [refreshModelRoute(activeConversationId() as string)]
					: []),
			]);
		},
	};

	const modelData = (): ModelListData => {
		void modelsQuery.data;
		void defaultsQuery.data;
		const models =
			queryClient.getQueryData<{ models: ConfiguredModel[] }>(queryKeys.modelPool)?.models ?? [];
		const defaults = queryClient.getQueryData<NonNullable<typeof defaultsQuery.data>>(
			queryKeys.modelDefaults,
		) ?? {
			vision: { mode: "auto" as const },
		};
		const selected = currentModelRoute()?.selected;
		const multimodalFallback =
			defaults.vision.mode === "manual" ? defaults.vision.route : undefined;
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
	};
	const modelApi: ModelApi = {
		data: modelData,
		models: () => {
			void modelsQuery.data;
			return (
				queryClient.getQueryData<{ models: ConfiguredModel[] }>(queryKeys.modelPool)?.models ?? []
			);
		},
		loading: () => modelsQuery.isFetching || defaultsQuery.isFetching,
		error: () => modelsQuery.error ?? defaultsQuery.error,
		refetch: () => {
			void refreshModelPool().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			void refreshModelDefaults().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			if (activeConversationId() !== null)
				void refreshModelRoute(activeConversationId() as string).catch((error) =>
					retainProjectionError("background.read", error, "projection"),
				);
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

	const runApi: RunApi = {
		list: async () => {
			const data = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.runs,
				request: runsRequest,
			});
			return data;
		},
		pendingPermissions: () => snapshotValue()?.presentation?.permissions ?? [],
		steer: async (runId, instruction) => {
			await invoke(client, () => client.run.steer({ runId, instruction }));
		},
		interrupt: async (runId) => {
			const data = await invoke(client, () => client.run.interrupt({ runId }));
			void refreshRuns().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			return data;
		},
		resume: async (runId) => {
			const data = await invoke(client, () => client.run.resume({ runId }));
			void refreshRuns().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			return data;
		},
		cancel: async (runId) => {
			const data = await invoke(client, () => client.run.cancel({ runId }));
			await refreshSnapshot();
			void refreshRuns().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			return data;
		},
		respondPermission: async (runId, requestId, optionId) => {
			const data = await invoke(client, () =>
				client.run.respondPermission({ runId, requestId, optionId }),
			);
			await refreshSnapshot();
			void refreshRuns().catch((error) =>
				retainProjectionError("background.read", error, "projection"),
			);
			return data;
		},
	};
	const externalAgentApi: ExternalAgentApi = {
		status: () => invoke(client, () => client.externalAgent.status({})),
		discover: async () =>
			(await invoke(client, () => client.externalAgent.discoverCodex({}))).candidates,
		connect: async (params) => {
			await invoke(client, () => client.externalAgent.connectCodex(params));
		},
	};

	const attachmentApi: AttachmentApi = {
		readData: (params) => {
			cacheRevision();
			return queryClient.getQueryData(["attachments", "read", params]);
		},
		list: async (conversationId, attachmentId) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: ["attachments", "list", conversationId, attachmentId ?? null],
					request: () =>
						invoke(client, () =>
							client.conversationAttachment.list({ conversationId, attachmentId }),
						),
				})
			).attachments,
		data: (conversationId, attachmentId) => {
			cacheRevision();
			return queryClient
				.getQueryData<{
					attachments: import("@bear-harness/protocol").ConversationAttachmentSummary[];
				}>(["attachments", "list", conversationId, attachmentId])
				?.attachments.find((item) => item.id === attachmentId);
		},
		observeUploads: (conversationId) => {
			const query = createRpcQuery({
				client: queryClient,
				key: () => ["attachments", "uploads", conversationId()],
				enabled: () => Boolean(conversationId()),
				request: (key) =>
					invoke(client, () =>
						client.conversationAttachment.uploads({ conversationId: key[2] as string }),
					),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		startUpload: async (params) =>
			invoke(client, () => client.conversationAttachment.startUpload(params)),
		appendChunk: async (params) => {
			await invoke(client, () => client.conversationAttachment.appendChunk(params));
		},
		completeUpload: async (params) =>
			invoke(client, () => client.conversationAttachment.completeUpload(params)),
		cancelUpload: async (params) => {
			await invoke(client, () => client.conversationAttachment.cancelUpload(params));
			await refreshRpcQuery({
				client: queryClient,
				key: ["attachments", "uploads", params.conversationId],
				request: () =>
					invoke(client, () =>
						client.conversationAttachment.uploads({ conversationId: params.conversationId }),
					),
			});
		},
		discard: async (conversationId, attachmentId) => {
			await invoke(client, () =>
				client.conversationAttachment.discard({ conversationId, attachmentId }),
			);
			queryClient.removeQueries({
				predicate: (query) => {
					const key = query.queryKey;
					if (key[0] !== "attachments") return false;
					if (key[1] === "list") return key[2] === conversationId;
					const params = key[2];
					return (
						typeof params === "object" &&
						params !== null &&
						"conversationId" in params &&
						params.conversationId === conversationId &&
						"attachmentId" in params &&
						params.attachmentId === attachmentId
					);
				},
			});
		},
		read: async (params) => {
			const response = await refreshRpcQuery({
				client: queryClient,
				key: ["attachments", "read", params],
				request: () => invoke(client, () => client.conversationAttachment.read(params)),
			});
			if (response.mode !== "semantic") throw new Error("unexpected_attachment_read_mode");
			return response;
		},
		readBytes: async (params) => {
			const response = await refreshRpcQuery({
				client: queryClient,
				key: ["attachments", "read", params],
				request: () => invoke(client, () => client.conversationAttachment.read(params)),
			});
			if (response.mode !== "bytes") throw new Error("unexpected_attachment_read_mode");
			return response;
		},
		url: async (params) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: ["attachments", "url", params],
					request: () => invoke(client, () => client.conversationAttachment.url(params)),
				})
			).url,
	};

	const activeCharacters = createMemo<CharacterSummary[]>(
		() => charactersQuery.data?.characters ?? [],
	);
	const characterApi: CharacterApi = {
		observeTrust: (characterId) => {
			const query = createRpcQuery({
				client: queryClient,
				key: () => ["character", "trust", characterId()],
				request: (key) =>
					invoke(client, () => client.character.pluginTrustGet({ characterId: key[2] as string })),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		observePackage: (characterId) => {
			const enabled = () => Boolean(characterId());
			const query = createRpcQuery({
				client: queryClient,
				key: () => queryKeys.characterPackage(characterId() ?? ""),
				enabled,
				request: (key) =>
					invoke(client, () => client.character.packageGet({ characterId: key[2] as string })),
			});
			createRpcQuery({
				client: queryClient,
				key: () => ["character", "trust", characterId() ?? ""],
				enabled,
				request: (key) =>
					invoke(client, () => client.character.pluginTrustGet({ characterId: key[2] as string })),
			});
			createRpcQuery({
				client: queryClient,
				key: () => ["settings", "character", characterId() ?? ""],
				enabled,
				request: (key) =>
					invoke(client, () => client.settings.get({ characterId: key[2] as string })),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		packageData: (id) => {
			cacheRevision();
			return queryClient.getQueryData<{ package: CharacterPackageDocument }>(
				queryKeys.characterPackage(id),
			)?.package;
		},
		pluginTrustData: (id) => {
			cacheRevision();
			return queryClient.getQueryData<{ trust: Awaited<ReturnType<CharacterApi["pluginTrust"]>> }>([
				"character",
				"trust",
				id,
			])?.trust;
		},
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
			await Promise.all([
				onboardingStore.resync(),
				refreshCharacters(),
				invalidateConversationList(),
				invalidateActiveConversationQueries(),
				refreshSnapshot(),
			]);
		},
		import: async (files) => {
			await invoke(client, () => client.character.import({ files }));
			await refreshCharacters();
		},
		pluginTrust: async (characterId) => {
			const { trust } = await refreshRpcQuery({
				client: queryClient,
				key: ["character", "trust", characterId],
				request: () => invoke(client, () => client.character.pluginTrustGet({ characterId })),
			});
			return trust;
		},
		packageGet: async (characterId) => {
			const { package: document } = await refreshRpcQuery({
				client: queryClient,
				key: queryKeys.characterPackage(characterId),
				request: () => invoke(client, () => client.character.packageGet({ characterId })),
			});
			return document;
		},
		packageUpdate: async (characterId, yaml, expectedSha256) => {
			await invoke(client, () =>
				client.character.packageUpdate({ characterId, yaml, expectedSha256 }),
			);
			return characterApi.packageGet(characterId);
		},
		confirmPluginTrust: async (characterId) => {
			await invoke(client, () => client.character.pluginTrustConfirm({ characterId }));
			await characterApi.pluginTrust(characterId);
		},
		draftCreate: async (params = {}) => {
			const { draft } = await invoke(client, () => client.character.draftCreate(params));
			return characterApi.draftGet(draft.id);
		},
		draftGet: async (id) => {
			const { draft } = await refreshRpcQuery({
				client: queryClient,
				key: ["character", "draft", id],
				request: () => invoke(client, () => client.character.draftGet({ id })),
			});
			return draft;
		},
		draftPatch: async (id, expectedRevision, files) => {
			const { draft } = await invoke(client, () =>
				client.character.draftPatch({ id, expectedRevision, files }),
			);
			return characterApi.draftGet(draft.id);
		},
		draftUploadAssets: async (id, expectedRevision, assets) => {
			const { draft } = await invoke(client, () =>
				client.character.draftUploadAssets({ id, expectedRevision, assets }),
			);
			return characterApi.draftGet(draft.id);
		},
		draftListRevisions: async (id) => {
			const { revisions } = await refreshRpcQuery({
				client: queryClient,
				key: ["character", "draftRevisions", id],
				request: () => invoke(client, () => client.character.draftListRevisions({ id })),
			});
			return revisions;
		},
		draftRestoreRevision: async (id, expectedRevision, sourceRevision) => {
			const { draft } = await invoke(client, () =>
				client.character.draftRestoreRevision({ id, expectedRevision, sourceRevision }),
			);
			return characterApi.draftGet(draft.id);
		},
		draftValidate: async (id, expectedRevision) => {
			const { draft } = await invoke(client, () =>
				client.character.draftValidate({ id, expectedRevision }),
			);
			return characterApi.draftGet(draft.id);
		},
		draftPublish: async (id, expectedRevision) => {
			const { draft } = await invoke(client, () =>
				client.character.draftPublish({ id, expectedRevision }),
			);
			await Promise.all([
				onboardingStore.resync(),
				refreshCharacters(),
				invalidateConversationList(),
				invalidateActiveConversationQueries(),
				refreshSnapshot(),
			]);
			return characterApi.draftGet(draft.id);
		},
	};
	const activeCanonSources = createMemo<CanonSource[]>(() => canonSourcesQuery.data?.sources ?? []);
	const activeCanonModules = createMemo<CanonModule[]>(() => canonModulesQuery.data?.modules ?? []);
	const canonApi: CanonApi = {
		searchResults: (query) => {
			cacheRevision();
			return (
				queryClient.getQueryData<{ chunks: CanonChunk[] }>([
					"canon",
					"search",
					currentCharacterId() ?? null,
					query,
				])?.chunks ?? []
			);
		},
		sources: activeCanonSources,
		modules: activeCanonModules,
		listSources: async () => {
			await refreshCanonSources();
		},
		addSource: async (logicalName, content) => {
			await invoke(client, () =>
				client.canon.addSource({ logicalName, content, characterId: currentCharacterId() }),
			);
			await refreshCanonSources();
		},
		search: async (query) => {
			const characterId = currentCharacterId();
			const { chunks } = await refreshRpcQuery({
				client: queryClient,
				key: ["canon", "search", characterId ?? null, query],
				request: () => invoke(client, () => client.canon.search({ query, characterId })),
			});
			return chunks;
		},
		removeSource: async (sourceId) => {
			await invoke(client, () =>
				client.canon.removeSource({ sourceId, characterId: currentCharacterId() }),
			);
			await refreshCanonSources();
		},
		listModules: async () => {
			await refreshCanonModules();
		},
		upsertModule: async (params) => {
			await invoke(client, () =>
				client.canon.upsertModule({ ...params, characterId: currentCharacterId() }),
			);
			await refreshCanonModules();
		},
		deleteModule: async (id) => {
			await invoke(client, () =>
				client.canon.deleteModule({ id, characterId: currentCharacterId() }),
			);
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
		downloadState,
		cancelDownload: () => invoke(client, () => client.memory.cancelLocalEmbeddingDownload({})),
		settingsQuery,
		capabilitiesQuery: settingsCapabilitiesQuery,
		settingsMutation: embeddingSettingsMutation,
		localConfigureMutation,
	};
	const trackedMemoryApi = trackApi("memory", memoryApi);
	const trackedSettingsApi = trackApi("settings", settingsApi);
	const trackedProviderApi = trackApi("provider", providerApi);
	const trackedModelApi = trackApi("model", modelApi);
	const trackedRunApi = trackApi("run", runApi);
	const trackedExternalAgentApi = trackApi("externalAgent", externalAgentApi);
	const trackedAttachmentApi = trackApi("conversationAttachment", attachmentApi);
	const trackedCharacterApi = trackApi("character", characterApi);
	const trackedCanonApi = trackApi("canon", canonApi);

	const store: CompanionStore = {
		get loading() {
			return state.loading || snapshotQuery.isPending;
		},
		get error() {
			return state.error ?? (snapshotQuery.error ? messageOf(snapshotQuery.error) : null);
		},
		get errorMetadata() {
			return (
				state.errorMetadata ??
				(snapshotQuery.error
					? projectionError("snapshot.get", snapshotQuery.error, "projection")
					: null)
			);
		},
		get onboarding() {
			return onboardingStore.data();
		},
		get activeConversationId() {
			return activeProjection()?.activeConversationId ?? null;
		},
		get activePiTimeline() {
			return activeProjection()?.piTimeline;
		},
		get activePiLiveState() {
			return activeProjection()?.piLiveState;
		},
		get conversations() {
			return activeConversations();
		},
		get archivedConversations() {
			return archivedConversations();
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
				await Promise.all([
					refreshConversations(),
					refreshSnapshot(),
					refreshActiveConversationProjection(),
				]);
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

		loadOlderMessages: async () => {
			const projection = activeProjection();
			if (!projection || projection.piTimeline.hasMoreBefore !== true) return;
			const beforeOffset = projection.piTimeline.startOffset ?? 0;
			const response = await invoke(client, () =>
				client.conversation.timelinePage({ id: projection.id, beforeOffset }),
			);
			const page = requirePiTimeline(response.piTimeline, "conversation.timelinePage");
			const existing = timelinePrefixes.get(projection.id)?.entries ?? [];
			const ids = new Set(page.entries.map((entry) => entry.id));
			timelinePrefixes.set(projection.id, {
				startOffset: page.startOffset ?? 0,
				entries: [...page.entries, ...existing.filter((entry) => !ids.has(entry.id))],
			});
			writeActiveProjection(projection);
		},

		selectConversation: async (id) => {
			try {
				await queryClient.cancelQueries({ queryKey: queryKeys.activeConversation });
				const projection = (await selectConversationMutation.mutateAsync({
					id,
				})) as ConversationSelectResponse;
				requirePiTimeline(projection.piTimeline, "conversation.select");
				if (isMutationResponse(projection)) await refreshActiveConversationProjection();
				else writeActiveProjection(projection);
				clearOperationError();
				await invalidateDerivedConversationQueries(projection);
			} catch (e) {
				if (e instanceof PiTimelineProjectionError) {
					retainProjectionError("conversation.select", e, "projection");
				} else {
					retainOperationError("conversation.select", e);
				}
			}
		},

		createConversation: async (title) => {
			try {
				await Promise.all([
					queryClient.cancelQueries({ queryKey: queryKeys.activeConversation }),
					queryClient.cancelQueries({ queryKey: queryKeys.conversations }),
				]);
				const projection = (await createConversationMutation.mutateAsync({
					title,
				})) as ConversationSelectResponse;
				requirePiTimeline(projection.piTimeline, "conversation.create");
				if (isMutationResponse(projection)) await refreshActiveConversationProjection();
				else writeActiveProjection(projection);
				clearOperationError();
				await Promise.all([
					invalidateConversationList(),
					invalidateDerivedConversationQueries(projection),
					refreshModelRoute(projection.activeConversationId),
				]);
			} catch (e) {
				if (e instanceof PiTimelineProjectionError) {
					retainProjectionError("conversation.create", e, "projection");
				} else {
					retainOperationError("conversation.create", e);
				}
			}
		},
		createConversationFromEntry: async (entryId) => {
			try {
				const sourceConversationId = requireActiveConversation();
				const projection = (await invoke(client, () =>
					client.conversation.create({ sourceConversationId, sourceEntryId: entryId }),
				)) as ConversationSelectResponse;
				requirePiTimeline(projection.piTimeline, "conversation.createFromEntry");
				if (isMutationResponse(projection)) await refreshActiveConversationProjection();
				else writeActiveProjection(projection);
				clearOperationError();
				await Promise.all([
					invalidateConversationList(),
					invalidateDerivedConversationQueries(projection),
					refreshModelRoute(projection.activeConversationId),
				]);
			} catch (e) {
				retainOperationError("conversation.createFromEntry", e);
			}
		},

		renameConversation: async (id, title) => {
			await invoke(client, () => client.conversation.rename({ id, title }));
			await refreshConversations();
		},

		archiveConversation: async (id) => {
			try {
				await Promise.all([
					queryClient.cancelQueries({ queryKey: queryKeys.activeConversation }),
					queryClient.cancelQueries({ queryKey: queryKeys.conversations }),
				]);
				const response = (await archiveConversationMutation.mutateAsync({
					id,
				})) as ConversationActiveResponse;
				if (response.conversation !== undefined) {
					requirePiTimeline(response.conversation.piTimeline, "conversation.archive");
				}
				queryClient.removeQueries({
					predicate: (query) => {
						const key = query.queryKey;
						return (
							(key[0] === "models" && key[1] === "route" && key[2] === id) ||
							(key[0] === "attachments" &&
								(key[2] === id ||
									(typeof key[2] === "object" &&
										key[2] !== null &&
										"conversationId" in key[2] &&
										key[2].conversationId === id)))
						);
					},
				});
				if (isMutationResponse(response)) await refreshActiveConversationProjection();
				else writeActiveProjection(response.conversation);
				clearOperationError();
				await Promise.all([
					invalidateConversationList(),
					queryClient.invalidateQueries({ queryKey: queryKeys.archivedConversations }),
					invalidateDerivedConversationQueries(response.conversation),
				]);
			} catch (e) {
				retainOperationError("conversation.archive", e);
			}
		},

		restoreConversation: async (id) => {
			try {
				await invoke(client, () => client.conversation.archive({ id, archived: false }));
				clearOperationError();
				await Promise.all([
					invalidateConversationList(),
					queryClient.invalidateQueries({ queryKey: queryKeys.archivedConversations }),
				]);
			} catch (e) {
				retainOperationError("conversation.restore", e);
			}
		},

		deleteConversation: async (id) => {
			try {
				await Promise.all([
					queryClient.cancelQueries({ queryKey: queryKeys.activeConversation }),
					queryClient.cancelQueries({ queryKey: queryKeys.conversations }),
				]);
				const response = (await deleteConversationMutation.mutateAsync({
					id,
				})) as ConversationActiveResponse;
				if (response.conversation !== undefined) {
					requirePiTimeline(response.conversation.piTimeline, "conversation.delete");
				}
				queryClient.removeQueries({
					predicate: (query) => {
						const key = query.queryKey;
						return (
							(key[0] === "models" && key[1] === "route" && key[2] === id) ||
							(key[0] === "attachments" &&
								(key[2] === id ||
									(typeof key[2] === "object" &&
										key[2] !== null &&
										"conversationId" in key[2] &&
										key[2].conversationId === id)))
						);
					},
				});
				if (isMutationResponse(response)) await refreshActiveConversationProjection();
				else writeActiveProjection(response.conversation);
				clearOperationError();
				await Promise.all([
					invalidateConversationList(),
					queryClient.invalidateQueries({ queryKey: queryKeys.archivedConversations }),
					invalidateDerivedConversationQueries(response.conversation),
				]);
			} catch (e) {
				retainOperationError("conversation.delete", e);
			}
		},
		patchCharacterState: async (operations) => {
			const conversationId = requireActiveConversation();
			const projection = snapshotValue()?.characterState?.byConversation[conversationId];
			if (!projection) throw new Error("character_state_projection_unavailable");
			await invoke(client, () =>
				client.characterState.patch({
					conversationId,
					expectedRevisions: projection.revisions,
					operations,
					dedupeKey: crypto.randomUUID(),
				}),
			);
		},
		sendMessage: async (text, attachmentIds) => {
			// No optimistic transcript state: Pi accepts the command first, then
			// the Host projection is read back under its native session identity.
			try {
				const conversationId = requireActiveConversation();
				setState("sending", true);
				try {
					const receipt = await invoke(client, () =>
						client.message.send({
							conversationId,
							text,
							...(attachmentIds?.length ? { attachmentIds } : {}),
						}),
					);
					await refreshConversationProjection(conversationId, receipt.sessionId);
				} finally {
					setState("sending", false);
				}
				clearOperationError();
			} catch (e) {
				retainOperationError("message.send", e);
			}
		},

		regenerateMessage: async (entryId) => {
			try {
				const conversationId = requireActiveConversation();
				const sessionId = activeProjection()?.piSessionId;
				await invoke(client, () => client.message.regenerate({ conversationId, entryId }));
				if (sessionId) await refreshConversationProjection(conversationId, sessionId);
				clearOperationError();
			} catch (e) {
				retainOperationError("message.regenerate", e);
			}
		},

		editMessage: async (entryId, text) => {
			try {
				const conversationId = requireActiveConversation();
				const sessionId = activeProjection()?.piSessionId;
				await invoke(client, () => client.message.edit({ conversationId, entryId, text }));
				if (sessionId) await refreshConversationProjection(conversationId, sessionId);
				clearOperationError();
			} catch (e) {
				retainOperationError("message.edit", e);
			}
		},

		correctMessage: async (entryId, presetId, detail) => {
			try {
				const conversationId = requireActiveConversation();
				const sessionId = activeProjection()?.piSessionId;
				await invoke(client, () =>
					client.message.correct({
						conversationId,
						entryId,
						presetId,
						...(detail?.trim() ? { detail: detail.trim() } : {}),
					}),
				);
				if (sessionId) await refreshConversationProjection(conversationId, sessionId);
				clearOperationError();
			} catch (e) {
				retainOperationError("message.correct", e);
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
			await refreshSnapshot();
		},
		dismissRoleplayMedia: async () => {
			try {
				const conversationId = requireActiveConversation();
				const mediaId = currentPresentation()?.mediaId;
				if (mediaId === undefined) return;
				await invoke(client, () => client.roleplay.dismissMedia({ conversationId, mediaId }));
				await refreshSnapshot();
				clearOperationError();
			} catch (e) {
				retainOperationError("roleplay.dismissMedia", e);
			}
		},
		dismissAmbientMedia: async () => {
			try {
				const conversationId = requireActiveConversation();
				const mediaId = currentPresentation()?.ambientMediaId;
				if (mediaId === undefined) return;
				await invoke(client, () => client.roleplay.dismissMedia({ conversationId, mediaId }));
				await refreshSnapshot();
				clearOperationError();
			} catch (e) {
				retainOperationError("roleplay.dismissMedia", e);
			}
		},
		submitOnboarding: async (stepId, answer) => {
			try {
				await onboardingStore.submit(stepId, answer);
				await onboardingStore.resync();
				if (onboardingStore.data().status === "complete") {
					await Promise.all([refreshConversations(), refreshActiveConversationProjection()]);
					const conversationId = activeConversationId();
					if (conversationId !== null) await refreshModelRoute(conversationId);
				}
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
			return snapshotValue()?.characterRuntime?.byConversation ?? {};
		},
		get characterState() {
			return snapshotValue()?.characterState;
		},
		get roleplay() {
			return snapshotValue()?.roleplay;
		},
		get activeRoleplayMediaId() {
			return currentPresentation()?.mediaId;
		},
		get activeAmbientMediaId() {
			return currentPresentation()?.ambientMediaId;
		},
		get activeRoleplayChoiceSetId() {
			return currentPresentation()?.choiceSetId;
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
		get run() {
			return trackedRunApi;
		},
		get externalAgent() {
			return trackedExternalAgentApi;
		},
		get attachments() {
			return trackedAttachmentApi;
		},
		get characters() {
			return trackedCharacterApi;
		},
		get canon() {
			return trackedCanonApi;
		},
	};
	onCleanup(() => {
		if (COMPANION_STORES.get(client) === store) {
			COMPANION_STORES.delete(client);
		}
	});
	return store;
}
