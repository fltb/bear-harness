import { productUi } from "@bear-harness/product-config";
import { render, screen, waitFor } from "@solidjs/testing-library";
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
	fixture.client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				eventSeq: 0,
				onboarding: COMPLETE_ONBOARDING,
				voice: {
					stacks: [
						{
							id: "primary-stack",
							providerId: "e2e-rule",
							modelId: "rule-model",
							revision: 1,
							label: "E2E Rule Provider",
							active: true,
							createdAt: "2026-01-01T00:00:00.000Z",
						},
					],
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
			name: productUi.composer.messageInputLabel,
		});
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "你是谁？");
		await user.click(screen.getByRole("button", { name: productUi.composer.sendLabel }));

		expect(screen.getByText("你是谁？")).toBeInTheDocument();
		expect(screen.getByRole("status", { name: productUi.messages.responding })).toBeInTheDocument();
		resolveSend?.({ ok: true, data: { messageId: "user-message-1" } });
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

		await screen.findByRole("button", { name: productUi.messages.continue });
		await waitFor(() => expect(screen.getAllByText(STREAMED_REPLY)).toHaveLength(1));
		expect(
			screen.queryByRole("status", { name: productUi.messages.responding }),
		).not.toBeInTheDocument();
		expect(client.snapshot.get).toHaveBeenCalled();
	});
});
