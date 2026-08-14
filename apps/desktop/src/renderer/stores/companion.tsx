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
 * - Every value that crosses the bridge is validated by a narrow guard in
 *   `stores/ipc.ts`; malformed payloads are dropped, never projected.
 * - A missing bridge (`window.bearDesktop.companion` absent) surfaces as
 *   `error = "unavailable"`, empty data, presence `idle`.
 *
 * The store is a flat object whose reactive fields are getters into a Solid
 * store proxy, so components read `store.activeMessages` etc. directly. All
 * action methods call the bridge, set `error` on failure and clear it on the
 * next success. Supplementary domain APIs (memory/settings/provider/voice/
 * commission/artifact) are exposed for the backstage sheets.
 */

import {
	createContext,
	createEffect,
	createResource,
	createSignal,
	onCleanup,
	useContext,
	type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { createOnboardingStore } from "./onboarding.js";
import { createVoiceStore } from "./voice.js";
import {
	invoke,
	isOnboardingStep,
	isSettingsData,
	normalizeArtifactList,
	normalizeCommissionList,
	normalizeConversationList,
	normalizeConversationSnapshot,
	normalizeMemoryEntries,
	normalizeMemorySnapshot,
	normalizeProviderList,
	normalizeRunList,
	payloadString,
	sanitizeSnapshot,
	type Artifact,
	type ArtifactListData,
	type Commission,
	type CommissionListData,
	type CharacterDisplay,
	type CharacterRuntimeState,
	type ConversationCreateResult,
	type ConversationListData,
	type ConversationSummary,
	type DomainEvent,
	type EventBatch,
	type MemoryCandidate,
	type MemoryDecision,
	type MemoryEntry,
	type MemoryListData,
	type MemoryScope,
	type MemorySearchData,
	type Message,
	type MessageApplyScope,
	type MessageBranchResult,
	type MessageSendResult,
	type OnboardingData,
	type OnboardingStep,
	type ProviderInfo,
	type ProviderListData,
	type ProviderLoginResult,
	type RelationKind,
	type RunInfo,
	type RunListData,
	type SettingsData,
	type SettingsResponseData,
	type Snapshot,
	type VoiceListData,
	type VoiceStack,
	type VoiceSwitchScope,
} from "./ipc.js";

export * from "./ipc.js";
export { createOnboardingStore } from "./onboarding.js";
export type { OnboardingStore } from "./onboarding.js";
export { createVoiceStore } from "./voice.js";
export type { VoiceStore } from "./voice.js";

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
const MAX_EVENTS_PER_BATCH = 100;
const SNAPSHOT_RETRY_MS = 5000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
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
	set(settings: Partial<SettingsData>): Promise<void>;
}

export interface ProviderApi {
	providers(): ProviderInfo[];
	list(): Promise<ProviderListData>;
	setApiKey(providerId: string, apiKey: string, sessionOnly?: boolean): Promise<void>;
	login(providerId: string): Promise<ProviderLoginResult>;
	logout(providerId: string): Promise<void>;
}

export interface VoiceApi {
	data(): VoiceListData;
	stacks(): VoiceStack[];
	activeStackId(): string | undefined;
	loading(): boolean;
	error(): unknown;
	refetch(): void;
	list(): Promise<VoiceListData>;
	switch(stackId: string, scope: VoiceSwitchScope): Promise<void>;
}

export interface CommissionApi {
	commissions(): Commission[];
	list(): Promise<CommissionListData>;
}

export interface ArtifactApi {
	artifacts(): Artifact[];
	list(): Promise<ArtifactListData>;
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
	readonly runs: RunInfo[];
	readonly presence: PresenceState;
	readonly character: CharacterDisplay | undefined;
	readonly characterRuntimeByConversation: Readonly<Record<string, CharacterRuntimeState>>;

