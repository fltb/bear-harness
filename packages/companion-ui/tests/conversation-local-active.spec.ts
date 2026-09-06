import type { CompanionClient } from "@bear-harness/companion-client";
import type {
	ConversationActiveResponse,
	ConversationDetail,
	ConversationSummary,
	LivePush,
	PiSessionEntry,
	RpcEnvelope,
	RunListResponse,
	SnapshotResponse,
} from "@bear-harness/protocol";
import { LivePush as LivePushSchema } from "@bear-harness/protocol/schema";
import { isCancelledError, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { type CompanionStore, createCompanionStore } from "../src/stores/companion.js";
import { createTestClient, pushPiEvent, THEMED_CHARACTER } from "./fixtures.js";

const summary = (conversationId: string): ConversationSummary => ({
	conversationId,
	name: `Conversation ${conversationId}`,
	created: "2026-01-01T00:00:00.000Z",
	modified: "2026-01-01T00:00:00.000Z",
	messageCount: 0,
	firstMessage: "",
	isStreaming: false,
});

const detail = (conversationId: string, entries: PiSessionEntry[] = []): ConversationDetail => ({
	conversationId,
	name: `Conversation ${conversationId}`,
	branch: {
		entries,
		hasMoreBefore: false,
		activeLeafId: entries.at(-1)?.id,
		latestLeafIds: entries.length ? [entries[entries.length - 1]!.id] : [],
	},
	live: {
		isStreaming: false,
		isRetrying: false,
		retryAttempt: 0,
		isCompacting: false,
		pendingToolCallIds: [],
		steering: [],
		followUp: [],
	},
});

const userEntry = (id: string, text: string) =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	}) satisfies PiSessionEntry;

const assistantEntry = (id: string, text: string) =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "relay",
			model: "model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
			responseId: "response-1",
		},
	}) satisfies PiSessionEntry;

const streamingAssistant = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "openai-responses" as const,
	provider: "relay",
	model: "model",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 2,
	responseId: "stream-response",
});

function mockActiveConversation(
	client: CompanionClient,
	initial: ConversationDetail | null = detail("a"),
) {
	let activeConversation = initial;
	const select = (next: ConversationDetail | null) => {
		activeConversation = next;
		return { ok: true as const, data: { activeConversation } };
	};
	client.conversation.activeGet = vi.fn(() => Promise.resolve(select(activeConversation)));
	client.conversation.select = vi.fn(({ conversationId }) =>
		Promise.resolve(select(detail(conversationId))),
	);
	client.conversation.open = vi.fn(({ conversationId }) =>
		Promise.resolve({ ok: true as const, data: detail(conversationId) }),
	);
	return select;
}

function createStoreWithCleanup(client: CompanionClient) {
	let dispose = () => undefined;
	let store: CompanionStore | undefined;
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
	});
	createRoot((cleanup) => {
		dispose = cleanup;
		createComponent(QueryClientProvider, {
			client: queryClient,
			get children() {
				store = createCompanionStore(client);
				return undefined;
			},
		});
	});
	if (!store) throw new Error("store was not created inside QueryClientProvider");
	return { store, queryClient, dispose };
}

