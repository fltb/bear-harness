import { setProductLocale } from "@bear-harness/i18n";
import { en, zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

describe("idle homepage (official config, no bridge)", () => {
	it("renders the localized app identity and shell frame", async () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(document.title).toBe(zhCN.shell.productName);
		expect(screen.getByRole("application", { name: zhCN.shell.productName })).toBeInTheDocument();
		// Without a bridge, character data is absent — the shell shows the
		// scene area and accessible controls but no character-specific copy.
		expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
		expect(screen.getByPlaceholderText(zhCN.shell.fallbackComposerPlaceholder)).toBeInTheDocument();

		await setProductLocale("en");

		await waitFor(() => expect(document.title).toBe(en.shell.productName));
		expect(screen.getByRole("application", { name: en.shell.productName })).toBeInTheDocument();
	});

	it("loads providers and requires a reply model before the first meeting", async () => {
		const { client, conversationList, providerList } = createTestClient();
		const activeOnboarding = {
			status: "active" as const,
			stateData: { answers: {}, decisions: {} },
		};
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					onboarding: activeOnboarding,
					model: { pool: { models: [] }, defaults: { vision: { mode: "auto" } } },
				},
			}),
		);
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { models: [] } }),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { vision: { mode: "auto" as const } } }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: activeOnboarding }),
		);
		client.settings.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					settings: {
						firstRunStage: "model" as const,
						relationshipMemoryEnabled: false,
						networkProxy: { mode: "direct" as const },
						memoryVectorService: { enabled: false, provider: "none" as const },
						modelDownloadSource: { type: "official" as const },
					},
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await waitFor(() => expect(conversationList).toHaveBeenCalled());
		await waitFor(() => expect(providerList).toHaveBeenCalled());
		expect(
			await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).toBeInTheDocument();
	});

	it("keeps the shell with accessibility landmarks", () => {
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(
			screen.getByRole("navigation", { name: zhCN.sidebar.conversations }),
		).toBeInTheDocument();
		expect(screen.getByRole("searchbox", { name: zhCN.sidebar.search })).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.sidebar.characterSettings })).toBeEnabled();
		expect(screen.getByRole("button", { name: zhCN.sidebar.systemSettings })).toBeEnabled();
	});

	it("opens the backstage sheet from the sidebar", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const backstage = screen.getByRole("button", { name: zhCN.sidebar.characterSettings });
		expect(backstage).toBeEnabled();
		await user.click(backstage);
		expect(
			await screen.findByRole("dialog", { name: zhCN.sidebar.characterSettings }),
		).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: zhCN.backstage.roleManagement })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: zhCN.backstage.close }));
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: zhCN.sidebar.characterSettings }),
			).not.toBeInTheDocument(),
		);
		await user.click(
			screen.getByRole("button", { name: zhCN.sidebar.systemSettings, hidden: true }),
		);
		const settings = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
		await user.click(
			within(settings).getByRole("button", { name: zhCN.settings.systemModelSettings }),
		);
		expect(
			screen.getByRole("region", { name: zhCN.settings.providerSetupLabel }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: zhCN.settings.addModel })).not.toBeInTheDocument();
	});

	it("switches the interface language from the settings workbench", async () => {
		await setProductLocale("zh-CN");
		const user = userEvent.setup();
		const { client } = createTestClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
		const settings = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
		await user.click(within(settings).getByRole("button", { name: zhCN.settings.language }));
		const languageSettings = within(settings).getByRole("region", {
			name: zhCN.settings.language,
		});
		await selectKobalteOption(user, within(languageSettings).getByRole("button"), "en");

		await waitFor(() => expect(document.title).toBe(en.shell.productName));
		await setProductLocale("zh-CN");
	});

	it("applies role theme tokens and warns without blocking on a language mismatch", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					character: THEMED_CHARACTER,
					model: {
						models: [
							{
								providerId: "test-provider",
								modelId: "test-model",
								label: "Test Model",
								supportsImages: true,
								createdAt: "2026-01-01 00:00:00",
							},
						],
					},
				},
			}),
		);
		Object.defineProperty(window.navigator, "languages", {
			configurable: true,
			value: ["en-US"],
		});

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const warning = await screen.findByRole("status");
		expect(warning).toHaveTextContent("ja-JP");
		expect(warning).toHaveTextContent("zh-CN");
		const app = screen.getByRole("application", { name: zhCN.shell.productName });
		expect(app?.style.getPropertyValue("--sys-accent")).toBe("#42c7a5");
		expect(screen.getByPlaceholderText("Message")).toBeInTheDocument();
		expect(warning).not.toHaveAttribute("aria-modal");

		await user.click(screen.getByRole("button", { name: zhCN.language.dismiss }));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
