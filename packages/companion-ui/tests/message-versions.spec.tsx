import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/App.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

describe("Pi message versions", () => {
	it("switches native leaves and sends correction labels through regeneration", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const session = {
			sessionId: "conversation-1",
			name: "Versions",
			timeline: {
				entries: [
					{
						id: "user-2",
						parentId: "root",
						timestamp: "2026-01-01T00:00:00.000Z",
						kind: "message" as const,
						role: "user" as const,
						text: "Hello",
					},
					{
						id: "assistant-2",
						parentId: "user-2",
						timestamp: "2026-01-01T00:00:01.000Z",
						kind: "message" as const,
						role: "assistant" as const,
						text: "Second reply",
						version: { current: 1, leafIds: ["assistant-1", "assistant-2"] },
					},
				],
			},
			live: { isStreaming: false, queuedUserMessages: [] },
		};
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					character: THEMED_CHARACTER,
					model: {
						pool: { models: [] },
						defaults: { vision: { mode: "auto" as const } },
					},
				} as never,
			}),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: session as never }),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessions: [
						{
							id: "conversation-1",
							title: "Versions",
							created: "2026-01-01T00:00:00.000Z",
							modified: "2026-01-01T00:00:01.000Z",
							messageCount: 2,
							firstMessage: "Hello",
						},
					],
				},
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(await screen.findByText("2 / 2")).toBeVisible();
		await user.click(screen.getByRole("button", { name: zhCN.messages.previousVersion }));
		await waitFor(() =>
			expect(client.message.switchVersion).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				leafId: "assistant-1",
			}),
		);

		const message = screen.getByText("Second reply").closest("article") as HTMLElement;
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