	refresh(): Promise<void>;
	selectConversation(id: string, branchId?: string): Promise<void>;
	createConversation(title?: string): Promise<void>;
	sendMessage(text: string): Promise<void>;
	regenerateMessage(messageId: string): Promise<void>;
	switchVersion(messageId: string, versionId: string): Promise<void>;
	editMessage(messageId: string, text: string, isUserMessage: boolean): Promise<void>;
	continueConversation(): Promise<void>;
	correctMessage(reason: string, applyScope: MessageApplyScope): Promise<void>;
	branchMessage(messageId: string): Promise<void>;
	abort(): Promise<void>;
	setOnboardingName(name: string): Promise<void>;
	setOnboardingRelation(kind: RelationKind): Promise<void>;
	setOnboardingMemoryDecision(enabled: boolean): Promise<void>;
	advanceOnboarding(): Promise<void>;

	/** Boot snapshot + event-bus access (supplementary). */
	readonly snapshot: SnapshotApi;
	readonly events: EventsApi;
	/** Supplementary domain APIs consumed by the backstage sheets. */
	readonly memory: MemoryApi;
	readonly settings: SettingsApi;
	readonly provider: ProviderApi;
	readonly voice: VoiceApi;
	readonly commission: CommissionApi;
	readonly artifact: ArtifactApi;
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

type CompanionProcessState = "starting" | "running" | "crashed" | "unavailable" | "stopped" | "unknown";

interface CompanionState {
	loading: boolean;
	error: string | null;
	conversations: ConversationSummary[];
	activeConversationId: string | null;
	activeBranchId: string | null;
	activeMessages: Message[];
	runs: RunInfo[];
	presence: PresenceState;
	characterRuntimeByConversation: Record<string, CharacterRuntimeState>;
	memoryCandidates: MemoryCandidate[];
	memoryEntries: MemoryEntry[] | undefined;
	settingsData: SettingsData | undefined;
	providers: ProviderInfo[];
	commissions: Commission[];
	artifacts: Artifact[];
	companionState: CompanionProcessState;
	sending: boolean;
	lastRunEvent: "adopted" | null;
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

export function createCompanionStore(): CompanionStore {
	const [state, setState] = createStore<CompanionState>({
		loading: true,
		error: null,
		conversations: [],
		activeConversationId: null,
		activeBranchId: null,
		activeMessages: [],
		runs: [],
		presence: "idle",
		memoryCandidates: [],
		characterRuntimeByConversation: {},
		memoryEntries: undefined,
		settingsData: undefined,
		providers: [],
		commissions: [],
		artifacts: [],
		companionState: "unknown",
		sending: false,
		lastRunEvent: null,
	});

	const [lastSeq, setLastSeq] = createSignal(0);
	const [stale, setStale] = createSignal(false);

	const [snapshotResource, snapshotActions] = createResource<Snapshot>(
		() => {
			const companion = window.bearDesktop?.companion;
			if (!companion) return { eventSeq: 0 };
			return invoke<Snapshot>(() => companion.snapshot.get()).then(sanitizeSnapshot);
		},
		{ initialValue: { eventSeq: 0 } },
	);

	const onboardingStore = createOnboardingStore();
	const voiceStore = createVoiceStore();

	let booted = false;

	// ---- refresh helpers (each re-fetches one domain list) ----

	const refreshConversations = async (): Promise<void> => {
		const data = await invoke<ConversationListData>(() =>
			window.bearDesktop.companion.conversation.list(),
		);
		const parsed = normalizeConversationList(data);
		if (parsed) setState("conversations", parsed.conversations);
	};

	const refreshRuns = async (): Promise<void> => {
		const data = await invoke<RunListData>(() => window.bearDesktop.companion.run.list());
		const parsed = normalizeRunList(data);
		if (parsed) setState("runs", parsed.runs);
	};

	const refreshMemory = async (): Promise<void> => {
		const data = await invoke<MemoryListData>(() =>
			window.bearDesktop.companion.memory.listCandidates(),
		);
		const parsed = normalizeMemorySnapshot(data);
		if (parsed?.candidates) setState("memoryCandidates", parsed.candidates);
	};

	const refreshMemoryEntries = async (): Promise<void> => {
		const data = await invoke<unknown>(() => window.bearDesktop.companion.memory.list());
		const entries = normalizeMemoryEntries(data);
		if (entries) setState("memoryEntries", entries);
	};

	const refreshProviders = async (): Promise<void> => {
		const data = await invoke<ProviderListData>(() => window.bearDesktop.companion.provider.list());
		const parsed = normalizeProviderList(data);
		if (parsed) setState("providers", parsed.providers);
	};

	const refreshCommissions = async (): Promise<void> => {
		const data = await invoke<CommissionListData>(() => window.bearDesktop.companion.commission.list());
		const parsed = normalizeCommissionList(data);
		if (parsed) setState("commissions", parsed.commissions);
	};

	const refreshArtifacts = async (): Promise<void> => {
		const data = await invoke<ArtifactListData>(() => window.bearDesktop.companion.artifact.list());
		const parsed = normalizeArtifactList(data);
		if (parsed) setState("artifacts", parsed.artifacts);
	};

	const refreshSettings = async (): Promise<void> => {
		const data = await invoke<SettingsResponseData>(() => window.bearDesktop.companion.settings.get());
		if (isSettingsData(data.settings)) setState("settingsData", data.settings);
	};

	const refreshSupplementary = (): void => {
		void Promise.allSettled([
			refreshMemory(),
			refreshMemoryEntries(),
			refreshProviders(),
			Promise.resolve(voiceStore.refetch()),
			refreshCommissions(),
			refreshRuns(),
			refreshArtifacts(),
			refreshSettings(),
		]);
	};

	// ---- snapshot → domain hydration ----

	const hydrateFromSnapshot = (snap: Snapshot): void => {
		onboardingStore._hydrate(snap.onboarding);
		voiceStore._hydrate(snap.voice);
		const conversation = snap.conversation;
		if (conversation) {
			if (conversation.activeConversationId !== undefined) {
				setState("activeConversationId", conversation.activeConversationId);
			}
			if (conversation.activeBranchId !== undefined) {
				setState("activeBranchId", conversation.activeBranchId);
			}
			if (conversation.messages !== undefined) setState("activeMessages", conversation.messages);
			if (conversation.conversations !== undefined) {
				setState("conversations", conversation.conversations);
			}
		}
		if (snap.memory) {
			if (snap.memory.candidates !== undefined) setState("memoryCandidates", snap.memory.candidates);
			if (snap.memory.entries !== undefined) setState("memoryEntries", snap.memory.entries);
		}
		if (snap.provider) setState("providers", snap.provider.providers);
		if (snap.run) setState("runs", snap.run.runs);
		if (snap.commission) setState("commissions", snap.commission.commissions);
		if (snap.artifact) setState("artifacts", snap.artifact.artifacts);
		if (snap.settings) setState("settingsData", snap.settings);
		if (snap.characterRuntime) setState("characterRuntimeByConversation", snap.characterRuntime.byConversation);
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
			if (window.bearDesktop?.companion) {
				void refreshConversations().catch((e) => setState("error", messageOf(e)));
				refreshSupplementary();
			}
		}
	});