describe("Host-authoritative conversation selection", () => {
	it("keeps the catalog empty until the user explicitly creates a conversation", async () => {
		const { client } = createTestClient();
		const select = mockActiveConversation(client, null);
		const conversations: ConversationSummary[] = [];
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [...conversations] } }),
		);
		client.conversation.create = vi.fn(() => {
			const created = detail("first");
			conversations.push(summary("first"));
			select(created);
			return Promise.resolve({ ok: true as const, data: created });
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(client.conversation.list).toHaveBeenCalled());
			expect(store.activeConversationId).toBeNull();
			expect(client.conversation.create).not.toHaveBeenCalled();
			await store.createConversation();
			expect(store.activeConversationId).toBe("first");
			expect(store.conversations.map((item) => item.conversationId)).toEqual(["first"]);
			expect(client.conversation.select).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("selects, archives, and deletes explicit conversations without aborting another session", async () => {
		const { client } = createTestClient();
		const conversations = [summary("b"), summary("a")];
		client.conversation.list = vi.fn(({ archived = false }) =>
			Promise.resolve({
				ok: true as const,
				data: { conversations: archived ? [] : [...conversations] },
			}),
		);
		const select = mockActiveConversation(client);
		client.conversation.archive = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve(select(detail("a")));
		});
		client.conversation.delete = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve(select(null));
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await store.selectConversation("b");
			expect(store.activeConversationId).toBe("b");
			await store.archiveConversation("b");
			expect(store.activeConversationId).toBe("a");
			await store.deleteConversation("a");
			expect(store.activeConversationId).toBeNull();
			expect(store.conversations).toEqual([]);
			expect(client.message.abort).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("does not let a delayed startup projection overwrite an explicit user selection", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { conversations: [summary("a"), summary("b")] },
			}),
		);
		mockActiveConversation(client);
		const startup = Promise.withResolvers<{ ok: true; data: ConversationActiveResponse }>();
		client.conversation.activeGet = vi.fn(() => startup.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(client.conversation.activeGet).toHaveBeenCalledTimes(2));
			await store.selectConversation("b");
			expect(store.activeConversationId).toBe("b");
			startup.resolve({ ok: true, data: { activeConversation: detail("a") } });
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(store.activeConversationId).toBe("b");
		} finally {
			dispose();
		}
	});

	it("does not let a delayed selection reactivate a deleted conversation", async () => {
		const { client } = createTestClient();
		const conversations = [summary("a"), summary("b")];
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [...conversations] } }),
		);
		const select = mockActiveConversation(client);
		const openingB = Promise.withResolvers<{ ok: true; data: ConversationActiveResponse }>();
		client.conversation.select = vi.fn(() => openingB.promise);
		client.conversation.delete = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve(select(detail("a")));
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const selecting = store.selectConversation("b");
			await waitFor(() =>
				expect(client.conversation.select).toHaveBeenCalledWith({ conversationId: "b" }),
			);
			await store.deleteConversation("b");
			openingB.resolve({ ok: true, data: { activeConversation: detail("b") } });
			await selecting;

			expect(store.activeConversationId).toBe("a");
			expect(store.conversations.some((item) => item.conversationId === "b")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("projects Pi native events per conversation and marks background completion", async () => {
		const { client } = createTestClient();
		const conversations = [summary("a"), summary("b")];
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations } }),
		);
		mockActiveConversation(client);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_start" } });
			await waitFor(() => expect(store.activePiLiveState?.isStreaming).toBe(true));
			const entry = userEntry("entry-a", "native entry");
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_start", message: entry.message },
			});
			client.conversation.open = vi.fn(({ conversationId }) =>
				Promise.resolve({
					ok: true as const,
					data: detail(conversationId, conversationId === "a" ? [entry] : []),
				}),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: entry.message },
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("entry-a"));
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_start" } });
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			await waitFor(() => expect(store.completedConversationIds.has("b")).toBe(true));
			await store.selectConversation("b");
			expect(store.completedConversationIds.has("b")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("isolates transient tool execution until authoritative results replace it", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		mockActiveConversation(client);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "b",
				event: {
					type: "tool_execution_start",
					toolCallId: "tool-b",
					toolName: "host_media",
					args: { id: "portrait" },
				},
			});
			expect(store.activeTimeline.some((item) => item.kind === "tool-execution")).toBe(false);

			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "tool_execution_start",
					toolCallId: "tool-a",
					toolName: "host_state",
					args: {},
				},
			});
			await waitFor(() =>
				expect(store.activeTimeline).toContainEqual({
					kind: "tool-execution",
					id: "tool:a:tool-a",
					toolCallId: "tool-a",
					toolName: "host_state",
					status: "running",
					args: {},
					result: undefined,
				}),
			);
			expect(store.activeTimeline).not.toContainEqual(
				expect.objectContaining({ kind: "tool-execution", toolCallId: "tool-b" }),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "tool_execution_update",
					toolCallId: "tool-a",
					toolName: "host_state",
					args: {},
					partialResult: { content: [{ type: "text", text: "working" }] },
				},
			});
			await waitFor(() =>
				expect(store.activeTimeline).toContainEqual(
					expect.objectContaining({
						toolCallId: "tool-a",
						args: {},
						result: { content: [{ type: "text", text: "working" }] },
					}),
				),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "tool_execution_end",
					toolCallId: "tool-a",
					toolName: "host_state",
					result: { content: [{ type: "text", text: "done" }] },
					isError: false,
				},
			});
			await waitFor(() =>
				expect(store.activeTimeline).toContainEqual(
					expect.objectContaining({ toolCallId: "tool-a", status: "completed" }),
				),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "tool_execution_end",
					toolCallId: "tool-failed",
					toolName: "host_media",
					result: { content: [{ type: "text", text: "failed" }] },
					isError: true,
				},
			});
			await waitFor(() =>
				expect(store.activeTimeline).toContainEqual(
					expect.objectContaining({ toolCallId: "tool-failed", status: "failed" }),
				),
			);

			const settledEntries: PiSessionEntry[] = [
				{
					type: "message",
					id: "result-a",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "tool-a",
						toolName: "host_state",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "result-failed",
					parentId: "result-a",
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "tool-failed",
						toolName: "host_media",
						content: [{ type: "text", text: "failed" }],
						isError: true,
						timestamp: 2,
					},
				},
			];
			const settledSnapshot = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
			client.conversation.open = vi.fn(() => settledSnapshot.promise);
			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_settled" } });
			await waitFor(() =>
				expect(client.conversation.open).toHaveBeenCalledWith({ conversationId: "a" }),
			);
			expect(store.activeTimeline).toEqual([
				expect.objectContaining({
					kind: "tool-execution",
					toolCallId: "tool-a",
					status: "completed",
				}),
				expect.objectContaining({
					kind: "tool-execution",
					toolCallId: "tool-failed",
					status: "failed",
				}),
			]);
			settledSnapshot.resolve({ ok: true, data: detail("a", settledEntries) });
			await waitFor(() =>
				expect(store.activeTimeline).toEqual(
					settledEntries.map((entry) => ({
						kind: "entry",
						id: `tool:a:${entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : entry.id}`,
						entry,
					})),
				),
			);
		} finally {
			dispose();
		}
	});

	it("ignores late Pi events after a conversation is deleted", async () => {
		const { client } = createTestClient();
		const conversations = [summary("a"), summary("b")];
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [...conversations] } }),
		);
		const select = mockActiveConversation(client);
		client.conversation.delete = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve(select(detail("a")));
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await store.deleteConversation("b");
			pushPiEvent(client, {
				type: "pi",
				conversationId: "b",
				event: { type: "message_end", message: userEntry("deleted-entry", "late").message },
			});
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_start" } });
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			client.conversation.open = vi.fn(() =>
				Promise.resolve({
					ok: true as const,
					data: detail("a", [userEntry("barrier", "still active")]),
				}),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: userEntry("barrier", "still active").message },
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("barrier"));
			expect(store.activePiEntries?.some((entry) => entry.id === "deleted-entry")).toBe(false);
			expect(store.completedConversationIds.has("b")).toBe(false);
			expect(store.conversations.some((item) => item.conversationId === "b")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("replaces the previous character's conversations and tasks when switching characters", async () => {
		const { client } = createTestClient();
		let switched = false;
		const oldRun: CompanionStore["runs"][number] = {
			id: "old-run",
			conversationId: "a",
			triggerEntryId: "entry",
			executorProfile: "pi-default",
			title: "Previous character task",
			status: "running",
			artifacts: [],
			evidence: [],
		};
		const currentRun = { ...oldRun, id: "current-run", conversationId: "c" };
		client.run.list = vi.fn(async () => ({
			ok: true as const,
			data: { runs: [switched ? currentRun : oldRun] },
		}));
		client.snapshot.get = vi.fn(async () => ({
			ok: true as const,
			data: {
				onboarding: { status: "complete" as const, stateData: { answers: {} } },
				character: switched ? { ...THEMED_CHARACTER, id: "other-character" } : THEMED_CHARACTER,
			},
		}));
		const select = mockActiveConversation(client);
		client.character.activate = vi.fn(() => {
			switched = true;
			select(detail("c"));
			return Promise.resolve({
				ok: true as const,
				data: { character: { ...THEMED_CHARACTER, id: "other-character" } },
			});
		});
		client.conversation.list = vi.fn(({ archived = false }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversations: archived ? [] : switched ? [summary("c")] : [summary("a"), summary("b")],
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(store.runs).toEqual([oldRun]));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "tool_execution_start",
					toolCallId: "tool-a",
					toolName: "host_state",
					args: {},
				},
			});
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_start" } });
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			await waitFor(() => expect(store.completedConversationIds.has("b")).toBe(true));

			await store.characters.activate("other-character");

			expect(store.activeConversationId).toBe("c");
			expect(store.completedConversationIds.size).toBe(0);
			expect(store.activeTimeline.some((item) => item.kind === "tool-execution")).toBe(false);
			await waitFor(() => expect(store.runs).toEqual([currentRun]));
			expect(store.character?.id).toBe("other-character");
			expect(store.conversations.map((conversation) => conversation.conversationId)).toEqual(["c"]);
		} finally {
			dispose();
		}
	});

	it("replaces a stale inactive live projection with the authoritative snapshot when selected", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		mockActiveConversation(client);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_start" } });
			await waitFor(() => expect(store.conversations[1]?.isStreaming).toBe(true));

			await store.selectConversation("b");

			expect(store.activePiLiveState?.isStreaming).toBe(false);
		} finally {
			dispose();
		}
	});

	it("replays Pi events received while an authoritative conversation snapshot is opening", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		mockActiveConversation(client);
		const openingB = Promise.withResolvers<{ ok: true; data: ConversationActiveResponse }>();
		client.conversation.select = vi.fn(() => openingB.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const selecting = store.selectConversation("b");
			await waitFor(() =>
				expect(client.conversation.select).toHaveBeenCalledWith({ conversationId: "b" }),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "b",
				event: { type: "message_update", message: streamingAssistant("partial reply") },
			});
			await waitFor(() => expect(store.conversations[1]?.isStreaming).toBe(true));
			expect(store.activeConversationId).toBe("a");
			expect(store.activePiLiveState?.isStreaming).toBe(false);
			expect(store.activeTimeline).toEqual([]);
			openingB.resolve({ ok: true, data: { activeConversation: detail("b") } });
			await selecting;

			expect(store.activePiLiveState?.isStreaming).toBe(true);
			expect(store.activeTimeline.at(-1)).toMatchObject({
				kind: "streaming-assistant",
				message: { content: [{ type: "text", text: "partial reply" }] },
			});
		} finally {
			dispose();
		}
	});

	it("refreshes authoritative Character and Display state when the active agent settles", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { conversations: [summary("a")] },
			}),
		);
		mockActiveConversation(client);
		let revision = 0;
		client.companionState.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					schema: { type: "object", properties: {} },
					state: {
						character: {
							document: { mood: revision === 0 ? "quiet" : "happy" },
							revisions: { conversation: revision, global: 0 },
						},
						display: {
							sceneId: revision === 0 ? "default" : "garden",
							expressionId: revision === 0 ? "default" : "smile",
						},
						revisions: { display: revision },
					},
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() =>
				expect(store.companionState?.state.character.document).toEqual({ mood: "quiet" }),
			);
			revision = 1;
			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_settled" } });
			await waitFor(() =>
				expect(store.companionState?.state).toEqual({
					character: {
						document: { mood: "happy" },
						revisions: { conversation: 1, global: 0 },
					},
					display: { sceneId: "garden", expressionId: "smile" },
					revisions: { display: 1 },
				}),
			);
		} finally {
			dispose();
		}
	});

	it("does not re-add a completed live reply after its transcript entry is present", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a")] } }),
		);
		mockActiveConversation(client);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const entry = assistantEntry("assistant-1", "done");
			client.conversation.open = vi.fn(() =>
				Promise.resolve({ ok: true as const, data: detail("a", [entry]) }),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: entry.message },
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("assistant-1"));
			expect(store.activePiLiveState?.streamingMessage).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("reconnects and replaces the active projection from Pi", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a")] } }),
		);
		let authoritative = detail("a", [userEntry("stale", "old projection")]);
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { activeConversation: authoritative } }),
		);
		let subscriptions = 0;
		const disconnect = Promise.withResolvers<void>();
		const reconnect = Promise.withResolvers<AsyncIterable<LivePush>>();
		client.live.subscribe = vi.fn(async (): Promise<AsyncIterable<LivePush>> => {
			subscriptions += 1;
			if (subscriptions === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "pi", conversationId: "a", event: { type: "agent_start" } };
						await disconnect.promise;
						throw new Error("disconnect");
					},
				};
			}
			return reconnect.promise;
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("stale"));
			await waitFor(() => expect(store.activePiLiveState?.isStreaming).toBe(true));
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			authoritative = detail("a", [userEntry("reconciled", "from snapshot")]);
			disconnect.resolve();
			await waitFor(() => expect(store.liveConnectionStatus).toBe("reconnecting"));
			reconnect.resolve({
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.withResolvers<IteratorResult<LivePush>>().promise,
				}),
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("reconciled"));
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledTimes(2));
			expect(store.activePiEntries?.map((entry) => entry.id)).toEqual(["reconciled"]);
			expect(store.activePiLiveState?.isStreaming).toBe(false);
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
		} finally {
			dispose();
		}
	});

	it("does not replay an obsolete opening snapshot across a live reconnect boundary", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		let authoritative = detail("a");
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { activeConversation: authoritative } }),
		);
		const opening = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
		client.conversation.open = vi.fn(() => opening.promise);
		const retry = Promise.withResolvers<void>();
		const disconnect = Promise.withResolvers<void>();
		let subscriptions = 0;
		client.live.subscribe = vi.fn(async (): Promise<AsyncIterable<LivePush>> => {
			subscriptions += 1;
			if (subscriptions === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						await retry.promise;
						yield {
							type: "pi",
							conversationId: "a",
							event: {
								type: "auto_retry_start",
								attempt: 2,
								maxAttempts: 3,
								delayMs: 1000,
								errorMessage: "retry before disconnect",
							},
						};
						await disconnect.promise;
						throw new Error("connection lost");
					},
				};
			}
			return {
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.withResolvers<IteratorResult<LivePush>>().promise,
				}),
			};
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			await store.sendMessage("start the authoritative read");
			await waitFor(() => expect(client.conversation.open).toHaveBeenCalled());
			retry.resolve();
			await waitFor(() => expect(store.activeActivity?.kind).toBe("retry"));
			authoritative = detail("a", [userEntry("reconnected", "new authoritative transcript")]);
			disconnect.resolve();
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledTimes(2));
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("reconnected"));
			expect(store.activeActivity).toBeUndefined();
			const obsolete = detail("a", [userEntry("obsolete", "old read")]);
			obsolete.live.isStreaming = true;
			opening.resolve({ ok: true, data: obsolete });
			const drained = Promise.withResolvers<void>();
			setTimeout(drained.resolve, 0);
			await drained.promise;
			expect(store.activePiEntries?.map((entry) => entry.id)).toEqual(["reconnected"]);
			expect(store.activePiLiveState).toMatchObject({
				isStreaming: false,
				isRetrying: false,
				isCompacting: false,
				pendingToolCallIds: [],
			});
			expect(store.activeActivity).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("waits for authoritative idle before clearing newer work or marking background completion", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client, detail("b"));
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		const firstSnapshot = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
		const backgroundSnapshot = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
		const idleSnapshot = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
		client.conversation.open = vi
			.fn()
			.mockImplementationOnce(() => firstSnapshot.promise)
			.mockImplementationOnce(() => backgroundSnapshot.promise)
			.mockImplementationOnce(() => idleSnapshot.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("b"));
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_start" } });
			pushPiEvent(client, {
				type: "pi",
				conversationId: "b",
				event: {
					type: "tool_execution_start",
					toolCallId: "newer-tool",
					toolName: "host_state",
					args: {},
				},
			});
			pushPiEvent(client, {
				type: "pi",
				conversationId: "b",
				event: {
					type: "auto_retry_start",
					attempt: 1,
					maxAttempts: 3,
					delayMs: 500,
					errorMessage: "newer retry",
				},
			});
			await waitFor(() => expect(store.activeActivity?.kind).toBe("retry"));
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			await waitFor(() => expect(client.conversation.open).toHaveBeenCalledTimes(1));
			expect(store.activePiLiveState).toMatchObject({
				isStreaming: true,
				isRetrying: true,
				pendingToolCallIds: ["newer-tool"],
			});
			expect(store.activeActivity).toMatchObject({ kind: "retry", attempt: 1 });
			expect(store.activeTimeline).toContainEqual(
				expect.objectContaining({
					kind: "tool-execution",
					toolCallId: "newer-tool",
					status: "running",
				}),
			);
			const running = detail("b", [userEntry("newer-turn", "new work")]);
			running.live = {
				...running.live,
				isStreaming: true,
				isRetrying: true,
				retryAttempt: 1,
				pendingToolCallIds: ["newer-tool"],
			};
			firstSnapshot.resolve({ ok: true, data: running });
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("newer-turn"));
			expect(store.activePiLiveState?.isStreaming).toBe(true);
			expect(store.activeActivity?.kind).toBe("retry");
			expect(store.activeTimeline).toContainEqual(
				expect.objectContaining({
					kind: "tool-execution",
					toolCallId: "newer-tool",
					status: "running",
				}),
			);
			await store.selectConversation("a");
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			await waitFor(() => expect(client.conversation.open).toHaveBeenCalledTimes(2));
			expect(store.conversations.find((item) => item.conversationId === "b")?.isStreaming).toBe(
				true,
			);
			expect(store.completedConversationIds.has("b")).toBe(false);
			backgroundSnapshot.resolve({ ok: true, data: running });
			const drained = Promise.withResolvers<void>();
			setTimeout(drained.resolve, 0);
			await drained.promise;
			expect(store.conversations.find((item) => item.conversationId === "b")?.isStreaming).toBe(
				true,
			);
			expect(store.completedConversationIds.has("b")).toBe(false);
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			await waitFor(() => expect(client.conversation.open).toHaveBeenCalledTimes(3));
			expect(store.completedConversationIds.has("b")).toBe(false);
			idleSnapshot.resolve({ ok: true, data: detail("b", running.branch.entries) });
			await waitFor(() => expect(store.completedConversationIds.has("b")).toBe(true));
			expect(store.conversations.find((item) => item.conversationId === "b")?.isStreaming).toBe(
				false,
			);
		} finally {
			dispose();
		}
	});

	it("accepts sends while live connection and its initial projection are pending", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const projection = Promise.withResolvers<{ ok: true; data: ConversationActiveResponse }>();
		vi.mocked(client.conversation.activeGet)
			.mockImplementationOnce(() =>
				Promise.resolve({ ok: true, data: { activeConversation: detail("a") } }),
			)
			.mockImplementation(() => projection.promise);
		const connection = Promise.withResolvers<AsyncIterable<LivePush>>();
		client.live.subscribe = vi.fn(() => connection.promise);
		client.message.send = vi.fn(() => Promise.resolve({ ok: true as const, data: {} }));
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			expect(store.liveConnectionStatus).toBe("connecting");
			await store.sendMessage("hello");
			expect(client.message.send).toHaveBeenCalledWith(
				expect.objectContaining({ conversationId: "a", text: "hello" }),
			);
			expect(store.activeSubmission).toMatchObject({ state: "accepted", text: "hello" });
			connection.resolve({
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.withResolvers<IteratorResult<LivePush>>().promise,
				}),
			});
			await waitFor(() => expect(client.conversation.activeGet).toHaveBeenCalledTimes(2));
			await store.sendMessage("while projection opens");
			expect(client.message.send).toHaveBeenCalledWith(
				expect.objectContaining({ conversationId: "a", text: "while projection opens" }),
			);
			projection.resolve({ ok: true, data: { activeConversation: detail("a") } });
		} finally {
			dispose();
		}
	});

	it("keeps RPC acceptance separate from matching native user messages and snapshots", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const accepted = Promise.withResolvers<{ ok: true; data: Record<string, never> }>();
		client.message.send = vi.fn(() => accepted.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const sending = store.sendMessage("hello");
			await waitFor(() => expect(store.activeSubmission?.state).toBe("submitting"));
			const submissionId = store.activeSubmission!.id;
			expect(store.activeTimeline).toContainEqual(
				expect.objectContaining({
					kind: "submission",
					submission: expect.objectContaining({ id: submissionId, kind: "send", text: "hello" }),
				}),
			);
			const entry = userEntry("pi-user", "hello");
			client.conversation.open = vi.fn(() =>
				Promise.resolve({ ok: true as const, data: detail("a", [entry]) }),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_start", message: entry.message },
			});
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: entry.message },
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("pi-user"));
			expect(store.activeSubmission).toMatchObject({ id: submissionId, state: "submitting" });
			const reconciliation = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
			client.conversation.open = vi.fn(() => reconciliation.promise);
			accepted.resolve({ ok: true, data: {} });
			await sending;
			expect(store.activeSubmission).toMatchObject({ id: submissionId, state: "accepted" });
			reconciliation.resolve({ ok: true, data: detail("a", [entry]) });
			await waitFor(() => expect(store.activeSubmission).toBeUndefined());
			expect(store.activeTimeline.filter((item) => item.kind === "entry")).toEqual([
				expect.objectContaining({ id: "pi-user" }),
			]);
		} finally {
			dispose();
		}
	});

	it("isolates an unresolved submission and late transport failure across conversations", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const accepted = Promise.withResolvers<{ ok: true; data: Record<string, never> }>();
		client.message.send = vi.fn(() => accepted.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const sending = store.sendMessage("hello");
			const failure = expect(sending).rejects.toThrow("connection lost");
			await waitFor(() => expect(store.activeSubmission?.state).toBe("submitting"));
			const submissionId = store.activeSubmission!.id;
			await store.selectConversation("b");
			expect(store.activeSubmission).toBeUndefined();
			expect(store.activeTimeline.some((item) => item.kind === "submission")).toBe(false);
			accepted.reject(new Error("connection lost"));
			await failure;
			expect(store.activeSubmission).toBeUndefined();
			await store.selectConversation("a");
			expect(store.activeSubmission).toMatchObject({
				id: submissionId,
				conversationId: "a",
				state: "unknown",
			});
			store.dismissSubmission(submissionId);
			expect(store.activeSubmission).toBeUndefined();
			expect(store.activeTimeline.some((item) => item.kind === "submission")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("retains acceptance when the authoritative snapshot fails and refreshes without resending", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const snapshot = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
		client.conversation.open = vi.fn(() => snapshot.promise);
		client.message.send = vi.fn(() => Promise.resolve({ ok: true as const, data: {} }));
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await store.sendMessage("accepted without reply");
			expect(store.activeSubmission).toMatchObject({
				conversationId: "a",
				text: "accepted without reply",
				state: "accepted",
			});
			const submissionId = store.activeSubmission!.id;
			await waitFor(() =>
				expect(client.conversation.open).toHaveBeenCalledWith({ conversationId: "a" }),
			);
			snapshot.resolve({
				ok: false,
				error: { kind: "unavailable", reason: "snapshot_unavailable" },
			});
			await waitFor(() => expect(store.activeSubmission?.error).toEqual(expect.any(String)));
			expect(store.activeSubmission).toMatchObject({ id: submissionId, state: "accepted" });
			const entry = userEntry("accepted-entry", "accepted without reply");
			client.conversation.open = vi.fn(() =>
				Promise.resolve({ ok: true as const, data: detail("a", [entry]) }),
			);
			await store.retrySubmission(submissionId);
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("accepted-entry"));
			expect(store.activeSubmission).toBeUndefined();
			expect(client.message.send).toHaveBeenCalledOnce();
		} finally {
			dispose();
		}
	});

	it.each(["edit", "correct"] as const)(
		"refreshes an uncertain %s without dispatching another non-idempotent generation",
		async (kind) => {
			const { client } = createTestClient();
			mockActiveConversation(client);
			client.message[kind] = vi.fn(() => Promise.reject(new Error("response connection lost")));
			const { store, dispose } = createStoreWithCleanup(client);
			try {
				await waitFor(() => expect(store.activeConversationId).toBe("a"));
				const submitted =
					kind === "edit"
						? store.editMessage("original-entry", "replacement")
						: store.correctMessage("original-entry", "replacement");
				await expect(submitted).rejects.toThrow("response connection lost");
				const submission = store.activeSubmission!;
				expect(submission).toMatchObject({ kind, state: "unknown", conversationId: "a" });
				const authoritative = detail("a", [userEntry("new-entry", "replacement")]);
				client.conversation.open = vi.fn(() =>
					Promise.resolve({ ok: true as const, data: authoritative }),
				);

				await store.retrySubmission(submission.id);

				expect(store.activePiEntries?.at(-1)?.id).toBe("new-entry");
				expect(client.message[kind]).toHaveBeenCalledOnce();
				expect(store.activeSubmission).toMatchObject({
					id: submission.id,
					kind,
					state: "unknown",
					error: "response connection lost",
				});
				store.dismissSubmission(submission.id);
				expect(store.activeSubmission).toBeUndefined();
			} finally {
				dispose();
			}
		},
	);

	it("retries a rejected submission with its original id and conversation after selection changes", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		client.message.send = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				error: { kind: "unavailable", reason: "temporarily_unavailable" },
			})
			.mockResolvedValue({ ok: true, data: {} });
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await expect(store.sendMessage("retry me")).rejects.toBeInstanceOf(Error);
			expect(store.activeSubmission).toMatchObject({ state: "failed", conversationId: "a" });
			const submissionId = store.activeSubmission!.id;
			const request = vi.mocked(client.message.send).mock.calls[0]![0];
			await store.selectConversation("b");
			await store.retrySubmission(submissionId);
			expect(store.activeConversationId).toBe("b");
			expect(store.activeSubmission).toBeUndefined();
			expect(vi.mocked(client.message.send).mock.calls[1]![0]).toEqual(request);
			expect(request).toMatchObject({ conversationId: "a", text: "retry me" });
			await store.selectConversation("a");
			expect(store.activeSubmission).toMatchObject({ id: submissionId, state: "accepted" });
		} finally {
			dispose();
		}
	});

	it("preserves completed assistant messages until each matching authoritative entry arrives", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const first = { ...streamingAssistant("first answer"), responseId: "first", timestamp: 2 };
		const second = { ...streamingAssistant("second answer"), responseId: "second", timestamp: 3 };
		let authoritative = detail("a");
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: authoritative }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		const assistantTexts = () =>
			store.activeTimeline.flatMap((item) => {
				const message =
					item.kind === "streaming-assistant"
						? item.message
						: item.kind === "entry" && item.entry.type === "message"
							? item.entry.message
							: undefined;
				return message?.role === "assistant"
					? [
							message.content
								.flatMap((block) => (block.type === "text" ? [block.text] : []))
								.join(""),
						]
					: [];
			});
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_start", message: first },
			});
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: first },
			});
			await waitFor(() => expect(assistantTexts()).toEqual(["first answer"]));
			await waitFor(() => expect(store.activePiLiveState?.streamingMessage).toBeUndefined());
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_start", message: second },
			});
			await waitFor(() => expect(assistantTexts()).toEqual(["first answer", "second answer"]));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: second },
			});
			await waitFor(() => expect(store.activePiLiveState?.streamingMessage).toBeUndefined());
			expect(assistantTexts()).toEqual(["first answer", "second answer"]);
			authoritative = detail("a", [
				{ ...assistantEntry("first-entry", "first answer"), message: first },
			]);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: first },
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("first-entry"));
			expect(assistantTexts()).toEqual(["first answer", "second answer"]);
			authoritative = detail("a", [
				{ ...assistantEntry("first-entry", "first answer"), message: first },
				{ ...assistantEntry("second-entry", "second answer"), message: second },
			]);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "message_end", message: second },
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("second-entry"));
			expect(assistantTexts()).toEqual(["first answer", "second answer"]);
			expect(store.activeTimeline.every((item) => item.kind === "entry")).toBe(true);
		} finally {
			dispose();
		}
	});

	it("projects retry, compaction, full native tool content, and distinct queue modes", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "auto_retry_start",
					attempt: 2,
					maxAttempts: 4,
					delayMs: 2500,
					errorMessage: "rate limited",
				},
			});
			await waitFor(() =>
				expect(store.activeActivity).toMatchObject({
					kind: "retry",
					attempt: 2,
					maxAttempts: 4,
					delayMs: 2500,
					errorMessage: "rate limited",
				}),
			);
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "auto_retry_end", success: true, attempt: 2 },
			});
			await waitFor(() => expect(store.activeActivity?.kind).not.toBe("retry"));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "compaction_start", reason: "threshold" },
			});
			await waitFor(() => expect(store.activeActivity?.kind).toBe("compaction"));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "compaction_end",
					reason: "threshold",
					result: undefined,
					aborted: false,
					willRetry: false,
				},
			});
			await waitFor(() => expect(store.activeActivity?.kind).not.toBe("compaction"));
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: {
					type: "tool_execution_update",
					toolCallId: "safe",
					toolName: "host_media",
					args: {},
					partialResult: {
						content: [
							{ type: "text", text: "rendering image" },
							{ type: "image", mimeType: "image/png", data: "PRIVATE_BASE64" },
						],
						details: { privateValue: "PRIVATE_DETAILS" },
					},
				},
			});
			await waitFor(() =>
				expect(store.activeTimeline).toContainEqual(
					expect.objectContaining({
						kind: "tool-execution",
						toolCallId: "safe",
						result: {
							content: [
								{ type: "text", text: "rendering image" },
								{ type: "image", mimeType: "image/png", data: "PRIVATE_BASE64" },
							],
							details: { privateValue: "PRIVATE_DETAILS" },
						},
					}),
				),
			);
			expect(store.activeActivity).toMatchObject({ kind: "tool", toolName: "host_media" });
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "queue_update", steering: ["same text"], followUp: ["same text"] },
			});
			await waitFor(() =>
				expect(store.activeTimeline.filter((item) => item.kind === "queued-user")).toEqual([
					expect.objectContaining({ text: "same text", queue: "steering" }),
					expect.objectContaining({ text: "same text", queue: "followUp" }),
				]),
			);
		} finally {
			dispose();
		}
	});

	it("clears only the matching memory-stage invocation and isolates background activity", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const { store, dispose } = createStoreWithCleanup(client);
		const activity = (
			conversationId: string,
			operationId: string,
			stage: "memory_recall" | "context" | "memory_capture",
			status: "started" | "completed",
		) =>
			pushPiEvent(client, {
				type: "conversationActivity",
				conversationId,
				operationId,
				activity: stage,
				status,
				live: detail(conversationId).live,
			});
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			activity("a", "recall-1", "memory_recall", "started");
			await waitFor(() => expect(store.activeActivity?.kind).toBe("memory_recall"));
			activity("a", "context-2", "context", "started");
			await waitFor(() => expect(store.activeActivity?.kind).toBe("context"));
			activity("a", "recall-1", "memory_recall", "completed");
			activity("b", "capture-b", "memory_capture", "started");
			await store.selectConversation("b");
			await waitFor(() => expect(store.activeActivity?.kind).toBe("memory_capture"));
			await store.selectConversation("a");
			expect(store.activeActivity?.kind).toBe("context");
			activity("a", "context-2", "context", "completed");
			await waitFor(() => expect(store.activeActivity).toBeUndefined());
			activity("a", "capture-3", "memory_capture", "started");
			await waitFor(() => expect(store.activeActivity?.kind).toBe("memory_capture"));
			activity("a", "capture-3", "memory_capture", "completed");
			await waitFor(() => expect(store.activeActivity).toBeUndefined());
		} finally {
			dispose();
		}
	});

	it("shows a terminal memory failure even when its started notice was missed", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		client.conversation.open = vi.fn(
			() => Promise.withResolvers<RpcEnvelope<ConversationDetail>>().promise,
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			pushPiEvent(client, {
				type: "conversationActivity",
				conversationId: "a",
				operationId: "unobserved-capture",
				activity: "memory_capture",
				status: "failed",
				errorMessage: "capture storage unavailable",
				live: {
					...detail("a").live,
					isStreaming: true,
					isRetrying: true,
					retryAttempt: 2,
				},
			});
			await waitFor(() =>
				expect(store.activeActivity).toMatchObject({
					kind: "memory_capture",
					errorMessage: "capture storage unavailable",
				}),
			);
			expect(store.activePiLiveState).toMatchObject({
				isStreaming: true,
				isRetrying: true,
				retryAttempt: 2,
			});
		} finally {
			dispose();
		}
	});

	it("retains an older capture failure when the newer context invocation completes", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		client.conversation.open = vi.fn(
			() => Promise.withResolvers<RpcEnvelope<ConversationDetail>>().promise,
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			pushPiEvent(client, {
				type: "conversationActivity",
				conversationId: "a",
				operationId: "older-capture",
				activity: "memory_capture",
				status: "started",
				live: detail("a").live,
			});
			await waitFor(() => expect(store.activeActivity?.kind).toBe("memory_capture"));
			pushPiEvent(client, {
				type: "conversationActivity",
				conversationId: "a",
				operationId: "newer-context",
				activity: "context",
				status: "started",
				live: detail("a").live,
			});
			await waitFor(() => expect(store.activeActivity?.kind).toBe("context"));
			pushPiEvent(client, {
				type: "conversationActivity",
				conversationId: "a",
				operationId: "older-capture",
				activity: "memory_capture",
				status: "failed",
				errorMessage: "capture write failed",
				live: { ...detail("a").live, isStreaming: true, isCompacting: true },
			});
			await waitFor(() =>
				expect(store.activeActivity).toMatchObject({
					kind: "memory_capture",
					errorMessage: "capture write failed",
				}),
			);
			expect(store.activePiLiveState).toMatchObject({ isStreaming: true, isCompacting: true });
			pushPiEvent(client, {
				type: "conversationActivity",
				conversationId: "a",
				operationId: "newer-context",
				activity: "context",
				status: "completed",
				live: detail("a").live,
			});
			await waitFor(() =>
				expect(store.activePiLiveState).toMatchObject({
					isStreaming: false,
					isCompacting: false,
				}),
			);
			expect(store.activeActivity).toMatchObject({
				kind: "memory_capture",
				errorMessage: "capture write failed",
			});
		} finally {
			dispose();
		}
	});

	it("applies an event retained between subscription establishment and snapshot replacement", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a")] } }),
		);
		const snapshot = Promise.withResolvers<{
			ok: true;
			data: ConversationActiveResponse;
		}>();
		client.conversation.activeGet = vi.fn(() => snapshot.promise);
		client.live.subscribe = vi.fn(client.live.subscribe);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledOnce());
			await waitFor(() => expect(client.conversation.activeGet).toHaveBeenCalledTimes(2));
			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_start" } });
			expect(store.activePiLiveState?.isStreaming).not.toBe(true);

			snapshot.resolve({ ok: true, data: { activeConversation: detail("a") } });
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(store.activePiLiveState?.isStreaming).toBe(true));
		} finally {
			dispose();
		}
	});

	it("aborts pending stream waits when disposed", async () => {
		const { client } = createTestClient();
		const signals: AbortSignal[] = [];
		client.live.subscribe = vi.fn(async (signal): Promise<AsyncIterable<LivePush>> => {
			signals.push(signal);
			return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) };
		});
		const { dispose } = createStoreWithCleanup(client);
		await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledOnce());
		dispose();
		expect(signals[0]?.aborted).toBe(true);
	});
	it("retains loaded native ancestry beyond the latest 50 entries after refresh", async () => {
		const { client } = createTestClient();
		const entries = Array.from({ length: 151 }, (_, index) => ({
			...userEntry(`history-${index}`, `Message ${index}`),
			parentId: index ? `history-${index - 1}` : null,
		}));
		const latest = detail("a", entries.slice(100, 150));
		latest.branch.hasMoreBefore = true;
		const setActive = mockActiveConversation(client, latest);
		client.conversation.history = vi.fn(async () => ({
			ok: true as const,
			data: { entries: entries.slice(0, 100) },
		}));
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			await store.loadOlderHistory();
			await waitFor(() => expect(store.activePiEntries).toEqual(entries.slice(0, 150)));
			expect(store.activePiBranch?.hasMoreBefore).toBe(false);
			const next = detail("a", entries.slice(101));
			next.branch.hasMoreBefore = true;
			setActive(next);
			client.conversation.open = vi.fn(async () => ({ ok: true as const, data: next }));
			await store.refresh();
			await waitFor(() => expect(store.activePiEntries).toEqual(entries));
			expect(store.activePiBranch?.hasMoreBefore).toBe(false);
		} finally {
			dispose();
		}
	});

	it.each(["switch", "branch"] as const)(
		"discards older history after a %s navigation",
		async (navigation) => {
			const { client } = createTestClient();
			const first = { ...userEntry("head", "Current"), parentId: "older" };
			const initial = detail("a", [first]);
			initial.branch.hasMoreBefore = true;
			mockActiveConversation(client, initial);
			const pending = Promise.withResolvers<RpcEnvelope<{ entries: PiSessionEntry[] }>>();
			client.conversation.history = vi.fn(() => pending.promise);
			const replacement = detail(navigation === "switch" ? "b" : "a", [
				userEntry("new-branch", "New branch"),
			]);
			client.message.switchVersion = vi.fn(async () => ({ ok: true as const, data: replacement }));
			const { store, dispose } = createStoreWithCleanup(client);
			try {
				await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
				const loading = store.loadOlderHistory();
				expect(store.historyLoading).toBe(true);
				if (navigation === "switch") await store.selectConversation("b");
				else await store.switchMessageVersion("new-branch");
				pending.resolve({ ok: true, data: { entries: [userEntry("older", "Old branch")] } });
				await loading;
				expect(store.activeConversationId).toBe(replacement.conversationId);
				expect(store.activePiEntries?.some((entry) => entry.id === "older")).toBe(false);
				expect(store.historyLoading).toBe(false);
				expect(store.historyError).toBeNull();
			} finally {
				dispose();
			}
		},
	);

	it.each([2, 4])(
		"orders captured queue events against snapshot sequence %s",
		async (snapshotSequence) => {
			const { client } = createTestClient();
			const initial = detail("a");
			initial.live.version = { instanceId: "native-a", sequence: 0 };
			mockActiveConversation(client, initial);
			const pending = Promise.withResolvers<RpcEnvelope<ConversationDetail>>();
			client.conversation.open = vi.fn(() => pending.promise);
			const { store, dispose } = createStoreWithCleanup(client);
			try {
				await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
				pushPiEvent(client, {
					type: "pi",
					conversationId: "a",
					version: { instanceId: "native-a", sequence: 1 },
					event: { type: "agent_settled" },
				});
				await waitFor(() => expect(client.conversation.open).toHaveBeenCalled());
				pushPiEvent(client, {
					type: "pi",
					conversationId: "a",
					version: { instanceId: "native-a", sequence: 3 },
					event: { type: "queue_update", steering: ["captured"], followUp: [] },
				});
				await waitFor(() => expect(store.activePiLiveState?.steering).toEqual(["captured"]));
				const snapshot = detail("a", [userEntry("snapshot", "Persisted")]);
				snapshot.live.version = { instanceId: "native-a", sequence: snapshotSequence };
				snapshot.live.steering = ["snapshot"];
				pending.resolve({ ok: true, data: snapshot });
				await waitFor(() => expect(store.activePiEntries?.[0]?.id).toBe("snapshot"));
				expect(store.activePiLiveState?.steering).toEqual([
					snapshotSequence > 3 ? "snapshot" : "captured",
				]);
				pushPiEvent(client, {
					type: "pi",
					conversationId: "a",
					event: { type: "queue_update", steering: ["unversioned stale"], followUp: [] },
				});
				pushPiEvent(client, {
					type: "pi",
					conversationId: "a",
					version: { instanceId: "native-a", sequence: 5 },
					event: { type: "agent_start" },
				});
				await waitFor(() => expect(store.activePiLiveState?.version?.sequence).toBe(5));
				expect(store.activePiLiveState?.steering).toEqual([
					snapshotSequence > 3 ? "snapshot" : "captured",
				]);
			} finally {
				dispose();
			}
		},
	);

	it("admits native non-text assistant content and reconstructs pending tool arguments", async () => {
		const { client } = createTestClient();
		const initial = detail("a");
		const assistant = streamingAssistant("");
		initial.live = {
			...initial.live,
			isStreaming: true,
			pendingToolCallIds: ["call"],
			streamingMessage: {
				...assistant,
				content: [
					{ type: "thinking", thinking: "Public native thinking" },
					{ type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } },
				],
			},
		};
		mockActiveConversation(client, initial);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			expect(store.activeTimeline).toContainEqual(
				expect.objectContaining({
					kind: "tool-execution",
					id: "tool:a:call",
					toolName: "read",
					args: { path: "README.md" },
				}),
			);
			expect(store.activeTimeline).toContainEqual(
				expect.objectContaining({
					kind: "streaming-assistant",
					message: initial.live.streamingMessage,
				}),
			);
			expect(store.activeTimeline.map((item) => item.kind)).toEqual([
				"streaming-assistant",
				"tool-execution",
			]);
		} finally {
			dispose();
		}
	});
	it("preserves loaded native ancestry when reconnect skips more than 50 entries", async () => {
		const { client } = createTestClient();
		const entries = Array.from({ length: 251 }, (_, index) => ({
			...userEntry(`reconnect-${index}`, `Message ${index}`),
			parentId: index ? `reconnect-${index - 1}` : null,
		}));
		const initial = detail("a", entries.slice(0, 100));
		initial.live.version = { instanceId: "same-native-instance", sequence: 1 };
		const setActive = mockActiveConversation(client, initial);
		const ancestry =
			Promise.withResolvers<RpcEnvelope<{ entries: PiSessionEntry[]; nextCursor?: string }>>();
		client.conversation.history = vi.fn(({ beforeEntryId }) =>
			beforeEntryId === "reconnect-201"
				? Promise.resolve({
						ok: true as const,
						data: { entries: entries.slice(101, 201), nextCursor: "reconnect-101" },
					})
				: ancestry.promise,
		);
		const disconnect = Promise.withResolvers<void>();
		const subscribe = client.live.subscribe;
		let subscriptions = 0;
		client.live.subscribe = vi.fn(
			async (signal): Promise<AsyncIterable<LivePush>> =>
				++subscriptions === 1
					? {
							[Symbol.asyncIterator]: () => ({
								next: async (): Promise<IteratorResult<LivePush>> => {
									await disconnect.promise;
									throw new Error("disconnect");
								},
							}),
						}
					: subscribe(signal),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			const fresh = detail("a", entries.slice(201));
			fresh.branch.hasMoreBefore = true;
			fresh.live.version = { instanceId: "same-native-instance", sequence: 152 };
			setActive(fresh);
			disconnect.resolve();
			await waitFor(() => expect(client.conversation.history).toHaveBeenCalledTimes(2));
			expect(store.activePiEntries).toEqual(entries.slice(0, 100));
			ancestry.resolve({
				ok: true,
				data: { entries: entries.slice(1, 101), nextCursor: "reconnect-1" },
			});
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			expect(store.activePiEntries).toEqual(entries);
			expect(store.activePiBranch?.hasMoreBefore).toBe(false);
		} finally {
			dispose();
		}
	});

	it("refreshes open task evidence, controls and history after reconnect without another Run event", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		let run: CompanionStore["runs"][number] = {
			id: "missed-completion",
			conversationId: "a",
			triggerEntryId: "entry",
			executorProfile: "pi-default",
			title: "Disconnected task",
			status: "running",
			controller: "attached",
			actions: ["cancel"],
			artifacts: [],
			evidence: [],
		};
		client.run.list = vi.fn(async (request) => ({
			ok: true as const,
			data: { runs: request?.scope === "history" && run.status !== "completed" ? [] : [run] },
		}));
		client.run.get = vi.fn(async () => ({
			ok: true as const,
			data: {
				run,
				instruction: "Finish the task",
				inputPaths: [],
				evidence:
					run.status === "completed"
						? [
								{
									id: "final",
									kind: "completion",
									createdAt: "2026-01-01T00:00:02.000Z",
									data: { summary: "Verified" },
								},
							]
						: [],
			},
		}));
		const disconnect = Promise.withResolvers<void>();
		const subscribe = client.live.subscribe;
		let subscriptions = 0;
		client.live.subscribe = vi.fn(
			async (signal): Promise<AsyncIterable<LivePush>> =>
				++subscriptions === 1
					? {
							[Symbol.asyncIterator]: () => ({
								next: async (): Promise<IteratorResult<LivePush>> => {
									await disconnect.promise;
									throw new Error("disconnect");
								},
							}),
						}
					: subscribe(signal),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		let disposeObservers = () => undefined;
		const observed = createRoot((cleanup) => {
			disposeObservers = cleanup;
			return {
				detail: store.run.observeDetail(() => run.id),
				history: store.run.observeHistory(),
			};
		});
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			await waitFor(() => expect(observed.detail.data?.run.actions).toEqual(["cancel"]));
			await waitFor(() => expect(observed.history.data?.runs).toEqual([]));
			run = {
				...run,
				status: "completed",
				controller: "confirmed_lost",
				actions: [],
				resultReportedAt: "2026-01-01T00:00:02.000Z",
			};
			disconnect.resolve();
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledTimes(2));
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			await waitFor(() => expect(observed.detail.data?.run.status).toBe("completed"));
			expect(observed.detail.data?.run.actions).toEqual([]);
			expect(observed.detail.data?.run.resultReportedAt).toBe("2026-01-01T00:00:02.000Z");
			expect(observed.detail.data?.evidence).toEqual([
				{
					id: "final",
					kind: "completion",
					createdAt: "2026-01-01T00:00:02.000Z",
					data: { summary: "Verified" },
				},
			]);
			await waitFor(() => expect(observed.history.data?.runs[0]?.status).toBe("completed"));
		} finally {
			disposeObservers();
			dispose();
		}
	});

	it("fences retired-character events and pending lists across delayed identity refresh while retaining current-character cross-conversation tasks", async () => {
		const { client } = createTestClient();
		const setActive = mockActiveConversation(client);
		let character = THEMED_CHARACTER;
		const identityRead = Promise.withResolvers<void>();
		const identity = Promise.withResolvers<RpcEnvelope<SnapshotResponse>>();
		client.snapshot.get = vi.fn(async () => {
			if (character.id !== THEMED_CHARACTER.id) {
				identityRead.resolve();
				return identity.promise;
			}
			return {
				ok: true as const,
				data: {
					onboarding: { status: "complete" as const, stateData: { answers: {} } },
					character,
				},
			};
		});
		client.character.activate = vi.fn(async ({ characterId }) => {
			character = { ...THEMED_CHARACTER, id: characterId };
			setActive(detail("new-selected"));
			return { ok: true as const, data: { character } };
		});
		const run: CompanionStore["runs"][number] = {
			id: "retired-task",
			conversationId: "a",
			triggerEntryId: "entry",
			executorProfile: "pi-default",
			title: "Retired private task",
			status: "running",
			artifacts: [],
			evidence: [],
		};
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			pushPiEvent(client, { type: "run", companionId: THEMED_CHARACTER.id, run });
			await waitFor(() => expect(store.runs.map((task) => task.id)).toEqual(["retired-task"]));
			const pendingList = Promise.withResolvers<RpcEnvelope<RunListResponse>>();
			const listRead = Promise.withResolvers<void>();
			vi.mocked(client.run.list).mockImplementationOnce(() => {
				listRead.resolve();
				return pendingList.promise;
			});
			const oldRead = store.run.list().catch((cause: unknown) => cause);
			await listRead.promise;
			const pendingHistory = Promise.withResolvers<RpcEnvelope<RunListResponse>>();
			const historyRead = Promise.withResolvers<void>();
			vi.mocked(client.run.list).mockImplementationOnce(() => {
				historyRead.resolve();
				return pendingHistory.promise;
			});
			const oldHistory = store.run.list({ scope: "history" }).catch((cause: unknown) => cause);
			await historyRead.promise;
			const switching = store.characters.activate("new-character");
			await identityRead.promise;
			await waitFor(() => expect(store.activeConversationId).toBe("new-selected"));
			pushPiEvent(client, {
				type: "run",
				companionId: THEMED_CHARACTER.id,
				run: { ...run, id: "retired-during-identity-refresh" },
			});
			pushPiEvent(client, {
				type: "pi",
				conversationId: "new-selected",
				event: { type: "queue_update", steering: ["new-scope event barrier"], followUp: [] },
			});
			await waitFor(() =>
				expect(store.activePiLiveState?.steering).toEqual(["new-scope event barrier"]),
			);
			expect(store.runs).toEqual([]);
			const currentRun = { ...run, id: "current-task", conversationId: "new-background" };
			vi.mocked(client.run.list).mockResolvedValue({ ok: true, data: { runs: [currentRun] } });
			identity.resolve({
				ok: true,
				data: {
					onboarding: { status: "complete", stateData: { answers: {} } },
					character,
				},
			});
			await switching;
			await waitFor(() => expect(store.runs).toEqual([currentRun]));
			pendingList.resolve({ ok: true, data: { runs: [run] } });
			expect(isCancelledError(await oldRead)).toBe(true);
			expect(store.runs).toEqual([currentRun]);
			expect(store.character?.id).toBe("new-character");
			pushPiEvent(client, { type: "run", companionId: THEMED_CHARACTER.id, run });
			pushPiEvent(client, {
				type: "run",
				companionId: "new-character",
				run: { ...run, id: "other-conversation-task", conversationId: "new-background" },
			});
			await waitFor(() =>
				expect(store.runs.map((task) => task.id)).toEqual([
					"other-conversation-task",
					"current-task",
				]),
			);
			expect(store.activeConversationId).toBe("new-selected");
			expect(
				LivePushSchema.safeParse({ type: "run", companionId: THEMED_CHARACTER.id, run }).success,
			).toBe(true);
			expect(LivePushSchema.safeParse({ type: "run", run }).success).toBe(false);

			const returnedRun = { ...run, id: "returned-character-task" };
			vi.mocked(client.run.list).mockResolvedValue({ ok: true, data: { runs: [returnedRun] } });
			await store.characters.activate(THEMED_CHARACTER.id);
			await waitFor(() => expect(store.runs).toEqual([returnedRun]));
			pendingHistory.resolve({ ok: true, data: { runs: [run] } });
			expect(isCancelledError(await oldHistory)).toBe(true);
			expect(store.runs).toEqual([returnedRun]);
		} finally {
			dispose();
		}
	});

	it("discards history across reconnect and ignores buffered events from the retired instance", async () => {
		const { client } = createTestClient();
		const initial = detail("a", [{ ...userEntry("head", "Before reconnect"), parentId: "older" }]);
		initial.branch.hasMoreBefore = true;
		initial.live.version = { instanceId: "before-reconnect", sequence: 1 };
		const setActive = mockActiveConversation(client, initial);
		const history = Promise.withResolvers<RpcEnvelope<{ entries: PiSessionEntry[] }>>();
		client.conversation.history = vi.fn(() => history.promise);
		const disconnect = Promise.withResolvers<void>();
		let subscriptions = 0;
		client.live.subscribe = vi.fn(async (): Promise<AsyncIterable<LivePush>> => {
			subscriptions++;
			return subscriptions === 1
				? {
						[Symbol.asyncIterator]: () => ({
							next: async (): Promise<IteratorResult<LivePush>> => {
								await disconnect.promise;
								throw new Error("disconnect");
							},
						}),
					}
				: {
						async *[Symbol.asyncIterator]() {
							yield {
								type: "pi",
								conversationId: "a",
								version: { instanceId: "before-reconnect", sequence: 100 },
								event: { type: "queue_update", steering: ["retired queue"], followUp: [] },
							};
							yield {
								type: "pi",
								conversationId: "a",
								version: { instanceId: "after-reconnect", sequence: 2 },
								event: { type: "agent_start" },
							};
							await Promise.withResolvers<void>().promise;
						},
					};
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			const loading = store.loadOlderHistory();
			const fresh = detail("a", [userEntry("fresh", "After reconnect")]);
			fresh.live.version = { instanceId: "after-reconnect", sequence: 1 };
			setActive(fresh);
			disconnect.resolve();
			await waitFor(() => expect(store.activePiLiveState?.version?.sequence).toBe(2));
			history.resolve({ ok: true, data: { entries: [userEntry("older", "Stale prefix")] } });
			await loading;
			expect(store.activePiEntries).toEqual(fresh.branch.entries);
			expect(store.activePiLiveState?.steering).toEqual([]);
			expect(store.historyLoading).toBe(false);
			expect(store.historyError).toBeNull();
		} finally {
			dispose();
		}
	});

	it("fills a native history gap before retaining the loaded ancestor prefix", async () => {
		const { client } = createTestClient();
		const entries = Array.from({ length: 201 }, (_, index) => ({
			...userEntry(`gap-${index}`, `Message ${index}`),
			parentId: index ? `gap-${index - 1}` : null,
		}));
		mockActiveConversation(client, detail("a", entries.slice(0, 100)));
		client.conversation.history = vi.fn(async () => ({
			ok: true as const,
			data: { entries: entries.slice(51, 151), nextCursor: "gap-51" },
		}));
		const fresh = detail("a", entries.slice(151));
		fresh.branch.hasMoreBefore = true;
		client.conversation.open = vi.fn(async () => ({ ok: true as const, data: fresh }));
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_settled" } });
			await waitFor(() => expect(store.activePiEntries).toEqual(entries));
			expect(store.activePiBranch?.hasMoreBefore).toBe(false);
		} finally {
			dispose();
		}
	});
	it("keeps every unfinished task while bounding completed live history", async () => {
		const { client } = createTestClient();
		mockActiveConversation(client);
		const unfinished: CompanionStore["runs"] = Array.from({ length: 12 }, (_, index) => ({
			id: `unfinished-${index}`,
			conversationId: "a",
			triggerEntryId: "entry",
			executorProfile: "pi-default",
			title: `Task ${index}`,
			status: index === 0 ? "interrupted" : "running",
			artifacts: [],
			evidence: [],
		}));
		client.run.list = vi.fn(async () => ({ ok: true as const, data: { runs: unfinished } }));
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.liveConnectionStatus).toBe("connected"));
			for (let index = 0; index < 110; index++)
				pushPiEvent(client, {
					type: "run",
					companionId: THEMED_CHARACTER.id,
					run: { ...unfinished[0]!, id: `completed-${index}`, status: "completed" },
				});
			await waitFor(() => expect(store.runs.some((run) => run.id === "completed-109")).toBe(true));
			expect(store.runs.filter((run) => run.status !== "completed")).toEqual(unfinished);
			expect(store.runs.filter((run) => run.status === "completed")).toHaveLength(100);
		} finally {
			dispose();
		}
	});
});
