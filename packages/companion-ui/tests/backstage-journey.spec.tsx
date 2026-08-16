import { zhCN } from "@bear-harness/i18n/locales";
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
		const dialog = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		const tabs = within(dialog);
		await user.click(tabs.getByRole("tab", { name: zhCN.backstage.roleManagement }));
		await user.click(tabs.getByRole("button", { name: zhCN.backstage.roleSwitch }));
		expect(activate).toHaveBeenCalledWith("other");

		await user.click(tabs.getByRole("tab", { name: zhCN.backstage.storyArchive }));
		await user.click(tabs.getByRole("button", { name: zhCN.backstage.storyUndo }));
		expect(revert).toHaveBeenCalledWith("change-1");
		await user.type(
			tabs.getByRole("textbox", { name: zhCN.backstage.storyAddPlaceholder }),
			"A new alternate event",
		);
		await user.click(tabs.getByRole("checkbox", { name: zhCN.backstage.storyBranchOnly }));
		await user.click(tabs.getByRole("button", { name: zhCN.backstage.storyAdd }));
		expect(apply).toHaveBeenCalledWith("A new alternate event", "branch");
		await user.click(tabs.getByRole("button", { name: zhCN.backstage.storyReset }));
		expect(reset).toHaveBeenCalledOnce();
	});

	it("opens character and system settings as distinct destinations and imports a package folder", async () => {
		const user = userEvent.setup();
		const importPackage = vi.fn(() => Promise.resolve());
		const store = {
			memory: { search: vi.fn(() => Promise.resolve([])) },
			characters: { characters: () => [], activate: vi.fn(), import: importPackage },
			settings: { data: () => ({ relationshipMemoryEnabled: false }), get: vi.fn() },
			provider: { list: vi.fn(() => Promise.resolve({ providers: [] })), providers: () => [] },
			model: {
				list: vi.fn(() => Promise.resolve({ models: [] })),
				models: () => [],
				data: () => ({ defaults: { vision: { mode: "auto" } } }),
			},
		} as unknown as CompanionStore;

		const characterView = render(() => (
			<DesktopProvider store={store}>
				<Backstage open initialTab="roles" onClose={() => undefined} character={THEMED_CHARACTER} />
			</DesktopProvider>
		));
		const characterDialog = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		expect(
			within(characterDialog).getByRole("tab", { name: zhCN.backstage.roleManagement }),
		).toHaveAttribute("data-selected");
		const input = within(characterDialog).getByLabelText(zhCN.backstage.roleImport, {
			selector: "input",
		});
		const manifest = new File(["id: imported"], "character.yaml", { type: "text/yaml" });
		Object.defineProperty(manifest, "webkitRelativePath", { value: "imported/character.yaml" });
		await user.upload(input, manifest);
		expect(importPackage).toHaveBeenCalledWith([
			expect.objectContaining({ path: "imported/character.yaml", base64: expect.any(String) }),
		]);
		characterView.unmount();

		const closeSystemSettings = vi.fn();
		render(() => (
			<DesktopProvider store={store}>
				<Backstage
					open
					initialTab="settings"
					onClose={closeSystemSettings}
					character={THEMED_CHARACTER}
				/>
			</DesktopProvider>
		));
		const systemDialog = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		expect(
			within(systemDialog).getByRole("tab", { name: zhCN.backstage.systemSettings }),
		).toHaveAttribute("data-selected");
		await user.click(within(systemDialog).getByRole("button", { name: zhCN.backstage.close }));
		expect(closeSystemSettings).toHaveBeenCalledOnce();
	});

	it("shows package-defined relationship levels and only unlocked collection media", async () => {
		const user = userEvent.setup();
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				variables: [
					{
						id: "trust",
						type: "number" as const,
						scope: "relationship" as const,
						initial: 0,
						display: {
							kind: "level" as const,
							label: "信任",
							levels: [
								{ min: 0, label: "谨慎相识" },
								{ min: 3, label: "彼此守望" },
							],
						},
					},
				],
				media: [
					{
						id: "night",
						kind: "animation" as const,
						label: "极光信号",
						loop: true,
						url: "data:image/webp;base64,UklGRg==",
					},
				],
				unlockables: [
					{
						id: "night_memory",
						kind: "cg" as const,
						label: "第一夜",
						description: "门后的信号",
						media: "night",
					},
					{ id: "locked", kind: "memory" as const, label: "未解锁", description: "不可见" },
				],
				choice_sets: [],
			},
		};
		const store = {
			roleplay: { values: { trust: 4 }, unlocked: ["night_memory"] },
			memory: { search: vi.fn(() => Promise.resolve([])) },
			settings: { data: () => ({ relationshipMemoryEnabled: false }), get: vi.fn() },
			characters: { characters: () => [], activate: vi.fn() },
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<Backstage open onClose={() => undefined} character={character} />
			</DesktopProvider>
		));
		const dialog = await screen.findByRole("dialog", { name: zhCN.backstage.title });
		await user.click(within(dialog).getByRole("tab", { name: zhCN.backstage.relationshipArchive }));
		expect(within(dialog).getByText("彼此守望")).toBeVisible();
		await user.click(within(dialog).getByRole("tab", { name: zhCN.backstage.collections }));
		expect(within(dialog).getByText("第一夜")).toBeVisible();
		expect(within(dialog).queryByText("未解锁")).not.toBeInTheDocument();
		expect(within(dialog).getByRole("img", { name: "极光信号" })).toHaveAttribute(
			"src",
			expect.stringMatching(/^data:image\/webp/),
		);
	});
});
