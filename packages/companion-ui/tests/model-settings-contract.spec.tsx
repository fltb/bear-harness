import { productUi } from "@bear-harness/product-config";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const PROVIDERS = [
	{
		id: "unused-provider",
		name: "Unused Provider",
		authType: "api_key" as const,
		credentialStatus: "missing" as const,
		availableModels: [
			{ id: "unused-model", name: "Unused Model", supportsImages: false, cost: FREE },
		],
		unavailable: [],
	},
	{
		id: "opencode-go",
		name: "OpenCode Go",
		authType: "api_key" as const,
		credentialStatus: "stored" as const,
		availableModels: [
			{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supportsImages: false, cost: FREE },
			{ id: "vision-model", name: "Vision Model", supportsImages: true, cost: FREE },
		],
		unavailable: [],
	},
];

function configuredClient() {
	const fixture = createTestClient();
	const voice = {
		stacks: [
			{
				id: "primary-stack",
				companionId: "test-character",
				providerId: "opencode-go",
				modelId: "deepseek-v4-flash",
				revision: 1,
				label: "OpenCode Go",
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
	fixture.client.snapshot.get = vi.fn(async () => {
		const base = await createTestClient().client.snapshot.get();
		if (!base.ok) return base;
		return { ok: true as const, data: { ...base.data, voice } };
	});
	fixture.client.provider.list = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { providers: PROVIDERS } }),
	);
	fixture.client.voice.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: voice,
		}),
	);
	return fixture;
}

async function openModelSettings() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: productUi.titlebar.backstage }));
	const backstage = await screen.findByRole("dialog");
	await user.click(
		within(backstage).getByRole("tab", { name: productUi.backstage.systemSettings }),
	);
	return { user, backstage };
}