	// ---- event subscription loop ----

	const eventsApi: EventsApi = {
		lastSeq,
		stale,
		subscribe: (afterSeq) =>
			invoke<EventBatch>(() => window.bearDesktop.companion.events.subscribe(afterSeq)).then(
				(batch) => batch.events,
			),
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
				return;
			case "message_update":
				// Streaming progress; main commits the message at message_end.
				return;
			case "message_end":
				setState("sending", false);
				void snapshotActions.refetch();
				return;
			case "message.aborted":
				setState("sending", false);
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
			case "conversation.created": {
				const id = payloadString(event.payload, "conversationId");
				if (id) setState("activeConversationId", id);
				debouncedRefetch(refreshConversations);
				return;
			}
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
			debouncedRefetch(refreshProviders);
		} else if (kind.startsWith("voice.")) {
			voiceStore._applyEvent(event);
		} else if (kind.startsWith("commission.")) {
			debouncedRefetch(refreshCommissions);
		} else if (kind.startsWith("run.")) {
			debouncedRefetch(refreshRuns);
		} else if (kind.startsWith("artifact.")) {
			debouncedRefetch(refreshArtifacts);
		} else if (kind.startsWith("settings.")) {
			debouncedRefetch(refreshSettings);
		}
		// Other kinds (evidence.collected, codex.*, fsops.*, diagnostics.* …)
		// are intentionally ignored: they do not invalidate projected state.
	};

	createEffect(() => {
		if (!window.bearDesktop?.companion) return;
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
				if (batch.length >= MAX_EVENTS_PER_BATCH) continue; // drain a backlog
				await sleep(POLL_INTERVAL_MS);
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
		if (id === null) throw new Error("conflict: 还没有选中对话");
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
		get: () =>
			invoke<Snapshot>(() => window.bearDesktop.companion.snapshot.get()).then(sanitizeSnapshot),
	};

	const memoryApi: MemoryApi = {
		candidates: () => state.memoryCandidates,
		entries: () => state.memoryEntries,
		listCandidates: async () => {
			const data = await invoke<MemoryListData>(() =>
				window.bearDesktop.companion.memory.listCandidates(),
			);
			const parsed = normalizeMemorySnapshot(data);
			if (parsed?.candidates) setState("memoryCandidates", parsed.candidates);
			return data;
		},
		decideCandidate: async (candidateId, decision, editedText, scope) => {
			await invoke<void>(() =>
				window.bearDesktop.companion.memory.decideCandidate(candidateId, decision, editedText, scope),
			);
			debouncedRefetch(refreshMemory);
		},
		search: async (query, scope) => {
			const data = await invoke<MemorySearchData>(() =>
				window.bearDesktop.companion.memory.search(query, scope),
			);
			const entries = normalizeMemoryEntries(data);
			if (entries) setState("memoryEntries", entries);
			return entries ?? [];
		},
		list: async (params) => {
			const data = await invoke<unknown>(() => window.bearDesktop.companion.memory.list(params));
			const entries = normalizeMemoryEntries(data);
			if (entries) setState("memoryEntries", entries);
			return entries ?? [];
		},
		pin: async (entryId, pinned) => {
			await invoke<void>(() => window.bearDesktop.companion.memory.pin(entryId, pinned));
			debouncedRefetch(refreshMemoryEntries);
		},
		forget: async (entryId) => {
			await invoke<void>(() => window.bearDesktop.companion.memory.forget(entryId));
			debouncedRefetch(refreshMemoryEntries);
		},
		exclude: async (entryId, excluded) => {
			await invoke<void>(() => window.bearDesktop.companion.memory.exclude(entryId, excluded));
			debouncedRefetch(refreshMemoryEntries);
		},
		edit: async (entryId, newText) => {
			await invoke<void>(() => window.bearDesktop.companion.memory.edit(entryId, newText));
			debouncedRefetch(refreshMemoryEntries);
		},
	};

	const settingsApi: SettingsApi = {
		data: () => state.settingsData,
		get: async () => {
			const data = await invoke<SettingsResponseData>(() => window.bearDesktop.companion.settings.get());
			if (isSettingsData(data.settings)) setState("settingsData", data.settings);
			return data.settings;
		},
		set: async (settings) => {
			await invoke<void>(() => window.bearDesktop.companion.settings.set(settings));
			void refreshSettings();
		},
	};

	const providerApi: ProviderApi = {
		providers: () => state.providers,
		list: async () => {
			const data = await invoke<ProviderListData>(() => window.bearDesktop.companion.provider.list());
			const parsed = normalizeProviderList(data);
			if (parsed) setState("providers", parsed.providers);
			return data;
		},
		setApiKey: async (providerId, apiKey, sessionOnly) => {
			await invoke<void>(() =>
				window.bearDesktop.companion.provider.setApiKey(providerId, apiKey, sessionOnly),
			);
			debouncedRefetch(refreshProviders);
		},
		login: (providerId) => invoke<ProviderLoginResult>(() => window.bearDesktop.companion.provider.login(providerId)),
		logout: async (providerId) => {
			await invoke<void>(() => window.bearDesktop.companion.provider.logout(providerId));
			debouncedRefetch(refreshProviders);
		},
	};

	const voiceApi: VoiceApi = {
		data: voiceStore.data,
		stacks: voiceStore.stacks,
		activeStackId: voiceStore.activeStackId,
		loading: voiceStore.loading,
		error: voiceStore.error,
		refetch: voiceStore.refetch,
		list: voiceStore.list,
		switch: voiceStore.switch,
	};

	const commissionApi: CommissionApi = {
		commissions: () => state.commissions,
		list: async () => {
			const data = await invoke<CommissionListData>(() => window.bearDesktop.companion.commission.list());
			const parsed = normalizeCommissionList(data);
			if (parsed) setState("commissions", parsed.commissions);
			return data;
		},
	};

	const artifactApi: ArtifactApi = {
		artifacts: () => state.artifacts,
		list: async () => {
			const data = await invoke<ArtifactListData>(() => window.bearDesktop.companion.artifact.list());
			const parsed = normalizeArtifactList(data);
			if (parsed) setState("artifacts", parsed.artifacts);
			return data;
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
			refreshSupplementary();
		},

		selectConversation: async (id, branchId) => {
			try {
				await invoke<void>(() => window.bearDesktop.companion.conversation.select(id, branchId));
				setState("activeConversationId", id);
				setState("activeBranchId", branchId ?? null);
				setState("error", null);
				void snapshotActions.refetch();
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		createConversation: async (title) => {
			try {
				const result = await invoke<ConversationCreateResult>(() =>
					window.bearDesktop.companion.conversation.create(title),
				);
				setState("activeConversationId", result.id);
				setState("activeBranchId", null);
				setState("error", null);
				void refreshConversations().catch((e) => setState("error", messageOf(e)));
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		sendMessage: async (text) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<MessageSendResult>(() =>
					window.bearDesktop.companion.message.send(conversationId, text),
				);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		regenerateMessage: async (messageId) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<void>(() =>
					window.bearDesktop.companion.message.regenerate(conversationId, messageId),
				);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		switchVersion: async (messageId, versionId) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<void>(() =>
					window.bearDesktop.companion.message.switchVersion(conversationId, messageId, versionId),
				);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		editMessage: async (messageId, text, isUserMessage) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<void>(() =>
					window.bearDesktop.companion.message.edit(conversationId, messageId, text, isUserMessage),
				);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		continueConversation: async () => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<void>(() => window.bearDesktop.companion.message.continue(conversationId));
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		correctMessage: async (reason, applyScope) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<void>(() =>
					window.bearDesktop.companion.message.correct(conversationId, reason, applyScope),
				);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		branchMessage: async (messageId) => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<MessageBranchResult>(() =>
					window.bearDesktop.companion.message.branch(conversationId, messageId),
				);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		abort: async () => {
			try {
				const conversationId = requireActiveConversation();
				await invoke<void>(() => window.bearDesktop.companion.message.abort(conversationId));
				setState("sending", false);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		setOnboardingName: async (name) => {
			try {
				await onboardingStore.setName(name);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		setOnboardingRelation: async (kind) => {
			try {
				await onboardingStore.setRelation(kind);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		setOnboardingMemoryDecision: async (enabled) => {
			try {
				await onboardingStore.setMemoryDecision(enabled);
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		advanceOnboarding: async () => {
			try {
				await onboardingStore.advance();
				setState("error", null);
			} catch (e) {
				setState("error", messageOf(e));
			}
		},

		get character() {
			return snapshotResource.latest?.character;
		},
		get characterRuntimeByConversation() {
			return state.characterRuntimeByConversation;
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
		get voice() {
			return voiceApi;
		},
		get commission() {
			return commissionApi;
		},
		get artifact() {
			return artifactApi;
		},
	};
}
