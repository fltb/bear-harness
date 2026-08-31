import type {
	ConversationDetail,
	ConversationSummary,
	PiSessionEventType,
	PiSessionLiveEvent,
} from "@bear-harness/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createCompanionStore } from "../src/stores/companion.js";
import { createTestClient, pushPiEvent } from "./fixtures.js";

const summary = (id: string): ConversationSummary => ({
	id,
	title: `Conversation ${id}`,
	created: "2026-01-01T00:00:00.000Z",
	modified: "2026-01-01T00:00:00.000Z",
	messageCount: 0,
	firstMessage: "",
});

const detail = (id: string): ConversationDetail => ({
	sessionId: id,
	name: `Conversation ${id}`,
	timeline: { entries: [] },
	live: { isStreaming: false, queuedUserMessages: [] },
});

function createStoreWithCleanup(client: ReturnType<typeof createTestClient>["client"]) {
	let dispose = () => undefined;
	let store: ReturnType<typeof createCompanionStore> | undefined;
	createRoot((cleanup) => {
		dispose = cleanup;
		createComponent(QueryClientProvider, {
			client: new QueryClient({
				defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
			}),
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
	it("clears the old role selection before loading and selecting the new role's conversations", async () => {
		const { client } = createTestClient();
		let role: "a" | "b" = "a";
		const byRole = {
			a: [summary("a-session")],
			b: [summary("b-session")],
		};
		client.character.activate = vi.fn(({ characterId }) => {
			role = characterId === "role-b" ? "b" : "a";
			return Promise.resolve({ ok: true as const, data: null });
		});
		client.character.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					characters: [
						{ id: "role-a", name: "A", active: role === "a" },
						{ id: "role-b", name: "B", active: role === "b" },
					],
				},
			}),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { sessions: byRole[role] } }),
		);
		client.conversation.open = vi.fn(({ id }) => {
			const valid = byRole[role].some((item) => item.id === id);
			if (!valid) {
				return Promise.resolve({
					ok: false as const,
					error: { kind: "not_found" as const, message: "conversation_not_found" },
				});
			}
			return Promise.resolve({ ok: true as const, data: detail(id) });
		});
		const { store, dispose } = createStoreWithCleanup(client);

		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a-session"));
			const opensBeforeSwitch = vi.mocked(client.conversation.open).mock.calls.length;
			await store.characters.activate("role-b");
			expect(store.activeConversationId).toBe("b-session");
			expect(
				vi
					.mocked(client.conversation.open)
					.mock.calls.slice(opensBeforeSwitch)
					.map(([request]) => request.id),
			).not.toContain("a-session");
		} finally {
			dispose();
		}
	});

	it("opens details locally and selects a remaining conversation after archive or delete", async () => {
		const { client } = createTestClient();
		const available = [summary("a"), summary("b")];
		const details = new Map(available.map((item) => [item.id, detail(item.id)]));
		const archived = new Set<string>();
		client.conversation.list = vi.fn(({ archived: wantArchived = false }) =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessions: available.filter((item) => archived.has(item.id) === wantArchived),
				},
			}),
		);
		client.conversation.open = vi.fn(({ id }) => {
			const projection = details.get(id);
			if (!projection) throw new Error(`missing conversation ${id}`);
			return Promise.resolve({ ok: true as const, data: projection });
		});
		client.conversation.create = vi.fn(() => {
			const projection = detail("c");
			details.set("c", projection);
			available.push(summary("c"));
			return Promise.resolve({ ok: true as const, data: projection });
		});
		client.message.branch = vi.fn(() => {
			const projection = detail("d");
			details.set("d", projection);
			available.push(summary("d"));
			return Promise.resolve({ ok: true as const, data: projection });
		});
		client.conversation.archive = vi.fn(({ id, archived: value }) => {
			if (value) archived.add(id);
			else archived.delete(id);
			return Promise.resolve({ ok: true as const, data: {} });
		});
		client.conversation.delete = vi.fn(({ id }) => {
			const index = available.findIndex((item) => item.id === id);
			if (index >= 0) available.splice(index, 1);
			details.delete(id);
			return Promise.resolve({ ok: true as const, data: {} });
		});
		const { store, dispose } = createStoreWithCleanup(client);

		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			await waitFor(() =>
				expect(client.companionState.get).toHaveBeenCalledWith({ conversationId: "a" }),
			);

			await store.selectConversation("b");
			expect(store.activeConversationId).toBe("b");
			expect(client.message.abort).not.toHaveBeenCalled();

			await store.createConversation("Third");
			expect(store.activeConversationId).toBe("c");

			await store.createConversationFromEntry("entry-1");
			expect(client.message.branch).toHaveBeenCalledWith({
				conversationId: "c",
				entryId: "entry-1",
			});
			expect(store.activeConversationId).toBe("d");

			await store.archiveConversation("d");
			expect(store.activeConversationId).toBe("a");
			expect(client.conversation.open).toHaveBeenCalledWith({ id: "a" });

			await store.selectConversation("b");
			await store.deleteConversation("b");
			expect(store.activeConversationId).toBe("a");
			expect(client.message.abort).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("keeps live projections per session and refreshes active details at Pi commit points", async () => {
		const { client } = createTestClient();
		const sessions = [summary("a"), summary("b")];
		const details = new Map(sessions.map((item) => [item.id, detail(item.id)]));
		client.conversation.list = vi.fn(({ archived = false }) =>
			Promise.resolve({
				ok: true as const,
				data: { sessions: archived ? [] : sessions },
			}),
		);
		client.conversation.open = vi.fn(({ id }) => {
			const projection = details.get(id);
			if (!projection) throw new Error(`missing conversation ${id}`);
			return Promise.resolve({ ok: true as const, data: projection });
		});
		const { store, dispose } = createStoreWithCleanup(client);

		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			pushPiEvent(client, {
				sessionId: "a",
				type: "message_update",
				live: {
					isStreaming: true,
					streamingMessage: { text: "token one", stopReason: "pending" },
					queuedUserMessages: [],
				},
			});
			await waitFor(() =>
				expect(store.activePiLiveState?.streamingMessage?.text).toBe("token one"),
			);

			const refreshTypes: PiSessionEventType[] = [
				"message_end",
				"entry_appended",
				"session_info_changed",
				"agent_settled",
			];
			for (const [index, type] of refreshTypes.entries()) {
				const entryId = `entry-${index}`;
				details.set("a", {
					...detail("a"),
					timeline: {
						entries: [
							{
								id: entryId,
								parentId: null,
								timestamp: "2026-01-01T00:00:00.000Z",
								kind: "message",
								role: "user",
								text: entryId,
							},
						],
					},
				});
				const callsBefore = vi.mocked(client.conversation.open).mock.calls.length;
				pushPiEvent(client, {
					sessionId: "a",
					type,
					live: {
						isStreaming: type !== "agent_settled",
						streamingMessage: { text: `token ${index + 2}`, stopReason: "pending" },
						queuedUserMessages: [],
					},
				});
				await waitFor(() =>
					expect(vi.mocked(client.conversation.open).mock.calls.length).toBeGreaterThan(
						callsBefore,
					),
				);
				await waitFor(() => expect(store.activePiTimeline?.entries[0]?.id).toBe(entryId));
				expect(store.activePiLiveState?.streamingMessage?.text).toBe(`token ${index + 2}`);
			}

			const callsBeforeInactive = vi.mocked(client.conversation.open).mock.calls.length;
			details.set("b", {
				...detail("b"),
				live: {
					isStreaming: true,
					streamingMessage: { text: "inactive token", stopReason: "pending" },
					queuedUserMessages: [],
				},
			});
			pushPiEvent(client, {
				sessionId: "b",
				type: "message_end",
				live: {
					isStreaming: true,
					streamingMessage: { text: "inactive token", stopReason: "pending" },
					queuedUserMessages: [],
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(vi.mocked(client.conversation.open).mock.calls).toHaveLength(callsBeforeInactive);
			await store.selectConversation("b");
			expect(store.activePiLiveState?.streamingMessage?.text).toBe("inactive token");
			expect(client.message.abort).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("reconciles from Pi and reconnects without using active selection as a global router", async () => {
		const { client } = createTestClient();
		const sessions = [summary("a"), summary("b")];
		const details = new Map(sessions.map((item) => [item.id, detail(item.id)]));
		client.conversation.list = vi.fn(({ archived = false }) =>
			Promise.resolve({ ok: true as const, data: { sessions: archived ? [] : sessions } }),
		);
		client.conversation.open = vi.fn(({ id }) => {
			const projection = details.get(id);
			if (!projection) throw new Error(`missing conversation ${id}`);
			return Promise.resolve({ ok: true as const, data: projection });
		});

		let releaseFirst = () => undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let releaseReconnected = () => undefined;
		const reconnectedGate = new Promise<void>((resolve) => {
			releaseReconnected = resolve;
		});
		let attempts = 0;
		client.pi.stream = vi.fn(async function* (signal): AsyncIterable<PiSessionLiveEvent> {
			const attempt = ++attempts;
			if (attempt === 1) {
				await firstGate;
				if (signal.aborted) return;
				yield {
					sessionId: "a",
					type: "message_update",
					live: {
						isStreaming: true,
						streamingMessage: { text: "transient before disconnect", stopReason: "pending" },
						queuedUserMessages: [],
					},
				};
				details.set("a", {
					...detail("a"),
					live: {
						isStreaming: true,
						streamingMessage: { text: "authoritative after disconnect", stopReason: "pending" },
						queuedUserMessages: [],
					},
				});
				throw new Error("transport disconnected");
			}
			await reconnectedGate;
			if (signal.aborted) return;
			yield {
				sessionId: "b",
				type: "message_update",
				live: {
					isStreaming: true,
					streamingMessage: { text: "stream after reconnect", stopReason: "pending" },
					queuedUserMessages: [],
				},
			};
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
		});

		const { store, dispose } = createStoreWithCleanup(client);
		try {
			await waitFor(() => expect(store.activeConversationId).toBe("a"));
			releaseFirst();
			await waitFor(() =>
				expect(store.activePiLiveState?.streamingMessage?.text).toBe(
					"authoritative after disconnect",
				),
			);

			details.set("b", {
				...detail("b"),
				live: {
					isStreaming: true,
					streamingMessage: { text: "authoritative b", stopReason: "pending" },
					queuedUserMessages: [],
				},
			});
			await store.selectConversation("b");
			expect(store.activePiLiveState?.streamingMessage?.text).toBe("authoritative b");
			expect(client.message.abort).not.toHaveBeenCalled();

			await waitFor(() => expect(client.pi.stream).toHaveBeenCalledTimes(2));
			const opensForA = vi
				.mocked(client.conversation.open)
				.mock.calls.filter(([request]) => request.id === "a").length;
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(
				vi.mocked(client.conversation.open).mock.calls.filter(([request]) => request.id === "a")
					.length,
			).toBe(opensForA);
			releaseReconnected();
			await waitFor(() =>
				expect(store.activePiLiveState?.streamingMessage?.text).toBe("stream after reconnect"),
			);
		} finally {
			dispose();
		}
	});

	it("cancels a pending reconnect immediately when the store is disposed", async () => {
		const { client } = createTestClient();
		client.conversation.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { sessions: [] } }),
		);
		const signals: AbortSignal[] = [];
		client.pi.stream = vi.fn((signal): AsyncIterable<PiSessionLiveEvent> => {
			signals.push(signal);
			return {
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.resolve({ done: true, value: undefined }),
				}),
			};
		});
		const { dispose } = createStoreWithCleanup(client);

		await waitFor(() => expect(client.pi.stream).toHaveBeenCalledTimes(1));
		dispose();
		expect(signals[0]?.aborted).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(client.pi.stream).toHaveBeenCalledTimes(1);
	});
});
