/**
 * Companion store: the single reactive facade the renderer consumes.
 *
 * Architecture (per the M5 recovery contract in
 * `local://renderer-contract.md`):
 *
 * - A boot `snapshot.get` resource seeds every domain; its `eventSeq` is the
 *   cursor for the event-subscription loop.
 * - A `createEffect` + `onCleanup` poll loop calls `events.subscribe(afterSeq)`
 *   and projects each `DomainEvent` into the reactive state. Gaps (seq jumps)
 *   discard the optimistic projection and re-fetch the snapshot. Duplicate
 *   replay is skipped (the event bus is idempotent by contract).
 * - Every value that crosses the client is validated by a narrow guard in
 *   `stores/ipc.ts`; malformed payloads are dropped, never projected.
 * - A missing client (the injected `CompanionClient` is absent) surfaces as
 *   `error = "unavailable"`, empty data, presence `idle`.
 *
 * The store is a flat object whose reactive fields are getters into a Solid
 * store proxy, so components read `store.activeMessages` etc. directly. All
 * action methods call the client, set `error` on failure and clear it on
 * the next success. Supplementary domain APIs (memory/settings/provider/
 * model/commission/artifact) are exposed for the backstage sheets.
 */

import type { CompanionClient } from "@bear-harness/companion-client";
import { i18n, useTranslation } from "@bear-harness/i18n";
import type { RoleplayState } from "@bear-harness/protocol";
import { useQueryClient } from "@tanstack/solid-query";
import {
	createContext,
	createEffect,
	createResource,
	createSignal,
	onCleanup,
	type ParentProps,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { IpcInvocationError } from "../lib/ipc.js";
import {
	type Artifact,
	type ArtifactListData,
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
	invoke,
	isRecord,
	type MemoryCandidate,
	type MemoryDecision,
	type MemoryEntry,
	type MemoryListData,
	type MemoryScope,
	type Message,
	type MessageApplyScope,
	type ModelListData,
	type ModelRouteData,
	type OnboardingData,
	type ProviderInfo,
	type ProviderListData,
	type ProviderLoginResult,
	payloadString,
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
import { createOnboardingStore } from "./onboarding.js";
import { createRpcMutation, createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";

export * from "./ipc.js";
export type { OnboardingStore } from "./onboarding.js";
export { createOnboardingStore } from "./onboarding.js";

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

const POLL_INTERVAL_MS = 1000;
const SNAPSHOT_RETRY_MS = 5000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function parseRunPermission(payload: unknown): RunPermissionRequest | null {
	if (
		!isRecord(payload) ||
		typeof payload.runId !== "string" ||
		typeof payload.requestId !== "string" ||
		typeof payload.prompt !== "string" ||
		!Array.isArray(payload.options)
	) {
		return null;
	}
	const options = payload.options;
	if (
		!options.every(
			(option) =>
				isRecord(option) &&
				typeof option.optionId === "string" &&
				typeof option.kind === "string" &&
				typeof option.name === "string",
		)
	) {
		return null;
	}
	return {
		runId: payload.runId,
		requestId: payload.requestId,
		prompt: payload.prompt,
		options: options as RunPermissionRequest["options"],
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
	candidates(): MemoryCandidate[];
	entries(): MemoryEntry[] | undefined;
	listCandidates(): Promise<MemoryListData>;
	decideCandidate(
		candidateId: string,
		decision: MemoryDecision,
		editedText?: string,
		scope?: MemoryScope,
	): Promise<void>;
	search(query: string, scope?: MemoryScope): Promise<MemoryEntry[]>;
	list(params?: Record<string, unknown>): Promise<MemoryEntry[]>;
	pin(entryId: string, pinned: boolean): Promise<void>;
	forget(entryId: string): Promise<void>;
	exclude(entryId: string, excluded: boolean): Promise<void>;
	edit(entryId: string, newText: string): Promise<void>;
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
		modelId: string;
		apiKey?: string;
		supportsImages?: boolean;
	}): Promise<void>;
	importPiConfig(configJson: string): Promise<void>;
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
	cancel(runId: string): Promise<RunInfo>;
	respondPermission(runId: string, requestId: string, optionId: string): Promise<RunInfo>;
}

export interface ArtifactApi {
	artifacts(): Artifact[];
	list(): Promise<ArtifactListData>;
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

export interface CompanionStore {
	readonly loading: boolean;
	readonly error: string | null;
	readonly onboarding: OnboardingData;
	readonly conversations: ConversationSummary[];
	readonly activeConversationId: string | null;
	readonly activeMessages: Message[];
	readonly pendingUserText: string | undefined;
	readonly streamingAssistantText: string;
	readonly assistantStreaming: boolean;
	readonly runs: RunInfo[];
	readonly presence: PresenceState;
	readonly character: CharacterDisplay | undefined;
	readonly characterRuntimeByConversation: Readonly<Record<string, CharacterRuntimeState>>;
	readonly roleplay: RoleplayState | undefined;
	readonly activeRoleplayMediaId: string | undefined;
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
	regenerateMessage(messageId: string): Promise<void>;
	switchVersion(messageId: string, versionId: string): Promise<void>;
	editMessage(messageId: string, text: string, isUserMessage: boolean): Promise<void>;
	continueConversation(): Promise<void>;
	correctMessage(reason: string, applyScope: MessageApplyScope): Promise<void>;
	branchMessage(messageId: string): Promise<void>;
	abort(): Promise<void>;
	triggerRoleplayEvent(eventId: string): Promise<void>;
	dismissRoleplayMedia(): void;
	submitOnboarding(stepId: string, answer?: string): Promise<void>;

	/** Boot snapshot + event-bus access (supplementary). */
	readonly snapshot: SnapshotApi;
	readonly events: EventsApi;
	/** Supplementary domain APIs consumed by the backstage sheets. */
	readonly memory: MemoryApi;
	readonly settings: SettingsApi;
	readonly provider: ProviderApi;
	readonly model: ModelApi;
	readonly commission: CommissionApi;
	readonly run: RunApi;
	readonly artifact: ArtifactApi;
	readonly story: StoryApi;
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
	| "unknown";

interface CompanionState {
	loading: boolean;
	error: string | null;
	conversations: ConversationSummary[];
	activeConversationId: string | null;
	activeBranchId: string | null;
	activeMessages: Message[];
	pendingUserText: string | undefined;
	streamingAssistantText: string;
	committedStreamingMessageId: string | null;
	assistantStreaming: boolean;
	runs: RunInfo[];
	presence: PresenceState;
	characterRuntimeByConversation: Record<string, CharacterRuntimeState>;
	memoryCandidates: MemoryCandidate[];
	memoryEntries: MemoryEntry[] | undefined;
	commissions: Commission[];
	artifacts: Artifact[];
	storyChanges: StoryChange[];
	storyProposals: StoryChangeProposal[];
	characters: CharacterSummary[];
	canonSources: CanonSource[];
	canonModules: CanonModule[];
	companionState: CompanionProcessState;
	sending: boolean;
	lastRunEvent: "adopted" | null;
	pendingRunPermissions: Record<string, RunPermissionRequest>;
	activeRoleplayMediaId: string | undefined;
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

function derivePresence(s: CompanionState): PresenceState {
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

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

const PENDING_REFETCHES = new Map<() => void, ReturnType<typeof setTimeout>>();

function debouncedRefetch(fn: () => void, ms = 250): void {
	const existing = PENDING_REFETCHES.get(fn);
	if (existing !== undefined) clearTimeout(existing);
	PENDING_REFETCHES.set(
		fn,
		setTimeout(() => {
			PENDING_REFETCHES.delete(fn);
			fn();
		}, ms),
	);
}

function isStaleOnboardingStep(error: unknown): boolean {
	return error instanceof IpcInvocationError && error.kind === "conflict";
}

export function createCompanionStore(client: CompanionClient): CompanionStore {
	const [t] = useTranslation(undefined, { i18n });
	const queryClient = useQueryClient();
	const [state, setState] = createStore<CompanionState>({
		loading: true,
		error: null,
		conversations: [],
		activeConversationId: null,
		activeBranchId: null,
		activeMessages: [],
		pendingUserText: undefined,
		streamingAssistantText: "",
		committedStreamingMessageId: null,
		assistantStreaming: false,
		runs: [],
		presence: "idle",
		memoryCandidates: [],
		characterRuntimeByConversation: {},
		memoryEntries: undefined,
		commissions: [],
		artifacts: [],
		storyChanges: [],
		storyProposals: [],
		characters: [],
		canonSources: [],
		canonModules: [],
		companionState: "unknown",
		sending: false,
		lastRunEvent: null,
		pendingRunPermissions: {},
		activeRoleplayMediaId: undefined,
		activeRoleplayChoiceSetId: undefined,
	});

	const [lastSeq, setLastSeq] = createSignal(0);
	const [stale, setStale] = createSignal(false);

	const [snapshotResource, snapshotActions] = createResource<Snapshot>(
		() => invoke(client, () => client.snapshot.get()),
		{ initialValue: { eventSeq: 0 } },
	);

	const onboardingStore = createOnboardingStore(client);
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
	const currentModelRoute = (): ModelRouteData | undefined => {
		modelRouteRevision();
		const conversationId = state.activeConversationId;
		return conversationId
			? queryClient.getQueryData<ModelRouteData>(queryKeys.modelRoute(conversationId))
			: undefined;
	};
	const settingsMutation = createRpcMutation<() => Promise<unknown>>({
		client: queryClient,
		request: (request) => request(),
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

	const refreshConversations = async (): Promise<void> => {
		const { conversations } = await invoke(client, () => client.conversation.list());
		setState("conversations", conversations);
	};

	const refreshRuns = async (): Promise<void> => {
		const { runs } = await invoke(client, () => client.run.list());
		setState("runs", runs);
	};

	const refreshMemory = async (): Promise<void> => {
		const { candidates } = await invoke(client, () => client.memory.listCandidates());
		setState("memoryCandidates", candidates);
	};

	const refreshMemoryEntries = async (): Promise<void> => {
		const { entries } = await invoke(client, () => client.memory.list());
		setState("memoryEntries", entries);
	};

	const refreshCommissions = async (): Promise<void> => {
		const { commissions } = await invoke(client, () => client.commission.list());
		setState("commissions", commissions);
	};

	const refreshArtifacts = async (): Promise<void> => {
		const { artifacts } = await invoke(client, () => client.artifact.list());
		setState("artifacts", artifacts);
	};

	const refreshStory = async (): Promise<void> => {
		const { changes } = await invoke(client, () =>
			client.story.listChanges({ branchId: state.activeBranchId ?? undefined }),
		);
		setState("storyChanges", changes);
	};

	const refreshStoryProposals = async (): Promise<void> => {
		const { proposals } = await invoke(client, () =>
			client.story.listProposals({ conversationId: state.activeConversationId ?? undefined }),
		);
		setState("storyProposals", proposals);
	};

	const refreshCharacters = async (): Promise<void> => {
		const { characters } = await invoke(client, () => client.character.list());
		setState("characters", characters);
	};

	const refreshSupplementary = async (): Promise<void> => {
		await Promise.all([
			refreshMemory(),
			refreshMemoryEntries(),
			refreshCommissions(),
			refreshRuns(),
			refreshArtifacts(),
			refreshStory(),
			refreshStoryProposals(),
			refreshCharacters(),
		]);
	};

	// ---- snapshot → domain hydration ----

	const hydrateFromSnapshot = (snap: Snapshot): void => {
		onboardingStore._hydrate(snap.onboarding);
		const conversation = snap.conversation;
		if (conversation) {
			if (conversation.activeConversationId !== undefined && !conversationSelectionChangedLocally) {
				setState("activeConversationId", conversation.activeConversationId);
				const conversationId = conversation.activeConversationId;
				void refreshRpcQuery({
					client: queryClient,
					key: queryKeys.modelRoute(conversationId),
					request: () => invoke(client, () => client.model.routeGet({ conversationId })),
				}).then(() => setModelRouteRevision((revision) => revision + 1));
			}
			if (conversation.activeBranchId !== undefined) {
				setState("activeBranchId", conversation.activeBranchId);
			}
			if (conversation.messages !== undefined) {
				setState("activeMessages", conversation.messages);
				const committedId = state.committedStreamingMessageId;
				if (committedId && conversation.messages.some((message) => message.id === committedId)) {
					setState("streamingAssistantText", "");
					setState("committedStreamingMessageId", null);
				}
			}
			if (conversation.conversations !== undefined) {
				setState("conversations", conversation.conversations);
			}
		}
		if (snap.memory) {
			if (snap.memory.candidates !== undefined)
				setState("memoryCandidates", snap.memory.candidates);
			if (snap.memory.entries !== undefined) setState("memoryEntries", snap.memory.entries);
		}
		if (snap.run) setState("runs", snap.run.runs);
		if (snap.commission) setState("commissions", snap.commission.commissions);
		if (snap.artifact) setState("artifacts", snap.artifact.artifacts);
		if (snap.story) setState("storyChanges", snap.story.changes);
		if (snap.characterRuntime)
			setState("characterRuntimeByConversation", snap.characterRuntime.byConversation);
		setLastSeq(Math.max(lastSeq(), snap.eventSeq));
	};

	const snapshotValue = (): Snapshot | undefined =>
		snapshotResource.error !== undefined ? undefined : snapshotResource.latest;

	createEffect(() => {
		const loading = snapshotResource.loading;
		if (loading) return;
		const failure = snapshotResource.error;
		if (failure !== undefined) {
			setState("error", messageOf(failure));
			const retry = setTimeout(() => {
				void snapshotActions.refetch();
			}, SNAPSHOT_RETRY_MS);
			onCleanup(() => clearTimeout(retry));
		} else {
			const data = snapshotValue();
			if (data !== undefined) {
				setState("error", null);
				hydrateFromSnapshot(data);
			}
		}
		setState("loading", false);
		setStale(false);
		if (!booted) {
			booted = true;
			if (client) {
				void refreshConversations().catch((e) => setState("error", messageOf(e)));
				void refreshSupplementary().catch((e) => setState("error", messageOf(e)));
			}
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
		const kind = event.kind;
		switch (kind) {
			case "message.user_sent":
				setState("sending", true);
				setState("lastRunEvent", null);
				return;
			case "message_start":
				setState("sending", true);
				setState("assistantStreaming", true);
				return;
			case "message_update": {
				const chunk = payloadString(event.payload, "text") ?? "";
				setState("assistantStreaming", true);
				setState("streamingAssistantText", (current) =>
					chunk.startsWith(current) ? chunk : `${current}${chunk}`,
				);
				return;
			}
			case "message_end": {
				const finalText = payloadString(event.payload, "text");
				if (finalText !== undefined) setState("streamingAssistantText", finalText);
				setState("sending", false);
				setState("assistantStreaming", false);
				void snapshotActions.refetch();
				return;
			}
			case "message.assistant_committed": {
				const messageId = payloadString(event.payload, "messageId");
				if (messageId) setState("committedStreamingMessageId", messageId);
				setState("sending", false);
				setState("assistantStreaming", false);
				void snapshotActions.refetch();
				return;
			}
			case "message.aborted":
				setState("sending", false);
				setState("assistantStreaming", false);
				setState("streamingAssistantText", "");
				setState("committedStreamingMessageId", null);
				return;
			case "character.scene_changed":
			case "character.visual_state_changed": {
				const conversationId = payloadString(event.payload, "conversationId");
				const sceneId = payloadString(event.payload, "sceneId");
				const visualState = payloadString(event.payload, "visualState");
				if (conversationId && sceneId && visualState) {
					setState("characterRuntimeByConversation", conversationId, { sceneId, visualState });
				}
				return;
			}
			case "roleplay.media_presented":
				setState("activeRoleplayMediaId", payloadString(event.payload, "mediaId"));
				return;
			case "roleplay.choices_presented":
				setState("activeRoleplayChoiceSetId", payloadString(event.payload, "choiceSetId"));
				return;
			case "conversation.created": {
				debouncedRefetch(refreshConversations);
				return;
			}
			case "model.selected": {
				const conversationId = payloadString(event.payload, "conversationId");
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
				const branchId = payloadString(event.payload, "branchId");
				if (branchId) setState("activeBranchId", branchId);
				void snapshotActions.refetch();
				return;
			}
			case "onboarding.state_changed":
			case "onboarding.reset":
				onboardingStore._applyEvent(event);
				return;
			case "companion.state_changed": {
				const next = payloadString(event.payload, "state");
				setState(
					"companionState",
					next === "running" || next === "crashed" || next === "unavailable" || next === "stopped"
						? next
						: "unknown",
				);
				if (next === "crashed" || next === "unavailable") void snapshotActions.refetch();
				return;
			}
			case "run.needs_user": {
				const permission = parseRunPermission(event.payload);
				if (permission) {
					setState("pendingRunPermissions", permission.runId, permission);
				}
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
		if (kind.startsWith("message.") || kind.startsWith("conversation.")) {
			void snapshotActions.refetch();
		} else if (kind.startsWith("onboarding.")) {
			onboardingStore._applyEvent(event);
		} else if (kind.startsWith("memory.")) {
			debouncedRefetch(refreshMemory);
			debouncedRefetch(refreshMemoryEntries);
		} else if (kind.startsWith("provider.")) {
			void queryClient.invalidateQueries(
				{ queryKey: queryKeys.providers },
				{ cancelRefetch: false },
			);
		} else if (kind.startsWith("model.")) {
			void refreshModelPool();
			void refreshModelDefaults();
			if (state.activeConversationId) void refreshModelRoute(state.activeConversationId);
		} else if (kind.startsWith("commission.")) {
			debouncedRefetch(refreshCommissions);
		} else if (kind.startsWith("run.")) {
			const runId = payloadString(event.payload, "runId");
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
			void snapshotActions.refetch();
		} else if (kind.startsWith("roleplay.")) {
			void snapshotActions.refetch();
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
		if (!client) return;
		const loading = snapshotResource.loading;
		if (loading || snapshotResource.error !== undefined) return;
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
				} catch {
					if (cancelled) return;
					await sleep(POLL_INTERVAL_MS);
					continue;
				}
				if (cancelled) return;
				if (batch.length === 0) {
					await sleep(POLL_INTERVAL_MS);
					continue;
				}
				const first = batch[0];
				const last = batch[batch.length - 1];
				if (first === undefined || last === undefined) {
					await sleep(POLL_INTERVAL_MS);
					continue;
				}
				if (first.seq > afterSeq + 1) {
					// Gap: the projection is untrustworthy — re-sync from the snapshot.
					setStale(true);
					void snapshotActions.refetch();
					return;
				}
				if (first.seq <= afterSeq) {
					// Duplicate replay (idempotent per the event-bus contract): skip.
					await sleep(POLL_INTERVAL_MS);
					continue;
				}
				for (const event of batch) dispatchEvent(event);
				afterSeq = last.seq;
				setLastSeq(afterSeq);
			}
		})();
	});

	// ---- presence derivation ----

	createEffect(() => {
		setState("presence", derivePresence(state));
	});

	// ---- actions ----

	const requireActiveConversation = (): string => {
		const id = state.activeConversationId;
		if (id === null) throw new Error(t("messages.noActiveConversationError"));
		return id;
	};

	const snapshotApi: SnapshotApi = {
		data: snapshotValue,
		eventSeq: () => snapshotValue()?.eventSeq ?? 0,
		loading: () => snapshotResource.loading,
		error: () => snapshotResource.error,
		refetch: () => {
			void snapshotActions.refetch();
		},
		get: () => invoke(client, () => client.snapshot.get()),
	};

	const memoryApi: MemoryApi = {
		candidates: () => state.memoryCandidates,
		entries: () => state.memoryEntries,
		listCandidates: async () => {
			const data = await invoke(client, () => client.memory.listCandidates());
			setState("memoryCandidates", data.candidates);
			return data;
		},
		decideCandidate: async (candidateId, decision, editedText, scope) => {
			await invoke(client, () =>
				client.memory.decideCandidate({ candidateId, decision, editedText, scope }),
			);
			debouncedRefetch(refreshMemory);
		},
		search: async (query, scope) => {
			const data = await invoke(client, () => client.memory.search({ query, scope }));
			setState("memoryEntries", data.entries);
			return data.entries;
		},
		list: async (params) => {
			const data = await invoke(client, () => client.memory.list(params));
			setState("memoryEntries", data.entries);
			return data.entries;
		},
		pin: async (entryId, pinned) => {
			await invoke(client, () => client.memory.pin({ entryId, pinned }));
			debouncedRefetch(refreshMemoryEntries);
		},
		forget: async (entryId) => {
			await invoke(client, () => client.memory.forget({ entryId }));
			debouncedRefetch(refreshMemoryEntries);
		},
		exclude: async (entryId, excluded) => {
			await invoke(client, () => client.memory.exclude({ entryId, excluded }));
			debouncedRefetch(refreshMemoryEntries);
		},
		edit: async (entryId, newText) => {
			await invoke(client, () => client.memory.edit({ entryId, newText }));
			debouncedRefetch(refreshMemoryEntries);
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
			await settingsMutation.mutateAsync(() =>
				invoke(client, () => client.settings.set({ settings })),
			);
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
			await providerMutation.mutateAsync(() =>
				invoke(client, () => client.provider.importPiConfig({ configJson })),
			);
			await refreshModelPool();
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

	const modelApi: ModelApi = {
		data: () => {
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
		},
		models: () => modelsQuery.data?.models ?? [],
		selectedValue: () => {
			const route = currentModelRoute()?.selected;
			return route ? `${route.providerId}:${route.modelId}` : "";
		},
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

	const commissionApi: CommissionApi = {
		commissions: () => state.commissions,
		list: async () => {
			const data = await invoke(client, () => client.commission.list());
			setState("commissions", data.commissions);
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
			const data = await invoke(client, () => client.run.list());
			setState("runs", data.runs);
			return data;
		},
		pendingPermissions: () => Object.values(state.pendingRunPermissions),
		steer: async (runId, instruction) => {
			await invoke(client, () => client.run.steer({ runId, instruction }));
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

	const artifactApi: ArtifactApi = {
		artifacts: () => state.artifacts,
		list: async () => {
			const data = await invoke(client, () => client.artifact.list());
			setState("artifacts", data.artifacts);
			return data;
		},
		download: async (artifactId) => {
			const data = await invoke(client, () => client.artifact.read({ artifactId }));
			const bytes = Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0));
			const url = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = data.logicalName;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		},
	};

	const storyApi: StoryApi = {
		changes: () => state.storyChanges,
		proposals: () =>
			state.storyProposals.filter(
				(proposal) => proposal.conversationId === state.activeConversationId,
			),
		list: async (branchId) => {
			const data = await invoke(client, () => client.story.listChanges({ branchId }));
			setState("storyChanges", data.changes);
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

	const characterApi: CharacterApi = {
		characters: () => state.characters,
		list: async () => {
			const data = await invoke(client, () => client.character.list());
			setState("characters", data.characters);
			return data;
		},
		activate: async (characterId) => {
			await invoke(client, () => client.character.activate({ characterId }));
			conversationSelectionChangedLocally = true;
			setState("activeConversationId", null);
			setState("activeBranchId", null);
			setState("activeMessages", []);
			await Promise.all([
				onboardingStore.resync(),
				refreshCharacters(),
				refreshConversations(),
				Promise.resolve(snapshotActions.refetch()),
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
			setState("activeMessages", []);
			await Promise.all([
				onboardingStore.resync(),
				refreshCharacters(),
				refreshConversations(),
				Promise.resolve(snapshotActions.refetch()),
			]);
			return draft;
		},
	};

	const canonApi: CanonApi = {
		sources: () => state.canonSources,
		modules: () => state.canonModules,
		listSources: async () => {
			const { sources } = await invoke(client, () => client.canon.listSources());
			setState("canonSources", sources);
		},
		addSource: async (logicalName, content) => {
			await invoke(client, () => client.canon.addSource({ logicalName, content }));
			await canonApi.listSources();
		},
		search: async (query) => {
			const { chunks } = await invoke(client, () => client.canon.search({ query }));
			return chunks;
		},
		removeSource: async (sourceId) => {
			await invoke(client, () => client.canon.removeSource({ sourceId }));
			await canonApi.listSources();
		},
		listModules: async () => {
			const { modules } = await invoke(client, () => client.canon.listModules());
			setState("canonModules", modules);
		},
		upsertModule: async (params) => {
			await invoke(client, () => client.canon.upsertModule(params));
			await canonApi.listModules();
		},
		deleteModule: async (id) => {
			await invoke(client, () => client.canon.deleteModule({ id }));
			await canonApi.listModules();
		},
	};

	return {
		get loading() {
			return state.loading;
		},
		get error() {
			return state.error;
		},
		get onboarding() {
			return onboardingStore.data();
		},
		get conversations() {
			return state.conversations;
		},
		get activeConversationId() {
			return state.activeConversationId;
		},
		get activeMessages() {
			return state.activeMessages;
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
			return state.runs;
		},
		get presence() {
			return state.presence;
		},

		refresh: async () => {
			setState("loading", true);
			try {
				await Promise.all([refreshConversations(), Promise.resolve(snapshotActions.refetch())]);
				if (snapshotResource.error === undefined) setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			} finally {
				setState("loading", false);
			}
			try {
				await refreshSupplementary();
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		selectConversation: async (id, branchId) => {
			try {
				const projection = await invoke(client, () => client.conversation.select({ id, branchId }));
				conversationSelectionChangedLocally = true;
				setState("activeConversationId", projection.activeConversationId);
				setState("activeBranchId", projection.activeBranchId ?? null);
				setState("activeMessages", projection.messages);
				setState("error", null);
				void refreshStoryProposals();
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		createConversation: async (title) => {
			try {
				const result = await invoke(client, () => client.conversation.create({ title }));
				conversationSelectionChangedLocally = true;
				setState("activeConversationId", result.id);
				setState("activeBranchId", null);
				setState("activeMessages", []);
				setState("error", null);
				await Promise.all([refreshConversations(), refreshModelRoute(result.id)]);
			} catch (e) {
				setState("error", messageOf(e));
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
				setState("activeBranchId", null);
				setState("activeMessages", []);
			}
			await refreshConversations();
		},

		deleteConversation: async (id) => {
			await invoke(client, () => client.conversation.delete({ id }));
			if (state.activeConversationId === id) {
				conversationSelectionChangedLocally = true;
				setState("activeConversationId", null);
				setState("activeBranchId", null);
				setState("activeMessages", []);
			}
			await refreshConversations();
		},

		sendMessage: async (text, attachments) => {
			setState("pendingUserText", text);
			setState("streamingAssistantText", "");
			setState("committedStreamingMessageId", null);
			setState("assistantStreaming", true);
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.send({ conversationId, text, attachments }));
				await snapshotActions.refetch();
				setState("pendingUserText", undefined);
				setState("error", null);
			} catch (e) {
				setState("assistantStreaming", false);
				setState("error", messageOf(e));
			}
		},

		regenerateMessage: async (messageId) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.regenerate({ conversationId, messageId }));
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		switchVersion: async (messageId, versionId) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () =>
					client.message.switchVersion({ conversationId, messageId, versionId }),
				);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		editMessage: async (messageId, text, isUserMessage) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () =>
					client.message.edit({ conversationId, messageId, text, isUserMessage }),
				);
				await snapshotActions.refetch();
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		continueConversation: async () => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.continue({ conversationId }));
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		correctMessage: async (reason, applyScope) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.correct({ conversationId, reason, applyScope }));
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		branchMessage: async (messageId) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.branch({ conversationId, messageId }));
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		abort: async () => {
			try {
				const conversationId = requireActiveConversation();
				await invoke(client, () => client.message.abort({ conversationId }));
				setState("sending", false);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		triggerRoleplayEvent: async (eventId) => {
			const conversationId = requireActiveConversation();
			await invoke(client, () =>
				client.roleplay.trigger({ conversationId, eventId, dedupeKey: crypto.randomUUID() }),
			);
			setState("activeRoleplayChoiceSetId", undefined);
			await snapshotActions.refetch();
		},
		dismissRoleplayMedia: () => setState("activeRoleplayMediaId", undefined),

		submitOnboarding: async (stepId, answer) => {
			try {
				await onboardingStore.submit(stepId, answer);
				await onboardingStore.resync();
				setState("error", null);
			} catch (error) {
				if (isStaleOnboardingStep(error)) {
					try {
						await onboardingStore.resync();
						setState("error", null);
					} catch (resyncError) {
						setState("error", messageOf(resyncError));
					}
					return;
				}
				setState("error", messageOf(error));
			}
		},

		get character() {
			return snapshotResource.latest?.character;
		},
		get characterRuntimeByConversation() {
			return state.characterRuntimeByConversation;
		},
		get roleplay() {
			return snapshotResource.latest?.roleplay;
		},
		get activeRoleplayMediaId() {
			return state.activeRoleplayMediaId;
		},
		get activeRoleplayChoiceSetId() {
			return state.activeRoleplayChoiceSetId;
		},
		get snapshot() {
			return snapshotApi;
		},
		get events() {
			return eventsApi;
		},
		get memory() {
			return memoryApi;
		},
		get settings() {
			return settingsApi;
		},
		get provider() {
			return providerApi;
		},
		get model() {
			return modelApi;
		},
		get commission() {
			return commissionApi;
		},
		get run() {
			return runApi;
		},
		get artifact() {
			return artifactApi;
		},
		get story() {
			return storyApi;
		},
		get characters() {
			return characterApi;
		},
		get canon() {
			return canonApi;
		},
	};
}
