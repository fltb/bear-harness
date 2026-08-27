import type { CompanionClient } from "@bear-harness/companion-client";
import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const STREAMED_REPLY = "我是季舟。";
const SESSION_ID = "session-1";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	eventSeq: 0,
	stateData: { schema_version: 1 as const, flow_version: 1, answers: {}, decisions: {} },
};

function mirrorSnapshotActiveGet(client: CompanionClient): void {
	client.conversation.activeGet = vi.fn(async () => {
		const snapshot = await client.snapshot.get();
		if (!snapshot.ok) return snapshot;
		const conversation = snapshot.data.conversation;
		const activeConversationId = conversation?.activeConversationId;
		if (activeConversationId === undefined) return { ok: true as const, data: {} };
		return {
			ok: true as const,
			data: {
				conversation: {
					activeConversationId,
					...(conversation.activeBranchId === undefined
						? {}
						: { activeBranchId: conversation.activeBranchId }),
					id: conversation.id ?? activeConversationId,
					title: conversation.title ?? "",
					sceneTitle: conversation.sceneTitle ?? "",
					piTimeline: conversation.piTimeline ?? { entries: [] },
				},
			},
		};
	});
}

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
	mirrorSnapshotActiveGet(fixture.client);
	fixture.client.onboarding.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
	);
	return fixture;
}

/** A full active projection with the Pi native session identity. */
function liveProjection(overrides: {
	entries?: unknown[];
	live?: {
		isStreaming: boolean;
		streamingMessage?: { text?: string; stopReason: string; errorMessage?: string };
		errorMessage?: string;
	};
}) {
	return {
		activeConversationId: "conversation-1",
		id: "conversation-1",
		title: "Streaming",
		sceneTitle: "Scene",
		piTimeline: { entries: overrides.entries ?? [] },
		piSessionId: SESSION_ID,
		piLiveState: { isStreaming: false, ...overrides.live },
	};
}

function neverSettle(): Promise<never> {
	const { promise } = Promise.withResolvers<never>();
	return promise;
}

function userEntry(id: string, text: string) {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		kind: "message" as const,
		role: "user" as const,
		text,
	};
}

function assistantEntry(id: string, text: string) {
	return {
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:02.000Z",
		kind: "message" as const,
		role: "assistant" as const,
		text,
	};
}

function sessionChanged(seq: number) {
	return {
		seq,
		kind: "pi.session.changed" as const,
		payload: {
			conversationId: "conversation-1",
			sessionId: SESSION_ID,
			reason: "message" as const,
		},
	};
}

