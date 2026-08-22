import { i18n } from "@bear-harness/i18n";
import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PROVIDER = {
	id: "opencode-go",
	name: "OpenCode Go",
	baseUrl: "https://saved.example/v1",
	authType: "api_key" as const,
	credentialStatus: "stored" as const,
	availableModels: [
		{ id: "fast", name: "Fast", supportsImages: false, cost: FREE },
		{ id: "vision", name: "Vision", supportsImages: true, cost: FREE },
	],
	unavailable: [],
};

const OAUTH_PROVIDER = {
	id: "oauth-service",
	name: "OAuth Service",
	authType: "oauth" as const,
	credentialStatus: "missing" as const,
	availableModels: [{ id: "oauth-model", name: "OAuth Model", supportsImages: false, cost: FREE }],
	unavailable: [],
};

function configuredClient() {
	const fixture = createTestClient();
	fixture.client.provider.list = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { providers: [PROVIDER] } }),
	);
	fixture.client.model.poolGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				models: [
					{
						providerId: "opencode-go",
						providerName: "OpenCode Go",
						modelId: "fast",
						label: "Fast",
						supportsImages: false,
						createdAt: "2026-01-01",
					},
				],
			},
		}),
	);
	return fixture;
}

async function openSettings() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
	const backstage = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
	return { user, backstage };
}

function selectTrigger(container: HTMLElement, label: string): HTMLButtonElement {
	const trigger = within(container)
		.getAllByRole("button")
		.find((button) => button.getAttribute("aria-label") === label);
	if (!(trigger instanceof HTMLButtonElement)) throw new Error(`select trigger missing: ${label}`);
	return trigger;
}

