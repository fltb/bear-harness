import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const STREAMED_REPLY = "我是季舟。";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	eventSeq: 0,
	stateData: { schema_version: 1 as const, flow_version: 1, answers: {}, decisions: {} },
};

function activeClient() {
	const fixture = createTestClient();
	fixture.client.model.poolGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				models: [
					{
						providerId: "e2e-rule",
						modelId: "rule-model",
						label: "E2E Rule Provider",
						supportsImages: false,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		}),
	);
	fixture.client.model.routeGet = vi.fn(({ conversationId }) =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversationId,
				selected: { providerId: "e2e-rule", modelId: "rule-model" },
			},
		}),
	);
	fixture.client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				eventSeq: 0,
				onboarding: COMPLETE_ONBOARDING,
				model: {
					pool: {
						models: [
							{
								providerId: "e2e-rule",
								modelId: "rule-model",
								label: "E2E Rule Provider",
								supportsImages: false,
								createdAt: "2026-01-01T00:00:00.000Z",
							},
						],
					},
					defaults: { vision: { mode: "auto" } },
					route: {
						conversationId: "conversation-1",
						selected: { providerId: "e2e-rule", modelId: "rule-model" },
					},
				},
				conversation: {
					activeConversationId: "conversation-1",
					conversations: [
						{
							id: "conversation-1",
							title: "Streaming",
							sceneTitle: "Scene",
							unread: false,
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					],
					piTimeline: { entries: [] },
				},
			},
		}),
	);
	fixture.client.onboarding.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
	);
	return fixture;
}

