import { createCompanionClient, unwrap } from "@bear-harness/companion-client";
import type { IpcEnvelope } from "@bear-harness/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionStore } from "../src/stores/companion.js";
import type { DomainEvent, Snapshot } from "../src/stores/ipc.js";
import { createTestClient, ROLEPLAY_MEDIA_CHARACTER } from "./fixtures.js";

type HostConversationProjection = {
	activeConversationId: string;
	activeBranchId?: string;
	id: string;
	title: string;
	sceneTitle: string;
	piTimeline: { entries: []; activeLeafId?: string };
	piSessionId?: string;
	piLiveState?: {
		isStreaming: boolean;
		streamingMessage?: {
			text?: string;
			stopReason: string;
			errorMessage?: string;
		};
		errorMessage?: string;
	};
};
type TestClient = Parameters<typeof createCompanionStore>[0];
type HostConversationSummary = {
	id: string;
	title: string;
	sceneTitle: string;
	unread: boolean;
	updatedAt: string;
};
function park(): Promise<never> {
	const { promise } = Promise.withResolvers<never>();
	return promise;
}

type HostConversationMutation = { conversation?: HostConversationProjection };
type ConversationApiWithActiveGet = TestClient["conversation"] & {
	activeGet: (request: Record<string, never>) => Promise<IpcEnvelope<HostConversationMutation>>;
};

function conversationApi(client: TestClient): ConversationApiWithActiveGet {
	return client.conversation as unknown as ConversationApiWithActiveGet;
}

function seedActiveConversation(
	client: TestClient,
	projection: HostConversationProjection | undefined,
): void {
	const conversation = conversationApi(client);
	conversation.activeGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: projection === undefined ? {} : { conversation: projection },
		}),
	);
}

function hostProjection(id: string, title = id): HostConversationProjection {
	return {
		activeConversationId: id,
		id,
		title,
		sceneTitle: "",
		piTimeline: { entries: [], activeLeafId: `${id}-leaf` },
	};
}