describe("model pool settings", () => {
	it("switches and persists the product UI language independently of character packages", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const language = within(backstage).getByRole("button", {
			name: new RegExp(zhCN.settings.language),
		});
		expect(language).toHaveTextContent(zhCN.settings.localeNames["zh-CN"]);

		await selectKobalteOption(user, language, "en");
		await waitFor(() => expect(document.documentElement).toHaveAttribute("lang", "en"));
		expect(localStorage.getItem("bear-harness.product-locale")).toBe("en");
		await waitFor(() => expect(language).toHaveAccessibleName(/Interface language/));

		await selectKobalteOption(user, language, "zh-TW");
		await waitFor(() => expect(document.documentElement).toHaveAttribute("lang", "zh-TW"));
		await waitFor(() => expect(language).toHaveAccessibleName(/介面語言/));

		await selectKobalteOption(user, language, "zh-CN");
		await waitFor(() => expect(document.documentElement).toHaveAttribute("lang", "zh-CN"));
	});
	it("surfaces locale switching failures without changing the canonical locale", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const language = within(backstage).getByRole("button", {
			name: new RegExp(zhCN.settings.language),
		});
		const failure = new Error("translation service unavailable");
		const changeLanguage = vi.spyOn(i18n, "changeLanguage").mockRejectedValueOnce(failure);

		await selectKobalteOption(user, language, "en");
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(failure.message));
		expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
		expect(localStorage.getItem("bear-harness.product-locale")).toBe("zh-CN");
		changeLanguage.mockRestore();
	});

	it("shows configured models, global defaults, and provider presets", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const remove = await waitFor(() =>
			within(backstage).getByRole("button", {
				name: `${zhCN.settings.removeModel} Fast (OpenCode Go)`,
			}),
		);
		expect(remove).toHaveAttribute("data-semantic", "danger");
		const service = within(backstage).getByRole("button", {
			name: new RegExp(zhCN.settings.serviceLabel),
		});
		expect(service).toHaveTextContent(zhCN.settings.chooseService);
		expect(selectTrigger(backstage, zhCN.settings.modelLabel)).toBeDisabled();
		await selectKobalteOption(user, service, "opencode-go");
		const model = selectTrigger(backstage, zhCN.settings.modelLabel);
		expect(model).toBeEnabled();
		await selectKobalteOption(user, model, "vision");
		expect(model).toHaveTextContent("Vision");
		expect(
			within(backstage).getByRole("button", {
				name: new RegExp(zhCN.settings.defaultReplyModel),
			}),
		).toBeEnabled();
		expect(
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.visionModel) }),
		).toHaveTextContent(zhCN.settings.visionModelAuto);
	});

	it("persists reply and vision defaults through their dedicated RPCs", async () => {
		const { client } = configuredClient();
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					models: [
						{
							providerId: "opencode-go",
							providerName: "OpenCode Go",
							modelId: "fast",
							label: "Fast",
							supportsImages: false,
							createdAt: "2026-01-01",
						},
						{
							providerId: "opencode-go",
							providerName: "OpenCode Go",
							modelId: "vision",
							label: "Vision",
							supportsImages: true,
							createdAt: "2026-01-02",
						},
					],
				},
			}),
		);
		client.model.defaultsGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					reply: { providerId: "opencode-go", modelId: "fast" },
					vision: { mode: "auto" as const },
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();

		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", {
				name: new RegExp(zhCN.settings.defaultReplyModel),
			}),
			{ label: "Vision (OpenCode Go)" },
		);
		expect(client.model.defaultsSetReply).toHaveBeenCalledWith({
			reply: { providerId: "opencode-go", modelId: "vision" },
		});

		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.visionModel) }),
			{ label: "Vision (OpenCode Go)" },
		);
		expect(client.model.defaultsSetVision).toHaveBeenCalledWith({
			mode: "manual",
			route: { providerId: "opencode-go", modelId: "vision" },
		});
	});

	it("adds and removes models from the reusable pool", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const service = within(backstage).getByRole("button", {
			name: new RegExp(zhCN.settings.serviceLabel),
		});
		expect(service).toHaveTextContent(zhCN.settings.chooseService);
		await selectKobalteOption(user, service, "opencode-go");
		await waitFor(() => expect(selectTrigger(backstage, zhCN.settings.modelLabel)).toBeEnabled());
		await selectKobalteOption(user, selectTrigger(backstage, zhCN.settings.modelLabel), "vision");
		await user.click(
			within(backstage).getByRole("button", {
				name: zhCN.settings.addModel,
			}),
		);
		expect(client.model.enable).toHaveBeenCalledWith({
			providerId: "opencode-go",
			modelId: "vision",
			label: "Vision",
		});
		await user.click(
			within(backstage).getByRole("button", {
				name: `${zhCN.settings.removeModel} Fast (OpenCode Go)`,
			}),
		);
		expect(client.model.disable).toHaveBeenCalledWith({
			providerId: "opencode-go",
			modelId: "fast",
		});
	});

	it("keeps provider URL override in advanced settings", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", {
				name: new RegExp(zhCN.settings.serviceLabel),
			}),
			"opencode-go",
		);
		await user.click(
			within(backstage).getByRole("button", {
				name: zhCN.settings.advancedToggle,
			}),
		);
		const baseUrlInput = within(backstage).getByPlaceholderText(zhCN.settings.customBaseUrlPlaceholder);
		expect(baseUrlInput).toHaveValue("https://saved.example/v1");
		await user.clear(baseUrlInput);
		await user.type(baseUrlInput, "https://relay.example/v1");
		await user.click(
			within(backstage).getByRole("button", {
				name: zhCN.settings.customSave,
			}),
		);
		expect(client.provider.overrideBaseUrl).toHaveBeenCalledWith({
			providerId: "opencode-go",
			baseUrl: "https://relay.example/v1",
		});
	});

	it("imports native Pi configuration from advanced settings without a model-owned API key", async () => {
		const { client } = configuredClient();
		client.provider.importPiConfig = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					models: [
						{
							providerId: "relay",
							modelId: "custom",
							label: "Custom",
							supportsImages: false,
							createdAt: "2026-01-01",
						},
					],
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.advancedToggle }));
		const configJson = JSON.stringify({
			providers: { relay: { models: [{ id: "custom", name: "Custom" }] } },
		});
		fireEvent.input(within(backstage).getByLabelText(zhCN.settings.piConfigLabel), {
			target: { value: configJson },
		});
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.piConfigImport }));
		expect(client.provider.importPiConfig).toHaveBeenCalledWith({ configJson });
		expect(await within(backstage).findByText("Custom (relay)")).toBeVisible();
		expect(within(backstage).queryByLabelText(zhCN.settings.customApiKey)).not.toBeInTheDocument();
	});

	it("stores credentials at provider scope and preserves the canonical stored-key placeholder", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"opencode-go",
		);
		const keyInput = within(backstage).getByLabelText(zhCN.settings.apiKeyLabel);
		expect(keyInput).toHaveAttribute("placeholder", zhCN.settings.apiKeyStoredPlaceholder);
		await user.type(keyInput, "provider-secret");
		await user.click(
			within(backstage).getByRole("button", {
				name: `${zhCN.settings.saveKey} ${zhCN.settings.apiKeyLabel}`,
			}),
		);
		await waitFor(() =>
			expect(client.provider.setApiKey).toHaveBeenCalledWith({
				providerId: "opencode-go",
				apiKey: "provider-secret",
			}),
		);
		expect(keyInput).toHaveValue("");
		expect(await within(backstage).findByRole("status")).toHaveTextContent(zhCN.settings.keySaved);
	});

	it("surfaces provider action failures and restores enabled controls", async () => {
		const { client } = configuredClient();
		client.provider.overrideBaseUrl = vi.fn(() => Promise.reject(new Error("relay rejected")));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"opencode-go",
		);
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.advancedToggle }));
		await user.type(
			within(backstage).getByPlaceholderText(zhCN.settings.customBaseUrlPlaceholder),
			"https://broken.example/v1",
		);
		const save = within(backstage).getByRole("button", { name: zhCN.settings.customSave });
		await user.click(save);
		expect(await within(backstage).findByRole("alert")).toHaveTextContent("relay rejected");
		await waitFor(() => expect(save).toBeEnabled());
	});

	it("completes an OAuth provider prompt before models are added separately", async () => {
		const { client } = configuredClient();
		client.provider.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { providers: [OAUTH_PROVIDER] } }),
		);
		client.provider.login = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					providerId: "oauth-service",
					status: "waiting_input" as const,
					message: "Choose account",
					prompt: {
						id: "account",
						type: "select" as const,
						message: "Choose account",
						options: [{ id: "personal", label: "Personal" }],
					},
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"oauth-service",
		);
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.loginWithBrowser }),
		);
		const answer = await within(backstage).findByLabelText("Choose account");
		expect(answer).toHaveValue("personal");
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.oauthSubmit }));
		expect(client.provider.loginAnswer).toHaveBeenCalledWith({
			providerId: "oauth-service",
			answer: "personal",
		});
		expect(client.model.enable).not.toHaveBeenCalled();
	});

	it("polls a running OAuth login through completion and refreshes provider state", async () => {
		const { client } = configuredClient();
		client.provider.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { providers: [OAUTH_PROVIDER] } }),
		);
		client.provider.login = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { providerId: "oauth-service", status: "running" as const },
			}),
		);
		client.provider.loginStatus = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { providerId: "oauth-service", status: "completed" as const },
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"oauth-service",
		);
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.loginWithBrowser }),
		);
		expect(await within(backstage).findByRole("status")).toHaveTextContent(
			zhCN.settings.oauthConnected,
		);
		expect(client.provider.loginStatus).toHaveBeenCalledWith({ providerId: "oauth-service" });
		await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
	});

	it("shows the OAuth provider failure message without adding a model", async () => {
		const { client } = configuredClient();
		client.provider.list = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { providers: [OAUTH_PROVIDER] } }),
		);
		client.provider.login = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					providerId: "oauth-service",
					status: "failed" as const,
					message: "authorization denied",
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"oauth-service",
		);
		await user.click(
			within(backstage).getByRole("button", { name: zhCN.settings.loginWithBrowser }),
		);
		expect(await within(backstage).findByRole("alert")).toHaveTextContent("authorization denied");
		expect(client.model.enable).not.toHaveBeenCalled();
	});

	it("marks multimodal models and prevents adding an already configured preset twice", async () => {
		const { client } = configuredClient();
		client.model.poolGet = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					models: [
						{
							providerId: "opencode-go",
							modelId: "vision",
							label: "Vision",
							supportsImages: true,
							createdAt: "2026-01-01",
						},
					],
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		expect(
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.visionModel) }),
		).toHaveTextContent(zhCN.settings.visionModelAuto);
		await selectKobalteOption(
			user,
			within(backstage).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"opencode-go",
		);
		await selectKobalteOption(user, selectTrigger(backstage, zhCN.settings.modelLabel), "vision");
		expect(
			within(backstage).getByRole("button", { name: zhCN.settings.modelAvailable }),
		).toBeDisabled();
	});
});
