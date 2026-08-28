import { zhCN } from "@bear-harness/i18n/locales";
import { Button } from "@kobalte/core/button";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backstage } from "../src/features/Backstage.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { createEmbeddingBinding, THEMED_CHARACTER } from "./fixtures.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

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
			embedding: createEmbeddingBinding() as never,
			memory: {
				revision: () => 0,
				search: vi.fn(() => Promise.resolve([])),
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
				candidateState: () => ({ candidates: [], loading: false, error: null }),
				observeCandidates: () => ({
					data: () => ({ candidates: [] }),
					loading: () => false,
					error: () => null,
				}),
				listState: () => ({ entries: [], loading: false, error: null }),
				observeList: () => ({
					data: () => ({ entries: [] }),
					loading: () => false,
					error: () => null,
				}),
			},
			characters: {
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
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
				observeTrust: () => ({
					data: () => ({
						trust: {
							origin: "imported",
							pluginHash: "a".repeat(64),
							pluginsPresent: true,
							trusted: false,
						},
					}),
					loading: () => false,
					error: () => null,
				}),
				pluginTrustData: () => ({
					origin: "imported",
					pluginHash: "a".repeat(64),
					pluginsPresent: true,
					trusted: false,
				}),
				confirmPluginTrust,
			},
			character: THEMED_CHARACTER,
		} as unknown as CompanionStore;

		render(() => (
			<DesktopProvider store={store}>
				<Backstage open initialTab="roles" onClose={() => undefined} />
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

	it("opens character and system settings as distinct destinations and imports a package folder", async () => {
		const user = userEvent.setup();
		const importPackage = vi.fn(() => Promise.resolve());
		const store = {
			embedding: createEmbeddingBinding() as never,
			memory: {
				search: vi.fn(() => Promise.resolve([])),
				revision: () => 0,
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
				candidateState: () => ({ candidates: [], loading: false, error: null }),
				observeCandidates: () => ({
					data: () => ({ candidates: [] }),
					loading: () => false,
					error: () => null,
				}),
				listState: () => ({ entries: [], loading: false, error: null }),
				observeList: () => ({
					data: () => ({ entries: [] }),
					loading: () => false,
					error: () => null,
				}),
			},
			characters: {
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				characters: () => [],
				activate: vi.fn(),
				import: importPackage,
			},
			settings: {
				data: () => ({ relationshipMemoryEnabled: false, networkProxy: { mode: "direct" } }),
				get: vi.fn(),
			},
			provider: { list: vi.fn(() => Promise.resolve({ providers: [] })), providers: () => [] },
			model: {
				list: vi.fn(() => Promise.resolve({ models: [] })),
				models: () => [],
				data: () => ({ defaults: { vision: { mode: "auto" } } }),
			},
			character: THEMED_CHARACTER,
		} as unknown as CompanionStore;

		const characterView = render(() => (
			<DesktopProvider store={store}>
				<Backstage open initialTab="roles" onClose={() => undefined} />
			</DesktopProvider>
		));
		const characterDialog = await screen.findByRole("dialog", {
			name: zhCN.sidebar.characterSettings,
		});
		expect(
			within(characterDialog).getByRole("tab", { name: zhCN.backstage.roleManagement }),
		).toHaveAttribute("data-selected");
		const input = within(characterDialog).getByLabelText(zhCN.backstage.roleImportInput, {
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
				<Backstage open initialTab="settings" onClose={closeSystemSettings} />
			</DesktopProvider>
		));
		const systemDialog = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
		expect(within(systemDialog).queryByRole("tablist")).not.toBeInTheDocument();
		await user.click(within(systemDialog).getByRole("button", { name: zhCN.backstage.close }));
		expect(closeSystemSettings).toHaveBeenCalledOnce();
	});

	it("does not expose roleplay state in the global character settings", async () => {
		const user = userEvent.setup();
		vi.stubGlobal("matchMedia", undefined);
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
						presentation: "dialog",
						url: "data:image/webp;base64,UklGRg==",
						posterUrl: "data:image/png;base64,cG9zdGVy",
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
			embedding: createEmbeddingBinding() as never,
			roleplay: { values: { trust: 4 }, unlocked: ["night_memory"] },
			memory: {
				search: vi.fn(() => Promise.resolve([])),
				revision: () => 0,
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
				candidateState: () => ({ candidates: [], loading: false, error: null }),
				observeCandidates: () => ({
					data: () => ({ candidates: [] }),
					loading: () => false,
					error: () => null,
				}),
				listState: () => ({ entries: [], loading: false, error: null }),
				observeList: () => ({
					data: () => ({ entries: [] }),
					loading: () => false,
					error: () => null,
				}),
			},
			settings: {
				data: () => ({ relationshipMemoryEnabled: false, networkProxy: { mode: "direct" } }),
				get: vi.fn(),
			},
			characters: {
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				characters: () => [],
				activate: vi.fn(),
			},
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<Backstage open onClose={() => undefined} />
			</DesktopProvider>
		));
		const dialog = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
		await user.click(within(dialog).getByRole("tab", { name: zhCN.backstage.roleManagement }));
		expect(
			within(dialog).queryByRole("tab", { name: zhCN.currentRolePackage.storageTab }),
		).not.toBeInTheDocument();
	});
	it("does not expose roleplay media in the global character settings", async () => {
		const user = userEvent.setup();
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: true })),
		);
		const character = {
			...THEMED_CHARACTER,
			roleplay: {
				...THEMED_CHARACTER.roleplay,
				media: [
					{
						id: "animation",
						kind: "animation" as const,
						label: "极光信号",
						loop: true,
						presentation: "dialog" as const,
						url: "data:image/webp;base64,YW5pbWF0aW9u",
						posterUrl: "data:image/png;base64,cG9zdGVy",
					},
				],
				unlockables: [
					{
						id: "animation-memory",
						kind: "cg" as const,
						label: "第一夜",
						description: "门后的信号",
						media: "animation",
					},
				],
			},
		};
		const store = {
			embedding: createEmbeddingBinding() as never,
			roleplay: { values: {}, unlocked: ["animation-memory"] },
			settings: {
				data: () => ({
					relationshipMemoryEnabled: false,
					conversationHistoryReadEnabled: false,
					networkProxy: { mode: "direct" as const },
					memoryVectorService: { enabled: false, provider: "none" as const },
					modelDownloadSource: { type: "official" },
				}),
				get: vi.fn(() =>
					Promise.resolve({
						relationshipMemoryEnabled: false,
						conversationHistoryReadEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: { enabled: false, provider: "none" as const },
						modelDownloadSource: { type: "official" },
					}),
				),
				set: vi.fn(() => Promise.resolve()),
			},
			memory: {
				entries: () => [],
				revision: () => 0,
				search: vi.fn(() => Promise.resolve([])),
				list: vi.fn(() => Promise.resolve([])),
				forget: vi.fn(() => Promise.resolve()),
				edit: vi.fn(() => Promise.resolve()),
				exclude: vi.fn(() => Promise.resolve()),
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
				candidateState: () => ({ candidates: [], loading: false, error: null }),
				observeCandidates: () => ({
					data: () => ({ candidates: [] }),
					loading: () => false,
					error: () => null,
				}),
				listState: () => ({ entries: [], loading: false, error: null }),
				observeList: () => ({
					data: () => ({ entries: [] }),
					loading: () => false,
					error: () => null,
				}),
				approveCandidate: vi.fn(() => Promise.resolve()),
				rejectCandidate: vi.fn(() => Promise.resolve()),
			},
			characters: {
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				characters: () => [],
			},
			character,
		} as unknown as CompanionStore;
		render(() => (
			<DesktopProvider store={store}>
				<Backstage open onClose={() => undefined} />
			</DesktopProvider>
		));
		const dialog = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
		await user.click(within(dialog).getByRole("tab", { name: zhCN.backstage.roleManagement }));
		expect(
			within(dialog).queryByRole("tab", { name: zhCN.currentRolePackage.storageTab }),
		).not.toBeInTheDocument();
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
		const [entryRevision, setEntryRevision] = createSignal(0);
		const edit = vi.fn((entryId: string, newText: string) => {
			currentEntries = currentEntries.map((entry) =>
				entry.id === entryId ? { ...entry, text: newText } : entry,
			);
			setEntryRevision((value) => value + 1);
			return Promise.resolve();
		});
		const forget = vi.fn(() => Promise.resolve());
		const store = {
			embedding: createEmbeddingBinding() as never,
			runs: [],
			characters: {
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				characters: () => [],
			},
			memory: {
				revision: () => 0,
				list,
				search,
				edit,
				forget,
				candidates: () => [],
				listCandidates: vi.fn(() => Promise.resolve([])),
				candidateState: () => ({ candidates: [], loading: false, error: null }),
				observeCandidates: () => ({
					data: () => ({ candidates: [] }),
					loading: () => false,
					error: () => null,
				}),
				listState: () => ({ entries: currentEntries, loading: false, error: null }),
				observeList: () => ({
					data: () => {
						entryRevision();
						return { entries: currentEntries };
					},
					loading: () => false,
					error: () => null,
				}),
			},
			character: THEMED_CHARACTER,
		} as unknown as CompanionStore;

		const [backstageOpen, setBackstageOpen] = createSignal(false);
		render(() => (
			<DesktopProvider store={store}>
				<Button type="button" onClick={() => setBackstageOpen(true)}>
					{zhCN.sidebar.characterSettings}
				</Button>
				<Backstage open={backstageOpen()} onClose={() => setBackstageOpen(false)} />
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
			expect(edit).toHaveBeenCalledWith("memory-user", "用户喜欢傍晚散步", undefined);
			expect(forget).toHaveBeenCalledWith("memory-user", undefined);
		});
	});
});
