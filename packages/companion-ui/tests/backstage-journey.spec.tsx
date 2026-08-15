import { productUi } from "@bear-harness/product-config";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Backstage } from "../src/features/Backstage.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { THEMED_CHARACTER } from "./fixtures.js";

describe("ordinary-user backstage journey", () => {
	it("switches roles and manages story changes through ordinary-language tabs", async () => {
		const user = userEvent.setup();
		const activate = vi.fn(() => Promise.resolve());
		const apply = vi.fn(() => Promise.resolve());
		const revert = vi.fn(() => Promise.resolve());
		const reset = vi.fn(() => Promise.resolve());
		const store = {
			memory: { search: vi.fn(() => Promise.resolve([])) },
			characters: {
				characters: () => [
					{
						id: "current",
						name: "Current Role",
						version: "1",
						subtitle: "Active",
						avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+",
						active: true,
					},
					{
						id: "other",
						name: "Other Role",
						version: "1",
						subtitle: "Available",
						avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+",
						active: false,
					},
				],
				activate,
			},
			story: {
				changes: () => [
					{
						id: "change-1",
						text: "The meeting happened elsewhere",
						scope: "global",
						source: "user_explicit",
						createdAt: "2026-08-16T00:00:00Z",
					},
				],
				apply,
				revert,
				reset,
			},
		} as unknown as CompanionStore;

		render(() => (
			<DesktopProvider store={store}>
				<Backstage open onClose={() => undefined} character={THEMED_CHARACTER} />
			</DesktopProvider>
		));
		const dialog = await screen.findByRole("dialog", { name: productUi.backstage.title });
		const tabs = within(dialog);
		await user.click(tabs.getByRole("tab", { name: productUi.backstage.roleManagement }));
		await user.click(tabs.getByRole("button", { name: productUi.backstage.roleSwitch }));
		expect(activate).toHaveBeenCalledWith("other");

		await user.click(tabs.getByRole("tab", { name: productUi.backstage.storyArchive }));
		await user.click(tabs.getByRole("button", { name: productUi.backstage.storyUndo }));
		expect(revert).toHaveBeenCalledWith("change-1");
		await user.type(
			tabs.getByRole("textbox", { name: productUi.backstage.storyAddPlaceholder }),
			"A new alternate event",
		);
		await user.click(tabs.getByRole("checkbox", { name: productUi.backstage.storyBranchOnly }));
		await user.click(tabs.getByRole("button", { name: productUi.backstage.storyAdd }));
		expect(apply).toHaveBeenCalledWith("A new alternate event", "branch");
		await user.click(tabs.getByRole("button", { name: productUi.backstage.storyReset }));
		expect(reset).toHaveBeenCalledOnce();
	});
});