function conversationSummary(id: string, title = id): HostConversationSummary {
	return {
		id,
		title,
		sceneTitle: "",
		unread: false,
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}
function createStoreWithCleanup(client: ReturnType<typeof createTestClient>["client"]) {
	let dispose = () => undefined;
	let store: ReturnType<typeof createCompanionStore> | undefined;
	createRoot((cleanup) => {
		dispose = cleanup;
		createComponent(QueryClientProvider, {
			client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
			get children() {
				store = createCompanionStore(client);
				return undefined;
			},
		});
	});
	if (!store) throw new Error("store initialization failed");
	return { store, dispose };
}

describe("store RPC contract", () => {
	it("rejects malformed success and failure envelopes before exposing values", () => {
		expect(() => unwrap<{ value: string }>({ ok: true })).toThrow();
		expect(() => unwrap({ ok: false, error: { kind: "internal", reason: 42 } })).toThrow();
		expect(() =>
			unwrap({ ok: false, error: { kind: "unsupported", reason: "bad kind" } }),
		).toThrow();
		expect(unwrap({ ok: true, data: { value: "safe" } })).toEqual({ value: "safe" });
	});

	it("keeps transport rejection separate from resolved RPC failure envelopes", async () => {
		const transportError = new Error("link unavailable");
		const transportInvoke = vi.fn(() => Promise.reject(transportError));
		const transportClient = createCompanionClient({ invoke: transportInvoke });
		await expect(transportClient.snapshot.get()).rejects.toBe(transportError);
		expect(transportInvoke).toHaveBeenCalledTimes(1);

		const rpcInvoke = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "unavailable" as const, reason: "host offline" },
			}),
		);
		const rpcClient = createCompanionClient({ invoke: rpcInvoke });
		const response = await rpcClient.snapshot.get();
		expect(response).toEqual({
			ok: false,
			error: { kind: "unavailable", reason: "host offline" },
		});
		expect(() => unwrap(response)).toThrow("unavailable");
		expect(rpcInvoke).toHaveBeenCalledTimes(1);
	});
	it("does not let a delayed boot snapshot erase a model enabled during startup", async () => {
		const { client } = createTestClient();
		seedActiveConversation(client, hostProjection("conversation-old", "Old"));
		let resolveSnapshot:
			| ((value: Awaited<ReturnType<typeof client.snapshot.get>>) => void)
			| undefined;
		client.snapshot.get = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSnapshot = resolve;
				}),
		);
		const configured = {
			providerId: "relay",
			modelId: "fast",
			label: "Fast",
			supportsImages: false,
			createdAt: "2026-01-01",
		};
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { models: [configured] } }),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					reply: { providerId: "relay", modelId: "fast" },
					vision: { mode: "auto" as const },
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await store.model.enable("relay", "fast", "Fast");
			await store.model.list();
			client.conversation.create = vi.fn(() =>
				Promise.resolve({ ok: true as const, data: hostProjection("conversation-new") }),
			);
			client.model.routeGet = vi.fn(({ conversationId }) =>
				Promise.resolve({
					ok: true as const,
					data: {
						conversationId,
						selected: { providerId: "relay", modelId: "fast" },
					},
				}),
			);
			await store.createConversation("New conversation");
			await waitFor(() =>
				expect(store.model.data().defaults.reply).toEqual({
					providerId: "relay",
					modelId: "fast",
				}),
			);
			resolveSnapshot?.({
				ok: true,
				data: {
					eventSeq: 1,
					conversation: {
						activeConversationId: "conversation-old",
						piTimeline: {
							entries: [
								{
									id: "old-message",
									parentId: null,
									timestamp: "2026-01-01T00:00:00.000Z",
									kind: "message",
									role: "user",
									text: "stale conversation body",
								},
							],
						},
					},
					model: { pool: { models: [] }, defaults: { vision: { mode: "auto" } } },
				},
			});
			await waitFor(() => expect(store.snapshot.eventSeq()).toBe(1));
			expect(store.activeConversationId).toBe("conversation-new");
			expect(store.activePiTimeline).toEqual({
				entries: [],
				activeLeafId: "conversation-new-leaf",
			});
			expect(store.model.models()).toEqual([configured]);
			expect(store.model.data().defaults.reply).toEqual({
				providerId: "relay",
				modelId: "fast",
			});
		} finally {
			dispose();
		}
	});
	it("keeps a Host-created active Pi projection over delayed pre-mutation responses", async () => {
		const { client } = createTestClient();
		const staleSnapshot = Promise.withResolvers<IpcEnvelope<Snapshot>>();
		const staleList =
			Promise.withResolvers<IpcEnvelope<{ conversations: HostConversationSummary[] }>>();
		client.snapshot.get = vi.fn(() => staleSnapshot.promise);
		client.conversation.list = vi.fn(() => staleList.promise);
		const conversation = conversationApi(client);
		conversation.activeGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { conversation: hostProjection("conversation-before-mutation") },
			}),
		);
		const created = hostProjection("conversation-created", "Created");
		client.conversation.create = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: created } as never),
		);
		client.conversation.select = vi.fn(() => {
			throw new Error("create must not issue a separate select RPC");
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(client.snapshot.get).toHaveBeenCalled());
			const create = store.createConversation("Created");
			await waitFor(() =>
				expect(client.conversation.create).toHaveBeenCalledWith({ title: "Created" }),
			);
			await waitFor(() => expect(store.activeConversationId).toBe(created.activeConversationId));
			staleSnapshot.resolve({
				ok: true,
				data: {
					eventSeq: 7,
					conversation: {
						activeConversationId: "conversation-before-mutation",
						piTimeline: { entries: [], activeLeafId: "stale-leaf" },
					},
				},
			});
			staleList.resolve({
				ok: true,
				data: { conversations: [conversationSummary("conversation-before-mutation")] },
			});
			await create;
			expect(client.conversation.select).not.toHaveBeenCalled();
			expect(store.activeConversationId).toBe(created.activeConversationId);
			expect(store.activePiTimeline).toEqual(created.piTimeline);
		} finally {
			dispose();
		}
	});

	it("renders the Host-selected replacement projection when archiving the active conversation", async () => {
		const { client } = createTestClient();
		const first = hostProjection("conversation-first", "First");
		const replacement = hostProjection("conversation-second", "Second");
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					conversation: {
						activeConversationId: first.activeConversationId,
						piTimeline: first.piTimeline,
					},
				},
			}),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversations: [
						conversationSummary(first.id, first.title),
						conversationSummary(replacement.id, replacement.title),
					],
				},
			}),
		);
		const conversation = conversationApi(client);
		conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversation: first } }),
		);
		client.conversation.select = vi.fn(() => {
			throw new Error("archive must use the Host mutation projection");
		});
		client.conversation.archive = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversation: replacement } } as never),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe(first.id));
			await store.archiveConversation(first.id);
			expect(client.conversation.archive).toHaveBeenCalledWith({ id: first.id, archived: true });
			expect(client.conversation.select).not.toHaveBeenCalled();
			expect(store.activeConversationId).toBe(replacement.activeConversationId);
			expect(store.activePiTimeline).toEqual(replacement.piTimeline);
		} finally {
			dispose();
		}
	});

	it("renders no active conversation when archiving the last conversation", async () => {
		const { client } = createTestClient();
		const last = hostProjection("conversation-last", "Last");
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					conversation: {
						activeConversationId: last.activeConversationId,
						piTimeline: last.piTimeline,
					},
				},
			}),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { conversations: [conversationSummary(last.id, last.title)] },
			}),
		);
		const conversation = conversationApi(client);
		conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversation: last } }),
		);
		client.conversation.archive = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: {} } as never),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe(last.id));
			await store.archiveConversation(last.id);
			expect(store.activeConversationId).toBeNull();
			expect(store.activePiTimeline).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("refetches list and Host-owned active projection for external conversation lifecycle events", async () => {
		const { client } = createTestClient();
		const first = hostProjection("conversation-one", "One");
		const renamed = hostProjection("conversation-one", "Renamed");
		const replacement = hostProjection("conversation-two", "Two");
		const created = conversationSummary("conversation-three", "Three");
		const firstSummary = conversationSummary(first.id, first.title);
		const lists: HostConversationSummary[][] = [
			[firstSummary, conversationSummary(replacement.id, replacement.title)],
			[
				conversationSummary(renamed.id, renamed.title),
				conversationSummary(replacement.id, replacement.title),
			],
			[conversationSummary(replacement.id, replacement.title)],
			[],
			[created],
		];
		let listVersion = 0;
		const bootSnapshot = Promise.withResolvers<IpcEnvelope<Snapshot>>();
		let activeProjection: HostConversationProjection | undefined = first;
		client.snapshot.get = vi.fn(() => bootSnapshot.promise);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { conversations: lists[listVersion] ?? [] },
			}),
		);
		const conversation = conversationApi(client);
		conversation.activeGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { conversation: activeProjection },
			}),
		);
		const eventGates = [
			Promise.withResolvers<IpcEnvelope<{ events: DomainEvent[] }>>(),
			Promise.withResolvers<IpcEnvelope<{ events: DomainEvent[] }>>(),
			Promise.withResolvers<IpcEnvelope<{ events: DomainEvent[] }>>(),
			Promise.withResolvers<IpcEnvelope<{ events: DomainEvent[] }>>(),
		];
		const events = [
			{
				seq: 1,
				kind: "conversation.renamed",
				payload: { conversationId: first.id, title: renamed.title },
			},
			{
				seq: 2,
				kind: "conversation.archived",
				payload: { conversationId: first.id, archived: true },
			},
			{
				seq: 3,
				kind: "conversation.deleted",
				payload: { conversationId: replacement.id },
			},
			{
				seq: 4,
				kind: "conversation.created",
				payload: { conversationId: created.id },
			},
		] as unknown as DomainEvent[];
		client.events.subscribe = vi.fn(({ afterSeq }: { afterSeq: number }) => {
			const gate = eventGates[afterSeq];
			return gate?.promise ?? new Promise<never>(() => undefined);
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe(first.id));
			bootSnapshot.resolve({
				ok: true,
				data: {
					eventSeq: 0,
					conversation: {
						activeConversationId: first.activeConversationId,
						piTimeline: first.piTimeline,
					},
				},
			});
			await waitFor(() => expect(client.events.subscribe).toHaveBeenCalledWith({ afterSeq: 0 }));

			const renamedListCalls = client.conversation.list.mock.calls.length;
			const renamedActiveCalls = conversation.activeGet.mock.calls.length;
			listVersion = 1;
			activeProjection = renamed;
			eventGates[0]?.resolve({ ok: true, data: { events: [events[0]!] } });
			await waitFor(() =>
				expect(client.conversation.list.mock.calls.length).toBeGreaterThan(renamedListCalls),
			);
			await waitFor(() =>
				expect(conversation.activeGet.mock.calls.length).toBeGreaterThan(renamedActiveCalls),
			);
			expect(store.conversations).toEqual(lists[1]);

			await waitFor(() => expect(client.events.subscribe).toHaveBeenCalledWith({ afterSeq: 1 }));
			const archivedListCalls = client.conversation.list.mock.calls.length;
			const archivedActiveCalls = conversation.activeGet.mock.calls.length;
			listVersion = 2;
			activeProjection = replacement;
			eventGates[1]?.resolve({ ok: true, data: { events: [events[1]!] } });
			await waitFor(() =>
				expect(client.conversation.list.mock.calls.length).toBeGreaterThan(archivedListCalls),
			);
			await waitFor(() =>
				expect(conversation.activeGet.mock.calls.length).toBeGreaterThan(archivedActiveCalls),
			);
			await waitFor(() => expect(store.activeConversationId).toBe(replacement.id));
			expect(store.activePiTimeline).toEqual(replacement.piTimeline);

			await waitFor(() => expect(client.events.subscribe).toHaveBeenCalledWith({ afterSeq: 2 }));
			const deletedListCalls = client.conversation.list.mock.calls.length;
			const deletedActiveCalls = conversation.activeGet.mock.calls.length;
			listVersion = 3;
			activeProjection = undefined;
			eventGates[2]?.resolve({ ok: true, data: { events: [events[2]!] } });
			await waitFor(() =>
				expect(client.conversation.list.mock.calls.length).toBeGreaterThan(deletedListCalls),
			);
			await waitFor(() =>
				expect(conversation.activeGet.mock.calls.length).toBeGreaterThan(deletedActiveCalls),
			);
			await waitFor(() => expect(store.activeConversationId).toBeNull());
			expect(store.activePiTimeline).toBeUndefined();

			await waitFor(() => expect(client.events.subscribe).toHaveBeenCalledWith({ afterSeq: 3 }));
			const createdListCalls = client.conversation.list.mock.calls.length;
			const createdActiveCalls = conversation.activeGet.mock.calls.length;
			listVersion = 4;
			eventGates[3]?.resolve({ ok: true, data: { events: [events[3]!] } });
			await waitFor(() =>
				expect(client.conversation.list.mock.calls.length).toBeGreaterThan(createdListCalls),
			);
			expect(store.conversations).toEqual(lists[4]);
			expect(store.activeConversationId).toBeNull();
			expect(conversation.activeGet.mock.calls.length).toBe(createdActiveCalls);
		} finally {
			dispose();
		}
	});
	it("does not let a delayed boot snapshot overwrite a scoped memory projection", async () => {
		const { client } = createTestClient();
		const snapshotGate = Promise.withResolvers<IpcEnvelope<Snapshot>>();
		const scopedMemoryGate =
			Promise.withResolvers<Awaited<ReturnType<typeof client.memory.list>>>();
		client.snapshot.get = vi.fn(() => snapshotGate.promise);
		const projectedEntry = {
			id: "memory-direct",
			kind: "fact" as const,
			scope: "self" as const,
			text: "direct memory result",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			importance: 0.9,
		};
		const olderEntry = { ...projectedEntry, id: "memory-older", text: "older boot snapshot" };
		client.memory.list = vi.fn(() => scopedMemoryGate.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			snapshotGate.resolve({
				ok: true,
				data: {
					eventSeq: 1,
					memory: { entries: [olderEntry] },
				},
			});

			const scopedList = store.memory.list({ scope: "self" });
			scopedMemoryGate.resolve({ ok: true, data: { entries: [projectedEntry] } });
			await expect(scopedList).resolves.toEqual([projectedEntry]);
			expect(store.memory.entries()).toEqual([projectedEntry]);
		} finally {
			dispose();
		}
	});
	it("keeps direct memory and candidate projections when a later snapshot resolves last", async () => {
		const { client } = createTestClient();
		let snapshotCalls = 0;
		const delayedSnapshot = Promise.withResolvers<IpcEnvelope<Snapshot>>();
		client.snapshot.get = vi.fn(() => {
			snapshotCalls += 1;
			return snapshotCalls === 1
				? Promise.resolve({ ok: true as const, data: { eventSeq: 0 } })
				: delayedSnapshot.promise;
		});
		const directEntry = {
			id: "memory-direct",
			kind: "fact" as const,
			scope: "self" as const,
			text: "direct memory result",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			importance: 0.9,
		};
		const olderEntry = { ...directEntry, id: "memory-older", text: "older snapshot result" };
		const directCandidate = {
			id: "candidate-direct",
			kind: "fact" as const,
			sourceKind: "user_request" as const,
			normalizedText: "direct candidate result",
			why: "test",
			suggestedScope: "self" as const,
			status: "pending" as const,
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		const entriesGate = Promise.withResolvers<Awaited<ReturnType<typeof client.memory.list>>>();
		const candidatesGate =
			Promise.withResolvers<Awaited<ReturnType<typeof client.memory.candidatesList>>>();
		let candidateCalls = 0;
		client.memory.list = vi.fn((params) =>
			params?.scope === "self"
				? entriesGate.promise
				: Promise.resolve({ ok: true as const, data: { entries: [] } }),
		);
		client.memory.candidatesList = vi.fn(() => {
			candidateCalls += 1;
			return candidateCalls === 1
				? Promise.resolve({ ok: true as const, data: { candidates: [] } })
				: candidatesGate.promise;
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => {
				expect(client.memory.list).toHaveBeenCalledTimes(1);
				expect(candidateCalls).toBe(1);
			});
			const directEntries = store.memory.list({ scope: "self" });
			const directCandidates = store.memory.listCandidates("pending");
			store.snapshot.refetch();
			await waitFor(() => expect(snapshotCalls).toBe(2));

			entriesGate.resolve({ ok: true, data: { entries: [directEntry] } });
			candidatesGate.resolve({ ok: true, data: { candidates: [directCandidate] } });
			await expect(directEntries).resolves.toEqual([directEntry]);
			await expect(directCandidates).resolves.toEqual([directCandidate]);
			expect(store.memory.entries()).toEqual([directEntry]);
			expect(store.memory.candidates()).toEqual([directCandidate]);

			delayedSnapshot.resolve({
				ok: true,
				data: { eventSeq: 1, memory: { entries: [olderEntry] } },
			});
			await waitFor(() => expect(store.snapshot.eventSeq()).toBe(1));
			expect(store.memory.entries()).toEqual([directEntry]);
			expect(store.memory.candidates()).toEqual([directCandidate]);
		} finally {
			dispose();
		}
	});
	it("does not let a stale debounced mutation refresh overwrite a newer scoped memory search", async () => {
		vi.useFakeTimers();
		try {
			const { client } = createTestClient();
			const snapshotGate = Promise.withResolvers<IpcEnvelope<Snapshot>>();
			const staleRefreshGate =
				Promise.withResolvers<Awaited<ReturnType<typeof client.memory.list>>>();
			const scopedSearchGate =
				Promise.withResolvers<Awaited<ReturnType<typeof client.memory.search>>>();
			const staleEntry = {
				id: "memory-stale-refresh",
				kind: "fact" as const,
				scope: "self" as const,
				text: "stale mutation refresh",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				importance: 0.2,
			};
			const scopedEntry = {
				...staleEntry,
				id: "memory-scoped-search",
				scope: "relationship" as const,
				text: "newer scoped search",
				importance: 0.9,
			};
			client.snapshot.get = vi.fn(() => snapshotGate.promise);
			client.memory.list = vi.fn(() => staleRefreshGate.promise);
			client.memory.search = vi.fn(() => scopedSearchGate.promise);
			client.memory.edit = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
			const { store, dispose } = createStoreWithCleanup(client);
			try {
				await store.memory.edit("memory-stale-refresh", "updated text");
				await vi.advanceTimersByTimeAsync(249);
				expect(client.memory.list).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
				expect(client.memory.list).toHaveBeenCalledTimes(1);

				const scopedSearch = store.memory.search("newer", "relationship");
				scopedSearchGate.resolve({ ok: true, data: { entries: [scopedEntry] } });
				await expect(scopedSearch).resolves.toEqual([scopedEntry]);
				expect(store.memory.entries()).toEqual([scopedEntry]);

				staleRefreshGate.resolve({ ok: true, data: { entries: [staleEntry] } });
				await staleRefreshGate.promise;
				await Promise.resolve();
				await Promise.resolve();
				expect(store.memory.entries()).toEqual([scopedEntry]);

				snapshotGate.resolve({ ok: true, data: { eventSeq: 2 } });
			} finally {
				dispose();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps scoped routes and loads the Host-applied default after creating a conversation", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 1,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
					model: {
						pool: {
							models: [
								{
									providerId: "relay",
									modelId: "fast",
									label: "Fast",
									supportsImages: false,
									createdAt: "2026-01-01",
								},
							],
						},
						defaults: { vision: { mode: "auto" } },
						route: {
							conversationId: "conversation-1",
							selected: { providerId: "relay", modelId: "fast" },
						},
					},
				},
			}),
		);
		seedActiveConversation(client, hostProjection("conversation-1"));
		client.model.routeGet = vi.fn(({ conversationId }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversationId,
					selected:
						conversationId === "conversation-2"
							? { providerId: "e2e-rule", modelId: "rule-model" }
							: { providerId: "relay", modelId: "fast" },
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() =>
				expect(store.model.data().selected).toEqual({ providerId: "relay", modelId: "fast" }),
			);
			await store.model.list();
			expect(store.model.data().selected).toEqual({ providerId: "relay", modelId: "fast" });
			client.conversation.create = vi.fn(() =>
				Promise.resolve({
					ok: true as const,
					data: hostProjection("conversation-2", "New conversation"),
				}),
			);
			await store.createConversation("New conversation");
			expect(store.model.data().selected).toEqual({
				providerId: "e2e-rule",
				modelId: "rule-model",
			});
			expect(client.model.routeGet).toHaveBeenCalledWith({ conversationId: "conversation-2" });
		} finally {
			dispose();
		}
	});

	it("invalidates and projects a refreshed provider list through its query key", async () => {
		const { client } = createTestClient();
		const provider = {
			id: "relay",
			name: "Relay",
			source: "builtin" as const,
			added: true,
			authType: "api_key" as const,
			credentialStatus: "stored" as const,
			availableModels: [],
			unavailable: [],
		};
		client.provider.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { providers: [provider] } }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await store.provider.list();
			await waitFor(() => expect(store.provider.providers()).toEqual([provider]));
		} finally {
			dispose();
		}
	});
	it("constructs under a QueryClientProvider and projects scoped memory lists", async () => {
		const { client } = createTestClient();
		const entry = {
			id: "memory-relationship",
			kind: "fact",
			scope: "relationship" as const,
			text: "我们会一起散步",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			importance: 0.8,
		};
		client.memory.list = vi.fn((params) =>
			Promise.resolve({
				ok: true as const,
				data: { entries: params?.scope === "relationship" ? [entry] : [] },
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await expect(store.memory.list({ scope: "relationship" })).resolves.toEqual([entry]);
			expect(client.memory.list).toHaveBeenCalledWith({ scope: "relationship" });
			expect(store.memory.entries()).toEqual([entry]);
		} finally {
			dispose();
		}
	});

	it("routes the complete settings, memory, provider, canon, and work surface", async () => {
		const { client } = createTestClient();
		seedActiveConversation(client, hostProjection("conversation-1"));
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 1,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [],
						piTimeline: { entries: [] },
					},
				},
			}),
		);
		const runResult = {
			id: "run-1",
			conversationId: "conversation-1",
			triggerEntryId: "entry-1",
			executorProfile: "pi-default",
			title: "Direct run",
			status: "running" as const,
		};
		client.run.cancel = vi.fn(() => Promise.resolve({ ok: true as const, data: runResult }));
		client.run.interrupt = vi.fn(() => Promise.resolve({ ok: true as const, data: runResult }));
		client.run.resume = vi.fn(() => Promise.resolve({ ok: true as const, data: runResult }));
		client.run.respondPermission = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: runResult }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-1"));

			await store.settings.get();
			await store.settings.set({
				relationshipMemoryEnabled: true,
			});
			await store.memory.capture("entry-1");
			await store.memory.search("query", "relationship");
			await store.memory.list({ scope: "relationship" });
			await store.memory.edit("memory-1", "new memory");
			await store.memory.forget("memory-1");
			await store.memory.exclude("memory-1", true);
			await store.memory.listCandidates();
			await store.memory.listCandidates("pending");
			await store.memory.approveCandidate("candidate-1", "edited", "scene");
			await store.memory.rejectCandidate("candidate-1");

			await store.provider.list();
			await store.provider.customUpsert({
				providerId: "relay",
				name: "Relay",
				baseUrl: "https://relay.example/v1",
				models: [{ id: "model" }],
				apiKey: "key",
			});
			await store.provider.overrideBaseUrl({
				providerId: "relay",
				baseUrl: "https://override.example/v1",
			});
			await store.provider.setApiKey("relay", "key");
			await store.provider.login("oauth-provider");
			await store.provider.loginStatus("oauth-provider");
			await store.provider.loginAnswer("oauth-provider", "answer");
			await store.provider.loginCancel("oauth-provider");
			await store.provider.logout("oauth-provider");

			await store.model.list("conversation-1");
			await store.model.enable("relay", "model", "Relay model");
			await store.model.select("conversation-1", "relay", "model");
			await store.model.disable("relay", "model");
			await store.characters.list();
			await store.characters.activate("role-2");

			await store.canon.listSources();
			await store.canon.addSource("source.txt", "source text");
			await store.canon.search("canon query");
			await store.canon.removeSource("source-1");
			await store.canon.listModules();
			await store.canon.upsertModule({
				kind: "root",
				title: "Recall",
				instructions: "Recall canon",
				sourceChunkIds: ["chunk-1"],
			});
			await store.canon.deleteModule("module-1");

			await store.run.list();
			await store.run.steer("run-1", "continue carefully");
			await store.run.interrupt("run-1");
			await store.run.resume("run-1");
			await store.run.cancel("run-1");
			await store.run.respondPermission("run-1", "permission-1", "allow");

			expect(client.settings.set).toHaveBeenCalled();
			expect(client.memory.capture).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "entry-1",
			});
			expect(client.memory.search).toHaveBeenCalledWith({
				query: "query",
				scope: "relationship",
			});
			expect(client.memory.list).toHaveBeenCalledWith({ scope: "relationship" });
			expect(client.memory.forget).toHaveBeenCalledWith({ entryId: "memory-1" });
			expect(client.memory.edit).toHaveBeenCalledWith({
				entryId: "memory-1",
				newText: "new memory",
			});
			expect(client.memory.exclude).toHaveBeenCalledWith({ memoryId: "memory-1", excluded: true });
			expect(client.memory.candidatesList).toHaveBeenCalledWith({ status: "pending" });
			expect(client.memory.candidateApprove).toHaveBeenCalledWith({
				candidateId: "candidate-1",
				editedText: "edited",
				decidedScope: "scene",
			});
			expect(client.memory.candidateReject).toHaveBeenCalledWith({ candidateId: "candidate-1" });
			expect(client.provider.overrideBaseUrl).toHaveBeenCalledWith({
				providerId: "relay",
				baseUrl: "https://override.example/v1",
			});
			expect(client.canon.upsertModule).toHaveBeenCalled();
			expect(client.run.interrupt).toHaveBeenCalledWith({ runId: "run-1" });
			expect(client.run.resume).toHaveBeenCalledWith({ runId: "run-1" });
		} finally {
			dispose();
		}
	});

	it("merges domain events and invalidates every affected projection", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
				},
			}),
		);
		seedActiveConversation(client, hostProjection("conversation-1"));
		client.model.routeGet = vi.fn(({ conversationId }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversationId,
					selected: { providerId: "e2e-rule", modelId: "rule-model" },
				},
			}),
		);
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription > 1) return new Promise<never>(() => undefined);
			const kinds = [
				[
					"character.scene_changed",
					{
						conversationId: "conversation-2",
						characterId: "character-1",
						sceneId: "room",
						visualState: "thinking",
					},
				],
				["conversation.created", { conversationId: "conversation-2" }],
				[
					"conversation.branched",
					{ conversationId: "conversation-2", messageId: "message-1", branchId: "branch-2" },
				],
				["companion.state_changed", { state: "running" }],
				[
					"run.needs_user",
					{
						runId: "run-1",
						requestId: "permission-1",
						prompt: "Allow?",
						options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
					},
				],
				["memory.changed", {}],
				["provider.changed", {}],
				["model.changed", {}],
				["character.changed", {}],
				["settings.changed", {}],
				["diagnostics.updated", {}],
			] as const;
			return Promise.resolve({
				ok: true as const,
				data: {
					events: kinds.map(([kind, payload], index) => ({ seq: index + 1, kind, payload })),
				},
			});
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-1"));
			await waitFor(() => expect(client.conversation.list).toHaveBeenCalled());
			expect(store.activeConversationId).toBe("conversation-1");
			expect(client.model.routeGet).not.toHaveBeenCalledWith({ conversationId: "conversation-2" });
			expect(store.characterRuntimeByConversation["conversation-2"]).toEqual({
				sceneId: "room",
				visualState: "thinking",
			});
			expect(store.run.pendingPermissions()).toEqual([
				expect.objectContaining({ runId: "run-1", requestId: "permission-1" }),
			]);
			await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
			await waitFor(() => expect(client.model.poolGet).toHaveBeenCalled());
			await waitFor(() => expect(client.memory.list).toHaveBeenCalled());
			await waitFor(() => expect(client.character.list).toHaveBeenCalled());
		} finally {
			dispose();
		}
	});
	it("projects payloads using each event kind's typed contract", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
				},
			}),
		);
		seedActiveConversation(client, hostProjection("conversation-1"));
		const conversation = conversationApi(client);
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription > 1) return new Promise<never>(() => undefined);
			return Promise.resolve({
				ok: true as const,
				data: {
					events: [
						{
							seq: 1,
							kind: "companion.tool_started" as const,
							payload: {
								conversationId: "conversation-1",
								toolCallId: "tool-1",
								tool: "search",
								label: "Search",
							},
						},
						{
							seq: 2,
							kind: "companion.tool_finished" as const,
							payload: {
								conversationId: "conversation-1",
								toolCallId: "tool-1",
								ok: false,
								message: "failed",
							},
						},
						{
							seq: 3,
							kind: "pi.session.changed" as const,
							payload: {
								conversationId: "conversation-1",
								sessionId: "session-1",
								reason: "message",
							},
						},
						{
							seq: 4,
							kind: "roleplay.choices_presented" as const,
							payload: { conversationId: "conversation-1", choiceSetId: "choices-1" },
						},
						{
							seq: 5,
							kind: "character.visual_state_changed" as const,
							payload: {
								conversationId: "conversation-1",
								characterId: "character-1",
								sceneId: "room",
								visualState: "thinking",
							},
						},
					],
				},
			});
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.events.lastSeq()).toBe(5));
			// pi.session.changed triggers a scoped projection refresh; it never
			// carries message text into the store.
			await waitFor(() => expect(conversation.activeGet.mock.calls.length).toBeGreaterThan(1));
			expect(store.activeRoleplayChoiceSetId).toBe("choices-1");
			expect(store.characterRuntimeByConversation["conversation-1"]).toEqual({
				sceneId: "room",
				visualState: "thinking",
			});
		} finally {
			dispose();
		}
	});
	it("projects the Pi live state and native session id from the active projection", async () => {
		const { client } = createTestClient();
		const entries = [
			{
				id: "pi:user-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				kind: "message" as const,
				role: "user" as const,
				text: "hello",
			},
		];
		seedActiveConversation(client, {
			...hostProjection("conversation-1"),
			piSessionId: "session-1",
			piLiveState: {
				isStreaming: true,
				streamingMessage: { text: "hi", stopReason: "pending" },
			},
			piTimeline: { entries: entries as never, activeLeafId: "conversation-1-leaf" },
		});
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() =>
				expect(store.activePiLiveState).toEqual({
					isStreaming: true,
					streamingMessage: { text: "hi", stopReason: "pending" },
				}),
			);
			expect(store.activePiTimeline).toEqual({
				entries: entries as never,
				activeLeafId: "conversation-1-leaf",
			});
		} finally {
			dispose();
		}
	});
	it("keeps the current page when a late pi.session.changed targets a stale session", async () => {
		const { client } = createTestClient();
		const a: HostConversationProjection = {
			...hostProjection("conversation-a", "A"),
			piSessionId: "session-a",
			piLiveState: {
				isStreaming: true,
				streamingMessage: { text: "hi", stopReason: "pending" },
			},
		};
		const b: HostConversationProjection = {
			...hostProjection("conversation-b", "B"),
			piSessionId: "session-b",
			piLiveState: { isStreaming: false },
		};
		const conversation = conversationApi(client);
		conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversation: a } }),
		);
		client.conversation.select = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: b as never }),
		);
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					conversation: { activeConversationId: "conversation-a", piTimeline: { entries: [] } },
				},
			}),
		);
		const eventGate = Promise.withResolvers<IpcEnvelope<{ events: DomainEvent[] }>>();
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription === 1) return eventGate.promise;
			return park();
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-a"));
			// Switch to B; the Host mutation response owns the active projection.
			await store.selectConversation("conversation-b");
			await waitFor(() => expect(store.activeConversationId).toBe("conversation-b"));
			const activeCallsAfterSelect = conversation.activeGet.mock.calls.length;
			// A stale Pi notification for A must not read or overwrite B's active
			// projection. It may be ignored because no scoped A projection exists.
			eventGate.resolve({
				ok: true,
				data: {
					events: [
						{
							seq: 1,
							kind: "pi.session.changed" as const,
							payload: {
								conversationId: "conversation-a",
								sessionId: "session-a",
								reason: "message" as const,
							},
						},
					],
				},
			});
			await Promise.resolve();
			expect(conversation.activeGet.mock.calls).toHaveLength(activeCallsAfterSelect);
			expect(store.activeConversationId).toBe("conversation-b");
			expect(store.activePiTimeline).toEqual(b.piTimeline);
			expect(store.activePiLiveState?.isStreaming).toBe(false);
		} finally {
			dispose();
		}
	});
	it("restarts the event replay with a fresh snapshot after a subscribe failure", async () => {
		const { client } = createTestClient();
		let snapshotCalls = 0;
		client.snapshot.get = vi.fn(() => {
			snapshotCalls += 1;
			return Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: snapshotCalls === 1 ? 0 : 2,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
				},
			});
		});
		const conversation = conversationApi(client);
		let projection: HostConversationProjection = {
			...hostProjection("conversation-1"),
			piSessionId: "session-1",
			piLiveState: { isStreaming: false },
		};
		conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversation: projection } }),
		);
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription === 1) return Promise.reject(new Error("link down"));
			if (subscription === 2) {
				projection = {
					...projection,
					piLiveState: {
						isStreaming: true,
						streamingMessage: { text: "hi", stopReason: "pending" as const },
					},
				};
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{
								seq: 3,
								kind: "pi.session.changed" as const,
								payload: {
									conversationId: "conversation-1",
									sessionId: "session-1",
									reason: "message" as const,
								},
							},
						],
					},
				});
			}
			return park();
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			// The failed subscription is recovered: the store re-reads the
			// active projection, resyncs the snapshot cursor (eventSeq 2), and
			// restarts from it; the seq-3 notification is then applied normally.
			await waitFor(() => expect(store.activePiLiveState?.isStreaming).toBe(true));
			expect(snapshotCalls).toBeGreaterThanOrEqual(2);
		} finally {
			dispose();
		}
	});

	it("resyncs instead of applying an event after an omitted malformed row", async () => {
		const { client } = createTestClient();
		let snapshotCalls = 0;
		client.snapshot.get = vi.fn(() => {
			snapshotCalls += 1;
			return Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: snapshotCalls === 1 ? 0 : 3,
				},
			});
		});
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription > 1) return new Promise<never>(() => undefined);
			return Promise.resolve({
				ok: true as const,
				data: {
					// The malformed seq=2 row was omitted. Seq=3 must not be
					// treated as contiguous with seq=1.
					events: [
						{
							seq: 1,
							kind: "run.needs_user" as const,
							payload: {
								runId: "run-1",
								requestId: "request-1",
								prompt: "Allow?",
								options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
							},
						},
						{ seq: 3, kind: "run.resumed" as const, payload: { runId: "run-1" } },
					],
				},
			});
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(snapshotCalls).toBe(2));
			expect(store.run.pendingPermissions()).toEqual([
				expect.objectContaining({ runId: "run-1", requestId: "request-1" }),
			]);
		} finally {
			dispose();
		}
	});

	it("keeps declared ambient and regular roleplay media independent", async () => {
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					character: ROLEPLAY_MEDIA_CHARACTER,
					conversation: { activeConversationId: "conversation-1", piTimeline: { entries: [] } },
				},
			}),
		);
		seedActiveConversation(client, hostProjection("conversation-1"));
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription > 1) return new Promise<never>(() => undefined);
			return Promise.resolve({
				ok: true as const,
				data: {
					events: [
						{
							seq: 1,
							kind: "roleplay.media_presented" as const,
							payload: { conversationId: "conversation-1", mediaId: "dialog-image" },
						},
						{
							seq: 2,
							kind: "roleplay.media_presented" as const,
							payload: { conversationId: "conversation-1", mediaId: "ambient-audio" },
						},
						{
							seq: 3,
							kind: "roleplay.media_presented" as const,
							payload: { conversationId: "conversation-1", mediaId: "inline-image" },
						},
						{
							seq: 4,
							kind: "roleplay.media_presented" as const,
							payload: { conversationId: "conversation-1", mediaId: "missing" },
						},
						{
							seq: 5,
							kind: "roleplay.media_dismissed" as const,
							payload: { conversationId: "conversation-1", mediaId: "dialog-image" },
						},
						{
							seq: 6,
							kind: "roleplay.media_dismissed" as const,
							payload: { conversationId: "conversation-1", mediaId: "ambient-audio" },
						},
						{
							seq: 7,
							kind: "roleplay.media_presented" as const,
							payload: { conversationId: "conversation-1", mediaId: "ambient-audio" },
						},
						{
							seq: 8,
							kind: "roleplay.media_presented" as const,
							payload: { conversationId: "conversation-1", mediaId: "missing" },
						},
					],
				},
			});
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => {
				expect(store.events.lastSeq()).toBe(8);
				expect(store.activeRoleplayMediaId).toBe("inline-image");
				expect(store.activeAmbientMediaId).toBe("ambient-audio");
			});

			const dismissMedia = vi.mocked(client.roleplay.dismissMedia);
			dismissMedia.mockResolvedValueOnce({
				ok: false as const,
				error: { kind: "conflict" as const, reason: "media_not_active" },
			});
			await store.dismissRoleplayMedia();
			expect(store.activeRoleplayMediaId).toBe("inline-image");
			expect(store.activeAmbientMediaId).toBe("ambient-audio");

			dismissMedia.mockResolvedValueOnce({ ok: true as const, data: {} });
			await store.dismissRoleplayMedia();
			expect(store.activeRoleplayMediaId).toBeUndefined();
			expect(store.activeAmbientMediaId).toBe("ambient-audio");

			dismissMedia.mockResolvedValueOnce({ ok: true as const, data: {} });
			await store.dismissAmbientMedia();
			expect(store.activeRoleplayMediaId).toBeUndefined();
			expect(store.activeAmbientMediaId).toBeUndefined();
		} finally {
			dispose();
		}
	});
});
