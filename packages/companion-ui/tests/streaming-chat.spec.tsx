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
					messages: [],
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
	it("renders raw current_user_message text from a reopened Host-framed Pi projection and keeps capture on its Pi entry", async () => {
		const user = userEvent.setup();
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
		const userVersionId = `${userEntryId}-v1`;
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
						conversations: [],
						messages: [
							{
								id: userEntryId,
								role: "user" as const,
								adoptedVersionId: userVersionId,
								createdAt: "2026-01-01T00:00:01.000Z",
								versions: [
									{
										id: userVersionId,
										role: "user" as const,
										content: rawUserText,
										editedByUser: false,
										createdAt: "2026-01-01T00:00:01.000Z",
										adopted: true,
									},
								],
							},
						],
					},
				},
			};
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(screen.getByText(rawUserText)).toBeInTheDocument());
		expect(screen.queryByText(framedPrompt)).not.toBeInTheDocument();

		const message = screen.getByText(rawUserText).closest("article");
		expect(message).not.toBeNull();
		await user.click(within(message as HTMLElement).getByRole("button", { name: zhCN.messages.operations }));
		await user.click(within(message as HTMLElement).getByRole("button", { name: "记住这一刻" }));
		await waitFor(() => expect(client.memory.capture).toHaveBeenCalledWith(userEntryId));
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
						messages: !assistantCommitted
							? []
							: [
									{
										id: "assistant-message-1",
										role: "assistant" as const,
										adoptedVersionId: "assistant-version-1",
										createdAt: "2026-01-01T00:00:01.000Z",
										versions: [
											{
												id: "assistant-version-1",
												role: "assistant" as const,
												content: STREAMED_REPLY,
												editedByUser: false,
												createdAt: "2026-01-01T00:00:01.000Z",
												adopted: true,
											},
										],
									},
								],
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

		await screen.findByRole("button", { name: zhCN.messages.continue });
		await waitFor(() => expect(screen.getAllByText(STREAMED_REPLY)).toHaveLength(1));
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
		expect(client.snapshot.get).toHaveBeenCalled();
	});

	it("clears the streaming draft when the projection carries a Pi entry id, not the legacy message id", async () => {
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
						messages: !committed
							? []
							: [
									{
										id: "pi:entry-assistant-9",
										role: "assistant" as const,
										adoptedVersionId: "pi:entry-assistant-9-v1",
										createdAt: "2026-01-01T00:00:01.000Z",
										versions: [
											{
												id: "pi:entry-assistant-9-v1",
												role: "assistant" as const,
												content: STREAMED_REPLY,
												editedByUser: false,
												createdAt: "2026-01-01T00:00:01.000Z",
												adopted: true,
											},
										],
									},
								],
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

		await screen.findByRole("button", { name: zhCN.messages.continue });
		await waitFor(() => expect(screen.getAllByText(STREAMED_REPLY)).toHaveLength(1));
		expect(
			screen.queryByRole("status", { name: zhCN.messages.responding }),
		).not.toBeInTheDocument();
	});
});
