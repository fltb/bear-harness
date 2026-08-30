import type { CompanionClient } from "@bear-harness/companion-client";
import type {
	EmbeddingDownloadState,
	MemoryCandidate as MemoryCandidateSchema,
} from "@bear-harness/protocol/schema";
import type { z } from "@bear-harness/schema";
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
	CharacterStateDocument,
	CompanionStatePatchOperation,
	CompanionStateSnapshot,
	ConversationSelectResponse,
	ConversationSummary,
	ModelRouteData,
	PiLiveState,
	PiTimeline,
	PiTimelineEntry,
	RunInfo,
	SettingsData,
	Snapshot,
} from "./ipc.js";
import { invoke, isRecord } from "./ipc.js";
import { createMemoryApi } from "./memory-api.js";
import { createModelProviderApis } from "./model-provider-api.js";
import { withRpcMutations } from "./mutation-client.js";
import { createOnboardingStore } from "./onboarding.js";
import { createRpcMutation, createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";
import { createRunApi } from "./run-api.js";
import type {
	CanonApi,
	CharacterApi,
	EmbeddingBinding,
	ExternalAgentApi,
	MemoryApi,
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
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type CharacterStateSnapshot = {
	schema: unknown;
	byConversation: Record<string, CharacterStateDocument>;
};

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
	readonly companionState: CompanionStateSnapshot | undefined;
	readonly characterState: CharacterStateSnapshot | undefined;
	readonly activePresentationMediaId: string | undefined;
	readonly activeAmbientMediaId: string | undefined;
	readonly activeChoiceSetId: string | undefined;
	refresh(): Promise<void>;
	searchConversations(title: string): Promise<void>;
	selectConversation(id: string): Promise<void>;
	createConversation(title?: string): Promise<void>;
	createConversationFromEntry(entryId: string): Promise<void>;
	renameConversation(id: string, title: string): Promise<void>;
	archiveConversation(id: string): Promise<void>;
	restoreConversation(id: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	patchCompanionState(operations: CompanionStatePatchOperation[]): Promise<void>;
	sendMessage(text: string): Promise<void>;
	regenerateMessage(entryId: string): Promise<void>;
	editMessage(entryId: string, text: string): Promise<void>;
	correctMessage(entryId: string, presetId: string, detail?: string): Promise<void>;
	abort(): Promise<void>;
	dismissPresentationMedia(): Promise<void>;
	dismissAmbientMedia(): Promise<void>;
	submitOnboarding(stepId: string, answer?: string): Promise<void>;
	readonly snapshot: SnapshotApi;
	readonly events: EventsApi;
	readonly memory: MemoryApi;
	readonly settings: SettingsApi;
	readonly provider: ProviderApi;
	readonly model: ModelApi;
	readonly embedding: EmbeddingBinding;
	readonly run: RunApi;
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
	const [memoryRevision, setMemoryRevision] = createSignal(0);
	const [memoryKey, setMemoryKey] = createSignal<readonly unknown[]>();
	const [candidateKey, setCandidateKey] = createSignal<readonly unknown[]>();
	const [titleQuery, setTitleQuery] = createSignal("");
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
	const activeRequest = () => invoke(client, () => client.conversation.activeGet({}));
	const activeQuery = createRpcQuery({
		client: queryClient,
		key: queryKeys.activeConversation,
		request: activeRequest,
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
	const routeQuery = createRpcQuery<ModelRouteData | undefined>({
		client: queryClient,
		key: () => queryKeys.modelRoute(activeSession()?.sessionId ?? ""),
		enabled: () => Boolean(activeSession()),
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

	function activeSession(): ConversationSelectResponse | undefined {
		return activeQuery.data?.session;
	}
	const refreshSnapshot = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.snapshot,
			request: snapshotRequest,
		});
	const refreshActive = async () => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.activeConversation,
			request: activeRequest,
		});
	};
	const refreshConversations = async () => {
		await refreshRpcQuery({
			client: queryClient,
			key: [...queryKeys.conversations, titleQuery()],
			request: conversationsRequest,
		});
	};
	const refreshArchived = async () => {
		await refreshRpcQuery({
			client: queryClient,
			key: queryKeys.archivedConversations,
			request: () => invoke(client, () => client.conversation.list({ archived: true })),
		});
	};
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
		const id = activeSession()?.sessionId;
		if (!id) throw new Error("conversation_not_selected");
		return id;
	};
	const refreshMemoryEntries = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.memoryProjection(undefined, undefined, currentCharacterId()),
			request: () =>
				invoke(client, () => client.memory.list({ characterId: currentCharacterId() })),
		});
	const refreshCandidates = () =>
		refreshRpcQuery({
			client: queryClient,
			key: queryKeys.memoryCandidates(undefined, currentCharacterId()),
			request: () =>
				invoke(client, () => client.memory.candidatesList({ characterId: currentCharacterId() })),
		});

	const memory = createMemoryApi({
		client,
		queryClient,
		cacheRevision,
		currentCharacterId,
		activeCharacterId: currentCharacterId,
		memoryProjectionKey: memoryKey,
		setMemoryProjectionKey: setMemoryKey,
		candidateProjectionKey: candidateKey,
		setCandidateProjectionKey: setCandidateKey,
		memoryRevision,
		setMemoryRevision,
		refreshEntries: refreshMemoryEntries,
		refreshCandidates,
		requireActiveConversation: requireConversation,
		onError: fail,
		clearError: () => setOperationError(null),
	});
	const { settingsApi, providerApi, modelApi } = createModelProviderApis({
		client,
		queryClient,
		cacheRevision,
		settings: () => settingsQuery.data,
		providers: () => providersQuery.data?.providers ?? [],
		models: () => poolQuery.data?.models ?? [],
		defaults: () => defaultsQuery.data ?? { vision: { mode: "auto" } },
		currentRoute: () => routeQuery.data,
		activeConversationId: () => activeSession()?.sessionId ?? null,
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
	const runApi = createRunApi({
		client,
		queryClient,
		runsRequest: () => invoke(client, () => client.run.list()),
		activeRuns: () => runsQuery.data?.runs ?? [],
		refreshRuns,
		refreshSnapshot,
		onRefreshError: (cause) => fail("run.refresh", cause),
	});
	const characterApi = createCharacterApi({
		client,
		queryClient,
		cacheRevision,
		currentCharacterId,
		characters: () => charactersQuery.data?.characters ?? [],
		refreshCharacters,
		refreshSnapshot,
		resyncOnboarding: onboarding.resync,
		invalidateConversations: refreshConversations,
		invalidateActiveConversation: refreshActive,
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

	const companionState = () => snapshotQuery.data?.companion;
	const display = () => {
		const id = activeSession()?.sessionId;
		return id ? companionState()?.byConversation[id]?.display : undefined;
	};
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
			return activeSession()?.sessionId ?? null;
		},
		get activePiTimeline() {
			return projectTimeline(activeSession());
		},
		get activePiLiveState() {
			return projectLive(activeSession());
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
		get characterState() {
			const value = companionState();
			return value
				? {
						schema: value.schema,
						byConversation: Object.fromEntries(
							Object.entries(value.byConversation).map(([id, item]) => [id, item.character]),
						),
					}
				: undefined;
		},
		get activePresentationMediaId() {
			return display()?.surfaces.modal ?? display()?.surfaces.inline ?? undefined;
		},
		get activeAmbientMediaId() {
			return display()?.surfaces.ambient ?? undefined;
		},
		get activeChoiceSetId() {
			return display()?.surfaces.choices ?? undefined;
		},
		refresh: () =>
			run("refresh", async () => {
				await Promise.all([
					refreshSnapshot(),
					refreshActive(),
					refreshConversations(),
					refreshRuns(),
				]);
			}),
		searchConversations: async (title) => {
			setTitleQuery(title.trim());
			await refreshConversations();
		},
		selectConversation: (id) =>
			run("conversation.select", async () => {
				await invoke(client, () => client.conversation.select({ id }));
				await Promise.all([refreshActive(), refreshSnapshot()]);
			}),
		createConversation: (title) =>
			run("conversation.create", async () => {
				await invoke(client, () => client.conversation.create({ title }));
				await Promise.all([refreshActive(), refreshConversations(), refreshSnapshot()]);
			}),
		createConversationFromEntry: (entryId) =>
			run("message.branch", async () => {
				await invoke(client, () =>
					client.message.branch({
						conversationId: requireConversation(),
						entryId,
					}),
				);
				await Promise.all([refreshActive(), refreshConversations(), refreshSnapshot()]);
			}),
		renameConversation: (id, title) =>
			run("conversation.rename", async () => {
				await invoke(client, () => client.conversation.rename({ id, title }));
				await refreshConversations();
			}),
		archiveConversation: (id) =>
			run("conversation.archive", async () => {
				await invoke(client, () => client.conversation.archive({ id, archived: true }));
				await Promise.all([
					refreshActive(),
					refreshConversations(),
					refreshArchived(),
					refreshSnapshot(),
				]);
			}),
		restoreConversation: (id) =>
			run("conversation.restore", async () => {
				await invoke(client, () => client.conversation.archive({ id, archived: false }));
				await Promise.all([refreshConversations(), refreshArchived()]);
			}),
		deleteConversation: (id) =>
			run("conversation.delete", async () => {
				await invoke(client, () => client.conversation.delete({ id }));
				await Promise.all([
					refreshActive(),
					refreshConversations(),
					refreshArchived(),
					refreshSnapshot(),
				]);
			}),
		patchCompanionState: (operations) =>
			run("companionState.patch", async () => {
				const id = requireConversation();
				const character = companionState()?.byConversation[id]?.character;
				if (!character) throw new Error("character_state_projection_unavailable");
				await invoke(client, () =>
					client.companionState.patch({
						conversationId: id,
						expectedRevisions: character.revisions,
						operations,
						dedupeKey: crypto.randomUUID(),
					}),
				);
				await refreshSnapshot();
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
		regenerateMessage: (entryId) =>
			run("message.regenerate", async () => {
				await invoke(client, () =>
					client.message.regenerate({
						conversationId: requireConversation(),
						entryId,
					}),
				);
				await refreshActive();
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
				await refreshActive();
			}),
		correctMessage: (entryId, presetId, detail) =>
			run("message.correct", async () => {
				await invoke(client, () =>
					client.message.correct({
						conversationId: requireConversation(),
						entryId,
						presetId,
						detail,
					}),
				);
				await refreshActive();
			}),
		abort: () =>
			run("message.abort", async () => {
				await invoke(client, () => client.message.abort({ conversationId: requireConversation() }));
				await refreshActive();
			}),
		dismissPresentationMedia: () =>
			dismissDisplay(display()?.surfaces.modal ?? display()?.surfaces.inline ?? undefined),
		dismissAmbientMedia: () => dismissDisplay(display()?.surfaces.ambient ?? undefined),
		submitOnboarding: (stepId, answer) =>
			run("onboarding.submit", async () => {
				await onboarding.submit(stepId, answer);
				await Promise.all([
					onboarding.resync(),
					refreshSnapshot(),
					refreshActive(),
					refreshConversations(),
				]);
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
		memory: trackApi("memory", memory, fail),
		settings: trackApi("settings", settingsApi, fail),
		provider: trackApi("provider", providerApi, fail),
		model: trackApi("model", modelApi, fail),
		embedding,
		run: trackApi("run", runApi, fail),
		externalAgent: trackApi("externalAgent", createExternalAgentApi(client), fail),
		characters: trackApi("character", characterApi, fail),
		canon: trackApi("canon", canonApi, fail),
	};
	function dismissDisplay(mediaId?: string) {
		if (!mediaId) return Promise.resolve();
		const current = display();
		const surface = (["ambient", "inline", "modal"] as const).find(
			(candidate) => current?.surfaces[candidate] === mediaId,
		);
		if (!surface) return Promise.resolve();
		return store.patchCompanionState([
			{ op: "replace", path: `/display/surfaces/${surface}`, value: null },
		]);
	}
	return store;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((part) =>
			isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("\n");
}
function projectTimeline(session?: ConversationSelectResponse): PiTimeline | undefined {
	if (!session) return undefined;
	const entries = session.entries.flatMap((raw): PiTimelineEntry[] => {
		if (
			!isRecord(raw) ||
			typeof raw.id !== "string" ||
			typeof raw.timestamp !== "string" ||
			typeof raw.type !== "string"
		)
			return [];
		const base = {
			id: raw.id,
			parentId: typeof raw.parentId === "string" ? raw.parentId : null,
			timestamp: raw.timestamp,
		};
		if (raw.type !== "message" || !isRecord(raw.message) || typeof raw.message.role !== "string")
			return [{ ...base, kind: supportedContextKind(raw.type) }];
		const message = raw.message;
		if (message.role === "user")
			return [
				{
					...base,
					kind: "message",
					role: "user",
					text: textContent(message.content),
				},
			];
		if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			return [
				{
					...base,
					kind: "message",
					role: "assistant",
					text: textContent(content),
					toolCalls: content.flatMap((part) =>
						isRecord(part) &&
						part.type === "toolCall" &&
						typeof part.name === "string" &&
						typeof part.id === "string"
							? [{ toolName: part.name, toolCallId: part.id }]
							: [],
					),
					stopReason: normalizeStop(message.stopReason),
					...(typeof message.errorMessage === "string"
						? { errorMessage: message.errorMessage }
						: {}),
				},
			];
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolName === "string" &&
			typeof message.toolCallId === "string"
		)
			return [
				{
					...base,
					kind: "message",
					role: "tool",
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					status: message.isError ? "failed" : "succeeded",
				},
			];
		return [];
	});
	return { entries, activeLeafId: entries.at(-1)?.id };
}
function supportedContextKind(
	value: string,
):
	| "thinking_level_change"
	| "model_change"
	| "compaction"
	| "branch_summary"
	| "custom"
	| "custom_message"
	| "label"
	| "session_info" {
	return (
		[
			"thinking_level_change",
			"model_change",
			"compaction",
			"branch_summary",
			"custom",
			"custom_message",
			"label",
			"session_info",
		].includes(value)
			? value
			: "custom"
	) as ReturnType<typeof supportedContextKind>;
}
function normalizeStop(
	value: unknown,
): "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred" | undefined {
	return ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(value))
		? (value as ReturnType<typeof normalizeStop>)
		: undefined;
}
function projectLive(session?: ConversationSelectResponse): PiLiveState | undefined {
	if (!session) return undefined;
	const raw = isRecord(session.streamingMessage) ? session.streamingMessage : undefined;
	return {
		isStreaming: session.isStreaming,
		...(raw
			? {
					streamingMessage: {
						text: textContent(raw.content),
						stopReason: session.isStreaming ? "pending" : (normalizeStop(raw.stopReason) ?? "stop"),
						...(typeof raw.errorMessage === "string" ? { errorMessage: raw.errorMessage } : {}),
					},
				}
			: {}),
		queuedUserMessages: [...session.steeringMessages, ...session.followUpMessages],
		...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
	};
}