describe("model settings contract", () => {
	it("shows the connected provider source and every model returned by Host", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openModelSettings();
		expect(
			within(backstage).getByRole("heading", { name: productUi.settings.primaryModelSection }),
		).toBeInTheDocument();
		expect(
			within(backstage).getByRole("heading", { name: productUi.settings.fallbackModelSection }),
		).toBeInTheDocument();

		await waitFor(() =>
			expect(
				within(backstage).getByRole("combobox", { name: productUi.settings.serviceLabel }),
			).toHaveValue("opencode-go"),
		);
		expect(within(backstage).getByText(productUi.settings.connected)).toBeInTheDocument();
		expect(within(backstage).getByLabelText(productUi.settings.apiKeyLabel)).toHaveAttribute(
			"placeholder",
			productUi.settings.apiKeyStoredPlaceholder,
		);
		expect(within(backstage).getByLabelText(productUi.settings.apiKeyLabel)).toHaveValue("");
		const primary = within(backstage).getByRole("combobox", {
			name: productUi.settings.modelLabel,
		});
		expect(within(primary).getByRole("option", { name: "DeepSeek V4 Flash" })).toBeInTheDocument();
		expect(within(primary).getByRole("option", { name: "Vision Model" })).toBeInTheDocument();
		expect(client.provider.list).toHaveBeenCalledTimes(1);
	});

	it("configures text and multimodal fallbacks independently", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openModelSettings();

		const textToggle = within(backstage).getByRole("switch", {
			name: productUi.settings.textFallbackEnable,
		});
		const multimodalToggle = within(backstage).getByRole("switch", {
			name: productUi.settings.multimodalFallbackEnable,
		});
		expect(textToggle).toHaveAttribute("aria-checked", "false");
		expect(multimodalToggle).toHaveAttribute("aria-checked", "false");
		await userEvent.click(textToggle);
		expect(
			within(backstage).getByRole("combobox", { name: productUi.settings.textFallbackProvider }),
		).toBeInTheDocument();
		expect(
			within(backstage).getByLabelText(productUi.settings.textFallbackApiKey),
		).toBeInTheDocument();
		expect(within(backstage).getByLabelText(productUi.settings.textFallbackApiKey)).toHaveAttribute(
			"placeholder",
			productUi.settings.apiKeyStoredPlaceholder,
		);
		expect(
			within(backstage).getByRole("combobox", { name: productUi.settings.textFallbackLabel }),
		).toBeInTheDocument();
		await userEvent.click(
			within(backstage).getByRole("button", { name: productUi.settings.textFallbackCustomToggle }),
		);
		const textUrl = within(backstage).getByLabelText(productUi.settings.textFallbackCustomUrl);
		expect(textUrl).toHaveAttribute("placeholder", productUi.settings.customBaseUrlPlaceholder);
		await userEvent.type(textUrl, "https://relay.example.com/v1");
		await userEvent.click(
			within(backstage).getByRole("button", { name: productUi.settings.customSave }),
		);
		expect(client.provider.overrideBaseUrl).toHaveBeenCalledWith({
			providerId: "opencode-go",
			baseUrl: "https://relay.example.com/v1",
		});
		await waitFor(() => expect(client.provider.list).toHaveBeenCalledTimes(2));
		expect(
			within(
				within(backstage).getByRole("combobox", { name: productUi.settings.textFallbackLabel }),
			).getByRole("option", { name: "DeepSeek V4 Flash" }),
		).toBeInTheDocument();
		await userEvent.click(multimodalToggle);
		expect(
			within(backstage).getByRole("combobox", {
				name: productUi.settings.multimodalFallbackProvider,
			}),
		).toBeInTheDocument();
		expect(
			within(backstage).getByLabelText(productUi.settings.multimodalFallbackApiKey),
		).toBeInTheDocument();
		await userEvent.click(
			within(backstage).getByRole("button", {
				name: productUi.settings.multimodalFallbackCustomToggle,
			}),
		);
		expect(
			within(backstage).getByLabelText(productUi.settings.multimodalFallbackCustomUrl),
		).toBeInTheDocument();
		expect(within(backstage).queryByLabelText(productUi.settings.customModelId)).toBeNull();
		expect(within(backstage).queryByLabelText(productUi.settings.customApiKey)).toBeNull();
		const multimodal = within(backstage).getByRole("combobox", {
			name: productUi.settings.multimodalFallbackLabel,
		});
		expect(within(multimodal).queryByRole("option", { name: "Text Model" })).toBeNull();
		expect(within(multimodal).getByRole("option", { name: "Vision Model" })).toBeInTheDocument();
	});

	it("keeps custom URL configuration inside an explicit advanced section", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openModelSettings();

		expect(within(backstage).queryByLabelText(productUi.settings.customBaseUrl)).toBeNull();
		await user.click(
			within(backstage).getByRole("button", { name: productUi.settings.advancedToggle }),
		);
		expect(within(backstage).getByLabelText(productUi.settings.customBaseUrl)).toHaveAttribute(
			"placeholder",
			productUi.settings.customBaseUrlPlaceholder,
		);
		expect(within(backstage).queryByLabelText(productUi.settings.customApiKey)).toBeNull();
		await user.type(
			within(backstage).getByLabelText(productUi.settings.customBaseUrl),
			productUi.settings.customBaseUrlPlaceholder,
		);
		expect(
			within(backstage).getByRole("button", { name: productUi.settings.customSave }),
		).toBeEnabled();
	});

	it("persists primary and fallback credentials, routes, and disable operations", async () => {
		const { client, settingsSet } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openModelSettings();
		const view = within(backstage);

		const primaryKey = view.getByLabelText(productUi.settings.apiKeyLabel);
		await user.type(primaryKey, "primary-key");
		await user.click(
			view.getByRole("button", {
				name: `${productUi.settings.saveKey} ${productUi.settings.apiKeyLabel}`,
			}),
		);
		expect(client.provider.setApiKey).toHaveBeenCalledWith({
			providerId: "opencode-go",
			apiKey: "primary-key",
			sessionOnly: undefined,
		});
		await user.click(view.getByRole("button", { name: productUi.settings.useModel }));
		expect(client.voice.pin).toHaveBeenCalledWith({
			providerId: "opencode-go",
			modelId: "deepseek-v4-flash",
			label: "OpenCode Go",
		});

		const textToggle = view.getByRole("switch", { name: productUi.settings.textFallbackEnable });
		await user.click(textToggle);
		await waitFor(() => expect(textToggle).toHaveAttribute("aria-checked", "true"));
		const textKey = view.getByLabelText(productUi.settings.textFallbackApiKey);
		await user.type(textKey, "fallback-key");
		await user.click(
			view.getByRole("button", {
				name: `${productUi.settings.saveKey} ${productUi.settings.textFallbackApiKey}`,
			}),
		);
		expect(client.provider.setApiKey).toHaveBeenCalledWith({
			providerId: "opencode-go",
			apiKey: "fallback-key",
			sessionOnly: undefined,
		});
		await user.selectOptions(
			view.getByRole("combobox", { name: productUi.settings.textFallbackProvider }),
			"unused-provider",
		);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({
				settings: {
					textFallback: { providerId: "unused-provider", modelId: "unused-model" },
				},
			}),
		);
		await waitFor(() =>
			expect(
				view.getByRole("combobox", { name: productUi.settings.textFallbackProvider }),
			).toHaveValue("unused-provider"),
		);
		await user.click(textToggle);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({ settings: { textFallback: null } }),
		);
		await waitFor(() => expect(textToggle).toHaveAttribute("aria-checked", "false"));

		const multimodalToggle = view.getByRole("switch", {
			name: productUi.settings.multimodalFallbackEnable,
		});
		await user.click(multimodalToggle);
		await waitFor(() => expect(multimodalToggle).toHaveAttribute("aria-checked", "true"));
		const multimodalKey = view.getByLabelText(productUi.settings.multimodalFallbackApiKey);
		await user.type(multimodalKey, "vision-key");
		await user.click(
			view.getByRole("button", {
				name: `${productUi.settings.saveKey} ${productUi.settings.multimodalFallbackApiKey}`,
			}),
		);
		expect(client.provider.setApiKey).toHaveBeenCalledWith({
			providerId: "opencode-go",
			apiKey: "vision-key",
			sessionOnly: undefined,
		});
		await user.click(multimodalToggle);
		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith({ settings: { multimodalFallback: null } }),
		);
	});
});
