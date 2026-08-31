import type { CompanionClient } from "@bear-harness/companion-client";
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
	PiTimeline,
	RunInfo,
	SettingsData,
	Snapshot,
} from "./ipc.js";
import { invoke, isRecord } from "./ipc.js";
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
import { affectedQueries } from "./sync-dependencies.js";
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
	readonly activePiTimeline: PiTimeline | undefined;
	readonly activePiLiveState: PiLiveState | undefined;
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
	regenerateMessage(entryId: string, feedback?: string): Promise<void>;
	switchMessageVersion(leafId: string): Promise<void>;
	editMessage(entryId: string, text: string): Promise<void>;
	abort(): Promise<void>;
	submitOnboarding(stepId: string, answer?: string): Promise<void>;
	readonly snapshot: SnapshotApi;
	readonly events: EventsApi;
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
		request: () => invoke(client, () => client.conversation.list({ archived: true })),
	});
	const activeDetailQuery = createRpcQuery<ConversationDetail | undefined>({
		client: queryClient,
		key: () => queryKeys.conversation(activeConversationId() ?? ""),
		enabled: () => activeConversationId() !== null,
		request: (key) =>
			key[1]
				? invoke(client, () => client.conversation.open({ id: key[1] as string }))
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
		request: () =>
			invoke(client, () => client.canon.listSources({ characterId: currentCharacterId() })),
	});
	const canonModules = createRpcQuery({
		client: queryClient,
		key: () => queryKeys.canonModules(currentCharacterId()),
		request: () =>
			invoke(client, () => client.canon.listModules({ characterId: currentCharacterId() })),
	});
	const downloadQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.embeddingDownload,
		request: () => invoke(client, () => client.memory.localEmbeddingDownloadStatus({})),
	});

	const activeDetail = () => activeDetailQuery.data;
	const refreshSnapshot = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.snapshot,
			request: snapshotRequest,
		});
	const refreshConversation = async (conversationId = activeConversationId()) => {
		if (!conversationId) return undefined;
		return refreshRpcQuery({
			client: queryClient,
			key: queryKeys.conversation(conversationId),
			request: () => invoke(client, () => client.conversation.open({ id: conversationId })),
		});
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
			next.set(detail.sessionId, detail.live);
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
		hydrateRpcQuery(queryClient, queryKeys.conversation(detail.sessionId), detail);
		setActiveConversationId(detail.sessionId);
	};
	const openAndActivate = async (id: string) => {
		const detail = await invoke(client, () => client.conversation.open({ id }));
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
			request: () => invoke(client, () => client.conversation.list({ archived: true })),
		});
	};
	let initialConversationSelected = false;
	onCleanup(
		queryClient.getQueryCache().subscribe((event) => {
			if (
				initialConversationSelected ||
				event.type !== "updated" ||
				event.action.type !== "success" ||
				event.query.queryKey[0] !== queryKeys.conversations[0] ||
				event.query.queryKey[1] !== ""
			)
				return;
			if (activeConversationId() !== null) {
				initialConversationSelected = true;
				return;
			}
			const available = event.query.state.data as { sessions?: ConversationSummary[] } | undefined;
			const first = available?.sessions?.[0];
			if (!first) return;
			initialConversationSelected = true;
			void openAndActivate(first.id).catch((cause) => fail("conversation.initialize", cause));
		}),
	);
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
			request: () =>
				invoke(client, () => client.canon.listSources({ characterId: currentCharacterId() })),
		});
	const refreshCanonModules = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.canonModules(currentCharacterId()),
			request: () =>
				invoke(client, () => client.canon.listModules({ characterId: currentCharacterId() })),
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
	const eventAbort = new AbortController();
	onCleanup(() => eventAbort.abort());
	void (async () => {
		for await (const events of client.events.stream(0, eventAbort.signal)) {
			for (const event of events) {
				onboarding._applyEvent(event);
				if (
					event.kind === "provider.login_changed" &&
					isRecord(event.payload) &&
					typeof event.payload.providerId === "string"
				) {
					await Promise.all([
						providerApi.loginStatus(event.payload.providerId),
						providerApi.list(),
					]);
					modelApi.refetch();
				}
				const sources =
					event.kind === "sync.invalidated" &&
					isRecord(event.payload) &&
					Array.isArray(event.payload.sources)
						? event.payload.sources.filter((value): value is string => typeof value === "string")
						: [`event:${event.kind}`];
				void queryClient.invalidateQueries({
					predicate: (query) => affectedQueries(sources)(query.queryKey),
				});
			}
		}
	})().catch(() => undefined);
	const piAbort = new AbortController();
	onCleanup(() => piAbort.abort());
	void (async () => {
		let consecutiveDisconnects = 0;
		const replaceActiveFromPi = async () => {
			const conversationId = activeConversationId();
			if (!conversationId || piAbort.signal.aborted) return;
			const detail = await settlePiSnapshot(
				invoke(client, () => client.conversation.open({ id: conversationId })),
				piAbort.signal,
			);
			if (!detail || piAbort.signal.aborted) return;
			dropPiLive(conversationId);
			hydrateRpcQuery(queryClient, queryKeys.conversation(conversationId), detail);
			replacePiLive(detail);
		};
		while (!piAbort.signal.aborted) {
			await replaceActiveFromPi();
			if (piAbort.signal.aborted) return;
			let receivedEvent = false;
			try {
				for await (const event of client.pi.stream(piAbort.signal)) {
					if (piAbort.signal.aborted) return;
					receivedEvent = true;
					consecutiveDisconnects = 0;
					setPiLiveBySession((current) => {
						const next = new Map(current);
						next.set(event.sessionId, event.live);
						return next;
					});
					if (
						event.sessionId === activeConversationId() &&
						["message_end", "entry_appended", "session_info_changed", "agent_settled"].includes(
							event.type,
						)
					)
						void refreshConversation(event.sessionId).catch((cause) =>
							fail("conversation.refreshFromPi", cause),
						);
				}
			} catch {
				// A transient transport failure is reconciled from Pi below and retried.
			}
			if (piAbort.signal.aborted) return;
			await replaceActiveFromPi();
			if (piAbort.signal.aborted) return;
			if (!receivedEvent) consecutiveDisconnects += 1;
			const delayMs = Math.min(
				PI_RECONNECT_MIN_DELAY_MS * 2 ** Math.min(Math.max(0, consecutiveDisconnects - 1), 10),
				PI_RECONNECT_MAX_DELAY_MS,
			);
			if (!(await waitForPiReconnect(piAbort.signal, delayMs))) return;
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
			const first = available.sessions[0];
			if (first) await openAndActivate(first.id);
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
			return conversationsQuery.data?.sessions ?? [];
		},
		get archivedConversations() {
			return archivedQuery.data?.sessions ?? [];
		},
		get activeConversationId() {
			return activeConversationId();
		},
		get activePiTimeline() {
			return activeDetail()?.timeline;
		},
		get activePiLiveState() {
			const id = activeConversationId();
			return id ? (piLiveBySession().get(id) ?? activeDetail()?.live) : undefined;
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
				await invoke(client, () => client.conversation.rename({ id, title }));
				await Promise.all([
					refreshConversations(),
					...(activeConversationId() === id ? [refreshConversation(id)] : []),
				]);
			}),
		archiveConversation: (id) =>
			run("conversation.archive", async () => {
				const wasActive = activeConversationId() === id;
				await invoke(client, () => client.conversation.archive({ id, archived: true }));
				const [available] = await Promise.all([refreshConversations(), refreshArchived()]);
				if (wasActive) {
					setActiveConversationId(null);
					const next = available.sessions.find((conversation) => conversation.id !== id);
					if (next) await openAndActivate(next.id);
				}
			}),
		restoreConversation: (id) =>
			run("conversation.restore", async () => {
				await invoke(client, () => client.conversation.archive({ id, archived: false }));
				await Promise.all([refreshConversations(), refreshArchived()]);
			}),
		deleteConversation: (id) =>
			run("conversation.delete", async () => {
				const wasActive = activeConversationId() === id;
				await invoke(client, () => client.conversation.delete({ id }));
				const [available] = await Promise.all([refreshConversations(), refreshArchived()]);
				setPiLiveBySession((current) => {
					if (!current.has(id)) return current;
					const next = new Map(current);
					next.delete(id);
					return next;
				});
				if (wasActive) {
					setActiveConversationId(null);
					const next = available.sessions.find((conversation) => conversation.id !== id);
					if (next) await openAndActivate(next.id);
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
		sendMessage: (text) =>
			run("message.send", async () => {
				await invoke(client, () =>
					client.message.send({
						conversationId: requireConversation(),
						text,
					}),
				);
			}),
		regenerateMessage: (entryId, feedback) =>
			run("message.regenerate", async () => {
				await invoke(client, () =>
					client.message.regenerate({
						conversationId: requireConversation(),
						entryId,
						feedback,
					}),
				);
				await refreshConversation();
			}),
		switchMessageVersion: (leafId) =>
			run("message.switchVersion", async () => {
				await invoke(client, () =>
					client.message.switchVersion({
						conversationId: requireConversation(),
						leafId,
					}),
				);
				await refreshConversation();
			}),
		editMessage: (entryId, text) =>
			run("message.edit", async () => {
				await invoke(client, () =>
					client.message.edit({
						conversationId: requireConversation(),
						entryId,
						text,
					}),
				);
				await refreshConversation();
			}),
		abort: () =>
			run("message.abort", async () => {
				await invoke(client, () => client.message.abort({ conversationId: requireConversation() }));
				await refreshConversation();
			}),
		submitOnboarding: (stepId, answer) =>
			run("onboarding.submit", async () => {
				await onboarding.submit(stepId, answer);
				const [, , available] = await Promise.all([
					onboarding.resync(),
					refreshSnapshot(),
					refreshConversations(),
				]);
				const currentId = activeConversationId();
				if (currentId) {
					await Promise.all([refreshConversation(currentId), refreshCompanionState(currentId)]);
				} else {
					const first = available.sessions[0];
					if (first) await openAndActivate(first.id);
				}
			}),
		snapshot: {
			data: () => snapshotQuery.data,
			eventSeq: () => snapshotQuery.data?.eventSeq ?? 0,
			loading: () => snapshotQuery.isLoading,
			error: () => snapshotQuery.error,
			refetch: () => void refreshSnapshot(),
			get: snapshotRequest,
		},
		events: {
			lastSeq: () => snapshotQuery.data?.eventSeq ?? 0,
			stale: () => false,
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
