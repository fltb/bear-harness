import type { CompanionClient } from "@bear-harness/companion-client";
import type { PiAgentSessionEvent as AgentSessionEvent, LivePush } from "@bear-harness/protocol";
import type { EmbeddingDownloadState } from "@bear-harness/protocol/schema";
import { isCancelledError, useQueryClient } from "@tanstack/solid-query";
import {
	createContext,
	createMemo,
	createSignal,
	onCleanup,
	type ParentProps,
	untrack,
	useContext,
} from "solid-js";
import { IpcInvocationError } from "../lib/ipc.js";
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
	SettingsData,
	Snapshot,
} from "./ipc.js";
import { invoke } from "./ipc.js";
import { createModelProviderApis } from "./model-provider-api.js";
import { withRpcMutations } from "./mutation-client.js";
import { createOnboardingStore } from "./onboarding.js";
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
export interface PendingUserMessage {
	clientMessageId: string;
	conversationId: string;
	text: string;
	createdAt: number;
	anchorEntryId?: string;
	state: "pending" | "failed";
	error?: string;
}
export type TimelineProjectionItem =
	| { kind: "entry"; id: string; entry: PiSessionEntry }
	| { kind: "optimistic-user"; id: string; message: PendingUserMessage }
	| { kind: "queued-user"; id: string; text: string }
	| {
			kind: "streaming-assistant";
			id: string;
			message: Extract<NonNullable<PiLiveState["streamingMessage"]>, { role: "assistant" }>;
	  };
export interface SnapshotApi {
	data(): Snapshot | undefined;
	loading(): boolean;
	error(): unknown;
	refetch(): void;
	get(): Promise<Snapshot>;
}
export interface CompanionStore {
	readonly loading: boolean;
	readonly error: string | null;
	readonly errorMetadata: CompanionErrorMetadata | null;
	readonly onboarding: ReturnType<typeof createOnboardingStore>["data"] extends () => infer T
		? T
		: never;
	readonly conversations: ConversationSummary[];
	readonly archivedConversations: ConversationSummary[];
	readonly activeConversationId: string | null;
	readonly activePiEntries: PiSessionEntry[] | undefined;
	readonly completedConversationIds: ReadonlySet<string>;
	readonly activePiLiveState: PiLiveState | undefined;
	readonly pendingUserMessages: readonly PendingUserMessage[];
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
	retryPendingMessage(clientMessageId: string): Promise<void>;
	dismissPendingMessage(clientMessageId: string): void;
	regenerateMessage(entryId: string, feedback?: string): Promise<void>;
	switchMessageVersion(leafId: string): Promise<void>;
	editMessage(entryId: string, text: string): Promise<void>;
	abort(): Promise<void>;
	submitOnboarding(stepId: string, answer?: string): Promise<void>;
	readonly snapshot: SnapshotApi;
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

function piMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
				? [String(part.text)]
				: [],
		)
		.join("\n");
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
	return created;
}

