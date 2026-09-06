import type { CompanionClient } from "@bear-harness/companion-client";
import type {
	ConversationActiveResponse,
	ConversationDetail,
	ConversationSummary,
	LivePush,
	PiSessionEntry,
} from "@bear-harness/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { type CompanionStore, createCompanionStore } from "../src/stores/companion.js";
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
	branch: {
		entries,
		hasMoreBefore: false,
		activeLeafId: entries.at(-1)?.id,
		latestLeafIds: entries.length ? [entries[entries.length - 1]!.id] : [],
	},
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
		mockActiveConversation(client);
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
				event: { type: "entry_appended", entry: userEntry("deleted-entry", "late") },
			});
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_start" } });
			pushPiEvent(client, { type: "pi", conversationId: "b", event: { type: "agent_settled" } });
			pushPiEvent(client, {
				type: "pi",
				conversationId: "a",
				event: { type: "entry_appended", entry: userEntry("barrier", "still active") },
			});
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("barrier"));
			expect(store.activePiEntries?.some((entry) => entry.id === "deleted-entry")).toBe(false);
			expect(store.completedConversationIds.has("b")).toBe(false);
			expect(store.conversations.some((item) => item.conversationId === "b")).toBe(false);
		} finally {
			dispose();
		}
	});

	it("releases every conversation projection when switching characters", async () => {
		const { client } = createTestClient();
		let switched = false;
		const select = mockActiveConversation(client);
		client.character.activate = vi.fn(() => {
			switched = true;
			select(detail("c"));
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
		let authoritative = detail("a", [userEntry("stale", "old projection")]);
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { activeConversation: authoritative } }),
		);
		let subscriptions = 0;
		const disconnect = Promise.withResolvers<void>();
		client.live.subscribe = vi.fn(async (signal): Promise<AsyncIterable<LivePush>> => {
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
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("stale"));
			await waitFor(() => expect(store.activePiLiveState?.isStreaming).toBe(true));
			authoritative = detail("a", [userEntry("reconciled", "from snapshot")]);
			disconnect.resolve();
			await waitFor(() => expect(store.activePiEntries?.at(-1)?.id).toBe("reconciled"));
			await waitFor(() => expect(client.live.subscribe).toHaveBeenCalledTimes(2));
			expect(store.activePiEntries?.map((entry) => entry.id)).toEqual(["reconciled"]);
			expect(store.activePiLiveState?.isStreaming).toBe(false);
		} finally {
			dispose();
		}
	});

	it("does not send before the live subscription and initial Pi projection are ready", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a")] } }),
		);
		mockActiveConversation(client);
		const projection = Promise.withResolvers<{ ok: true; data: ConversationActiveResponse }>();
		vi.mocked(client.conversation.activeGet)
			.mockImplementationOnce(() =>
				Promise.resolve({ ok: true, data: { activeConversation: detail("a") } }),
			)
			.mockImplementation(() => projection.promise);
		let connect!: (events: AsyncIterable<LivePush>) => void;
		client.live.subscribe = vi.fn(
			() =>
				new Promise<AsyncIterable<LivePush>>((resolve) => {
					connect = resolve;
				}),
		);
		client.message.send = vi.fn(() => Promise.resolve({ ok: true as const, data: {} }));
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
			await waitFor(() => expect(client.conversation.activeGet).toHaveBeenCalledTimes(2));
			expect(client.message.send).not.toHaveBeenCalled();
			projection.resolve({ ok: true, data: { activeConversation: detail("a") } });
			await sending;
			expect(client.message.send).toHaveBeenCalledWith(
				expect.objectContaining({ conversationId: "a", text: "hello" }),
			);
		} finally {
			dispose();
		}
	});

	it("replaces the pending user message when Pi appends its authoritative entry", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a")] } }),
		);
		mockActiveConversation(client);
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

	it("releases a pending failure that arrives after the user switches conversations", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversations: [summary("a"), summary("b")] } }),
		);
		mockActiveConversation(client);
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
});