describe("Pi-projection chat", () => {
	it("shows no optimistic message while the Pi preflight is pending", async () => {
		const user = userEvent.setup();
		const { client } = activeClient();
		const sendGate = Promise.withResolvers<{
			ok: true;
			data: { accepted: true; sessionId: string };
		}>();
		client.message.send = vi.fn(() => sendGate.promise);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const composer = await screen.findByRole("textbox", {
			name: zhCN.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "你是谁？");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		// The renderer never creates a message: no user article and no
		// responding status before the Pi preflight accepts the send.
		const thread = screen.getByRole("region", { name: zhCN.messages.conversation });
		expect(within(thread).queryAllByRole("article")).toHaveLength(0);
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
		expect(composer).toHaveValue("你是谁？");
		sendGate.resolve({ ok: true, data: { accepted: true, sessionId: SESSION_ID } });
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
		const failure = await within(thread).findByRole("article", {
			name: `${zhCN.messages.toolActivity.generic} failed`,
		});
		expect(failure).toHaveTextContent(zhCN.messages.toolActivity.generic);
		expect(failure).toHaveTextContent(zhCN.messages.toolActivity.failed);
	});
	it("renders a persisted assistant provider failure after streaming settles", async () => {
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
						piTimeline: {
							entries: [
								{
									id: "provider-failure",
									parentId: null,
									timestamp: "2026-01-01T00:00:00.000Z",
									kind: "message",
									role: "assistant",
									stopReason: "error",
									errorMessage: "Model is unavailable",
								},
							],
						},
					},
				},
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });
		expect(await within(thread).findByRole("alert")).toHaveTextContent("Model is unavailable");
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
						id: "conversation-1",
						title: "Internal only",
						sceneTitle: "Scene",
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

		await waitFor(() => expect(client.conversation.activeGet).toHaveBeenCalled());
		expect(within(thread).queryByText("仅供内部使用的工具结果")).not.toBeInTheDocument();
		expect(within(thread).queryAllByRole("article")).toHaveLength(0);
		expect(thread.children).toHaveLength(0);
	});

	it("renders the Pi live partial assistant then the native timeline on completion", async () => {
		const { client } = activeClient();
		let projection = liveProjection({});
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { conversation: projection } }),
		);
		let subscription = 0;
		const completionGate = Promise.withResolvers<void>();
		client.events.subscribe = vi.fn(() => {
			subscription += 1;
			if (subscription === 1) {
				// Pi accepted the message: the native user entry is durable and
				// the assistant text is streaming.
				projection = liveProjection({
					entries: [userEntry("pi:user-1", "你是谁？")],
					live: {
						isStreaming: true,
						streamingMessage: { text: "我是", stopReason: "pending" },
					},
				});
				return Promise.resolve({
					ok: true as const,
					data: { events: [sessionChanged(1)] },
				});
			}
			if (subscription === 2) {
				// Hold completion until the live projection has been observed.
				return completionGate.promise.then(() => {
					projection = liveProjection({
						entries: [
							userEntry("pi:user-1", "你是谁？"),
							assistantEntry("pi:assistant-1", STREAMED_REPLY),
						],
						live: { isStreaming: false },
					});
					return {
						ok: true as const,
						data: { events: [sessionChanged(2)] },
					};
				});
			}
			return neverSettle();
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		// The user entry and the partial assistant both come from the Pi
		// projection; the renderer creates no message of its own.
		await waitFor(() => expect(screen.getByText("你是谁？")).toBeInTheDocument());
		expect(screen.getByText("我是")).toBeInTheDocument();
		expect(screen.getByRole("status", { name: zhCN.messages.responding })).toBeInTheDocument();
		completionGate.resolve();

		// Completion: exactly one persisted assistant article, no partial, no
		// responding status, and no duplicated user entry.
		await waitFor(() => expect(screen.getAllByText(STREAMED_REPLY)).toHaveLength(1));
		expect(screen.queryByText("我是")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
		const thread = screen.getByRole("region", { name: zhCN.messages.conversation });
		expect(within(thread).getAllByRole("article")).toHaveLength(2);
		expect(within(thread).queryByText("你是谁？")).toBeInTheDocument();
	});

	it("renders the Pi final error message from the live state", async () => {
		const { client } = activeClient();
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversation: liveProjection({
						live: {
							isStreaming: false,
							streamingMessage: {
								text: "",
								stopReason: "error",
								errorMessage: "provider unavailable",
							},
						},
					}),
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });
		await waitFor(() =>
			expect(within(thread).getByRole("alert")).toHaveTextContent("provider unavailable"),
		);
	});

	it("turns an aborted provider error into a recoverable user-facing state", async () => {
		const { client } = activeClient();
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversation: liveProjection({
						entries: [
							{
								...assistantEntry("pi:assistant-aborted", ""),
								stopReason: "aborted" as const,
								errorMessage: "Request was aborted",
							},
						],
					}),
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const thread = await screen.findByRole("region", { name: zhCN.messages.conversation });
		await waitFor(() =>
			expect(within(thread).getByRole("alert")).toHaveTextContent(zhCN.messages.responseStopped),
		);
		expect(within(thread).queryByText("Request was aborted")).not.toBeInTheDocument();
	});

	it("confirms a captured memory on the message action itself", async () => {
		const user = userEvent.setup();
		const { client } = activeClient();
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversation: liveProjection({
						entries: [userEntry("pi:user-memory", "请记住我的偏好")],
					}),
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const operations = await screen.findByRole("button", { name: zhCN.messages.operations });
		expect(operations).toHaveAttribute("aria-expanded", "false");
		await user.click(operations);
		expect(operations).toHaveAttribute("aria-expanded", "true");
		await user.click(operations);
		expect(operations).toHaveAttribute("aria-expanded", "false");
		const action = await screen.findByRole("button", { name: zhCN.messages.rememberMoment });
		await user.click(action);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: zhCN.messages.rememberedMoment })).toBeDisabled(),
		);
		expect(client.memory.capture).toHaveBeenCalledWith({
			conversationId: "conversation-1",
			entryId: "pi:user-memory",
		});
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
});
