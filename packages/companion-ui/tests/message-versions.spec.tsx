import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/App.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

describe("Pi message actions", () => {
	it("sends correction labels through native regeneration", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const session = {
			conversationId: "conversation-1",
			name: "Versions",
			branch: {
				entries: [
					{
						type: "message" as const,
						id: "user-2",
						parentId: "root",
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user" as const, content: "Hello", timestamp: 1 },
					},
					{
						type: "message" as const,
						id: "assistant-2",
						parentId: "user-2",
						timestamp: "2026-01-01T00:00:01.000Z",
						message: {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "Second reply" }],
							provider: "test",
							model: "test",
							timestamp: 2,
							stopReason: "stop" as const,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					},
				],
				hasMoreBefore: false,
			},
			live: { isStreaming: false, steering: [], followUp: [] },
		};
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					onboarding: { status: "complete" as const, stateData: { answers: {}, decisions: {} } },
					character: THEMED_CHARACTER,
				} as never,
			}),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: session as never }),
		);
		client.message.regenerate = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: session as never }),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					conversations: [
						{
							conversationId: "conversation-1",
							name: "Versions",
							created: "2026-01-01T00:00:00.000Z",
							modified: "2026-01-01T00:00:01.000Z",
							messageCount: 2,
							firstMessage: "Hello",
							isStreaming: false,
						},
					],
				},
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const message = (await screen.findByText("Second reply")).closest("article") as HTMLElement;
		await user.click(within(message).getByRole("button", { name: zhCN.messages.operations }));
		await user.click(within(message).getByRole("button", { name: "Correct" }));
		await user.click(within(message).getByRole("button", { name: "Voice" }));
		await waitFor(() =>
			expect(client.message.regenerate).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "assistant-2",
				feedback: "Voice",
			}),
		);
	});
});
