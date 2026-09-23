import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import userEvent from "@testing-library/user-event";
import { strToU8, zipSync } from "fflate";
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
			settings: { data: () => ({ memoryVectorService: { enabled: false } }) },
			characters: {
				memoryGet: vi.fn(async () => ({ enabled: false })),
				memorySet: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				characters: () => [
					{
						id: "imported-role",
						name: "Imported Role",
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
			<QueryClientProvider client={new QueryClient()}>
				<DesktopProvider store={store}>
					<Backstage open initialTab="roles" onClose={() => undefined} />
				</DesktopProvider>
			</QueryClientProvider>
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

	it("switches the displayed character while another character is streaming", async () => {
		const user = userEvent.setup();
		const activate = vi.fn(() => Promise.resolve());
		const store = {
			embedding: createEmbeddingBinding() as never,
			settings: { data: () => ({ memoryVectorService: { enabled: false } }) },
			model: {
				models: () => [],
				data: () => ({ defaults: { vision: { mode: "auto" }, onboardingComplete: true } }),
			},
			activePiLiveState: {
				isStreaming: true,
				isRetrying: false,
				retryAttempt: 0,
				isCompacting: false,
				pendingToolCallIds: [],
				steering: [],
				followUp: [],
			},
			characters: {
				memoryGet: vi.fn(async () => ({ enabled: false })),
				memorySet: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				observeTrust: () => ({
					data: () => ({
						trust: {
							origin: "official" as const,
							pluginHash: "",
							pluginsPresent: false,
							trusted: true,
						},
					}),
					loading: () => false,
					error: () => null,
				}),
				pluginTrustData: () => ({
					origin: "official" as const,
					pluginHash: "",
					pluginsPresent: false,
					trusted: true,
				}),
				characters: () => [
					{
						id: THEMED_CHARACTER.id,
						name: THEMED_CHARACTER.name,
						subtitle: THEMED_CHARACTER.character.subtitle,
						avatarUrl: THEMED_CHARACTER.visual.avatarUrl,
						active: true,
					},
					{
						id: "target-character",
						name: "Target Character",
						subtitle: "Target subtitle",
						avatarUrl: THEMED_CHARACTER.visual.avatarUrl,
						active: false,
					},
				],
				activate,
			},
			character: THEMED_CHARACTER,
		} as unknown as CompanionStore;

		render(() => (
			<QueryClientProvider client={new QueryClient()}>
				<DesktopProvider store={store}>
					<Backstage open initialTab="roles" onClose={() => undefined} />
				</DesktopProvider>
			</QueryClientProvider>
		));

		const backstage = await screen.findByRole("dialog", {
			name: zhCN.sidebar.characterSettings,
		});
		const switchButton = within(backstage).getByRole("button", {
			name: zhCN.backstage.roleSwitch,
		});
		await user.click(switchButton);
		await waitFor(() => expect(activate).toHaveBeenCalledWith("target-character"));
		expect(activate).toHaveBeenCalledTimes(1);
		expect(store.activePiLiveState.isStreaming).toBe(true);
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
	});

	it("opens character and system settings as distinct destinations and imports a ZIP package", async () => {
		const user = userEvent.setup();
		const importPackage = vi.fn(() => Promise.resolve());
		const store = {
			embedding: createEmbeddingBinding() as never,
			characters: {
				memoryGet: vi.fn(async () => ({ enabled: false })),
				memorySet: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				characters: () => [],
				activate: vi.fn(),
				import: importPackage,
			},
			settings: {
				data: () => ({ memoryVectorService: { enabled: false }, networkProxy: { mode: "direct" } }),
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
			<QueryClientProvider client={new QueryClient()}>
				<DesktopProvider store={store}>
					<Backstage open initialTab="roles" onClose={() => undefined} />
				</DesktopProvider>
			</QueryClientProvider>
		));
		const characterDialog = await screen.findByRole("dialog", {
			name: zhCN.sidebar.characterSettings,
		});
		expect(within(characterDialog).queryByRole("tablist")).not.toBeInTheDocument();
		const input = within(characterDialog).getByLabelText(zhCN.backstage.roleImportInput, {
			selector: "input",
		});
		const manifest = new File(
			[zipSync({ "imported/character.yaml": strToU8("id: imported") })],
			"imported.zip",
			{ type: "application/zip" },
		);
		await user.upload(input, manifest);
		expect(importPackage).toHaveBeenCalledWith(manifest);
		characterView.unmount();

		const closeSystemSettings = vi.fn();
		render(() => (
			<QueryClientProvider client={new QueryClient()}>
				<DesktopProvider store={store}>
					<Backstage open initialTab="settings" onClose={closeSystemSettings} />
				</DesktopProvider>
			</QueryClientProvider>
		));
		const systemDialog = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
		expect(within(systemDialog).queryByRole("tablist")).not.toBeInTheDocument();
		await user.click(within(systemDialog).getByRole("button", { name: zhCN.backstage.close }));
		expect(closeSystemSettings).toHaveBeenCalledOnce();
	});

	it("does not expose package media in the lightweight character settings view", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({ matches: true })),
		);
		const character = {
			...THEMED_CHARACTER,
			media: [
				{
					id: "animation",
					kind: "animation" as const,
					label: "极光信号",
					description: "极光中的信号。",
					use_when: "需要展示信号时",
					loop: true,
					url: "data:image/webp;base64,YW5pbWF0aW9u",
					posterUrl: "data:image/png;base64,cG9zdGVy",
				},
			],
		};
		const store = {
			embedding: createEmbeddingBinding() as never,
			settings: {
				data: () => ({
					relationshipMemoryEnabled: false,
					networkProxy: { mode: "direct" as const },
					memoryVectorService: { enabled: false, provider: "none" as const },
					modelDownloadSource: { type: "official" },
				}),
				get: vi.fn(() =>
					Promise.resolve({
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: { enabled: false, provider: "none" as const },
						modelDownloadSource: { type: "official" },
					}),
				),
				set: vi.fn(() => Promise.resolve()),
			},
			characters: {
				memoryGet: vi.fn(async () => ({ enabled: false })),
				memorySet: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
				observePackage: () => ({ data: () => undefined, loading: () => false, error: () => null }),
				characters: () => [],
			},
			character,
		} as unknown as CompanionStore;
		render(() => (
			<QueryClientProvider client={new QueryClient()}>
				<DesktopProvider store={store}>
					<Backstage open onClose={() => undefined} />
				</DesktopProvider>
			</QueryClientProvider>
		));
		const dialog = await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings });
		expect(
			within(dialog).queryByRole("tab", { name: zhCN.currentRolePackage.storageTab }),
		).not.toBeInTheDocument();
	});
});
