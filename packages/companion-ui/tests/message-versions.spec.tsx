import { zhCN } from "@bear-harness/i18n/locales";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
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
						id: "user-1",
						parentId: "root",
						timestamp: "2025-12-31T23:59:58.000Z",
						message: { role: "user" as const, content: "First question", timestamp: 0 },
					},
					{
						type: "message" as const,
						id: "assistant-1",
						parentId: "user-1",
						timestamp: "2025-12-31T23:59:59.000Z",
						message: {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "First reply" }],
							provider: "test",
							model: "test",
							timestamp: 1,
							stopReason: "stop" as const,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
						},
					},
					{
						type: "message" as const,
						id: "user-2",
						parentId: "assistant-1",
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

		const firstUser = (await screen.findByText("First question")).closest("article") as HTMLElement;
		const firstAssistant = screen.getByText("First reply").closest("article") as HTMLElement;
		const latestUser = screen.getByText("Hello").closest("article") as HTMLElement;
		const message = screen.getByText("Second reply").closest("article") as HTMLElement;
		expect(within(firstUser).queryByRole("button", { name: zhCN.messages.edit })).toBeNull();
		expect(
			within(firstAssistant).queryByRole("button", { name: zhCN.messages.regenerate }),
		).toBeNull();
		expect(within(firstAssistant).queryByRole("button", { name: "Correct" })).toBeNull();
		expect(within(firstAssistant).queryByRole("button", { name: zhCN.messages.branch })).toBeNull();
		expect(within(firstAssistant).getByRole("button", { name: zhCN.messages.copy })).toBeVisible();
		expect(within(latestUser).getByRole("button", { name: zhCN.messages.edit })).toBeVisible();
		expect(within(message).getByRole("button", { name: zhCN.messages.regenerate })).toBeVisible();
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		await user.click(within(firstAssistant).getByRole("button", { name: zhCN.messages.copy }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("First reply"));
		expect(
			within(firstAssistant).getByRole("button", { name: zhCN.messages.copied }),
		).toBeVisible();
		if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		else Reflect.deleteProperty(navigator, "clipboard");
		await user.click(within(message).getByRole("button", { name: "Correct" }));
		await user.click(within(message).getByRole("menuitem", { name: "Voice" }));
		await waitFor(() =>
			expect(client.message.regenerate).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "assistant-2",
				feedback: "Voice",
			}),
		);
		await user.click(within(message).getByRole("button", { name: zhCN.messages.branch }));
		await waitFor(() =>
			expect(client.message.branch).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "assistant-2",
			}),
		);
		await waitFor(() => expect(screen.queryByText("Second reply")).toBeNull());

		cleanup();
		const { client: failingClient } = createTestClient();
		failingClient.snapshot.get = client.snapshot.get;
		failingClient.conversation.open = client.conversation.open;
		failingClient.conversation.list = client.conversation.list;
		failingClient.message.branch = vi.fn(() => Promise.reject(new Error("fork unavailable")));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={failingClient} />);
		const sourceMessage = (await screen.findByText("Second reply")).closest(
			"article",
		) as HTMLElement;
		await user.click(within(sourceMessage).getByRole("button", { name: zhCN.messages.branch }));
		expect(await within(sourceMessage).findByRole("alert")).toHaveTextContent("fork unavailable");
		expect(screen.getByText("Second reply")).toBeVisible();
	});
});
