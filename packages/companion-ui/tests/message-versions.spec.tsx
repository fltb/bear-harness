import { zhCN } from "@bear-harness/i18n/locales";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/App.js";
import { createTestClient, OFFICIAL_PRODUCT, pushPiEvent, THEMED_CHARACTER } from "./fixtures.js";

describe("Pi message actions", () => {
	it("edits and corrects every native message through authoritative conversation mutations", async () => {
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
			live: { isStreaming: false, pendingToolCallIds: [], steering: [], followUp: [] },
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
		client.conversation.activeGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { activeConversation: session } as never,
			}),
		);
		const correctionRequest = Promise.withResolvers<{
			ok: true;
			data: never;
		}>();
		client.message.correct = vi.fn(() => correctionRequest.promise);
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
		expect(within(firstUser).getByRole("button", { name: zhCN.messages.edit })).toBeVisible();
		expect(within(firstAssistant).getByRole("button", { name: "Correct" })).toBeVisible();
		expect(within(firstAssistant).queryByRole("button", { name: zhCN.messages.branch })).toBeNull();
		expect(within(firstAssistant).getByRole("button", { name: zhCN.messages.copy })).toBeVisible();
		expect(within(latestUser).getByRole("button", { name: zhCN.messages.edit })).toBeVisible();
		expect(within(message).getByRole("button", { name: "Correct" })).toBeVisible();
		await user.click(within(firstUser).getByRole("button", { name: zhCN.messages.edit }));
		const historicalEditor = within(firstUser).getByRole("textbox", {
			name: zhCN.messages.editLabel,
		});
		await user.clear(historicalEditor);
		await user.type(historicalEditor, "Revised first question");
		await user.click(within(firstUser).getByRole("button", { name: zhCN.messages.save }));
		await waitFor(() =>
			expect(client.message.edit).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "user-1",
				text: "Revised first question",
			}),
		);
		expect(screen.getByText("First question")).toBeVisible();
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
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			event: { type: "agent_start" },
		});
		await screen.findByRole("status", { name: zhCN.messages.responding });
		await waitFor(() => expect(document.body.contains(firstAssistant)).toBe(true));
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			event: { type: "agent_settled" },
		});
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: zhCN.messages.responding })).toBeNull(),
		);
		await waitFor(() =>
			expect(
				within(firstAssistant).getByRole("button", { name: zhCN.messages.copied }),
			).toBeVisible(),
		);
		if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		else Reflect.deleteProperty(navigator, "clipboard");
		await user.click(within(message).getByRole("button", { name: "Correct" }));
		await user.click(screen.getByRole("button", { name: "Voice" }));
		await waitFor(() =>
			expect(client.message.correct).toHaveBeenCalledWith({
				conversationId: "conversation-1",
				entryId: "assistant-2",
				feedback: "Voice",
			}),
		);
		expect(
			within(firstUser).getByRole("button", { name: zhCN.messages.edit, hidden: true }),
		).toBeDisabled();
		expect(
			within(message).getByRole("button", { name: zhCN.messages.branch, hidden: true }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: zhCN.composer.attachLabel, hidden: true }),
		).toBeDisabled();
		correctionRequest.resolve({ ok: true, data: session as never });
		await waitFor(() =>
			expect(within(message).getByRole("button", { name: zhCN.messages.branch })).toBeEnabled(),
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
		failingClient.conversation.activeGet = client.conversation.activeGet;
		failingClient.conversation.list = client.conversation.list;
		failingClient.message.branch = vi.fn(() => Promise.reject(new Error("fork unavailable")));
		failingClient.message.correct = vi.fn(() =>
			Promise.reject(new Error("correction unavailable")),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={failingClient} />);
		const sourceMessage = (await screen.findByText("Second reply")).closest(
			"article",
		) as HTMLElement;
		await user.click(within(sourceMessage).getByRole("button", { name: "Correct" }));
		await user.click(screen.getByRole("button", { name: "Voice" }));
		const correctionDialog = screen.getByRole("dialog", { name: "Correct" });
		expect(await within(correctionDialog).findByRole("alert")).toHaveTextContent(
			"correction unavailable",
		);
		expect(within(sourceMessage).getByText("Second reply")).toBeVisible();
		expect(within(correctionDialog).getByRole("button", { name: "Voice" })).toBeVisible();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Correct" })).toBeNull());
		const branchAction = await within(sourceMessage).findByRole("button", {
			name: zhCN.messages.branch,
		});
		await user.click(branchAction);
		expect(await within(sourceMessage).findByRole("alert")).toHaveTextContent("fork unavailable");
		expect(screen.getByText("Second reply")).toBeVisible();
	});
});
