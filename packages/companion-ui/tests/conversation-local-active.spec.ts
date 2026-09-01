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
	live: { isStreaming: false, steering: [], followUp: [] },
});

const userEntry = (id: string, text: string): PiSessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: text, timestamp: 1 },
});

function createStoreWithCleanup(client: ReturnType<typeof createTestClient>["client"]) {
	let dispose = () => undefined;
	let store: ReturnType<typeof createCompanionStore> | undefined;
	createRoot((cleanup) => {
		dispose = cleanup;
		createComponent(QueryClientProvider, {
			client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } }),
			get children() {
				store = createCompanionStore(client);
				return undefined;
			},
		});
	});
	if (!store) throw new Error("store was not created inside QueryClientProvider");
	return { store, dispose };
}

describe("renderer-local conversation selection", () => {
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
			expect(client.message.send).toHaveBeenCalledWith({ conversationId: "a", text: "hello" });
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
