import { zhCN } from "@bear-harness/product-config/locales";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PROVIDER = {
	id: "opencode-go",
	name: "OpenCode Go",
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
	fixture.client.model.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				models: [
					{
						providerId: "opencode-go",
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
	await user.click(screen.getByRole("button", { name: zhCN.titlebar.backstage }));
	const backstage = await screen.findByRole("dialog");
	await user.click(
		within(backstage).getByRole("tab", {
			name: zhCN.backstage.systemSettings,
		}),
	);
	return { user, backstage };
}

describe("model pool settings", () => {
	it("switches and persists the product UI language independently of character packages", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const language = within(backstage).getByRole("combobox", { name: zhCN.settings.language });
		expect(language).toHaveValue("zh-CN");

		await user.selectOptions(language, "en");
		expect(document.documentElement).toHaveAttribute("lang", "en");
		expect(localStorage.getItem("bear-harness.product-locale")).toBe("en");
		expect(language).toHaveAccessibleName("Interface language");

		await user.selectOptions(language, "zh-TW");
		expect(document.documentElement).toHaveAttribute("lang", "zh-TW");
		expect(language).toHaveAccessibleName("介面語言");

		await user.selectOptions(language, "zh-CN");
		expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
	});

	it("shows configured models and provider presets without fallback controls", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const remove = await waitFor(() =>
			within(backstage).getByRole("button", {
				name: `${zhCN.settings.removeModel} Fast`,
			}),
		);
		expect(remove).toHaveAttribute("data-semantic", "danger");
		const service = within(backstage).getByRole("combobox", {
			name: zhCN.settings.serviceLabel,
		});
		expect(service).toHaveValue("");
		expect(
			within(backstage).getByRole("combobox", {
				name: zhCN.settings.modelLabel,
			}),
		).toBeDisabled();
		await user.selectOptions(service, "opencode-go");
		expect(within(backstage).getByRole("option", { name: "Vision" })).toBeInTheDocument();
		expect(within(backstage).queryByText(zhCN.settings.fallbackModelSection)).toBeNull();
	});

	it("adds and removes models from the reusable pool", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const service = within(backstage).getByRole("combobox", {
			name: zhCN.settings.serviceLabel,
		});
		expect(service).toHaveValue("");
		await user.selectOptions(service, "opencode-go");
		await waitFor(() =>
			expect(
				within(backstage).getByRole("combobox", {
					name: zhCN.settings.modelLabel,
				}),
			).toBeEnabled(),
		);
		await user.selectOptions(
			within(backstage).getByRole("combobox", {
				name: zhCN.settings.modelLabel,
			}),
			"vision",
		);
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
				name: `${zhCN.settings.removeModel} Fast`,
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
		await user.selectOptions(
			within(backstage).getByRole("combobox", {
				name: zhCN.settings.serviceLabel,
			}),
			"opencode-go",
		);
		await user.click(
			within(backstage).getByRole("button", {
				name: zhCN.settings.advancedToggle,
			}),
		);
		await user.type(
			within(backstage).getByPlaceholderText(zhCN.settings.customBaseUrlPlaceholder),
			"https://relay.example/v1",
		);
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
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.advancedToggle }));
		const configJson = JSON.stringify({
			providers: { relay: { models: [{ id: "custom", name: "Custom" }] } },
		});
		fireEvent.input(within(backstage).getByRole("textbox", { name: zhCN.settings.piConfigLabel }), {
			target: { value: configJson },
		});
		await user.click(within(backstage).getByRole("button", { name: zhCN.settings.piConfigImport }));
		expect(client.provider.importPiConfig).toHaveBeenCalledWith({ configJson });
		expect(within(backstage).queryByLabelText(zhCN.settings.customApiKey)).not.toBeInTheDocument();
	});

	it("stores credentials at provider scope and preserves the canonical stored-key placeholder", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		await user.selectOptions(
			within(backstage).getByRole("combobox", { name: zhCN.settings.serviceLabel }),
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
		await user.selectOptions(
			within(backstage).getByRole("combobox", { name: zhCN.settings.serviceLabel }),
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
		await user.selectOptions(
			within(backstage).getByRole("combobox", { name: zhCN.settings.serviceLabel }),
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
		await user.selectOptions(
			within(backstage).getByRole("combobox", { name: zhCN.settings.serviceLabel }),
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
		await user.selectOptions(
			within(backstage).getByRole("combobox", { name: zhCN.settings.serviceLabel }),
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
		client.model.list = vi.fn(() =>
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
		expect(await within(backstage).findByText(zhCN.settings.multimodal)).toBeVisible();
		await user.selectOptions(
			within(backstage).getByRole("combobox", { name: zhCN.settings.serviceLabel }),
			"opencode-go",
		);
		await user.selectOptions(
			within(backstage).getByRole("combobox", { name: zhCN.settings.modelLabel }),
			"vision",
		);
		expect(
			within(backstage).getByRole("button", { name: zhCN.settings.modelAvailable }),
		).toBeDisabled();
	});
});
