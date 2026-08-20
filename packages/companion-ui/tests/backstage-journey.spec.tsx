import { zhCN } from "@bear-harness/i18n/locales";
import { Button } from "@kobalte/core/button";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Backstage } from "../src/features/Backstage.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { THEMED_CHARACTER } from "./fixtures.js";

describe("ordinary-user backstage journey", () => {
	it("requires an explicit hash review before enabling imported behavior plugins", async () => {
		const user = userEvent.setup();
		const confirmPluginTrust = vi.fn(() => Promise.resolve());
		const pluginTrust = vi.fn(() =>
			Promise.resolve({
				origin: "imported" as const,
				pluginHash: "a".repeat(64),
				pluginsPresent: true,
				trusted: false,
			}),
		);
		const store = {
			memory: {
				revision: () => 0,
				search: vi.fn(() => Promise.resolve([])),
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
			},
			characters: {
				characters: () => [
					{
						id: "imported-role",
						name: "Imported Role",
						version: "1",
						subtitle: "Imported",
						avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+",
						active: false,
					},
				],
				activate: vi.fn(() => Promise.resolve()),
				pluginTrust,
				confirmPluginTrust,
			},
		} as unknown as CompanionStore;

		render(() => (
			<DesktopProvider store={store}>
				<Backstage open initialTab="roles" onClose={() => undefined} character={THEMED_CHARACTER} />
			</DesktopProvider>
		));

		const dialog = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
		await user.click(
			within(dialog).getByRole("button", { name: zhCN.backstage.roleEnablePlugins }),
		);
		const confirmation = await screen.findByRole("dialog", {
			name: zhCN.backstage.rolePluginTrustTitle,
		});
		expect(within(confirmation).getByText("a".repeat(64))).toBeVisible();
		expect(confirmPluginTrust).not.toHaveBeenCalled();
		await user.click(
			within(confirmation).getByRole("button", { name: zhCN.backstage.rolePluginTrustConfirm }),
		);
		expect(confirmPluginTrust).toHaveBeenCalledWith("imported-role");
	});

	it("switches roles and manages story changes through ordinary-language tabs", async () => {
		const user = userEvent.setup();
		const activate = vi.fn(() => Promise.resolve());
		const apply = vi.fn(() => Promise.resolve());
		const revert = vi.fn(() => Promise.resolve());
		const reset = vi.fn(() => Promise.resolve());
		const store = {
			memory: {
				search: vi.fn(() => Promise.resolve([])),
				revision: () => 0,
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
			},
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
		const dialog = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
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
			memory: {
				search: vi.fn(() => Promise.resolve([])),
				revision: () => 0,
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
			},
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
		const characterDialog = await screen.findByRole("dialog", {
			name: zhCN.sidebar.characterSettings,
		});
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
		const systemDialog = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
		expect(within(systemDialog).queryByRole("tablist")).not.toBeInTheDocument();
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
			memory: {
				search: vi.fn(() => Promise.resolve([])),
				revision: () => 0,
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
			},
			settings: { data: () => ({ relationshipMemoryEnabled: false }), get: vi.fn() },
			characters: { characters: () => [], activate: vi.fn() },
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<Backstage open onClose={() => undefined} character={character} />
			</DesktopProvider>
		));
		const dialog = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
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
	it("manages direct memory records with edit and forget", async () => {
		const user = userEvent.setup();
		let currentEntries = [
			{
				id: "memory-user",
				kind: "fact",
				scope: "self" as const,
				text: "用户喜欢清晨散步",
				createdAt: "2026-08-16T00:00:00Z",
				updatedAt: "2026-08-16T00:00:00Z",
				importance: 0.8,
			},
			{
				id: "memory-auto",
				kind: "preference",
				scope: "self" as const,
				text: "用户偏好简短回答",
				createdAt: "2026-08-15T00:00:00Z",
				updatedAt: "2026-08-15T00:00:00Z",
				importance: 0.6,
			},
		];
		const search = vi.fn(() => Promise.resolve(currentEntries));
		const list = vi.fn(() => Promise.resolve(currentEntries));
		const edit = vi.fn((entryId: string, newText: string) => {
			currentEntries = currentEntries.map((entry) =>
				entry.id === entryId ? { ...entry, text: newText } : entry,
			);
			return Promise.resolve();
		});
		const forget = vi.fn(() => Promise.resolve());
		const store = {
			runs: [],
			characters: { characters: () => [] },
			memory: {
				revision: () => 0,
				list,
				search,
				edit,
				forget,
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
			},
		} as unknown as CompanionStore;

		const [backstageOpen, setBackstageOpen] = createSignal(false);
		render(() => (
			<DesktopProvider store={store}>
				<Button type="button" onClick={() => setBackstageOpen(true)}>
					{zhCN.sidebar.characterSettings}
				</Button>
				<Backstage
					open={backstageOpen()}
					onClose={() => setBackstageOpen(false)}
					character={THEMED_CHARACTER}
				/>
			</DesktopProvider>
		));

		await user.click(screen.getByRole("button", { name: zhCN.sidebar.characterSettings }));
		const backstage = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
		await user.click(within(backstage).getByRole("tab", { name: zhCN.backstage.memory }));

		const region = await screen.findByRole("region", { name: zhCN.memory.defaultEntriesTitle });
		const firstMemoryEntry = async () => {
			const currentRegion = await screen.findByRole("region", {
				name: zhCN.memory.defaultEntriesTitle,
			});
			return within(currentRegion).getAllByRole("listitem")[0] as HTMLElement;
		};
		expect(within(region).getByText("用户喜欢清晨散步")).toBeVisible();
		expect(within(region).getByText("用户偏好简短回答")).toBeVisible();

		await user.click(
			within(await firstMemoryEntry()).getByRole("button", {
				name: zhCN.memory.edit,
			}),
		);
		const editor = within(await firstMemoryEntry()).getByRole("textbox", {
			name: zhCN.memory.editedContent,
		});
		await user.clear(editor);
		await user.type(editor, "用户喜欢傍晚散步");
		await user.click(
			within(await firstMemoryEntry()).getByRole("button", {
				name: zhCN.memory.saveEdit,
			}),
		);
		await waitFor(async () => {
			const refreshedRegion = await screen.findByRole("region", {
				name: zhCN.memory.defaultEntriesTitle,
			});
			expect(within(refreshedRegion).getByText("用户喜欢傍晚散步")).toBeVisible();
		});
		await user.click(
			within(await firstMemoryEntry()).getByRole("button", {
				name: zhCN.memory.forget,
			}),
		);

		await waitFor(() => {
			expect(edit).toHaveBeenCalledWith("memory-user", "用户喜欢傍晚散步");
			expect(forget).toHaveBeenCalledWith("memory-user");
		});
	});
});
