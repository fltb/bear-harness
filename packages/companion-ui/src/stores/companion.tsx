import type { CompanionClient } from "@bear-harness/companion-client";
import type {
	PiAgentSessionEvent as AgentSessionEvent,
	ConversationActiveResponse,
	LivePush,
	LocalEmbeddingAcquisitionState,
} from "@bear-harness/protocol";
import {
	CancelledError,
	createQuery,
	isCancelledError,
	useQueryClient,
} from "@tanstack/solid-query";
import {
	batch,
	createContext,
	createMemo,
	createSignal,
	onCleanup,
	type ParentProps,
	untrack,
	useContext,
} from "solid-js";
import { IpcInvocationError } from "../lib/ipc.js";
import {
	appendPiProjectionEvent,
	isNewerPiVersion,
	retainPiHistory,
} from "../lib/pi-event-replay.js";
import { createCanonApi, createCharacterApi } from "./character-api.js";
import { createExternalAgentApi } from "./external-agent-api.js";
import type {
	CharacterDisplay,
	CompanionStateChange,
	CompanionStateData,
	ConversationDetail,
	ConversationSummary,
	ModelRouteData,
	PiLiveState,
	PiSessionEntry,
	RunInfo,
	RunListData,
	RunListRequest,
	Snapshot,
} from "./ipc.js";
import { invoke } from "./ipc.js";
import { createModelProviderApis } from "./model-provider-api.js";
import { withRpcMutations } from "./mutation-client.js";
import { createOnboardingStore } from "./onboarding.js";
import {
	listAllCanonModules,
	listAllCanonSources,
	listAllCharacters,
	listAllModels,
	listAllProviders,
} from "./paged-rpc.js";
import {
	createRpcMutation,
	createRpcQuery,
	hydrateRpcQuery,
	queryKeys,
	refreshRpcQuery,
} from "./rpc-query.js";
import { createRunApi } from "./run-api.js";
import type {
	ArtifactApi,
	CanonApi,
	CharacterApi,
	EmbeddingBinding,
	ExternalAgentApi,
	ModelApi,
	ProviderApi,
	RunApi,
	SettingsApi,
} from "./supplementary-api.js";
import { trackApi } from "./track-api.js";

export * from "./ipc.js";
export type { OnboardingStore } from "./onboarding.js";
export { createOnboardingStore } from "./onboarding.js";
export * from "./supplementary-api.js";

export interface CompanionErrorMetadata {
	message: string;
	operation: string;
	source: "transport" | "domain" | "projection";
	kind?: string;
}
export interface ConversationSubmission {
	id: string;
	conversationId: string;
	kind: "send" | "edit" | "correct";
	text: string;
	entryId?: string;
	state: "submitting" | "accepted" | "failed" | "unknown";
	error?: string;
}
export interface ConversationActivity {
	kind:
		| "memory_recall"
		| "context"
		| "memory_capture"
		| "responding"
		| "tool"
		| "retry"
		| "compaction";
	toolName?: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
}
export type TimelineProjectionItem =
	| { kind: "entry"; id: string; entry: PiSessionEntry }
	| { kind: "submission"; id: string; submission: ConversationSubmission }
	| { kind: "queued-user"; id: string; text: string; queue: "steering" | "followUp" }
	| {
			kind: "tool-execution";
			id: string;
			toolCallId: string;
			toolName: string;
			status: "pending" | "running" | "completed" | "failed";
			args?: unknown;
			result?: unknown;
	  }
	| {
			kind: "streaming-assistant";
			id: string;
			message: Extract<NonNullable<PiLiveState["streamingMessage"]>, { role: "assistant" }>;
	  };
export interface CompanionStore {
	readonly loading: boolean;
	readonly systemSetupReady: boolean;
	readonly characterSetupReady: boolean;
	readonly setupLoadError: string | null;
	readonly error: string | null;
	readonly errorMetadata: CompanionErrorMetadata | null;
	readonly onboarding: ReturnType<typeof createOnboardingStore>["data"] extends () => infer T
		? T
		: never;
	readonly conversations: ConversationSummary[];
	readonly archivedConversations: ConversationSummary[];
	readonly activeConversationId: string | null;
	readonly activePiEntries: PiSessionEntry[] | undefined;
	readonly activePiBranch: ConversationDetail["branch"] | undefined;
	readonly historyLoading: boolean;
	readonly historyError: string | null;
	loadOlderHistory(): Promise<void>;
	readonly completedConversationIds: ReadonlySet<string>;
	readonly activePiLiveState: PiLiveState | undefined;
	readonly activeSubmission: ConversationSubmission | undefined;
	readonly activeActivity: ConversationActivity | undefined;
	readonly liveConnectionStatus: "connecting" | "connected" | "reconnecting";
	readonly conversationMutationBusy: boolean;
	readonly activeAbortPending: boolean;
	readonly activeTimeline: readonly TimelineProjectionItem[];
	readonly runs: RunInfo[];
	readonly character: CharacterDisplay | undefined;
	readonly companionState: CompanionStateData | undefined;
	refresh(): Promise<void>;
	searchConversations(title: string): Promise<void>;
	selectConversation(id: string): Promise<void>;
	createConversation(title?: string): Promise<void>;
	createConversationFromEntry(entryId: string): Promise<void>;
	renameConversation(id: string, title: string): Promise<void>;
	archiveConversation(id: string): Promise<void>;
	restoreConversation(id: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	updateCompanionState(changes: CompanionStateChange[]): Promise<void>;
	sendMessage(text: string): Promise<void>;
	retrySubmission(id: string): Promise<void>;
	dismissSubmission(id: string): void;
	correctMessage(entryId: string, feedback: string): Promise<void>;
	switchMessageVersion(leafId: string): Promise<void>;
	editMessage(entryId: string, text: string): Promise<void>;
	abort(): Promise<void>;
	submitOnboarding(stepId: string, answer?: string): Promise<void>;
	readonly settings: SettingsApi;
	readonly provider: ProviderApi;
	readonly model: ModelApi;
	readonly embedding: EmbeddingBinding;
	readonly run: RunApi;
	readonly artifact: ArtifactApi;
	readonly externalAgent: ExternalAgentApi;
	readonly characters: CharacterApi;
	readonly canon: CanonApi;
}

export const CompanionStoreContext = createContext<CompanionStore>();
const MAX_DELETED_CONVERSATION_TOMBSTONES = 128;
export function DesktopProvider(props: ParentProps<{ store: CompanionStore }>) {
	return (
		<CompanionStoreContext.Provider value={props.store}>
			{props.children}
		</CompanionStoreContext.Provider>
	);
}
export function useCompanionStore(): CompanionStore {
	const value = useContext(CompanionStoreContext);
	if (!value) throw new Error("useCompanionStore must be used within DesktopProvider");
	return value;
}

const stores = new WeakMap<CompanionClient, CompanionStore>();
const PI_RECONNECT_MIN_DELAY_MS = 100;
const PI_RECONNECT_MAX_DELAY_MS = 5_000;

function samePiMessage(
	left: NonNullable<PiLiveState["streamingMessage"]>,
	right: NonNullable<PiLiveState["streamingMessage"]>,
): boolean {
	if (left.role !== right.role) return false;
	if (
		left.role === "assistant" &&
		right.role === "assistant" &&
		left.responseId &&
		right.responseId
	)
		return left.responseId === right.responseId;
	if (left.role === "toolResult" && right.role === "toolResult")
		return left.toolCallId === right.toolCallId;
	return left.timestamp === right.timestamp;
}

function waitForPiReconnect(signal: AbortSignal, delayMs: number): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const finish = (completed: boolean) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			resolve(completed);
		};
		const abort = () => finish(false);
		const timer = setTimeout(() => finish(true), delayMs);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

function settlePiSnapshot<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value?: T) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			resolve(value);
		};
		const abort = () => finish();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		void promise.then(
			(value) => finish(value),
			() => finish(),
		);
	});
}

export function createCompanionStore(source: CompanionClient): CompanionStore {
	const existing = stores.get(source);
	if (existing) return existing;
	const created = untrack(() => createStoreForClient(source));
	stores.set(source, created);
	onCleanup(() => {
		if (stores.get(source) === created) stores.delete(source);
	});
	return created;
}

