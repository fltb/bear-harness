import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen } from "@solidjs/testing-library";
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
		const onOpenBackstage = vi.fn();
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const store = {
			activeConversationId: "conversation-1",
			conversations: [
				{
					id: "conversation-1",
					title: "Alpha project",
					sceneTitle: "Workshop",
					unread: true,
					updatedAt: "2026-08-16T00:00:00Z",
				},
				{
					id: "conversation-2",
					title: "Beta notes",
					sceneTitle: "Library",
					unread: false,
					updatedAt: "2026-08-16T00:00:00Z",
				},
			],
			createConversation,
			selectConversation,
			renameConversation,
			archiveConversation,
			deleteConversation,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<Sidebar character={THEMED_CHARACTER} onOpenBackstage={onOpenBackstage} />
			</DesktopProvider>
		));

		const search = screen.getByRole("searchbox", { name: zhCN.sidebar.search });
		await user.keyboard("{Control>}k{/Control}");
		expect(search).toHaveFocus();
		await user.type(search, "alpha");
		expect(screen.getByRole("button", { name: /Alpha project/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.queryByRole("button", { name: /Beta notes/ })).not.toBeInTheDocument();
		expect(screen.getByRole("img", { name: zhCN.sidebar.unreadMessage })).toBeVisible();

		await user.click(screen.getByRole("button", { name: /Alpha project/ }));
		expect(selectConversation).toHaveBeenCalledWith("conversation-1");
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.renameConversation }));
		const rename = screen.getByRole("textbox", { name: zhCN.sidebar.renameConversation });
		await user.clear(rename);
		await user.type(rename, "Renamed project");
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.saveConversation }));
		expect(renameConversation).toHaveBeenCalledWith("conversation-1", "Renamed project");
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.archiveConversation }));
		expect(archiveConversation).toHaveBeenCalledWith("conversation-1");
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.deleteConversation }));
		expect(deleteConversation).toHaveBeenCalledWith("conversation-1");
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.newConversation }));
		expect(createConversation).toHaveBeenCalledOnce();

		await user.click(screen.getByRole("button", { name: zhCN.sidebar.characterSettings }));
		await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
		expect(onOpenBackstage).toHaveBeenNthCalledWith(1, "roles");
		expect(onOpenBackstage).toHaveBeenNthCalledWith(2, "settings");
	});
});