describe("optimistic and streaming chat", () => {
	it("shows the user message and an assistant loading block before send RPC resolves", async () => {
		const user = userEvent.setup();
		const { client } = activeClient();
		let resolveSend: ((value: { ok: true; data: { messageId: string } }) => void) | undefined;
		client.message.send = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSend = resolve;
				}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "你是谁？");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		expect(screen.getByText("你是谁？")).toBeInTheDocument();
		expect(screen.getByRole("status", { name: zhCN.messages.responding })).toBeInTheDocument();
		resolveSend?.({ ok: true, data: { messageId: "user-message-1" } });
	});
	it("renders a failed Pi tool entry", async () => {
		const { client } = activeClient();
		const initialSnapshot = client.snapshot.get;
		client.snapshot.get = vi.fn(async () => {
			const result = await initialSnapshot();
			if (!result.ok) return result;
			return {
				...result,
				data: {
					...result.data,
					conversation: {
						...result.data.conversation,
						activeConversationId: "conversation-1",
						conversations: [
							{
								id: "conversation-1",
								title: "Streaming",
								sceneTitle: "Scene",
								unread: false,
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						],
						piTimeline: {
							entries: [
								{
									id: "failed-assistant",
									parentId: null,
									timestamp: "2026-01-01T00:00:00.000Z",
									kind: "message",
									role: "tool",
									toolName: "model unavailable",
									toolCallId: "failed-assistant-v1",
									status: "failed",
								},
							],
						},
					},
				},
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });
		const failure = await within(thread).findByRole("article", { name: "model unavailable failed" });
		expect(failure).toHaveTextContent("model unavailable");
		expect(failure).toHaveTextContent("failed");
	});
	it("does not render completed or aborted empty assistant turns as failures", async () => {
		const { client } = activeClient();
		const initialSnapshot = client.snapshot.get;
		client.snapshot.get = vi.fn(async () => {
			const result = await initialSnapshot();
			if (!result.ok) return result;
			return {
				...result,
				data: {
					...result.data,
					conversation: {
						...result.data.conversation,
						activeConversationId: "conversation-1",
						conversations: [
							{
								id: "conversation-1",
								title: "Streaming",
								sceneTitle: "Scene",
								unread: false,
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						],
						piTimeline: {
							entries: (["completed", "aborted"] as const).map((status, index) => ({
								id: `${status}-assistant`,
								parentId: null,
								timestamp: `2026-01-01T00:00:0${index}.000Z`,
								kind: "message" as const,
								role: "assistant" as const,
							})),
						},
					},
				},
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });
		await waitFor(() => expect(within(thread).getAllByRole("article")).toHaveLength(2));
		expect(within(thread).queryByRole("alert")).not.toBeInTheDocument();
	});
	it("omits an internal-only persisted projection from the user-facing thread", async () => {
		const { client } = activeClient();
		const initialSnapshot = client.snapshot.get;
		client.snapshot.get = vi.fn(async () => {
			const result = await initialSnapshot();
			if (!result.ok) return result;
			return {
				...result,
				data: {
					...result.data,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [
							{
								id: "conversation-1",
								title: "Internal only",
								sceneTitle: "Scene",
								unread: false,
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						],
						piTimeline: {
							entries: [
								{
									id: "internal-only",
									parentId: null,
									timestamp: "2026-01-01T00:00:01.000Z",
									kind: "custom",
								},
							],
						},
					},
				},
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });

		await screen.findByText("Internal only");
		expect(within(thread).queryByText("仅供内部使用的工具结果")).not.toBeInTheDocument();
		expect(within(thread).queryAllByRole("article")).toHaveLength(0);
	});

	it("hides a streamed draft when persisted assistant content contains that draft", async () => {
		const user = userEvent.setup();
		const { client } = activeClient();
		const persistedReply = `${STREAMED_REPLY}这是持久化的最终尾声`;
		let committed = false;
		const initialSnapshot = client.snapshot.get;
		client.snapshot.get = vi.fn(async () => {
			const result = await initialSnapshot();
			if (!result.ok) return result;
			return {
				...result,
				data: {
					...result.data,
					eventSeq: committed ? 5 : 0,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [],
						piTimeline: {
							entries: committed
								? [
										{
											id: "pi:assistant-entry-contains-draft",
											parentId: null,
											timestamp: "2026-01-01T00:00:01.000Z",
											kind: "message" as const,
											role: "assistant" as const,
											text: persistedReply,
										},
									]
								: [],
						},
					},
				},
			};
		});

		const initialEvents = Promise.withResolvers<{
			ok: true;
			data: {
				events: Array<{
					seq: number;
					kind: "message_start" | "message_update";
					payload: { conversationId: string; text?: string };
				}>;
			};
		}>();
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription === 1) return initialEvents.promise;
			if (subscription === 2) {
				committed = true;
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{
								seq: 3,
								kind: "message_end" as const,
								payload: { conversationId: "conversation-1", text: STREAMED_REPLY },
							},
							{
								seq: 5,
								kind: "message.assistant_committed" as const,
								payload: { conversationId: "conversation-1" },
							},
						],
					},
				});
			}
			const pending = Promise.withResolvers<never>();
			return pending.promise;
		});
		const pendingSend = Promise.withResolvers<never>();
		client.message.send = vi.fn(() => pendingSend.promise);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "继续说");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));
		initialEvents.resolve({
			ok: true,
			data: {
				events: [
					{
						seq: 1,
						kind: "message_start",
						payload: { conversationId: "conversation-1" },
					},
					{
						seq: 2,
						kind: "message_update",
						payload: { conversationId: "conversation-1", text: STREAMED_REPLY },
					},
				],
			},
		});

		await waitFor(() => expect(screen.getByText(persistedReply)).toBeInTheDocument());
		expect(screen.queryByText(STREAMED_REPLY)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
	});
	it("renders raw current_user_message text from a Pi user entry", async () => {
		const { client } = activeClient();
		const rawUserText = "请记住这条当前消息";
		const framedPrompt = [
			"<host_context>",
			"只用于模型上下文的内部 Host 状态",
			"</host_context>",
			"",
			"<current_user_message>",
			rawUserText,
			"</current_user_message>",
		].join("\n");
		const userEntryId = "pi:user-entry-1";
		const initialSnapshot = client.snapshot.get;
		client.snapshot.get = vi.fn(async () => {
			const result = await initialSnapshot();
			if (!result.ok) return result;
			return {
				...result,
				data: {
					...result.data,
					eventSeq: 1,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [
							{
								id: "conversation-1",
								title: "Streaming",
								sceneTitle: "Scene",
								unread: false,
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						],
						piTimeline: {
							entries: [
								{
									id: userEntryId,
									parentId: null,
									timestamp: "2026-01-01T00:00:01.000Z",
									kind: "message",
									role: "user",
									text: rawUserText,
								},
							],
						},
					},
				},
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(screen.getByText(rawUserText)).toBeInTheDocument());
		expect(screen.queryByText(framedPrompt)).not.toBeInTheDocument();

		expect(screen.getByText(rawUserText).closest("article")).not.toBeNull();
	});

	it("replaces the streaming block with exactly one persisted assistant message", async () => {
		const { client } = activeClient();
		let assistantCommitted = false;
		client.snapshot.get = vi.fn(() => {
			return Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: assistantCommitted ? 5 : 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [],
						piTimeline: {
							entries: !assistantCommitted
								? []
								: [
										{
											id: "assistant-message-1",
											parentId: null,
											timestamp: "2026-01-01T00:00:01.000Z",
											kind: "message" as const,
											role: "assistant" as const,
											text: STREAMED_REPLY,
										},
									],
						},
					},
				},
			});
		});
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription === 1) {
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{ seq: 1, kind: "message_start", payload: { conversationId: "conversation-1" } },
							{
								seq: 2,
								kind: "message_update",
								payload: { conversationId: "conversation-1", text: "我是" },
							},
						],
					},
				});
			}
			if (subscription === 2) {
				assistantCommitted = true;
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{
								seq: 3,
								kind: "message_update",
								payload: { conversationId: "conversation-1", text: "季舟。" },
							},
							{
								seq: 4,
								kind: "message_end",
								payload: { conversationId: "conversation-1", text: STREAMED_REPLY },
							},
							{
								seq: 5,
								kind: "message.assistant_committed",
								payload: {
									conversationId: "conversation-1",
									messageId: "assistant-message-1",
									versionId: "assistant-version-1",
								},
							},
						],
					},
				});
			}
			return new Promise<never>(() => {});
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(screen.getAllByText(STREAMED_REPLY)).toHaveLength(1));
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
		expect(client.snapshot.get).toHaveBeenCalled();
	});

	it("clears the streaming draft when the projection carries a Pi entry id", async () => {
		const { client } = activeClient();
		let committed = false;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: committed ? 5 : 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [],
						piTimeline: {
							entries: !committed
								? []
								: [
										{
											id: "pi:entry-assistant-9",
											parentId: null,
											timestamp: "2026-01-01T00:00:01.000Z",
											kind: "message" as const,
											role: "assistant" as const,
											text: STREAMED_REPLY,
										},
									],
						},
					},
				},
			}),
		);
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription === 1) {
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{ seq: 1, kind: "message_start", payload: { conversationId: "conversation-1" } },
							{
								seq: 2,
								kind: "message_update",
								payload: { conversationId: "conversation-1", text: "我是" },
							},
						],
					},
				});
			}
			if (subscription === 2) {
				committed = true;
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{
								seq: 3,
								kind: "message_update",
								payload: { conversationId: "conversation-1", text: "季舟。" },
							},
							{
								seq: 4,
								kind: "message_end",
								payload: { conversationId: "conversation-1", text: STREAMED_REPLY },
							},
							{
								seq: 5,
								kind: "message.assistant_committed",
								payload: {
									conversationId: "conversation-1",
									messageId: "assistant-message-1",
									versionId: "assistant-version-1",
								},
							},
						],
					},
				});
			}
			return new Promise<never>(() => {});
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(screen.getAllByText(STREAMED_REPLY)).toHaveLength(1));
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
	});

	it("keeps the responding status hidden when a late delta follows the settled Pi final", async () => {
		// Mirrors the native Pi journey: two stream deltas close into the final
		// text, the committed projection carries a Pi entry id while
		// message.assistant_committed carries the persisted turn id, and a
		// stale delta from the settled turn can still arrive afterwards. The
		// status must stay hidden and the final content must render exactly once.
		const STREAM_ONE = "STREAM_ONE ";
		const STREAM_TWO = "STREAM_TWO";
		const STREAMED_FINAL = `${STREAM_ONE}${STREAM_TWO}`;
		const { client } = activeClient();
		let committed = false;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: committed ? 5 : 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: {
						activeConversationId: "conversation-1",
						conversations: [],
						piTimeline: {
							entries: !committed
								? []
								: [
										{
											id: "pi:entry-assistant-late-delta",
											parentId: null,
											timestamp: "2026-01-01T00:00:01.000Z",
											kind: "message" as const,
											role: "assistant" as const,
											text: STREAMED_FINAL,
										},
									],
						},
					},
				},
			}),
		);
		const lateDelta = Promise.withResolvers<{
			ok: true;
			data: {
				events: Array<{
					seq: number;
					kind: "message_update";
					payload: { conversationId: string; text: string };
				}>;
			};
		}>();
		let subscription = 0;
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription === 1) {
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{ seq: 1, kind: "message_start", payload: { conversationId: "conversation-1" } },
							{
								seq: 2,
								kind: "message_update",
								payload: { conversationId: "conversation-1", text: STREAM_ONE },
							},
						],
					},
				});
			}
			if (subscription === 2) {
				committed = true;
				return Promise.resolve({
					ok: true as const,
					data: {
						events: [
							{
								seq: 3,
								kind: "message_update",
								payload: { conversationId: "conversation-1", text: STREAM_TWO },
							},
							{
								seq: 4,
								kind: "message_end",
								payload: { conversationId: "conversation-1", text: STREAMED_FINAL },
							},
							{
								seq: 5,
								kind: "message.assistant_committed",
								payload: {
									conversationId: "conversation-1",
									messageId: "assistant-message-1",
									versionId: "assistant-version-1",
								},
							},
						],
					},
				});
			}
			// The refetch from message_end re-enters the subscription loop; the
			// live loop parks here so the stale delta can be delivered later.
			if (subscription >= 3) return lateDelta.promise;
			return new Promise<never>(() => {});
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(screen.getAllByText(STREAMED_FINAL)).toHaveLength(1));
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();

		// The settled turn still emits one last cumulative delta in the native
		// Pi flow; the persisted final projection supersedes it, so the status
		// must not come back and the content must not render twice.
		lateDelta.resolve({
			ok: true,
			data: {
				events: [
					{
						seq: 6,
						kind: "message_update",
						payload: { conversationId: "conversation-1", text: STREAMED_FINAL },
					},
				],
			},
		});
		await waitFor(() => expect(screen.getAllByText(STREAMED_FINAL)).toHaveLength(1));
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
	});
});
