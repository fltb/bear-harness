import type {
	ConversationDetail,
	ConversationSummary,
	LivePush,
	PiSessionEntry,
} from "@bear-harness/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionStore } from "../src/stores/companion.js";
import { createTestClient, pushPiEvent } from "./fixtures.js";

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
	branch: { entries, hasMoreBefore: false, activeLeafId: entries.at(-1)?.id },
	live: { isStreaming: false, pendingToolCallIds: [], steering: [], followUp: [] },
});

const userEntry = (id: string, text: string): PiSessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: text, timestamp: 1 },
});

const assistantEntry = (id: string, text: string): PiSessionEntry => ({
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
});

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

function createStoreWithCleanup(client: ReturnType<typeof createTestClient>["client"]) {
	let dispose = () => undefined;
	let store: ReturnType<typeof createCompanionStore> | undefined;
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

describe("renderer-local conversation selection", () => {
	it("keeps the catalog empty until the user explicitly creates a conversation", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [] } }),
		);
		client.conversation.create = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: detail("first") }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(client.conversation.list).toHaveBeenCalled());
			expect(store.activeConversationId).toBeNull();
			expect(client.conversation.create).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("selects, archives, and deletes explicit conversations without aborting another session", async () => {
		const { client } = createTestClient();
		const conversations = [summary("a"), summary("b")];
		client.conversation.list = vi.fn(({ archived = false }) =>
			Promise.resolve({
				ok: true as const,
				data: { conversations: archived ? [] : [...conversations] },
			}),
		);
		client.conversation.open = vi.fn(({ conversationId }) =>
			Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		client.conversation.archive = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve({ ok: true as const, data: {} });
		});
		client.conversation.delete = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve({ ok: true as const, data: {} });
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await store.selectConversation("b");
			expect(store.activeConversationId).toBe("b");
			await store.archiveConversation("b");
			expect(store.activeConversationId).toBe("a");
			await store.deleteConversation("a");
			expect(client.message.abort).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("does not let a delayed startup open overwrite an explicit user selection", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { conversations: [summary("a"), summary("b")] },
			}),
		);
		let resolveStartup: ((value: { ok: true; data: ConversationDetail }) => void) | undefined;
		client.conversation.open = vi.fn(({ conversationId }) => {
			if (conversationId === "a") {
				return new Promise((resolve) => {
					resolveStartup = resolve;
				});
			}
			return Promise.resolve({ ok: true as const, data: detail(conversationId) });
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(resolveStartup).toBeTypeOf("function"));
			await store.selectConversation("b");
			expect(store.activeConversationId).toBe("b");
			resolveStartup?.({ ok: true, data: detail("a") });
			await waitFor(() => expect(client.conversation.open).toHaveBeenCalledTimes(2));
			expect(store.activeConversationId).toBe("b");
		} finally {
			dispose();
		}
	});

	it("does not let a delayed open reactivate a deleted conversation", async () => {
		const { client } = createTestClient();
		const conversations = [summary("a"), summary("b")];
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [...conversations] } }),
		);
		const openingB = Promise.withResolvers<{ ok: true; data: ConversationDetail }>();
		client.conversation.open = vi.fn(({ conversationId }) =>
			conversationId === "b"
				? openingB.promise
				: Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		client.conversation.delete = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve({ ok: true as const, data: {} });
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const selecting = store.selectConversation("b");
			await waitFor(() =>
				expect(client.conversation.open).toHaveBeenCalledWith({ conversationId: "b" }),
			);
			await store.deleteConversation("b");
			openingB.resolve({ ok: true, data: detail("b") });
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
		client.conversation.open = vi.fn(({ conversationId }) =>
			Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_start" } });
			await waitFor(() => expect(store.activePiLiveState?.isStreaming).toBe(true));
			const entry = userEntry("entry-a", "native entry");
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "entry_appended", entry },
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

	it("isolates transient tool execution by conversation and clears it on settlement", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		client.conversation.open = vi.fn(({ conversationId }) =>
			Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
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
					id: "pi-tool-tool-a",
					toolCallId: "tool-a",
					toolName: "host_state",
					status: "running",
				}),
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

			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_settled" } });
			await waitFor(() =>
				expect(store.activeTimeline.some((item) => item.kind === "tool-execution")).toBe(false),
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
		client.conversation.open = vi.fn(({ conversationId }) =>
			Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		client.conversation.delete = vi.fn(({ conversationId }) => {
			const index = conversations.findIndex((item) => item.conversationId === conversationId);
			if (index >= 0) conversations.splice(index, 1);
			return Promise.resolve({ ok: true as const, data: {} });
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await store.deleteConversation("b");
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_start" } });
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			expect(store.completedConversationIds.has("b")).toBe(false);
			expect(store.conversations.some((item) => item.conversationId === "b")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("releases every conversation projection when switching characters", async () => {
		const { client } = createTestClient();
		let switched = false;
		client.character.activate = vi.fn(() => {
			switched = true;
			return Promise.resolve({ ok: true as const, data: null });
		});
		client.conversation.list = vi.fn(({ archived = false }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversations: archived ? [] : switched ? [summary("c")] : [summary("a"), summary("b")],
				},
			}),
		);
		client.conversation.open = vi.fn(({ conversationId }) =>
			Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		const { store, queryClient, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
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
			queryClient.setQueryData(["companionState", "a"], { character: {}, display: {} });
			queryClient.setQueryData(["models", "route", "a"], { selected: null });
			queryClient.setQueryData(["runs"], { runs: [{ id: "old-run" }] });

			await store.characters.activate("other-character");

			expect(store.activeConversationId).toBe("c");
			expect(store.completedConversationIds.size).toBe(0);
			expect(store.activeTimeline.some((item) => item.kind === "tool-execution")).toBe(false);
			expect(queryClient.getQueryData(["conversation", "a"])).toBeUndefined();
			expect(queryClient.getQueryData(["companionState", "a"])).toBeUndefined();
			expect(queryClient.getQueryData(["models", "route", "a"])).toBeUndefined();
			expect(queryClient.getQueryData(["runs"])).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("replaces a stale inactive live projection with the authoritative snapshot when selected", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		client.conversation.open = vi.fn(({ conversationId }) =>
			Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
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
		const openingB = Promise.withResolvers<{ ok: true; data: ConversationDetail }>();
		client.conversation.open = vi.fn(({ conversationId }) =>
			conversationId === "b"
				? openingB.promise
				: Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const selecting = store.selectConversation("b");
			await waitFor(() =>
				expect(client.conversation.open).toHaveBeenCalledWith({ conversationId: "b" }),
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
			openingB.resolve({ ok: true, data: detail("b") });
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
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: detail("a") }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(client.companionState.get).toHaveBeenCalled());
			const readsBeforeSettle = vi.mocked(client.companionState.get).mock.calls.length;
			pushPiEvent(client, { type: "pi", conversationId: "a", event: { type: "agent_settled" } });
			await waitFor(() =>
				expect(client.companionState.get).toHaveBeenCalledTimes(readsBeforeSettle + 1),
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
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: detail("a") }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const entry = assistantEntry("assistant-1", "done");
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "entry_appended", entry },
			});
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
		let authoritative = detail("a");
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: authoritative }),
		);
		let subscriptions = 0;
		client.live.subscribe = vi.fn(async (signal): Promise<AsyncIterable<LivePush>> => {
			subscriptions += 1;
			if (subscriptions === 1) {
				authoritative = detail("a", [userEntry("reconciled", "from snapshot")]);
				throw new Error("disconnect");
			}
			return {
				async *[Symbol.asyncIterator]() {
					await new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				},
			};
		});
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("reconciled"));
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledTimes(2));
		} finally {
			dispose();
		}
	});

	it("does not send before the live subscription and initial Pi projection are ready", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a")] } }),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: detail("a") }),
		);
		let connect!: (events: AsyncIterable<LivePush>) => void;
		client.live.subscribe = vi.fn(
			() =>
				new Promise<AsyncIterable<LivePush>>((resolve) => {
					connect = resolve;
				}),
		);
		client.message.send = vi.fn(({ text }) =>
			Promise.resolve({ ok: true as const, data: { entry: userEntry("accepted", text) } }),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledOnce());
			const sending = store.sendMessage("hello");
			await Promise.resolve();
			expect(client.message.send).not.toHaveBeenCalled();
			connect({
				async *[Symbol.asyncIterator]() {
					await new Promise<void>(() => undefined);
				},
			});
			await sending;
			expect(client.message.send).toHaveBeenCalledWith(
				expect.objectContaining({ conversationId: "a", text: "hello" }),
			);
		} finally {
			dispose();
		}
	});

	it("replaces the optimistic user message when Pi appends its authoritative entry", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a")] } }),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: detail("a") }),
		);
		const accepted = Promise.withResolvers<{ ok: true; data: Record<string, never> }>();
		client.message.send = vi.fn(() => accepted.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const sending = store.sendMessage("hello");
			await waitFor(() => expect(store.pendingUserMessages).toHaveLength(1));

			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "entry_appended", entry: userEntry("pi-user", "hello") },
			});

			await waitFor(() => expect(store.pendingUserMessages).toHaveLength(0));
			expect(store.activeTimeline).toHaveLength(1);
			expect(store.activeTimeline[0]).toMatchObject({ kind: "entry", id: "pi-user" });
			accepted.resolve({ ok: true, data: {} });
			await sending;
		} finally {
			dispose();
		}
	});

	it("releases an optimistic failure that arrives after the user switches conversations", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		client.conversation.open = vi.fn(({ conversationId }) =>
			Promise.resolve({ ok: true as const, data: detail(conversationId) }),
		);
		const accepted = Promise.withResolvers<{ ok: true; data: Record<string, never> }>();
		client.message.send = vi.fn(() => accepted.promise);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			const sending = store.sendMessage("hello");
			await waitFor(() => expect(store.pendingUserMessages).toHaveLength(1));
			await store.selectConversation("b");
			accepted.reject(new Error("send failed"));

			await expect(sending).rejects.toThrow("send failed");
			expect(store.pendingUserMessages).toHaveLength(0);
			await store.selectConversation("a");
			expect(store.pendingUserMessages).toHaveLength(0);
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
			data: ConversationDetail;
		}>();
		client.conversation.open = vi.fn(() => snapshot.promise);
		client.live.subscribe = vi.fn(
			async (signal): Promise<AsyncIterable<LivePush>> => ({
				async *[Symbol.asyncIterator]() {
					yield { type: "pi", conversationId: "a", event: { type: "agent_start" } };
					await new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				},
			}),
		);
		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledOnce());
			await waitFor(() => expect(client.conversation.open).toHaveBeenCalled());
			expect(store.activePiLiveState?.isStreaming).not.toBe(true);

			snapshot.resolve({ ok: true, data: detail("a") });
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
});