function createStoreForClient(source: CompanionClient): CompanionStore {
	const queryClient = useQueryClient();
	const client = withRpcMutations(source, queryClient);
	const [cacheRevision, setCacheRevision] = createSignal(0);
	const [operationError, setOperationError] = createSignal<CompanionErrorMetadata | null>(null);
	const [mutationSessions, setMutationSessions] = createSignal<ReadonlySet<string>>(new Set());
	const [abortSessions, setAbortSessions] = createSignal<ReadonlySet<string>>(new Set());
	const conversationMutationBusy = () =>
		mutationSessions().has(activeConversationId() ?? "") ||
		submissionsBySession().get(activeConversationId() ?? "")?.state === "submitting";
	const [liveConnectionStatus, setLiveConnectionStatus] = createSignal<
		"connecting" | "connected" | "reconnecting"
	>("connecting");
	const [activitiesBySession, setActivitiesBySession] = createSignal<
		ReadonlyMap<string, { activity: ConversationActivity; failed: boolean }>
	>(new Map());
	const [hostStagesBySession, setHostStagesBySession] = createSignal<
		ReadonlyMap<string, { operationId: string; activity: ConversationActivity }>
	>(new Map());
	const [hostFailuresBySession, setHostFailuresBySession] = createSignal<
		ReadonlyMap<string, ConversationActivity>
	>(new Map());
	const [completedMessagesBySession, setCompletedMessagesBySession] = createSignal<
		ReadonlyMap<string, NonNullable<PiLiveState["streamingMessage"]>[]>
	>(new Map());
	const [titleQuery, setTitleQuery] = createSignal("");
	const [piLiveBySession, setPiLiveBySession] = createSignal<ReadonlyMap<string, PiLiveState>>(
		new Map(),
	);
	const [completedConversationIds, setCompletedConversationIds] = createSignal<ReadonlySet<string>>(
		new Set(),
	);
	const [submissionsBySession, setSubmissionsBySession] = createSignal<
		ReadonlyMap<string, ConversationSubmission>
	>(new Map());
	const submissionAnchors = new Map<string, ReadonlySet<string>>();
	const [toolExecutionsBySession, setToolExecutionsBySession] = createSignal<
		ReadonlyMap<
			string,
			ReadonlyMap<
				string,
				{
					toolCallId: string;
					toolName: string;
					status: "running" | "completed" | "failed";
					args?: unknown;
					result?: unknown;
				}
			>
		>
	>(new Map());
	const piEventCaptures = new Map<string, Set<AgentSessionEvent[]>>();
	type PiVersion = NonNullable<PiLiveState["version"]>;
	const eventVersions = new WeakMap<AgentSessionEvent, PiVersion>();
	const sessionVersions = new Map<string, PiVersion>();
	const retiredInstances = new Map<string, Set<string>>();
	const readGenerations = new Map<string, number>();
	const [historyRequest, setHistoryRequest] = createSignal<{
		conversationId: string;
		token: object;
	}>();
	const [historyFailure, setHistoryFailure] = createSignal<{
		conversationId: string;
		message: string;
	}>();
	const clearTransientProjection = (conversationId: string) => {
		dropToolExecutions(conversationId);
		setCompletedMessagesBySession((current) => {
			const next = new Map(current);
			next.delete(conversationId);
			return next;
		});
	};
	let projectionEpoch = 0;
	const deletedConversationIds = new Set<string>();
	const markConversationDeleted = (conversationId: string) => {
		deletedConversationIds.delete(conversationId);
		deletedConversationIds.add(conversationId);
		if (deletedConversationIds.size <= MAX_DELETED_CONVERSATION_TOMBSTONES) return;
		const oldest = deletedConversationIds.values().next().value;
		if (oldest !== undefined) deletedConversationIds.delete(oldest);
	};
	onCleanup(queryClient.getQueryCache().subscribe(() => setCacheRevision((value) => value + 1)));
	const fail = (operation: string, cause: unknown) => {
		setOperationError({
			message: cause instanceof Error ? cause.message : String(cause),
			operation,
			source: cause instanceof IpcInvocationError ? "domain" : "transport",
			...(cause instanceof IpcInvocationError ? { kind: cause.kind } : {}),
		});
	};
	const run = async <T,>(operation: string, action: () => Promise<T>): Promise<T> => {
		try {
			const value = await action();
			setOperationError(null);
			return value;
		} catch (cause) {
			if (!isCancelledError(cause)) fail(operation, cause);
			throw cause;
		}
	};
	const runConversationMutation = async <T,>(
		operation: string,
		action: () => Promise<T>,
	): Promise<T> => {
		const conversationId = requireConversation();
		if (conversationMutationBusy()) throw new Error("conversation_mutation_pending");
		setMutationSessions((current) => new Set(current).add(conversationId));
		try {
			return await run(operation, action);
		} finally {
			setMutationSessions((current) => {
				const next = new Set(current);
				next.delete(conversationId);
				return next;
			});
		}
	};

	const onboarding = createOnboardingStore(client, queryClient);
	const snapshotRequest = () => invoke(client, () => client.snapshot.get({}));
	const snapshotQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.snapshot,
		request: snapshotRequest,
	});
	const conversationsRequest = () =>
		invoke(client, () =>
			client.conversation.list({
				...(titleQuery() ? { title: titleQuery() } : {}),
				limit: 100,
			}),
		);
	const conversationsQuery = createRpcQuery({
		client: queryClient,
		key: () => [...queryKeys.conversations, titleQuery()],
		request: conversationsRequest,
	});
	const archivedQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.archivedConversations,
		request: () => invoke(client, () => client.conversation.list({ archived: true, limit: 100 })),
	});
	createRpcQuery<ConversationActiveResponse>({
		client: queryClient,
		key: queryKeys.activeConversation,
		request: () => invoke(client, () => client.conversation.activeGet({})),
		enabled: false,
	});
	// Native events retire transient rows in the same transaction that updates
	// this query. Its Solid observer notifies later; read the authoritative cache
	// through the existing revision signal so a row never disappears in between.
	const activeDetail = createMemo(() => {
		cacheRevision();
		return (
			queryClient.getQueryData<ConversationActiveResponse>(queryKeys.activeConversation)
				?.activeConversation ?? undefined
		);
	});
	const activeConversationId = () => activeDetail()?.conversationId ?? null;
	const companionStateQuery = createRpcQuery<CompanionStateData | undefined>({
		client: queryClient,
		key: () => queryKeys.companionState(activeConversationId() ?? ""),
		enabled: () => activeConversationId() !== null,
		request: (key) =>
			key[1]
				? invoke(client, () => client.companionState.get({ conversationId: key[1] as string }))
				: Promise.resolve(undefined),
	});
	const charactersQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.characters,
		request: () => listAllCharacters(client),
	});
	const currentCharacterId = createMemo(
		() =>
			charactersQuery.data?.characters.find((item) => item.active)?.id ??
			snapshotQuery.data?.character?.id,
	);
	// Primitive identity equality keeps same-character refreshes valid; a new token
	// on every transition also retires manual reads when switching A → B → A.
	const runIdentity = createMemo(() => ({ characterId: currentCharacterId() }));
	const runsRequest = async (request?: RunListRequest, signal?: AbortSignal) => {
		const identity = runIdentity();
		if (!identity.characterId) throw new CancelledError({ silent: true });
		const result = await invoke(client, () => client.run.list(request));
		if (signal?.aborted || identity !== runIdentity()) throw new CancelledError({ silent: true });
		return result;
	};
	const runsQuery = createQuery(
		() => ({
			queryKey: queryKeys.activeRuns(runIdentity().characterId),
			enabled: !!runIdentity().characterId,
			structuralSharing: false,
			staleTime: 0,
			queryFn: ({ signal }) => runsRequest(undefined, signal),
		}),
		() => queryClient,
	);
	const settingsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.settings,
		request: () => invoke(client, () => client.settings.get()),
	});
	const capabilitiesQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.settingsCapabilities,
		request: () => invoke(client, () => client.settings.capabilitiesGet({})),
	});
	const providersQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.providers,
		request: () => listAllProviders(client),
	});
	const poolQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.modelPool,
		request: () => listAllModels(client),
	});
	const defaultsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.modelDefaults,
		request: () => invoke(client, () => client.model.defaultsGet()),
	});
	const systemDefaultsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.systemModelDefaults,
		request: () => invoke(client, () => client.model.systemDefaultsGet()),
	});
	const characterSetupKeys = [
		queryKeys.snapshot,
		queryKeys.characters,
		queryKeys.modelDefaults,
		queryKeys.onboarding,
	] as const;
	const setupQueryReady = (key: readonly unknown[]): boolean => {
		cacheRevision();
		const state = queryClient.getQueryState(key);
		return state?.data !== undefined;
	};
	const systemSetupReady = createMemo(
		() => settingsQuery.data !== undefined && setupQueryReady(queryKeys.settings),
	);
	const characterSetupReady = createMemo(
		() =>
			systemSetupReady() &&
			defaultsQuery.data !== undefined &&
			snapshotQuery.data !== undefined &&
			charactersQuery.data !== undefined &&
			characterSetupKeys.every(setupQueryReady) &&
			snapshotQuery.data?.character.id === currentCharacterId() &&
			snapshotQuery.data?.character.id ===
				queryClient.getQueryData<Snapshot>(queryKeys.snapshot)?.character.id,
	);
	const routeQuery = createRpcQuery<ModelRouteData | undefined>({
		client: queryClient,
		key: () => queryKeys.modelRoute(activeConversationId() ?? ""),
		enabled: () => activeConversationId() !== null,
		request: (key) =>
			key[2]
				? invoke(client, () => client.model.routeGet({ conversationId: key[2] as string }))
				: Promise.resolve(undefined),
	});
	const canonSources = createRpcQuery({
		client: queryClient,
		key: () => queryKeys.canonSources(currentCharacterId()),
		request: () => listAllCanonSources(client),
	});
	const canonModules = createRpcQuery({
		client: queryClient,
		key: () => queryKeys.canonModules(currentCharacterId()),
		request: () => listAllCanonModules(client),
	});
	const inventoryQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.embeddingInventory,
		request: () => invoke(client, () => client.memory.localEmbeddingInventory({})),
	});
	const acquisitionQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.embeddingAcquisition,
		request: () => invoke(client, () => client.memory.localEmbeddingAcquisitionStatus({})),
	});
	const removeSubmission = (conversationId: string) =>
		setSubmissionsBySession((current) => {
			if (!current.has(conversationId)) return current;
			const next = new Map(current);
			next.delete(conversationId);
			return next;
		});
	const updateSubmission = (submission: ConversationSubmission) => {
		if (deletedConversationIds.has(submission.conversationId)) return;
		setSubmissionsBySession((current) => {
			const previous = current.get(submission.conversationId);
			if (previous && previous.id !== submission.id) submissionAnchors.delete(previous.id);
			return new Map(current).set(submission.conversationId, submission);
		});
	};
	const reconcileMessages = (detail: ConversationDetail) => {
		const submission = submissionsBySession().get(detail.conversationId);
		const anchor = submission && submissionAnchors.get(submission.id);
		if (
			submission?.state === "accepted" &&
			(submission.kind !== "send" ||
				(anchor &&
					detail.branch.entries.some(
						(entry) =>
							!anchor.has(entry.id) && entry.type === "message" && entry.message.role === "user",
					)))
		) {
			submissionAnchors.delete(submission.id);
			removeSubmission(detail.conversationId);
		}
		setCompletedMessagesBySession((current) => {
			const messages = current.get(detail.conversationId);
			if (!messages) return current;
			const remaining = messages.filter(
				(message) =>
					!detail.branch.entries.some(
						(entry) => entry.type === "message" && samePiMessage(entry.message, message),
					),
			);
			const next = new Map(current);
			if (remaining.length) next.set(detail.conversationId, remaining);
			else next.delete(detail.conversationId);
			return next;
		});
		setActivitiesBySession((current) => {
			const native = current.get(detail.conversationId);
			if (
				!native ||
				native.failed ||
				(native.activity.kind === "retry" && detail.live.isRetrying) ||
				(native.activity.kind === "compaction" && detail.live.isCompacting)
			)
				return current;
			const next = new Map(current);
			next.delete(detail.conversationId);
			return next;
		});
	};
	const refreshSnapshot = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.snapshot,
			request: snapshotRequest,
		});
	const refreshConversation = async (conversationId = activeConversationId()) => {
		if (!conversationId) return undefined;
		return withPiEventReplay(
			conversationId,
			() => invoke(client, () => client.conversation.open({ conversationId })),
			(detail) => {
				hydrateRpcQuery(queryClient, queryKeys.conversation(detail.conversationId), detail);
				reconcileMessages(detail);
				setPiLiveBySession((current) => new Map(current).set(detail.conversationId, detail.live));
				replaceToolExecutions(detail);
				if (activeConversationId() === detail.conversationId)
					hydrateRpcQuery(queryClient, queryKeys.activeConversation, {
						activeConversation: detail,
					});
			},
		);
	};
	const refreshCompanionState = async (conversationId = activeConversationId()) => {
		if (!conversationId) return undefined;
		return refreshRpcQuery({
			client: queryClient,
			key: queryKeys.companionState(conversationId),
			request: () => invoke(client, () => client.companionState.get({ conversationId })),
		});
	};
	const dropPiLive = (conversationId: string) => {
		setPiLiveBySession((current) => {
			if (!current.has(conversationId)) return current;
			const next = new Map(current);
			next.delete(conversationId);
			return next;
		});
	};
	const dropToolExecutions = (conversationId: string) => {
		setToolExecutionsBySession((current) => {
			if (!current.has(conversationId)) return current;
			const next = new Map(current);
			next.delete(conversationId);
			return next;
		});
	};
	const replaceToolExecutions = (detail: ConversationDetail) => {
		const pending = new Set(detail.live.pendingToolCallIds);
		const executions = new Map(toolExecutionsBySession().get(detail.conversationId) ?? []);
		for (const [id] of executions) {
			const persisted = detail.branch.entries.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === id,
			);
			if (persisted || !pending.has(id)) executions.delete(id);
		}
		const messages = detail.branch.entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
		);
		if (detail.live.streamingMessage?.role === "assistant")
			messages.push(detail.live.streamingMessage);
		for (const message of messages) {
			for (const part of message.content) {
				if (part.type !== "toolCall" || !pending.has(part.id)) continue;
				executions.set(part.id, {
					...executions.get(part.id),
					toolCallId: part.id,
					toolName: part.name,
					args: part.arguments,
					status: "running",
				});
			}
		}
		for (const toolCallId of pending) {
			if (!executions.has(toolCallId))
				executions.set(toolCallId, { toolCallId, toolName: "tool", status: "running" });
		}
		setToolExecutionsBySession((current) => {
			const next = new Map(current);
			if (executions.size === 0) next.delete(detail.conversationId);
			else next.set(detail.conversationId, executions);
			return next;
		});
	};
	let activeMutationGeneration = 0;
	let activeProjectionLoaded = false;
	const beginActiveMutation = () => {
		setHistoryRequest(undefined);
		setHistoryFailure(undefined);
		return ++activeMutationGeneration;
	};
	const applyActiveProjectionIfCurrent = (
		generation: number,
		response: ConversationActiveResponse,
	) => {
		if (generation === activeMutationGeneration) applyActiveProjection(response);
	};
	const updateConversationProjection = (
		conversationId: string,
		update: (detail: ConversationDetail) => ConversationDetail,
	) => {
		queryClient.setQueryData<ConversationActiveResponse>(queryKeys.activeConversation, (current) =>
			current?.activeConversation?.conversationId === conversationId
				? { activeConversation: update(current.activeConversation) }
				: current,
		);
		queryClient.setQueryData<ConversationDetail>(
			queryKeys.conversation(conversationId),
			(current) => (current ? update(current) : current),
		);
	};
	const applyActiveProjection = (response: ConversationActiveResponse) => {
		activeProjectionLoaded = true;
		const previousId = activeConversationId();
		let detail = response.activeConversation ?? undefined;
		if (detail) {
			const previous = queryClient.getQueryData<ConversationDetail>(
				queryKeys.conversation(detail.conversationId),
			);
			const currentVersion = sessionVersions.get(detail.conversationId);
			const version = detail.live.version;
			if (
				currentVersion &&
				(!version ||
					(version.instanceId === currentVersion.instanceId &&
						version.sequence < currentVersion.sequence))
			)
				return;
			if (version && retiredInstances.get(detail.conversationId)?.has(version.instanceId)) return;
			const previousVersion = previous?.live.version ?? currentVersion;
			const changedInstance = previousVersion && version?.instanceId !== previousVersion.instanceId;
			if (changedInstance) {
				const retired = retiredInstances.get(detail.conversationId) ?? new Set<string>();
				retired.add(previousVersion.instanceId);
				if (retired.size > 8) retired.delete(retired.values().next().value!);
				retiredInstances.set(detail.conversationId, retired);
			}
			if (
				changedInstance ||
				(previous?.branch.activeLeafId !== detail.branch.activeLeafId &&
					!detail.branch.entries.some((entry) => entry.id === previous?.branch.activeLeafId))
			)
				clearTransientProjection(detail.conversationId);
			if (!changedInstance)
				detail = { ...detail, branch: retainPiHistory(previous?.branch, detail.branch) };
			if (version) sessionVersions.set(detail.conversationId, version);
		}
		hydrateRpcQuery(queryClient, queryKeys.activeConversation, {
			activeConversation: detail ?? null,
		});
		if (detail) {
			hydrateRpcQuery(queryClient, queryKeys.conversation(detail.conversationId), detail);
			if (detail.selectedModel)
				hydrateRpcQuery(queryClient, queryKeys.modelRoute(detail.conversationId), {
					selected: detail.selectedModel,
				});
			reconcileMessages(detail);
			setPiLiveBySession((current) => new Map(current).set(detail.conversationId, detail.live));
			replaceToolExecutions(detail);
			setCompletedConversationIds((current) => {
				if (!current.has(detail.conversationId)) return current;
				const next = new Set(current);
				next.delete(detail.conversationId);
				return next;
			});
		}
		if (previousId && previousId !== detail?.conversationId) {
			queryClient.removeQueries({ queryKey: queryKeys.conversation(previousId), exact: true });
			queryClient.removeQueries({ queryKey: queryKeys.companionState(previousId), exact: true });
			queryClient.removeQueries({ queryKey: queryKeys.modelRoute(previousId), exact: true });
		}
	};
	const commitConversationDetailIfCurrent = (
		conversationId: string,
		detail: ConversationDetail,
	) => {
		hydrateRpcQuery(queryClient, queryKeys.conversation(conversationId), detail);
		if (detail.selectedModel)
			hydrateRpcQuery(queryClient, queryKeys.modelRoute(conversationId), {
				selected: detail.selectedModel,
			});
		if (activeConversationId() === conversationId)
			applyActiveProjection({ activeConversation: detail });
		else {
			setPiLiveBySession((current) => new Map(current).set(conversationId, detail.live));
			reconcileMessages(detail);
			replaceToolExecutions(detail);
		}
	};

	const refreshActiveConversation = async () => {
		const generation = activeMutationGeneration;
		const epoch = projectionEpoch;
		const conversationId = activeConversationId();
		if (!conversationId) {
			const response = await invoke(client, () => client.conversation.activeGet({}));
			if (epoch === projectionEpoch) applyActiveProjectionIfCurrent(generation, response);
			return;
		}
		let response: ConversationActiveResponse | undefined;
		await withPiEventReplay(
			conversationId,
			async () => {
				response = await invoke(client, () => client.conversation.activeGet({}));
				return response.activeConversation ?? undefined;
			},
			(detail) => applyActiveProjectionIfCurrent(generation, { activeConversation: detail }),
		);
		if (response && epoch === projectionEpoch && !response.activeConversation)
			applyActiveProjectionIfCurrent(generation, response);
	};
	const refreshConversations = async () => {
		const result = await refreshRpcQuery({
			client: queryClient,
			key: [...queryKeys.conversations, titleQuery()],
			request: conversationsRequest,
		});
		const available = new Set(
			result.conversations.map((conversation) => conversation.conversationId),
		);
		setCompletedConversationIds((current) => {
			const next = new Set([...current].filter((id) => available.has(id)));
			return next.size === current.size ? current : next;
		});
		return result;
	};
	const refreshArchived = async () => {
		return refreshRpcQuery({
			client: queryClient,
			key: queryKeys.archivedConversations,
			request: () => invoke(client, () => client.conversation.list({ archived: true, limit: 100 })),
		});
	};
	const startupActiveGeneration = activeMutationGeneration;
	void Promise.all([
		queryClient.fetchQuery({ queryKey: queryKeys.onboarding, queryFn: onboarding.get }),
		queryClient.fetchQuery({
			queryKey: [...queryKeys.conversations, titleQuery()],
			queryFn: conversationsRequest,
		}),
		invoke(client, () => client.conversation.activeGet({})),
	])
		.then(([, , active]) => {
			if (!activeProjectionLoaded) applyActiveProjectionIfCurrent(startupActiveGeneration, active);
		})
		.catch((cause) => fail("conversation.initialize", cause));
	const refreshRuns = () =>
		queryClient.invalidateQueries(
			{ queryKey: queryKeys.activeRuns(currentCharacterId()), exact: true },
			{ cancelRefetch: false },
		);
	const refreshCharacters = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.characters,
			request: () => listAllCharacters(client),
		});
	const refreshCanonSources = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonSources(currentCharacterId()),
			request: () => listAllCanonSources(client),
		});
	const refreshCanonModules = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonModules(currentCharacterId()),
			request: () => listAllCanonModules(client),
		});
	const requireConversation = () => {
		const id = activeConversationId();
		if (!id) throw new Error("conversation_not_selected");
		return id;
	};
	const { settingsApi, providerApi, modelApi } = createModelProviderApis({
		client,
		queryClient,
		cacheRevision,
		settings: () => settingsQuery.data,
		providers: () => providersQuery.data?.providers ?? [],
		models: () => poolQuery.data?.models ?? [],
		defaults: () => defaultsQuery.data ?? { vision: { mode: "auto" }, onboardingComplete: false },
		systemDefaults: () => systemDefaultsQuery.data ?? { vision: { mode: "auto" } },
		currentRoute: () => routeQuery.data,
		activeConversationId,
		onRefreshError: (cause) => fail("model.refresh", cause),
	});
	const projectionRefreshes = new Map<
		string,
		{ dirty: boolean; settled: boolean; epoch: number }
	>();
	const scheduleConversationRefresh = (conversationId: string, settled = false) => {
		const running = projectionRefreshes.get(conversationId);
		if (running) {
			running.dirty = true;
			running.settled ||= settled;
			return;
		}
		const request = { dirty: true, settled, epoch: projectionEpoch };
		projectionRefreshes.set(conversationId, request);
		// Native message_end precedes SessionManager append. Leave its synchronous
		// listener stack before reading; coalesce updates arriving during the read.
		queueMicrotask(() => {
			void (async () => {
				try {
					let detail: ConversationDetail | undefined;
					do {
						if (request.epoch !== projectionEpoch) return;
						request.dirty = false;
						detail = await refreshConversation(conversationId);
					} while (
						request.dirty &&
						request.epoch === projectionEpoch &&
						!deletedConversationIds.has(conversationId)
					);
					if (
						detail &&
						request.epoch === projectionEpoch &&
						request.settled &&
						conversationId !== activeConversationId()
					) {
						// A delayed settled notice may belong to an older run. Only the
						// refreshed native snapshot, including replayed events, establishes idle.
						const live = piLiveBySession().get(conversationId) ?? detail.live;
						const available = conversationsQuery.data?.conversations.some(
							(item) => item.conversationId === conversationId,
						);
						if (
							available &&
							!live.isStreaming &&
							!live.isRetrying &&
							!live.isCompacting &&
							!live.pendingToolCallIds.length
						)
							setCompletedConversationIds((current) => new Set(current).add(conversationId));
					}
				} catch (cause) {
					if (request.epoch !== projectionEpoch) return;
					const message = cause instanceof Error ? cause.message : String(cause);
					const submission = submissionsBySession().get(conversationId);
					if (submission?.state === "accepted") updateSubmission({ ...submission, error: message });
					else if (activeConversationId() === conversationId)
						setOperationError({
							operation: "conversation.projection",
							source: "projection",
							message,
						});
				} finally {
					if (projectionRefreshes.get(conversationId) === request)
						projectionRefreshes.delete(conversationId);
				}
			})();
		});
	};
	const applyPiEvent = (
		conversationId: string,
		event: AgentSessionEvent,
		options: { capture: boolean; version?: PiVersion } = { capture: true },
	) =>
		batch(() => {
			if (deletedConversationIds.has(conversationId)) return;
			const version = options.version;
			const currentVersion = sessionVersions.get(conversationId);
			if (version && retiredInstances.get(conversationId)?.has(version.instanceId)) return;
			if (version && currentVersion && version.instanceId !== currentVersion.instanceId) {
				const retired = retiredInstances.get(conversationId) ?? new Set<string>();
				retired.add(currentVersion.instanceId);
				if (retired.size > 8) retired.delete(retired.values().next().value!);
				retiredInstances.set(conversationId, retired);
				sessionVersions.set(conversationId, version);
				readGenerations.set(conversationId, (readGenerations.get(conversationId) ?? 0) + 1);
				if (historyRequest()?.conversationId === conversationId) {
					setHistoryRequest(undefined);
					setHistoryFailure(undefined);
				}
				clearTransientProjection(conversationId);
				dropPiLive(conversationId);
				scheduleConversationRefresh(conversationId);
				return;
			}
			if (!isNewerPiVersion(version, currentVersion)) return;
			if (version) {
				sessionVersions.set(conversationId, version);
				eventVersions.set(event, version);
			}
			if (options.capture)
				for (const capture of piEventCaptures.get(conversationId) ?? [])
					appendPiProjectionEvent(capture, event);
			setPiLiveBySession((current) => {
				const previous = current.get(conversationId) ??
					queryClient.getQueryData<ConversationDetail>(queryKeys.conversation(conversationId))
						?.live ?? {
						isStreaming: false,
						pendingToolCallIds: [],
						steering: [],
						followUp: [],
						isRetrying: false,
						retryAttempt: 0,
						isCompacting: false,
					};
				let nextLive = previous;
				switch (event.type) {
					case "agent_start":
						nextLive = { ...previous, isStreaming: true, errorMessage: undefined };
						break;
					case "message_start":
					case "message_update":
						nextLive = {
							...previous,
							isStreaming: true,
							streamingMessage: event.message,
						};
						break;
					case "message_end":
						nextLive = {
							...previous,
							streamingMessage: samePiMessage(
								previous.streamingMessage ?? event.message,
								event.message,
							)
								? undefined
								: previous.streamingMessage,
							...(event.message.role === "assistant" && event.message.errorMessage
								? { errorMessage: event.message.errorMessage }
								: {}),
						};
						break;
					case "queue_update":
						nextLive = {
							...previous,
							steering: [...event.steering],
							followUp: [...event.followUp],
						};
						break;
					case "tool_execution_start":
					case "tool_execution_update":
						nextLive = {
							...previous,
							pendingToolCallIds: [...new Set([...previous.pendingToolCallIds, event.toolCallId])],
						};
						break;
					case "tool_execution_end":
						nextLive = {
							...previous,
							pendingToolCallIds: previous.pendingToolCallIds.filter(
								(toolCallId) => toolCallId !== event.toolCallId,
							),
						};
						break;
					case "agent_settled":
						// May describe a run whose capture overlapped a newer run. Refresh below.
						break;
					case "auto_retry_start":
						nextLive = { ...previous, isRetrying: true, retryAttempt: event.attempt };
						break;
					case "auto_retry_end":
						nextLive = {
							...previous,
							isRetrying: false,
							errorMessage: event.success ? undefined : event.finalError,
						};
						break;
					case "compaction_start":
						nextLive = { ...previous, isCompacting: true };
						break;
					case "compaction_end":
						nextLive = { ...previous, isCompacting: false, errorMessage: event.errorMessage };
						break;
					case "agent_end":
					// End/settled notices do not identify the currently running native turn.
					case "turn_start":
					case "turn_end":
					case "entry_appended":
					case "session_info_changed":
					case "thinking_level_changed":
					case "summarization_retry_scheduled":
					case "summarization_retry_attempt_start":
					case "summarization_retry_finished":
					case "bash_execution_update":
						// Turn boundaries/config have no separate phase. Summarization has
						// explicit activity below; standalone bash deltas lack tool ownership.
						break;
					default: {
						const exhaustive: never = event;
						return exhaustive;
					}
				}
				if (version) nextLive = { ...nextLive, version };
				if (nextLive === previous) return current;
				const next = new Map(current);
				next.set(conversationId, nextLive);
				return next;
			});
			setActivitiesBySession((current) => {
				const previous = current.get(conversationId);
				let activity = previous?.activity;
				let failed = previous?.failed ?? false;
				switch (event.type) {
					case "auto_retry_start":
					case "summarization_retry_scheduled":
						activity = {
							kind: "retry",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						};
						failed = false;
						break;
					case "auto_retry_end":
						activity = event.success
							? undefined
							: { kind: "retry", attempt: event.attempt, errorMessage: event.finalError };
						failed = !event.success;
						break;
					case "compaction_start":
					case "summarization_retry_attempt_start":
						activity = { kind: "compaction" };
						failed = false;
						break;
					case "compaction_end":
						activity = event.errorMessage
							? { kind: "compaction", errorMessage: event.errorMessage }
							: undefined;
						failed = !!event.errorMessage;
						break;
					case "summarization_retry_finished":
						activity = undefined;
						break;
					case "agent_start":
						activity = undefined;
						break;
				}
				if (activity === previous?.activity && failed === (previous?.failed ?? false))
					return current;
				const next = new Map(current);
				if (activity) next.set(conversationId, { activity, failed });
				else next.delete(conversationId);
				return next;
			});
			if (event.type === "message_end") {
				if (event.message.role === "assistant")
					setCompletedMessagesBySession((current) => {
						const messages = current.get(conversationId) ?? [];
						const next = new Map(current);
						next.set(conversationId, [
							...messages.filter((message) => !samePiMessage(message, event.message)),
							event.message,
						]);
						return next;
					});
				if (options.capture) scheduleConversationRefresh(conversationId);
			}
			if (
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end"
			) {
				setToolExecutionsBySession((current) => {
					const executions = new Map(current.get(conversationId) ?? []);
					executions.set(event.toolCallId, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						status:
							event.type !== "tool_execution_end"
								? "running"
								: event.isError
									? "failed"
									: "completed",
						args: "args" in event ? event.args : executions.get(event.toolCallId)?.args,
						result:
							event.type === "tool_execution_update"
								? event.partialResult
								: event.type === "tool_execution_end"
									? event.result
									: undefined,
					});
					const next = new Map(current);
					next.set(conversationId, executions);
					return next;
				});
			}
			if (event.type === "entry_appended") {
				if (event.entry.type === "message" && event.entry.message.role === "assistant") {
					setPiLiveBySession((current) => {
						const previous = current.get(conversationId);
						if (
							!previous?.streamingMessage ||
							event.entry.type !== "message" ||
							!samePiMessage(previous.streamingMessage, event.entry.message)
						)
							return current;
						const next = new Map(current);
						next.set(conversationId, { ...previous, streamingMessage: undefined });
						return next;
					});
				}
				const appendEntry = (current: ConversationDetail): ConversationDetail => {
					const existing = current.branch.entries.findIndex((entry) => entry.id === event.entry.id);
					const entries = [...current.branch.entries];
					if (existing >= 0) entries[existing] = event.entry;
					else if (event.entry.parentId === (current.branch.activeLeafId ?? null))
						entries.push(event.entry);
					else {
						if (options.capture) scheduleConversationRefresh(conversationId);
						return current;
					}
					return {
						...current,
						branch: { ...current.branch, entries, activeLeafId: event.entry.id },
					};
				};
				updateConversationProjection(conversationId, appendEntry);
				const detail = queryClient.getQueryData<ConversationDetail>(
					queryKeys.conversation(conversationId),
				);
				if (detail) reconcileMessages(detail);
				const completedToolCallId =
					event.entry.type === "message" && event.entry.message.role === "toolResult"
						? event.entry.message.toolCallId
						: undefined;
				if (completedToolCallId) {
					setToolExecutionsBySession((current) => {
						const existing = current.get(conversationId);
						if (!existing?.has(completedToolCallId)) return current;
						const executions = new Map(existing);
						executions.delete(completedToolCallId);
						const next = new Map(current);
						if (executions.size === 0) next.delete(conversationId);
						else next.set(conversationId, executions);
						return next;
					});
				}
			}
			if (event.type === "session_info_changed") {
				queryClient.setQueryData<ConversationDetail>(
					queryKeys.conversation(conversationId),
					(current) => (current ? { ...current, name: event.name } : current),
				);
			}
			if (event.type === "agent_start") {
				setHostFailuresBySession((current) => {
					if (!current.has(conversationId)) return current;
					const next = new Map(current);
					next.delete(conversationId);
					return next;
				});
				setCompletedConversationIds((current) => {
					if (!current.has(conversationId)) return current;
					const next = new Set(current);
					next.delete(conversationId);
					return next;
				});
			}
			if (event.type === "agent_settled") {
				if (options.capture) {
					scheduleConversationRefresh(conversationId, true);
					if (conversationId === activeConversationId())
						void refreshCompanionState(conversationId).catch((cause) =>
							fail("conversation.settled", cause),
						);
				}
			}
		});
	async function withPiEventReplay(
		conversationId: string,
		request: () => Promise<ConversationDetail | undefined>,
		commit: (detail: ConversationDetail) => void,
	): Promise<ConversationDetail | undefined> {
		const epoch = projectionEpoch;
		const navigation = activeMutationGeneration;
		const baselineVersion = sessionVersions.get(conversationId);
		const generation = (readGenerations.get(conversationId) ?? 0) + 1;
		readGenerations.set(conversationId, generation);
		const current = () =>
			epoch === projectionEpoch &&
			navigation === activeMutationGeneration &&
			readGenerations.get(conversationId) === generation &&
			!deletedConversationIds.has(conversationId);
		const capture: AgentSessionEvent[] = [];
		const captures = piEventCaptures.get(conversationId) ?? new Set<AgentSessionEvent[]>();
		captures.add(capture);
		piEventCaptures.set(conversationId, captures);
		try {
			const detail = await request();
			if (!detail || !current()) return undefined;
			const previous = queryClient.getQueryData<ConversationDetail>(
				queryKeys.conversation(conversationId),
			);
			const version = detail.live.version;
			const currentVersion = sessionVersions.get(conversationId);
			if (
				currentVersion &&
				(!version || retiredInstances.get(conversationId)?.has(version.instanceId))
			)
				return undefined;
			if (
				baselineVersion &&
				version?.instanceId === baselineVersion.instanceId &&
				version.sequence < baselineVersion.sequence
			)
				return undefined;
			let branch = detail.branch;
			const previousVersion = previous?.live.version ?? currentVersion;
			const changedInstance = previousVersion && version?.instanceId !== previousVersion.instanceId;
			if (!changedInstance) {
				// A long turn may move the latest page beyond the loaded window. Ask Pi
				// for the missing ancestry rather than joining disconnected branches.
				for (
					let page = 0;
					previous?.branch.entries.length && branch.hasMoreBefore && page < 100;
					page++
				) {
					const retained = retainPiHistory(previous.branch, branch);
					if (retained !== branch) {
						branch = retained;
						break;
					}
					const first = branch.entries[0];
					if (!first || previous.branch.entries.some((entry) => entry.id === first.id)) break;
					const older = await invoke(client, () =>
						client.conversation.history({
							conversationId,
							beforeEntryId: first.id,
							limit: 100,
						}),
					);
					if (!current()) return undefined;
					const joined = retainPiHistory(
						{ ...branch, entries: older.entries, hasMoreBefore: !!older.nextCursor },
						branch,
					);
					if (joined === branch) break;
					branch = joined;
				}
			} else {
				clearTransientProjection(conversationId);
				const retired = retiredInstances.get(conversationId) ?? new Set<string>();
				retired.add(previousVersion.instanceId);
				if (retired.size > 8) retired.delete(retired.values().next().value!);
				retiredInstances.set(conversationId, retired);
			}
			if (!current()) return undefined;
			if (
				previous?.branch.activeLeafId &&
				previous.branch.activeLeafId !== branch.activeLeafId &&
				!branch.entries.some((entry) => entry.id === previous.branch.activeLeafId)
			)
				clearTransientProjection(conversationId);
			const resolvedDetail = { ...detail, branch };
			// The snapshot may precede captured events; replay only strictly later
			// events from this exact native instance.
			if (version) sessionVersions.set(conversationId, version);
			batch(() => {
				commit(resolvedDetail);
				for (const event of capture)
					applyPiEvent(conversationId, event, {
						capture: false,
						version: eventVersions.get(event),
					});
			});
			return resolvedDetail;
		} finally {
			captures.delete(capture);
			if (captures.size === 0 && piEventCaptures.get(conversationId) === captures)
				piEventCaptures.delete(conversationId);
		}
	}
	async function selectAndActivate(
		conversationId: string,
	): Promise<ConversationDetail | undefined> {
		const generation = beginActiveMutation();
		const epoch = projectionEpoch;
		let response: ConversationActiveResponse | undefined;
		const detail = await withPiEventReplay(
			conversationId,
			async () => {
				response = await invoke(client, () => client.conversation.select({ conversationId }));
				return generation === activeMutationGeneration
					? (response.activeConversation ?? undefined)
					: undefined;
			},
			(active) => applyActiveProjectionIfCurrent(generation, { activeConversation: active }),
		);
		if (
			response &&
			epoch === projectionEpoch &&
			generation === activeMutationGeneration &&
			!response.activeConversation
		)
			applyActiveProjectionIfCurrent(generation, response);
		else if (!detail && response && generation === activeMutationGeneration)
			await refreshActiveConversation();
		return detail;
	}
	const invalidationAbort = new AbortController();
	onCleanup(() => invalidationAbort.abort());
	void (async () => {
		while (!invalidationAbort.signal.aborted) {
			try {
				for await (const notice of client.invalidations.stream(invalidationAbort.signal)) {
					if (invalidationAbort.signal.aborted) return;
					await Promise.all(
						notice.keys.map((key) => queryClient.invalidateQueries({ queryKey: key })),
					);
				}
			} catch {
				// Invalidations are transient cache hints; reconnect for future notices.
			}
			if (invalidationAbort.signal.aborted) return;
			if (!(await waitForPiReconnect(invalidationAbort.signal, PI_RECONNECT_MIN_DELAY_MS))) return;
		}
	})().catch(() => undefined);
	const liveAbort = new AbortController();
	onCleanup(() => liveAbort.abort());
	void (async () => {
		let consecutiveDisconnects = 0;
		let initialized = false;
		const replaceActiveFromHost = async () => {
			const reconnecting = liveConnectionStatus() === "reconnecting";
			if (reconnecting) {
				++projectionEpoch;
				piEventCaptures.clear();
				projectionRefreshes.clear();
			}
			const generation = activeMutationGeneration;
			const epoch = projectionEpoch;
			const response = await settlePiSnapshot(
				invoke(client, () => client.conversation.activeGet({})),
				liveAbort.signal,
			);
			if (
				!response ||
				liveAbort.signal.aborted ||
				generation !== activeMutationGeneration ||
				epoch !== projectionEpoch
			)
				return;
			if (reconnecting) {
				++projectionEpoch;
				piEventCaptures.clear();
				projectionRefreshes.clear();
			}
			const commit = (active: ConversationActiveResponse) => {
				if (liveAbort.signal.aborted || generation !== activeMutationGeneration) return;
				setHostStagesBySession(new Map());
				setHostFailuresBySession(new Map());
				setActivitiesBySession(new Map());
				setPiLiveBySession(new Map());
				setToolExecutionsBySession(new Map());
				setCompletedMessagesBySession(new Map());
				applyActiveProjectionIfCurrent(generation, active);
			};
			if (response.activeConversation) {
				const detail = response.activeConversation;
				await withPiEventReplay(
					detail.conversationId,
					() => Promise.resolve(detail),
					(activeConversation) => commit({ activeConversation }),
				);
			} else {
				commit(response);
			}
		};
		const applyLiveEvent = (event: LivePush) => {
			if (event.type === "pi")
				applyPiEvent(event.conversationId, event.event, { capture: true, version: event.version });
			if (
				event.type === "conversationActivity" &&
				!deletedConversationIds.has(event.conversationId)
			) {
				// The snapshot is freshly projected native state, independent of
				// which overlapping stage currently owns the visible phase.
				const currentVersion = sessionVersions.get(event.conversationId);
				if (
					!currentVersion ||
					(event.live.version?.instanceId === currentVersion.instanceId &&
						event.live.version.sequence >= currentVersion.sequence)
				) {
					setPiLiveBySession((current) => new Map(current).set(event.conversationId, event.live));
					if (event.live.version) sessionVersions.set(event.conversationId, event.live.version);
				}
				if (event.status === "failed")
					setHostFailuresBySession((current) =>
						new Map(current).set(event.conversationId, {
							kind: event.activity,
							errorMessage: event.errorMessage ?? "conversation_activity_failed",
						}),
					);
				setHostStagesBySession((current) => {
					const previous = current.get(event.conversationId);
					const next = new Map(current);
					if (event.status === "started")
						next.set(event.conversationId, {
							operationId: event.operationId,
							activity: { kind: event.activity },
						});
					else if (previous?.operationId === event.operationId) next.delete(event.conversationId);
					else return current;
					return next;
				});
				if (event.activity === "memory_capture" && event.status !== "started")
					scheduleConversationRefresh(event.conversationId);
			}
			if (event.type === "companionState")
				hydrateRpcQuery(queryClient, queryKeys.companionState(event.conversationId), event.state);
			if (event.type === "run" && event.companionId === currentCharacterId()) {
				queryClient.setQueryData(
					queryKeys.activeRuns(event.companionId),
					(current: RunListData | undefined) => {
						const runs = current?.runs.some((run) => run.id === event.run.id)
							? current.runs.map((run) => (run.id === event.run.id ? event.run : run))
							: [event.run, ...(current?.runs ?? [])];
						let terminalCount = 0;
						return {
							...current,
							runs: runs.filter(
								(run) =>
									run.status === "enqueued" ||
									run.status === "running" ||
									run.status === "needs_user" ||
									run.status === "interrupted" ||
									++terminalCount <= 100,
							),
						};
					},
				);
				void queryClient.invalidateQueries({
					queryKey: queryKeys.runs,
					predicate: (query) =>
						query.queryKey[1] !== "active" && query.queryKey[2] === currentCharacterId(),
				});
			}
			if (event.type === "embeddingAcquisition") {
				hydrateRpcQuery(queryClient, queryKeys.embeddingAcquisition, event.state);
				if (event.state.phase === "completed")
					void refreshRpcQuery({
						client: queryClient,
						key: queryKeys.embeddingInventory,
						request: () => invoke(client, () => client.memory.localEmbeddingInventory({})),
					}).catch((cause) => fail("embedding.inventory", cause));
			}
			if (event.type === "providerLogin") {
				hydrateRpcQuery(queryClient, queryKeys.providerLogin(event.providerId), event.state);
				if (event.state.status === "completed") {
					const conversationId = activeConversationId();
					void Promise.all([
						refreshRpcQuery({
							client: queryClient,
							key: queryKeys.providers,
							request: () => listAllProviders(client),
						}),
						refreshRpcQuery({
							client: queryClient,
							key: queryKeys.modelPool,
							request: () => listAllModels(client),
						}),
						refreshRpcQuery({
							client: queryClient,
							key: queryKeys.modelDefaults,
							request: () => invoke(client, () => client.model.defaultsGet()),
						}),
						refreshRpcQuery({
							client: queryClient,
							key: queryKeys.systemModelDefaults,
							request: () => invoke(client, () => client.model.systemDefaultsGet()),
						}),
						...(conversationId
							? [
									refreshRpcQuery({
										client: queryClient,
										key: queryKeys.modelRoute(conversationId),
										request: () => invoke(client, () => client.model.routeGet({ conversationId })),
									}),
								]
							: []),
					]).catch((cause) => fail("provider.login.complete", cause));
				}
			}
		};
		while (!liveAbort.signal.aborted) {
			let receivedEvent = false;
			try {
				const events = await client.live.subscribe(liveAbort.signal);
				await Promise.all([
					replaceActiveFromHost(),
					...(initialized
						? [
								refreshRuns(),
								queryClient.invalidateQueries({
									queryKey: queryKeys.runs,
									predicate: (query) =>
										query.queryKey[1] !== "active" && query.queryKey[2] === currentCharacterId(),
								}),
							]
						: []),
					...(initialized ? [refreshConversations()] : []),
					...(initialized
						? [
								queryClient.invalidateQueries({
									predicate: (query) =>
										[queryKeys.settings, ...characterSetupKeys].some(
											(key) =>
												key.length === query.queryKey.length &&
												key.every((part, index) => part === query.queryKey[index]),
										),
								}),
							]
						: []),
				]);
				if (liveAbort.signal.aborted) return;
				initialized = true;
				setLiveConnectionStatus("connected");
				if (operationError()?.operation === "live.initialize") setOperationError(null);
				for await (const event of events) {
					if (liveAbort.signal.aborted) return;
					receivedEvent = true;
					consecutiveDisconnects = 0;
					applyLiveEvent(event);
				}
			} catch (cause) {
				if (!initialized) fail("live.initialize", cause);
			}
			if (liveAbort.signal.aborted) return;
			++projectionEpoch;
			piEventCaptures.clear();
			projectionRefreshes.clear();
			setHistoryRequest(undefined);
			setHistoryFailure(undefined);
			setLiveConnectionStatus("reconnecting");
			if (!receivedEvent) consecutiveDisconnects += 1;
			const delayMs = Math.min(
				PI_RECONNECT_MIN_DELAY_MS * 2 ** Math.min(Math.max(0, consecutiveDisconnects - 1), 10),
				PI_RECONNECT_MAX_DELAY_MS,
			);
			if (!(await waitForPiReconnect(liveAbort.signal, delayMs))) return;
		}
	})().catch(() => undefined);
	const runApi = createRunApi({
		client,
		queryClient,
		runsRequest,
		characterId: currentCharacterId,
		activeRuns: () => runsQuery.data?.runs ?? [],
		refreshRuns,
		onRefreshError: (cause) => {
			if (!isCancelledError(cause)) fail("run.refresh", cause);
		},
	});
	const artifactApi: ArtifactApi = {
		read: (request) => invoke(client, () => client.artifact.read(request)),
		open: (identity) => invoke(client, () => client.artifact.open(identity)),
		reveal: (identity) => invoke(client, () => client.artifact.reveal(identity)),
		saveAs: (identity) => invoke(client, () => client.artifact.saveAs(identity)),
	};
	const characterApi = createCharacterApi({
		client,
		queryClient,
		cacheRevision,
		currentCharacterId,
		characters: () => charactersQuery.data?.characters ?? [],
		refreshCharacters,
		refreshSnapshot,
		resyncOnboarding: onboarding.resync,
		switchCharacterConversations: async () => {
			beginActiveMutation();
			++projectionEpoch;
			projectionRefreshes.clear();
			sessionVersions.clear();
			retiredInstances.clear();
			readGenerations.clear();
			setPiLiveBySession(new Map());
			setToolExecutionsBySession(new Map());
			setSubmissionsBySession(new Map());
			submissionAnchors.clear();
			setActivitiesBySession(new Map());
			setHostStagesBySession(new Map());
			setHostFailuresBySession(new Map());
			setCompletedMessagesBySession(new Map());
			setCompletedConversationIds(new Set<string>());
			piEventCaptures.clear();
			deletedConversationIds.clear();
			await refreshActiveConversation();
			await Promise.resolve();
			queryClient.removeQueries({
				predicate: (query) =>
					query.queryKey[0] === "conversation" && query.queryKey[1] !== "active",
			});
			queryClient.removeQueries({ queryKey: ["companionState"] });
			queryClient.removeQueries({ queryKey: ["models", "route"] });
			await Promise.all([refreshConversations(), refreshArchived()]);
		},
		invalidateConversations: refreshConversations,
		invalidateActiveConversation: async () => {
			await refreshActiveConversation();
			await refreshCompanionState();
		},
	});
	const canonApi = createCanonApi({
		client,
		queryClient,
		cacheRevision,
		currentCharacterId,
		canonSources,
		canonModules,
		refreshSources: refreshCanonSources,
		refreshModules: refreshCanonModules,
	});
	const embedding: EmbeddingBinding = {
		acquisitionState: () =>
			acquisitionQuery.data ??
			({
				revision: 0,
				phase: "idle",
				downloadedBytes: 0,
			} as LocalEmbeddingAcquisitionState),
		cancelAcquisition: async () => {
			const current = acquisitionQuery.data;
			if (!current || !("operationId" in current)) return embedding.acquisitionState();
			const state = await invoke(client, () =>
				client.memory.localEmbeddingAcquisitionCancel({
					operationId: current.operationId,
				}),
			);
			hydrateRpcQuery(queryClient, queryKeys.embeddingAcquisition, state);
			return state;
		},
		settingsQuery,
		capabilitiesQuery,
		inventoryQuery,
		acquisitionQuery,
		settingsMutation: createRpcMutation({
			client: queryClient,
			request: (value) =>
				invoke(client, () =>
					client.settings.set({
						settings:
							"type" in value ? { modelDownloadSource: value } : { memoryVectorService: value },
					}),
				),
			invalidates: [],
			onSuccess: (result) => hydrateRpcQuery(queryClient, queryKeys.settings, result),
		}),
		acquisitionStartMutation: createRpcMutation({
			client: queryClient,
			request: (params) =>
				invoke(client, () => client.memory.localEmbeddingAcquisitionStart(params)),
			invalidates: [],
			onSuccess: (state) => hydrateRpcQuery(queryClient, queryKeys.embeddingAcquisition, state),
		}),
		activateLocalMutation: createRpcMutation({
			client: queryClient,
			request: (target) => invoke(client, () => client.memory.activateLocalEmbedding({ target })),
			invalidates: [queryKeys.embeddingInventory],
			onSuccess: (result) => hydrateRpcQuery(queryClient, queryKeys.settings, result),
		}),
		completeEmbeddingMutation: createRpcMutation({
			client: queryClient,
			request: (params) => invoke(client, () => client.systemOnboarding.completeEmbedding(params)),
			invalidates: [queryKeys.embeddingInventory],
			onSuccess: (result) => hydrateRpcQuery(queryClient, queryKeys.settings, result),
		}),
	};

	const dispatchSubmission = async (submission: ConversationSubmission): Promise<void> => {
		const { conversationId, text, entryId } = submission;
		if (
			mutationSessions().has(conversationId) ||
			submissionsBySession().get(conversationId)?.state === "submitting"
		)
			throw new Error("conversation_mutation_pending");
		if (submission.kind !== "send") beginActiveMutation();
		if (!submissionAnchors.has(submission.id))
			submissionAnchors.set(
				submission.id,
				new Set(
					(
						queryClient.getQueryData<ConversationDetail>(queryKeys.conversation(conversationId))
							?.branch.entries ?? []
					).map((entry) => entry.id),
				),
			);
		updateSubmission({ ...submission, state: "submitting", error: undefined });
		let accepted = false;
		try {
			if (submission.kind === "send") {
				await invoke(client, () =>
					client.message.send({ conversationId, text, clientMessageId: submission.id }),
				);
				accepted = true;
				updateSubmission({ ...submission, state: "accepted", error: undefined });
				scheduleConversationRefresh(conversationId);
			} else {
				if (!entryId) throw new Error("message_entry_required");
				const projected = await withPiEventReplay(
					conversationId,
					async () => {
						const detail = await invoke(client, () =>
							submission.kind === "edit"
								? client.message.edit({ conversationId, entryId, text })
								: client.message.correct({ conversationId, entryId, feedback: text }),
						);
						accepted = true;
						updateSubmission({ ...submission, state: "accepted", error: undefined });
						return detail;
					},
					(detail) => commitConversationDetailIfCurrent(conversationId, detail),
				);
				if (!projected) scheduleConversationRefresh(conversationId);
				else if (submissionsBySession().get(conversationId)?.id === submission.id) {
					submissionAnchors.delete(submission.id);
					removeSubmission(conversationId);
				}
			}
			if (activeConversationId() === conversationId) setOperationError(null);
		} catch (cause) {
			updateSubmission({
				...submission,
				state: accepted ? "accepted" : cause instanceof IpcInvocationError ? "failed" : "unknown",
				error: cause instanceof Error ? cause.message : String(cause),
			});
			throw cause;
		}
	};
	const companionState = () => companionStateQuery.data;
	const store: CompanionStore = {
		get loading() {
			return snapshotQuery.isPending;
		},
		get systemSetupReady() {
			return systemSetupReady();
		},
		get characterSetupReady() {
			return characterSetupReady();
		},
		get setupLoadError() {
			cacheRevision();
			const keys =
				settingsQuery.data?.settings.firstRunStage === "role"
					? [queryKeys.settings, ...characterSetupKeys]
					: [queryKeys.settings];
			for (const key of keys) {
				const error = queryClient.getQueryState(key)?.error;
				if (error) return error instanceof Error ? error.message : String(error);
			}
			return null;
		},
		get error() {
			return (
				operationError()?.message ?? (snapshotQuery.error ? String(snapshotQuery.error) : null)
			);
		},
		get errorMetadata() {
			return operationError();
		},
		get onboarding() {
			return onboarding.data();
		},
		get conversations() {
			const live = piLiveBySession();
			const activeId = activeConversationId();
			const active = activeDetail();
			completedConversationIds();
			return (conversationsQuery.data?.conversations ?? []).map((conversation) => ({
				...conversation,
				isStreaming:
					live.get(conversation.conversationId)?.isStreaming ??
					(activeId === conversation.conversationId ? active?.live.isStreaming : undefined) ??
					conversation.isStreaming,
			}));
		},
		get archivedConversations() {
			return archivedQuery.data?.conversations ?? [];
		},
		get activeConversationId() {
			return activeConversationId();
		},
		get activePiEntries() {
			return activeDetail()?.branch.entries;
		},
		get activePiBranch() {
			return activeDetail()?.branch;
		},
		get historyLoading() {
			return historyRequest()?.conversationId === activeConversationId();
		},
		get historyError() {
			return historyFailure()?.conversationId === activeConversationId()
				? historyFailure()!.message
				: null;
		},
		loadOlderHistory: async () => {
			const detail = activeDetail();
			const first = detail?.branch.entries[0];
			if (!detail || !first || !detail.branch.hasMoreBefore || historyRequest()) return;
			const conversationId = detail.conversationId;
			const epoch = projectionEpoch;
			const navigation = activeMutationGeneration;
			const generation = readGenerations.get(conversationId);
			const token = {};
			setHistoryRequest({ conversationId, token });
			setHistoryFailure(undefined);
			const current = () =>
				epoch === projectionEpoch &&
				navigation === activeMutationGeneration &&
				generation === readGenerations.get(conversationId) &&
				activeConversationId() === conversationId &&
				historyRequest()?.token === token &&
				activeDetail()?.branch.entries[0]?.id === first.id;
			try {
				const page = await invoke(client, () =>
					client.conversation.history({
						conversationId,
						beforeEntryId: first.id,
						limit: 100,
					}),
				);
				if (!current()) return;
				const branch = retainPiHistory(
					{ ...detail.branch, entries: page.entries, hasMoreBefore: !!page.nextCursor },
					activeDetail()!.branch,
				);
				if (branch === activeDetail()!.branch)
					throw new Error("conversation_history_ancestry_mismatch");
				updateConversationProjection(conversationId, (latest) => ({ ...latest, branch }));
			} catch (cause) {
				if (current())
					setHistoryFailure({
						conversationId,
						message: cause instanceof Error ? cause.message : String(cause),
					});
			} finally {
				if (historyRequest()?.token === token) setHistoryRequest(undefined);
			}
		},
		get completedConversationIds() {
			return completedConversationIds();
		},
		get activePiLiveState() {
			const id = activeConversationId();
			return id ? (piLiveBySession().get(id) ?? activeDetail()?.live) : undefined;
		},
		get activeSubmission() {
			return submissionsBySession().get(activeConversationId() ?? "");
		},
		get liveConnectionStatus() {
			return liveConnectionStatus();
		},
		get activeActivity(): ConversationActivity | undefined {
			const id = activeConversationId();
			if (!id) return undefined;
			const failure = hostFailuresBySession().get(id);
			if (failure) return failure;
			const stage = hostStagesBySession().get(id)?.activity;
			if (stage) return stage;
			const native = activitiesBySession().get(id);
			if (native) return native.activity;
			const live = piLiveBySession().get(id) ?? activeDetail()?.live;
			if (live?.isCompacting) return { kind: "compaction" };
			if (live?.isRetrying) return { kind: "retry", attempt: live.retryAttempt };
			if (live?.pendingToolCallIds.length) {
				const execution = toolExecutionsBySession().get(id)?.get(live.pendingToolCallIds[0]!);
				return { kind: "tool", toolName: execution?.toolName };
			}
			return live?.isStreaming ? { kind: "responding" } : undefined;
		},
		get conversationMutationBusy() {
			return conversationMutationBusy();
		},
		get activeAbortPending() {
			return abortSessions().has(activeConversationId() ?? "");
		},
		get activeTimeline() {
			const detail = activeDetail();
			const id = activeConversationId();
			if (!detail || !id) return [];
			const result: TimelineProjectionItem[] = [];
			const executions = toolExecutionsBySession().get(id);
			const live = piLiveBySession().get(id) ?? detail.live;
			const displayedTools = new Set<string>();
			for (const entry of detail.branch.entries)
				if (entry.type === "message" && entry.message.role === "toolResult")
					displayedTools.add(entry.message.toolCallId);
			const appendTools = (
				message: NonNullable<PiLiveState["streamingMessage"]>,
				preparing = false,
			) => {
				if (message.role !== "assistant") return;
				for (const part of message.content) {
					if (part.type !== "toolCall" || displayedTools.has(part.id)) continue;
					const execution = executions?.get(part.id);
					if (!execution && !preparing) continue;
					displayedTools.add(part.id);
					// A native streamed call is inspectable before execution starts.
					// This row is presentation only; it never enters the execution map.
					result.push({
						kind: "tool-execution",
						id: `tool:${id}:${part.id}`,
						...(execution ?? {
							toolCallId: part.id,
							toolName: part.name,
							args: part.arguments,
							status:
								message.stopReason === "error" || message.stopReason === "aborted"
									? "failed"
									: "pending",
						}),
					});
				}
			};
			for (const entry of detail.branch.entries) {
				result.push({
					kind: "entry",
					id:
						entry.type === "message" && entry.message.role === "toolResult"
							? `tool:${id}:${entry.message.toolCallId}`
							: entry.id,
					entry,
				});
				if (entry.type === "message")
					appendTools(entry.message, live.isStreaming && entry.id === detail.branch.activeLeafId);
			}
			const submission = submissionsBySession().get(id);
			if (submission?.kind === "send")
				result.push({ kind: "submission", id: submission.id, submission });
			for (const queue of ["steering", "followUp"] as const)
				for (const [index, text] of live[queue].entries())
					result.push({
						kind: "queued-user",
						id: `pi-queue-${queue}-${index}-${text}`,
						text,
						queue,
					});
			const messages = [...(completedMessagesBySession().get(id) ?? [])];
			if (
				live.streamingMessage &&
				!messages.some((message) => samePiMessage(message, live.streamingMessage!))
			)
				messages.push(live.streamingMessage);
			for (const streaming of messages) {
				if (streaming.role !== "assistant") continue;
				const displayable = streaming.content.some(
					(part) =>
						(part.type === "text" && part.text.length > 0) ||
						(part.type !== "text" && part.type !== "toolCall"),
				);
				const failed = streaming.stopReason === "error" || streaming.stopReason === "aborted";
				const persisted = detail.branch.entries.some(
					(entry) => entry.type === "message" && samePiMessage(entry.message, streaming),
				);
				if (!persisted && (displayable || failed || !!streaming.errorMessage))
					result.push({
						kind: "streaming-assistant",
						id: `pi-stream-${streaming.responseId ?? streaming.timestamp}`,
						message: streaming,
					});
				appendTools(streaming, true);
			}
			for (const execution of executions?.values() ?? [])
				if (!displayedTools.has(execution.toolCallId))
					result.push({
						kind: "tool-execution",
						id: `tool:${id}:${execution.toolCallId}`,
						...execution,
					});
			return result;
		},
		get runs() {
			return runsQuery.data?.runs ?? [];
		},
		get character() {
			return snapshotQuery.data?.character;
		},
		get companionState() {
			return companionState();
		},
		refresh: async () => {
			await refreshActiveConversation();
			await Promise.all([
				refreshSnapshot(),
				refreshConversation(),
				refreshCompanionState(),
				refreshConversations(),
				refreshRuns(),
			]);
		},
		searchConversations: async (title) => {
			setTitleQuery(title.trim());
			await refreshConversations();
		},
		selectConversation: (conversationId) =>
			run("conversation.select", async () => {
				await selectAndActivate(conversationId);
			}),
		createConversation: (title) =>
			run("conversation.create", async () => {
				const generation = beginActiveMutation();
				const detail = await invoke(client, () => client.conversation.create({ title }));
				applyActiveProjectionIfCurrent(generation, { activeConversation: detail });
				await refreshConversations();
			}),
		createConversationFromEntry: (entryId) =>
			runConversationMutation("message.branch", async () => {
				const generation = beginActiveMutation();
				const conversationId = requireConversation();
				const detail = await invoke(client, () =>
					client.message.branch({ conversationId, entryId }),
				);
				applyActiveProjectionIfCurrent(generation, { activeConversation: detail });
				await refreshConversations();
			}),
		renameConversation: (id, title) =>
			run("conversation.rename", async () => {
				await invoke(client, () => client.conversation.rename({ conversationId: id, title }));
				await Promise.all([
					refreshConversations(),
					...(activeConversationId() === id ? [refreshConversation(id)] : []),
				]);
			}),
		archiveConversation: (conversationId) =>
			run("conversation.archive", async () => {
				const generation = beginActiveMutation();
				const response = await invoke(client, () =>
					client.conversation.archive({ conversationId, archived: true }),
				);
				applyActiveProjectionIfCurrent(generation, response);
				await Promise.all([refreshConversations(), refreshArchived()]);
			}),
		restoreConversation: (conversationId) =>
			run("conversation.restore", async () => {
				const generation = beginActiveMutation();
				const response = await invoke(client, () =>
					client.conversation.archive({ conversationId, archived: false }),
				);
				applyActiveProjectionIfCurrent(generation, response);
				await Promise.all([refreshConversations(), refreshArchived()]);
			}),
		deleteConversation: (conversationId) =>
			run("conversation.delete", async () => {
				const generation = beginActiveMutation();
				const response = await invoke(client, () => client.conversation.delete({ conversationId }));
				markConversationDeleted(conversationId);
				sessionVersions.delete(conversationId);
				retiredInstances.delete(conversationId);
				readGenerations.delete(conversationId);
				piEventCaptures.delete(conversationId);
				const submission = submissionsBySession().get(conversationId);
				if (submission) submissionAnchors.delete(submission.id);
				removeSubmission(conversationId);
				dropPiLive(conversationId);
				dropToolExecutions(conversationId);
				setActivitiesBySession((current) => {
					const next = new Map(current);
					next.delete(conversationId);
					return next;
				});
				setHostStagesBySession((current) => {
					const next = new Map(current);
					next.delete(conversationId);
					return next;
				});
				setCompletedMessagesBySession((current) => {
					const next = new Map(current);
					next.delete(conversationId);
					return next;
				});
				setHostFailuresBySession((current) => {
					const next = new Map(current);
					next.delete(conversationId);
					return next;
				});
				queryClient.removeQueries({
					queryKey: queryKeys.conversation(conversationId),
					exact: true,
				});
				queryClient.removeQueries({
					queryKey: queryKeys.companionState(conversationId),
					exact: true,
				});
				queryClient.removeQueries({
					queryKey: queryKeys.modelRoute(conversationId),
					exact: true,
				});
				applyActiveProjectionIfCurrent(generation, response);
				await Promise.all([refreshConversations(), refreshArchived()]);
			}),
		updateCompanionState: (changes) =>
			run("companionState.update", async () => {
				const id = requireConversation();
				await invoke(client, () =>
					client.companionState.update({
						conversationId: id,
						changes,
					}),
				);
				await refreshCompanionState(id);
			}),
		sendMessage: (text) =>
			dispatchSubmission({
				id: crypto.randomUUID(),
				conversationId: requireConversation(),
				kind: "send",
				text,
				state: "submitting",
			}),
		retrySubmission: async (id) => {
			const submission = [...submissionsBySession().values()].find((item) => item.id === id);
			if (!submission || submission.state === "submitting") return;
			if (
				submission.state === "accepted" ||
				(submission.state === "unknown" && submission.kind !== "send")
			) {
				try {
					await refreshConversation(submission.conversationId);
					const current = submissionsBySession().get(submission.conversationId);
					if (current?.id === id) {
						// Edit/correct lack Host request deduplication or receipt identity.
						// A fresh branch alone cannot prove which request changed it.
						if (current.state === "unknown") return;
						if (current.kind === "send") updateSubmission({ ...current, error: undefined });
						else {
							submissionAnchors.delete(id);
							removeSubmission(submission.conversationId);
						}
					}
				} catch (cause) {
					updateSubmission({
						...submission,
						error: cause instanceof Error ? cause.message : String(cause),
					});
					throw cause;
				}
				return;
			}
			await dispatchSubmission(submission);
		},
		dismissSubmission: (id) => {
			const submission = [...submissionsBySession().values()].find((item) => item.id === id);
			if (!submission || submission.state === "submitting") return;
			submissionAnchors.delete(id);
			removeSubmission(submission.conversationId);
		},
		correctMessage: (entryId, text) =>
			dispatchSubmission({
				id: crypto.randomUUID(),
				conversationId: requireConversation(),
				kind: "correct",
				entryId,
				text,
				state: "submitting",
			}),
		switchMessageVersion: (leafId) =>
			runConversationMutation("message.switchVersion", async () => {
				const conversationId = requireConversation();
				beginActiveMutation();
				const projected = await withPiEventReplay(
					conversationId,
					() => invoke(client, () => client.message.switchVersion({ conversationId, leafId })),
					(detail) => commitConversationDetailIfCurrent(conversationId, detail),
				);
				if (!projected) scheduleConversationRefresh(conversationId);
			}),
		editMessage: (entryId, text) =>
			dispatchSubmission({
				id: crypto.randomUUID(),
				conversationId: requireConversation(),
				kind: "edit",
				entryId,
				text,
				state: "submitting",
			}),
		abort: async () => {
			const conversationId = requireConversation();
			if (abortSessions().has(conversationId)) return;
			setAbortSessions((current) => new Set(current).add(conversationId));
			try {
				await run("message.abort", async () => {
					await invoke(client, () => client.message.abort({ conversationId }));
					await refreshConversation(conversationId);
				});
			} finally {
				setAbortSessions((current) => {
					const next = new Set(current);
					next.delete(conversationId);
					return next;
				});
			}
		},
		submitOnboarding: (stepId, answer) =>
			run("onboarding.submit", async () => {
				await onboarding.submit(stepId, answer);
				await refreshConversations();
				if (activeConversationId())
					await Promise.all([
						refreshSnapshot(),
						refreshConversation(),
						refreshCompanionState(),
						refreshRuns(),
					]);
			}),
		settings: trackApi("settings", settingsApi, fail),
		provider: trackApi("provider", providerApi, fail),
		model: trackApi("model", modelApi, fail),
		embedding,
		run: trackApi("run", runApi, fail),
		artifact: trackApi("artifact", artifactApi, fail),
		externalAgent: trackApi("externalAgent", createExternalAgentApi(client), fail),
		characters: trackApi("character", characterApi, fail),
		canon: trackApi("canon", canonApi, fail),
	};
	return store;
}