function createStoreForClient(source: CompanionClient): CompanionStore {
	const queryClient = useQueryClient();
	const client = withRpcMutations(source, queryClient);
	const [cacheRevision, setCacheRevision] = createSignal(0);
	const [operationError, setOperationError] = createSignal<CompanionErrorMetadata | null>(null);
	const [titleQuery, setTitleQuery] = createSignal("");
	const [activeConversationId, setActiveConversationId] = createSignal<string | null>(null);
	const [piLiveBySession, setPiLiveBySession] = createSignal<ReadonlyMap<string, PiLiveState>>(
		new Map(),
	);
	const [completedConversationIds, setCompletedConversationIds] = createSignal<ReadonlySet<string>>(
		new Set(),
	);
	const [optimisticUserBySession, setOptimisticUserBySession] = createSignal<
		ReadonlyMap<string, PendingUserMessage>
	>(new Map());
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
	const activeDetailQuery = createRpcQuery<ConversationDetail | undefined>({
		client: queryClient,
		key: () => queryKeys.conversation(activeConversationId() ?? ""),
		enabled: () => activeConversationId() !== null,
		request: (key) =>
			key[1]
				? invoke(client, () => client.conversation.open({ conversationId: key[1] as string }))
				: Promise.resolve(undefined),
	});
	const companionStateQuery = createRpcQuery<CompanionStateData | undefined>({
		client: queryClient,
		key: () => queryKeys.companionState(activeConversationId() ?? ""),
		enabled: () => activeConversationId() !== null,
		request: (key) =>
			key[1]
				? invoke(client, () => client.companionState.get({ conversationId: key[1] as string }))
				: Promise.resolve(undefined),
	});
	const runsQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.runs,
		request: () => invoke(client, () => client.run.list()),
	});
	const charactersQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.characters,
		request: () => invoke(client, () => client.character.list()),
	});
	const currentCharacterId = createMemo(
		() =>
			charactersQuery.data?.characters.find((item) => item.active)?.id ??
			snapshotQuery.data?.character?.id,
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
		request: () => invoke(client, () => client.provider.list()),
	});
	const poolQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.modelPool,
		request: () => invoke(client, () => client.model.poolGet()),
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
		request: () => invoke(client, () => client.canon.listSources({})),
	});
	const canonModules = createRpcQuery({
		client: queryClient,
		key: () => queryKeys.canonModules(currentCharacterId()),
		request: () => invoke(client, () => client.canon.listModules({})),
	});
	const downloadQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.embeddingDownload,
		request: () => invoke(client, () => client.memory.localEmbeddingDownloadStatus({})),
	});

	const activeDetail = () => activeDetailQuery.data;
	const removeOptimisticUser = (conversationId: string) =>
		setOptimisticUserBySession((current) => {
			if (!current.has(conversationId)) return current;
			const next = new Map(current);
			next.delete(conversationId);
			return next;
		});
	const reconcileOptimisticUser = (detail: ConversationDetail) => {
		const optimistic = optimisticUserBySession().get(detail.conversationId);
		if (!optimistic) return;
		const anchorIndex = optimistic.anchorEntryId
			? detail.branch.entries.findIndex((entry) => entry.id === optimistic.anchorEntryId)
			: -1;
		const acknowledged = detail.branch.entries
			.slice(anchorIndex + 1)
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					piMessageText(entry.message.content) === optimistic.text,
			);
		if (acknowledged) removeOptimisticUser(detail.conversationId);
	};
	const refreshSnapshot = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.snapshot,
			request: snapshotRequest,
		});
	const refreshConversation = async (conversationId = activeConversationId()) => {
		if (!conversationId) return undefined;
		const detail = await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.conversation(conversationId),
			request: () => invoke(client, () => client.conversation.open({ conversationId })),
		});
		if (detail) reconcileOptimisticUser(detail);
		return detail;
	};
	const refreshCompanionState = async (conversationId = activeConversationId()) => {
		if (!conversationId) return undefined;
		return refreshRpcQuery({
			client: queryClient,
			key: queryKeys.companionState(conversationId),
			request: () => invoke(client, () => client.companionState.get({ conversationId })),
		});
	};
	const replacePiLive = (detail: ConversationDetail) => {
		setPiLiveBySession((current) => {
			const next = new Map(current);
			next.set(detail.conversationId, detail.live);
			return next;
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
	const activateDetail = (detail: ConversationDetail) => {
		hydrateRpcQuery(queryClient, queryKeys.conversation(detail.conversationId), detail);
		if (detail.selectedModel)
			hydrateRpcQuery(queryClient, queryKeys.modelRoute(detail.conversationId), {
				selected: detail.selectedModel,
			});
		reconcileOptimisticUser(detail);
		setActiveConversationId(detail.conversationId);
		setCompletedConversationIds((current) => {
			if (!current.has(detail.conversationId)) return current;
			const next = new Set(current);
			next.delete(detail.conversationId);
			return next;
		});
	};
	const openAndActivate = async (id: string) => {
		const detail = await invoke(client, () => client.conversation.open({ conversationId: id }));
		activateDetail(detail);
		return detail;
	};
	const refreshConversations = async () => {
		return refreshRpcQuery({
			client: queryClient,
			key: [...queryKeys.conversations, titleQuery()],
			request: conversationsRequest,
		});
	};
	const refreshArchived = async () => {
		return refreshRpcQuery({
			client: queryClient,
			key: queryKeys.archivedConversations,
			request: () => invoke(client, () => client.conversation.list({ archived: true, limit: 100 })),
		});
	};
	void Promise.all([
		queryClient.fetchQuery({ queryKey: queryKeys.onboarding, queryFn: onboarding.get }),
		queryClient.fetchQuery({
			queryKey: [...queryKeys.conversations, titleQuery()],
			queryFn: conversationsRequest,
		}),
	])
		.then(([onboardingData, conversations]) => {
			if (onboardingData.status !== "complete" || activeConversationId() !== null) return;
			const first = conversations.conversations[0];
			if (!first) return;
			return invoke(client, () =>
				client.conversation.open({ conversationId: first.conversationId }),
			).then((detail) => {
				if (activeConversationId() === null) activateDetail(detail);
			});
		})
		.catch((cause) => fail("conversation.initialize", cause));
	const refreshRuns = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.runs,
			request: () => invoke(client, () => client.run.list()),
		});
	const refreshCharacters = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.characters,
			request: () => invoke(client, () => client.character.list()),
		});
	const refreshCanonSources = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonSources(currentCharacterId()),
			request: () => invoke(client, () => client.canon.listSources({})),
		});
	const refreshCanonModules = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonModules(currentCharacterId()),
			request: () => invoke(client, () => client.canon.listModules({})),
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
	const applyPiEvent = (conversationId: string, event: AgentSessionEvent) => {
		setPiLiveBySession((current) => {
			const previous = current.get(conversationId) ?? {
				isStreaming: false,
				steering: [],
				followUp: [],
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
				case "message_end": {
					const responseId =
						event.message.role === "assistant" ? event.message.responseId : undefined;
					const persisted =
						event.message.role === "assistant" &&
						queryClient
							.getQueryData<ConversationDetail>(queryKeys.conversation(conversationId))
							?.branch.entries.some(
								(entry) =>
									entry.type === "message" &&
									entry.message.role === "assistant" &&
									((entry.message.responseId && entry.message.responseId === responseId) ||
										entry.message.timestamp === event.message.timestamp),
							);
					nextLive = {
						...previous,
						// Keep the completed transient message visible until Pi appends the
						// authoritative transcript entry. Clearing it here creates a visible gap.
						streamingMessage: persisted ? undefined : event.message,
						...(event.message.role === "assistant" && event.message.errorMessage
							? { errorMessage: event.message.errorMessage }
							: {}),
					};
					break;
				}
				case "queue_update":
					nextLive = {
						...previous,
						steering: [...event.steering],
						followUp: [...event.followUp],
					};
					break;
				case "agent_settled":
					nextLive = { ...previous, isStreaming: false };
					break;
			}
			if (nextLive === previous) return current;
			const next = new Map(current);
			next.set(conversationId, nextLive);
			return next;
		});
		if (event.type === "entry_appended") {
			if (event.entry.type === "message" && event.entry.message.role === "assistant") {
				setPiLiveBySession((current) => {
					const previous = current.get(conversationId);
					if (!previous?.streamingMessage) return current;
					const next = new Map(current);
					next.set(conversationId, { ...previous, streamingMessage: undefined });
					return next;
				});
			}
			queryClient.setQueryData<ConversationDetail>(
				queryKeys.conversation(conversationId),
				(current) => {
					if (!current) return current;
					const existing = current.branch.entries.findIndex((entry) => entry.id === event.entry.id);
					const entries = [...current.branch.entries];
					if (existing >= 0) entries[existing] = event.entry;
					else entries.push(event.entry);
					return {
						...current,
						branch: { ...current.branch, entries, activeLeafId: event.entry.id },
					};
				},
			);
			if (
				event.entry.type === "message" &&
				event.entry.message.role === "user" &&
				optimisticUserBySession().get(conversationId)?.text ===
					piMessageText(event.entry.message.content)
			)
				removeOptimisticUser(conversationId);
		}
		if (event.type === "session_info_changed") {
			queryClient.setQueryData<ConversationDetail>(
				queryKeys.conversation(conversationId),
				(current) => (current ? { ...current, name: event.name } : current),
			);
		}
		if (event.type === "agent_start") {
			setCompletedConversationIds((current) => {
				if (!current.has(conversationId)) return current;
				const next = new Set(current);
				next.delete(conversationId);
				return next;
			});
		}
		if (event.type === "agent_settled") {
			if (conversationId === activeConversationId())
				void Promise.all([
					refreshConversation(conversationId),
					refreshCompanionState(conversationId),
				]).catch((cause) => fail("conversation.settled", cause));
			else setCompletedConversationIds((current) => new Set(current).add(conversationId));
		}
	};
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
	let markInitialLiveProjection!: () => void;
	const initialLiveProjection = new Promise<void>((resolve) => {
		markInitialLiveProjection = resolve;
	});
	const liveAbort = new AbortController();
	onCleanup(() => liveAbort.abort());
	void (async () => {
		let consecutiveDisconnects = 0;
		let initialized = false;
		const replaceActiveFromPi = async () => {
			const conversationId = activeConversationId();
			if (!conversationId || liveAbort.signal.aborted) return;
			const detail = await settlePiSnapshot(
				invoke(client, () => client.conversation.open({ conversationId })),
				liveAbort.signal,
			);
			if (!detail || liveAbort.signal.aborted) return;
			dropPiLive(conversationId);
			hydrateRpcQuery(queryClient, queryKeys.conversation(conversationId), detail);
			if (detail.selectedModel)
				hydrateRpcQuery(queryClient, queryKeys.modelRoute(conversationId), {
					selected: detail.selectedModel,
				});
			reconcileOptimisticUser(detail);
			replacePiLive(detail);
		};
		const applyLiveEvent = (event: LivePush) => {
			if (event.type === "pi") applyPiEvent(event.conversationId, event.event);
			if (event.type === "companionState")
				hydrateRpcQuery(queryClient, queryKeys.companionState(event.conversationId), event.state);
			if (event.type === "run") {
				queryClient.setQueryData(queryKeys.runs, (current: RunListData | undefined) => ({
					runs: current?.runs.some((run) => run.id === event.run.id)
						? current.runs.map((run) => (run.id === event.run.id ? event.run : run))
						: [event.run, ...(current?.runs ?? [])].slice(0, 10),
				}));
			}
			if (event.type === "embeddingDownload")
				hydrateRpcQuery(queryClient, queryKeys.embeddingDownload, event.state);
			if (event.type === "providerLogin") {
				hydrateRpcQuery(queryClient, queryKeys.providerLogin(event.providerId), event.state);
				if (event.state.status === "completed") {
					const conversationId = activeConversationId();
					void Promise.all([
						refreshRpcQuery({
							client: queryClient,
							key: queryKeys.providers,
							request: () => invoke(client, () => client.provider.list()),
						}),
						refreshRpcQuery({
							client: queryClient,
							key: queryKeys.modelPool,
							request: () => invoke(client, () => client.model.poolGet()),
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
				await Promise.all([replaceActiveFromPi(), refreshRuns()]);
				if (liveAbort.signal.aborted) return;
				if (!initialized) {
					initialized = true;
					markInitialLiveProjection();
				}
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
		runsRequest: () => invoke(client, () => client.run.list()),
		activeRuns: () => runsQuery.data?.runs ?? [],
		refreshRuns,
		onRefreshError: (cause) => fail("run.refresh", cause),
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
			setActiveConversationId(null);
			setPiLiveBySession(new Map());
			const available = await refreshConversations();
			const first = available.conversations[0];
			if (first) await openAndActivate(first.conversationId);
		},
		invalidateConversations: refreshConversations,
		invalidateActiveConversation: async () => {
			await Promise.all([refreshConversation(), refreshCompanionState()]);
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
		downloadState: () =>
			downloadQuery.data ?? ({ status: "idle", downloadedBytes: 0 } as EmbeddingDownloadState),
		cancelDownload: () => invoke(client, () => client.memory.cancelLocalEmbeddingDownload({})),
		settingsQuery,
		capabilitiesQuery,
		settingsMutation: createRpcMutation<
			SettingsData["memoryVectorService"] | SettingsData["modelDownloadSource"]
		>({
			client: queryClient,
			request: (value) =>
				invoke(client, () =>
					client.settings.set({
						settings:
							"type" in value ? { modelDownloadSource: value } : { memoryVectorService: value },
					}),
				),
			invalidates: [queryKeys.settings],
		}),
		localConfigureMutation: createRpcMutation({
			client: queryClient,
			request: (params: {
				provider: "none" | "local";
				candidateId?: string;
				customPath?: string;
			}) => invoke(client, () => client.memory.configureLocalEmbedding(params)),
			invalidates: [queryKeys.settings],
		}),
	};

	const companionState = () => companionStateQuery.data;
	const store: CompanionStore = {
		get loading() {
			return snapshotQuery.isPending;
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
			completedConversationIds();
			return (conversationsQuery.data?.conversations ?? []).map((conversation) => ({
				...conversation,
				isStreaming: live.get(conversation.conversationId)?.isStreaming ?? conversation.isStreaming,
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
		get completedConversationIds() {
			return completedConversationIds();
		},
		get activePiLiveState() {
			const id = activeConversationId();
			return id ? (piLiveBySession().get(id) ?? activeDetail()?.live) : undefined;
		},
		get pendingUserMessages() {
			const id = activeConversationId();
			const message = id ? optimisticUserBySession().get(id) : undefined;
			return message ? [message] : [];
		},
		get activeTimeline() {
			const detail = activeDetail();
			const id = activeConversationId();
			if (!detail || !id) return [];
			const result: TimelineProjectionItem[] = detail.branch.entries.map((entry) => ({
				kind: "entry",
				id: entry.id,
				entry,
			}));
			const optimistic = optimisticUserBySession().get(id);
			if (optimistic)
				result.push({
					kind: "optimistic-user",
					id: optimistic.clientMessageId,
					message: optimistic,
				});
			const live = piLiveBySession().get(id) ?? detail.live;
			for (const [index, text] of [...live.steering, ...live.followUp].entries())
				result.push({ kind: "queued-user", id: `pi-queue-${index}-${text}`, text });
			const streaming = live.streamingMessage;
			if (streaming?.role === "assistant") {
				const text = piMessageText(streaming.content);
				const failed = streaming.stopReason === "error" || streaming.stopReason === "aborted";
				const persisted = detail.branch.entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						((streaming.responseId && entry.message.responseId === streaming.responseId) ||
							entry.message.timestamp === streaming.timestamp),
				);
				if (!persisted && (text.length > 0 || failed))
					result.push({
						kind: "streaming-assistant",
						id: `pi-stream-${streaming.responseId ?? streaming.timestamp}`,
						message: streaming,
					});
			}
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
		refresh: () =>
			run("refresh", async () => {
				await Promise.all([
					refreshSnapshot(),
					refreshConversation(),
					refreshCompanionState(),
					refreshConversations(),
					refreshRuns(),
				]);
			}),
		searchConversations: async (title) => {
			setTitleQuery(title.trim());
			await refreshConversations();
		},
		selectConversation: (id) =>
			run("conversation.open", async () => {
				await openAndActivate(id);
			}),
		createConversation: (title) =>
			run("conversation.create", async () => {
				const detail = await invoke(client, () => client.conversation.create({ title }));
				activateDetail(detail);
				await refreshConversations();
			}),
		createConversationFromEntry: (entryId) =>
			run("message.branch", async () => {
				const detail = await invoke(client, () =>
					client.message.branch({
						conversationId: requireConversation(),
						entryId,
					}),
				);
				activateDetail(detail);
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
		archiveConversation: (id) =>
			run("conversation.archive", async () => {
				const wasActive = activeConversationId() === id;
				await invoke(client, () =>
					client.conversation.archive({ conversationId: id, archived: true }),
				);
				const [available] = await Promise.all([refreshConversations(), refreshArchived()]);
				if (wasActive) {
					setActiveConversationId(null);
					const next = available.conversations.find(
						(conversation) => conversation.conversationId !== id,
					);
					if (next) await openAndActivate(next.conversationId);
				}
			}),
		restoreConversation: (id) =>
			run("conversation.restore", async () => {
				await invoke(client, () =>
					client.conversation.archive({ conversationId: id, archived: false }),
				);
				await Promise.all([refreshConversations(), refreshArchived()]);
			}),
		deleteConversation: (id) =>
			run("conversation.delete", async () => {
				const wasActive = activeConversationId() === id;
				await invoke(client, () => client.conversation.delete({ conversationId: id }));
				const [available] = await Promise.all([refreshConversations(), refreshArchived()]);
				setPiLiveBySession((current) => {
					if (!current.has(id)) return current;
					const next = new Map(current);
					next.delete(id);
					return next;
				});
				if (wasActive) {
					setActiveConversationId(null);
					const next = available.conversations.find(
						(conversation) => conversation.conversationId !== id,
					);
					if (next) await openAndActivate(next.conversationId);
				}
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
		sendMessage: (text) => {
			const conversationId = requireConversation();
			if (optimisticUserBySession().has(conversationId))
				return Promise.reject(new Error("message_send_pending"));
			const clientMessageId = crypto.randomUUID();
			setOptimisticUserBySession((current) => {
				const next = new Map(current);
				next.set(conversationId, {
					clientMessageId,
					conversationId,
					text,
					createdAt: Date.now(),
					anchorEntryId: activeDetail()?.branch.activeLeafId,
					state: "pending",
				});
				return next;
			});
			return run("message.send", async () => {
				await initialLiveProjection;
				try {
					await invoke(client, () =>
						client.message.send({
							conversationId,
							text,
							clientMessageId,
						}),
					);
				} catch (cause) {
					setOptimisticUserBySession((current) => {
						const item = current.get(conversationId);
						if (item?.clientMessageId !== clientMessageId) return current;
						const next = new Map(current);
						next.set(conversationId, {
							...item,
							state: "failed",
							error: cause instanceof Error ? cause.message : String(cause),
						});
						return next;
					});
					throw cause;
				}
			});
		},
		retryPendingMessage: async (clientMessageId) => {
			const message = [...optimisticUserBySession().values()].find(
				(item) => item.clientMessageId === clientMessageId,
			);
			if (!message) return;
			removeOptimisticUser(message.conversationId);
			await store.sendMessage(message.text);
		},
		dismissPendingMessage: (clientMessageId) => {
			const message = [...optimisticUserBySession().values()].find(
				(item) => item.clientMessageId === clientMessageId,
			);
			if (message) removeOptimisticUser(message.conversationId);
		},
		regenerateMessage: (entryId, feedback) =>
			run("message.regenerate", async () => {
				const detail = await invoke(client, () =>
					client.message.regenerate({
						conversationId: requireConversation(),
						entryId,
						feedback,
					}),
				);
				activateDetail(detail);
			}),
		switchMessageVersion: (leafId) =>
			run("message.switchVersion", async () => {
				const detail = await invoke(client, () =>
					client.message.switchVersion({
						conversationId: requireConversation(),
						leafId,
					}),
				);
				activateDetail(detail);
			}),
		editMessage: (entryId, text) =>
			run("message.edit", async () => {
				const detail = await invoke(client, () =>
					client.message.edit({
						conversationId: requireConversation(),
						entryId,
						text,
					}),
				);
				activateDetail(detail);
			}),
		abort: () =>
			run("message.abort", async () => {
				await invoke(client, () => client.message.abort({ conversationId: requireConversation() }));
				await refreshConversation();
			}),
		submitOnboarding: (stepId, answer) =>
			run("onboarding.submit", async () => {
				await onboarding.submit(stepId, answer);
				const available = await refreshConversations();
				const currentId = activeConversationId();
				if (currentId) {
					await Promise.all([refreshConversation(currentId), refreshCompanionState(currentId)]);
				} else {
					const first = available.conversations[0];
					if (first) await openAndActivate(first.conversationId);
				}
			}),
		snapshot: {
			data: () => snapshotQuery.data,
			loading: () => snapshotQuery.isLoading,
			error: () => snapshotQuery.error,
			refetch: () => void refreshSnapshot(),
			get: snapshotRequest,
		},
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
