import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/Sidebar.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { THEMED_CHARACTER } from "./fixtures.js";

describe("sidebar conversation journey", () => {
	it("searches and performs every conversation-management action", async () => {
		const user = userEvent.setup();
		const createConversation = vi.fn(() => Promise.resolve());
		const selectConversation = vi.fn(() => Promise.resolve());
		const renameConversation = vi.fn(() => Promise.resolve());
		const archiveConversation = vi.fn(() => Promise.resolve());
		const deleteConversation = vi.fn(() => Promise.resolve());
		const searchConversations = vi.fn(() => Promise.resolve());
		const onOpenBackstage = vi.fn();
		const onNavigate = vi.fn();
		const store = {
			activeConversationId: "conversation-1",
			completedConversationIds: new Set<string>(),
			conversations: [
				{
					conversationId: "conversation-empty",
					name: "",
					created: "2026-08-16T00:00:00Z",
					modified: "2026-08-16T00:00:00Z",
					messageCount: 0,
					firstMessage: "",
					isStreaming: false,
				},
				{
					conversationId: "conversation-1",
					name: "Alpha project",
					created: "2026-08-16T00:00:00Z",
					modified: "2026-08-16T00:00:00Z",
					messageCount: 1,
					firstMessage: "Alpha project",
					isStreaming: false,
				},
				{
					conversationId: "conversation-2",
					name: "Beta notes",
					created: "2026-08-16T00:00:00Z",
					modified: "2026-08-16T00:00:00Z",
					messageCount: 1,
					firstMessage: "Beta notes",
					isStreaming: false,
				},
			],
			archivedConversations: [
				{
					conversationId: "conversation-archived",
					name: "Archived project",
					created: "2026-08-15T00:00:00Z",
					modified: "2026-08-15T00:00:00Z",
					messageCount: 1,
					firstMessage: "Archived project",
					isStreaming: false,
				},
			],
			createConversation,
			selectConversation,
			renameConversation,
			archiveConversation,
			deleteConversation,
			searchConversations,
			model: { models: () => [], data: () => ({}) },
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<Sidebar
					character={THEMED_CHARACTER}
					onOpenBackstage={onOpenBackstage}
					onNavigate={onNavigate}
				/>
			</DesktopProvider>
		));
		await user.click(
			screen.getByRole("button", {
				name: `${zhCN.backstage.close} ${zhCN.sidebar.conversations}`,
			}),
		);
		expect(onNavigate).toHaveBeenCalledOnce();

		const search = screen.getByRole("searchbox", { name: zhCN.sidebar.search });
		await user.keyboard("{Control>}k{/Control}");
		expect(search).toHaveFocus();
		await user.type(search, "alpha");
		await waitFor(() => expect(searchConversations).toHaveBeenCalledWith("alpha"));
		expect(screen.getByRole("button", { name: /Alpha project/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("button", { name: /Beta notes/ })).toBeInTheDocument();
		expect(
			within(screen.getByRole("navigation", { name: zhCN.sidebar.conversations })).getByRole(
				"button",
				{
					name: new RegExp(zhCN.sidebar.newConversation),
				},
			),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /Alpha project/ }));
		expect(selectConversation).toHaveBeenCalledWith("conversation-1");
		const alphaRow = screen.getByText("Alpha project").closest(".nav-item-wrap");
		expect(alphaRow).not.toBeNull();
		await user.click(
			within(alphaRow as HTMLElement).getByRole("button", {
				name: zhCN.sidebar.renameConversation,
			}),
		);
		const rename = screen.getByRole("textbox", {
			name: zhCN.sidebar.renameConversation,
		});
		await user.clear(rename);
		await user.type(rename, "Renamed project");
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.saveConversation }));
		expect(renameConversation).toHaveBeenCalledWith("conversation-1", "Renamed project");
		await user.click(
			within(alphaRow as HTMLElement).getByRole("button", {
				name: zhCN.sidebar.archiveConversationHint,
			}),
		);
		expect(archiveConversation).toHaveBeenCalledWith("conversation-1");
		await user.clear(search);
		expect(
			screen.queryByRole("button", {
				name: zhCN.sidebar.archivedConversations,
			}),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Archived project")).not.toBeInTheDocument();
		const activeRow = screen.getByText("Alpha project").closest(".nav-item-wrap");
		expect(activeRow).not.toBeNull();
		await user.click(
			within(activeRow as HTMLElement).getByRole("button", {
				name: zhCN.sidebar.deleteConversation,
			}),
		);
		const confirmation = screen.getByRole("dialog", {
			name: zhCN.sidebar.deleteConversationTitle,
		});
		expect(confirmation).toHaveTextContent("Alpha project");
		expect(deleteConversation).not.toHaveBeenCalled();
		await user.click(
			within(confirmation).getByRole("button", {
				name: zhCN.sidebar.deleteConversationConfirmAction,
			}),
		);
		expect(deleteConversation).toHaveBeenCalledWith("conversation-1");
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", {
					name: zhCN.sidebar.deleteConversationTitle,
				}),
			).not.toBeInTheDocument(),
		);
		await user.click(await screen.findByTitle(zhCN.sidebar.newConversation));
		expect(createConversation).toHaveBeenCalledOnce();
		expect(onNavigate).toHaveBeenCalledTimes(3);

		await user.click(await screen.findByRole("button", { name: zhCN.sidebar.characterSettings }));
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
		expect(screen.queryByRole("button", { name: /已归档\s*1/ })).not.toBeInTheDocument();
		expect(onOpenBackstage).toHaveBeenNthCalledWith(1, "roles");
		expect(onOpenBackstage).toHaveBeenNthCalledWith(2, "settings");
	});

	it("keeps Cmd/Ctrl+K accessible in the application landmark without hijacking editing contexts", async () => {
		const user = userEvent.setup();
		const store = {
			activeConversationId: null,
			conversations: [],
			searchConversations: vi.fn(() => Promise.resolve()),
			model: { models: () => [], data: () => ({}) },
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<div role="application" aria-label="Companion">
					<Sidebar character={undefined} onOpenBackstage={() => undefined} />
					<button type="button" aria-label="Application shortcut target">
						Application
					</button>
					<form aria-label="editing form">
						<input aria-label="Input" />
						<textarea aria-label="Textarea" />
						<select aria-label="Select">
							<option>One</option>
						</select>
					</form>
					<div role="dialog" aria-label="Dialog">
						<button type="button">Dialog action</button>
					</div>
				</div>
			</DesktopProvider>
		));

		const search = screen.getByRole("searchbox", { name: zhCN.sidebar.search });
		const protectedControls = [
			screen.getByRole("textbox", { name: "Input" }),
			screen.getByRole("textbox", { name: "Textarea" }),
			screen.getByRole("combobox", { name: "Select" }),
			screen.getByRole("button", { name: "Dialog action" }),
		];
		for (const control of protectedControls) {
			await user.click(control);
			await user.keyboard("{Control>}k{/Control}");
			expect(control).toHaveFocus();
			expect(search).not.toHaveFocus();
		}

		expect(screen.getByRole("application", { name: "Companion" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Application shortcut target" }));
		await user.keyboard("{Control>}k{/Control}");
		expect(search).toHaveFocus();
	});
});
