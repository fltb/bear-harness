import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../src/features/ModelSelector.js";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CANDIDATE = {
	id: "openai",
	name: "OpenAI",
	source: "builtin" as const,
	added: false,
	authMethods: [{ type: "api_key" as const, name: "OpenAI API key" }],
	credentialStatus: "missing" as const,
	availableModels: [{ id: "gpt-mini", name: "GPT Mini", supportsImages: false, cost: FREE }],
	unavailable: [],
};
const PROVIDER = {
	id: "relay",
	name: "Relay",
	source: "custom" as const,
	added: true,
	baseUrl: "https://saved.example/v1",
	authMethods: [{ type: "api_key" as const, name: "Relay API key" }],
	credentialStatus: "stored" as const,
	availableModels: [{ id: "fast", name: "Fast", supportsImages: false, cost: FREE }],
	unavailable: [],
};
const OAUTH = {
	id: "oauth",
	name: "OAuth",
	source: "builtin" as const,
	added: true,
	authMethods: [
		{ type: "api_key" as const, name: "OAuth provider API key" },
		{ type: "oauth" as const, name: "OAuth subscription" },
	],
	credentialStatus: "stored" as const,
	availableModels: [{ id: "oauth-model", name: "OAuth Model", supportsImages: false, cost: FREE }],
	unavailable: [],
};

function configuredClient() {
	const fixture = createTestClient();
	let providers = [CANDIDATE, PROVIDER, OAUTH];
	const providerList = vi.fn(() => Promise.resolve({ ok: true as const, data: { providers } }));
	fixture.client.provider.list = providerList;
	fixture.client.provider.setApiKey = vi.fn(
		async ({ providerId }: { providerId: string; apiKey: string }) => {
			providers = providers.map((provider) =>
				provider.id === providerId
					? { ...provider, added: true as const, credentialStatus: "stored" as const }
					: provider,
			) as typeof providers;
			return { ok: true as const, data: null };
		},
	);
	fixture.client.provider.overrideBaseUrl = vi.fn(
		async ({ providerId, baseUrl }: { providerId: string; baseUrl: string }) => {
			providers = providers.map((provider) =>
				provider.id === providerId ? { ...provider, baseUrl } : provider,
			) as typeof providers;
			return { ok: true as const, data: null };
		},
	);
	fixture.client.provider.remove = vi.fn(async ({ providerId }: { providerId: string }) => {
		providers = providers.filter((provider) => provider.id !== providerId);
		return { ok: true as const, data: null };
	});
	fixture.client.model.poolGet = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				models: [
					{
						providerId: "relay",
						providerName: "Relay",
						modelId: "fast",
						label: "Fast",
						supportsImages: false,
						createdAt: "2026-01-01",
					},
					{
						providerId: "relay",
						providerName: "Relay",
						modelId: "vision",
						label: "Vision",
						supportsImages: true,
						createdAt: "2026-01-02",
					},
				],
			},
		}),
	);
	return { ...fixture, providers: () => providers };
}

async function openSettings() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: zhCN.sidebar.systemSettings }));
	const backstage = await screen.findByRole("dialog", { name: zhCN.sidebar.systemSettings });
	return { user, backstage };
}

function providerSetup(backstage: HTMLElement): HTMLElement {
	return within(backstage).getByRole("region", { name: zhCN.settings.providerSetupLabel });
}
function detailsSummary(container: HTMLElement, label: string): HTMLElement {
	const summary = within(container)
		.getAllByText(label)
		.find((candidate) => candidate.tagName === "SUMMARY");
	if (!summary) throw new Error(`details summary missing: ${label}`);
	return summary;
}

function providerEditorForAction(
	setup: HTMLElement,
	providerId: string,
	actionName: string,
): HTMLElement {
	const action = within(setup)
		.getAllByRole("button", { name: actionName })
		.find((candidate) => candidate.closest(`[data-provider-editor="${providerId}"]`));
	if (!action) throw new Error(`provider action missing: ${providerId} ${actionName}`);
	const editor = action.closest(`[data-provider-editor="${providerId}"]`);
	expect(editor).toHaveAttribute("data-provider-editor", providerId);
	return editor as HTMLElement;
}

describe("breaking provider and model settings contract", () => {
	it("shows only current reply and optional image controls, not old default or model-pool controls", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { backstage } = await openSettings();
		expect(within(backstage).getByText(zhCN.settings.currentReplyModel)).toBeVisible();
		expect(within(backstage).getByText(zhCN.settings.visionModel)).toBeVisible();
		expect(within(backstage).queryByText("新对话默认模型")).not.toBeInTheDocument();
		expect(within(backstage).queryByText(zhCN.settings.addModel)).not.toBeInTheDocument();
		expect(within(backstage).queryByText(zhCN.settings.removeModel)).not.toBeInTheDocument();
	});

	it("exposes candidate selection, added providers, imports, and the selected editor", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		const candidateHeading = within(setup).getByRole("heading", {
			name: zhCN.settings.addProvider,
		});
		const providerSelect = within(setup).getByLabelText(zhCN.settings.providerLabel);
		const addedProviders = within(setup).getByRole("region", {
			name: zhCN.settings.addedProviders,
		});

		expect(candidateHeading).toBeVisible();
		expect(providerSelect).toBeVisible();
		expect(within(addedProviders).getByText(PROVIDER.name)).toBeVisible();
		expect(detailsSummary(setup, zhCN.settings.piConfigLabel)).toBeVisible();
		expect(detailsSummary(setup, zhCN.settings.customProvider)).toBeVisible();

		await selectKobalteOption(user, providerSelect, "openai");
		const editor = providerEditorForAction(setup, "openai", zhCN.settings.addProvider);
		expect(within(editor).getByLabelText(zhCN.settings.apiKeyLabel)).toBeVisible();
		expect(within(editor).getByLabelText(zhCN.settings.customBaseUrl)).toBeVisible();
		expect(
			within(addedProviders).queryByLabelText(zhCN.settings.apiKeyLabel),
		).not.toBeInTheDocument();
	});

	it("adds a builtin candidate with an API key and optional URL", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		await selectKobalteOption(
			user,
			within(setup).getByLabelText(zhCN.settings.providerLabel),
			"openai",
		);
		const editor = providerEditorForAction(setup, "openai", zhCN.settings.addProvider);
		client.provider.list.mockClear();
		client.model.poolGet.mockClear();
		client.model.defaultsGet.mockClear();
		await user.type(within(editor).getByLabelText(zhCN.settings.apiKeyLabel), "candidate-secret");
		await user.type(
			within(editor).getByLabelText(zhCN.settings.customBaseUrl),
			"https://relay.example/v1",
		);
		await user.click(within(editor).getByRole("button", { name: zhCN.settings.addProvider }));
		await waitFor(() =>
			expect(client.provider.setApiKey).toHaveBeenCalledWith({
				providerId: "openai",
				apiKey: "candidate-secret",
			}),
		);
		expect(client.provider.overrideBaseUrl).toHaveBeenCalledWith({
			providerId: "openai",
			baseUrl: "https://relay.example/v1",
		});
		await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
		expect(client.model.poolGet).toHaveBeenCalled();
		expect(client.model.defaultsGet).toHaveBeenCalled();
		await waitFor(() =>
			expect(within(setup).getAllByText(CANDIDATE.name).length).toBeGreaterThan(0),
		);
	});

	it("edits an added provider key and URL from its card", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		const card = within(setup).getByText(PROVIDER.name).closest("article")!;
		client.provider.list.mockClear();
		client.model.poolGet.mockClear();
		client.model.defaultsGet.mockClear();
		await user.click(within(card).getByRole("button", { name: zhCN.settings.editProviderKey }));
		const editor = providerEditorForAction(setup, "relay", zhCN.settings.saveKey);
		await user.type(within(editor).getByLabelText(zhCN.settings.apiKeyLabel), "replacement-secret");
		await user.click(within(editor).getByRole("button", { name: zhCN.settings.saveKey }));
		await waitFor(() =>
			expect(client.provider.setApiKey).toHaveBeenCalledWith({
				providerId: "relay",
				apiKey: "replacement-secret",
			}),
		);
		await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
		expect(client.model.poolGet).toHaveBeenCalled();
		expect(client.model.defaultsGet).toHaveBeenCalled();
		client.provider.list.mockClear();
		client.model.poolGet.mockClear();
		client.model.defaultsGet.mockClear();
		await user.click(within(card).getByRole("button", { name: zhCN.settings.editProviderUrl }));
		const urlEditor = providerEditorForAction(setup, "relay", zhCN.settings.customSave);
		const url = within(urlEditor).getByLabelText(zhCN.settings.customBaseUrl);
		await user.clear(url);
		await user.type(url, "https://new.example/v1");
		await user.click(within(urlEditor).getByRole("button", { name: zhCN.settings.customSave }));
		expect(client.provider.overrideBaseUrl).toHaveBeenCalledWith({
			providerId: "relay",
			baseUrl: "https://new.example/v1",
		});
		await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
		expect(client.model.poolGet).not.toHaveBeenCalled();
	});

	it("reauthenticates OAuth, answers an explicit select prompt, polls, and refreshes providers only after completion", async () => {
		const { client } = configuredClient();
		client.provider.login = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					providerId: "oauth",
					status: "waiting_input" as const,
					prompt: {
						type: "select" as const,
						message: "Choose account",
						options: [{ id: "personal", label: "Personal" }],
					},
				},
			}),
		);
		client.provider.loginAnswer = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { providerId: "oauth", status: "running" as const },
			}),
		);
		client.provider.loginStatus = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { providerId: "oauth", status: "completed" as const },
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		const card = within(setup).getByText(OAUTH.name).closest("article")!;
		expect(within(card).getByRole("button", { name: zhCN.settings.editProviderKey })).toBeVisible();
		client.provider.list.mockClear();
		client.model.poolGet.mockClear();
		client.model.defaultsGet.mockClear();
		await user.click(within(card).getByRole("button", { name: zhCN.settings.reauthProvider }));
		const editor = providerEditorForAction(setup, "oauth", zhCN.settings.oauthSubmit);
		const prompt = within(editor).getByLabelText("Choose account");
		expect(prompt).toBeVisible();
		// No account is pre-selected: the submit action must be explicit.
		expect(within(editor).getByRole("button", { name: zhCN.settings.oauthSubmit })).toBeDisabled();
		await selectKobalteOption(user, prompt, "Personal");
		await user.click(within(editor).getByRole("button", { name: zhCN.settings.oauthSubmit }));
		expect(client.provider.loginAnswer).toHaveBeenCalledWith({
			providerId: "oauth",
			answer: "personal",
		});
		await waitFor(
			() => expect(client.provider.loginStatus).toHaveBeenCalledWith({ providerId: "oauth" }),
			{ timeout: 2000 },
		);
		await waitFor(() => expect(client.provider.list).toHaveBeenCalledTimes(1), { timeout: 2500 });
		expect(client.model.poolGet).toHaveBeenCalledTimes(1);
		expect(client.model.defaultsGet).toHaveBeenCalledTimes(1);
		expect(within(setup).getByText(OAUTH.name)).toBeVisible();
		expect(within(card).getAllByText(zhCN.settings.connected).length).toBeGreaterThan(0);
	});

	it("keeps polling a manual-code fallback until the browser callback completes", async () => {
		const { client } = configuredClient();
		client.provider.login = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { providerId: "oauth", status: "running" as const },
			}),
		);
		client.provider.loginStatus = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true as const,
				data: {
					providerId: "oauth",
					status: "waiting_input" as const,
					authUrl: "https://auth.example/authorize",
					prompt: {
						type: "manual_code" as const,
						message: "Paste the callback URL",
					},
				},
			})
			.mockResolvedValueOnce({
				ok: true as const,
				data: { providerId: "oauth", status: "completed" as const },
			});
		Object.defineProperty(window, "bearDesktop", {
			configurable: true,
			value: {},
		});
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		try {
			render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
			const { user, backstage } = await openSettings();
			const setup = providerSetup(backstage);
			const card = within(setup).getByText(OAUTH.name).closest("article")!;
			client.provider.list.mockClear();
			await user.click(within(card).getByRole("button", { name: zhCN.settings.reauthProvider }));
			await waitFor(
				() =>
					expect(open).toHaveBeenCalledWith(
						"https://auth.example/authorize",
						"_blank",
						"noopener,noreferrer",
					),
				{ timeout: 2000 },
			);
			await waitFor(() => expect(client.provider.list).toHaveBeenCalledTimes(1), {
				timeout: 3000,
			});
			expect(client.provider.loginStatus).toHaveBeenCalledTimes(2);
		} finally {
			open.mockRestore();
			Reflect.deleteProperty(window, "bearDesktop");
		}
	});

	it("surfaces device code, verification URL, instructions, and info links from the OAuth session", async () => {
		const { client } = configuredClient();
		client.provider.login = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					providerId: "oauth",
					status: "running" as const,
					deviceCode: "ABCD-EFGH",
					verificationUri: "https://github.com/login/device",
					instructions: "Open the page and enter the code.",
					message: "Waiting for authorization…",
					infoLinks: [{ url: "https://docs.example/oauth-help", label: "OAuth help" }],
				},
			}),
		);
		client.provider.loginStatus = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { providerId: "oauth", status: "running" as const },
			}),
		);
		client.provider.loginCancel = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		const card = within(setup).getByText(OAUTH.name).closest("article")!;
		client.provider.list.mockClear();
		client.model.poolGet.mockClear();
		client.model.defaultsGet.mockClear();
		await user.click(within(card).getByRole("button", { name: zhCN.settings.reauthProvider }));
		const editor = providerEditorForAction(setup, "oauth", zhCN.settings.oauthCancel);
		expect(within(editor).getByText("ABCD-EFGH")).toBeVisible();
		expect(within(editor).getByRole("link", { name: zhCN.settings.oauthOpen })).toHaveAttribute(
			"href",
			"https://github.com/login/device",
		);
		expect(within(editor).getByText("Open the page and enter the code.")).toBeVisible();
		expect(within(editor).getByText("Waiting for authorization…")).toBeVisible();
		expect(within(editor).getByRole("link", { name: "OAuth help" })).toHaveAttribute(
			"href",
			"https://docs.example/oauth-help",
		);
		// A running flow must not refresh provider queries.
		expect(client.provider.list).not.toHaveBeenCalled();
		expect(client.model.poolGet).not.toHaveBeenCalled();
		// Explicit cancellation stops the flow and clears the surface.
		await user.click(within(editor).getByRole("button", { name: zhCN.settings.oauthCancel }));
		expect(client.provider.loginCancel).toHaveBeenCalledWith({ providerId: "oauth" });
		await waitFor(() => expect(within(editor).queryByText("ABCD-EFGH")).not.toBeInTheDocument());
		expect(client.provider.list).not.toHaveBeenCalled();
	});

	it("reports failed OAuth sessions without refreshing provider queries", async () => {
		const { client } = configuredClient();
		client.provider.login = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: { providerId: "oauth", status: "running" as const },
			}),
		);
		client.provider.loginStatus = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					providerId: "oauth",
					status: "failed" as const,
					message: "token exchange failed: invalid_grant",
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		const card = within(setup).getByText(OAUTH.name).closest("article")!;
		client.provider.list.mockClear();
		client.model.poolGet.mockClear();
		client.model.defaultsGet.mockClear();
		await user.click(within(card).getByRole("button", { name: zhCN.settings.reauthProvider }));
		await waitFor(
			() => expect(within(setup).getByText("token exchange failed: invalid_grant")).toBeVisible(),
			{ timeout: 2000 },
		);
		expect(client.provider.list).not.toHaveBeenCalled();
		expect(client.model.poolGet).not.toHaveBeenCalled();
		expect(client.model.defaultsGet).not.toHaveBeenCalled();
	});

	it("removes an added provider and drops its card after the Host deletion", async () => {
		const { client } = configuredClient();
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		const card = within(setup).getByText(PROVIDER.name).closest("article")!;
		client.provider.list.mockClear();
		client.model.poolGet.mockClear();
		client.model.defaultsGet.mockClear();
		await user.click(within(card).getByRole("button", { name: zhCN.settings.deleteProvider }));
		expect(client.provider.remove).toHaveBeenCalledWith({ providerId: "relay" });
		await waitFor(() => expect(client.provider.list).toHaveBeenCalled());
		expect(client.model.poolGet).toHaveBeenCalled();
		expect(client.model.defaultsGet).toHaveBeenCalled();
		await waitFor(() => expect(within(setup).queryByText(PROVIDER.name)).not.toBeInTheDocument());
	});

	it("adds custom Pi configuration and a custom provider through their explicit forms", async () => {
		const { client } = configuredClient();
		client.provider.importPiConfig = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					models: [
						{
							providerId: "pi-local",
							modelId: "local",
							label: "Local",
							supportsImages: false,
							createdAt: "2026-01-01",
						},
					],
				},
			}),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const { user, backstage } = await openSettings();
		const setup = providerSetup(backstage);
		await user.click(detailsSummary(setup, zhCN.settings.piConfigLabel));
		// Empty drafts are intentionally ignored; submit an actual Pi document.
		fireEvent.input(within(setup).getByLabelText(zhCN.settings.piConfigLabel), {
			target: { value: '{"providers":{"pi-local":{"models":[{"id":"local"}]}}}' },
		});
		await user.click(within(setup).getByRole("button", { name: zhCN.settings.piConfigImport }));
		expect(client.provider.importPiConfig).toHaveBeenCalledWith({
			configJson: '{"providers":{"pi-local":{"models":[{"id":"local"}]}}}',
		});
		await user.click(detailsSummary(setup, zhCN.settings.customProvider));
		await user.type(within(setup).getByLabelText(zhCN.settings.customProviderId), "custom-relay");
		await user.type(within(setup).getByLabelText(zhCN.settings.customServiceName), "Custom Relay");
		await user.type(
			within(setup).getByLabelText(zhCN.settings.customBaseUrl),
			"https://custom.example/v1",
		);
		await user.type(within(setup).getByLabelText(zhCN.settings.customModels), "custom-model");
		await user.type(within(setup).getByLabelText(zhCN.settings.apiKeyLabel), "custom-secret");
		const customEditor = within(setup)
			.getByLabelText(zhCN.settings.customProviderId)
			.closest("details");
		if (!customEditor) throw new Error("custom provider editor missing");
		await user.click(within(customEditor).getByRole("button", { name: zhCN.settings.addProvider }));
		expect(client.provider.customUpsert).toHaveBeenCalledWith({
			providerId: "custom-relay",
			name: "Custom Relay",
			baseUrl: "https://custom.example/v1",
			models: [{ id: "custom-model" }],
			apiKey: "custom-secret",
		});
	});
});

describe("shared model selector contract", () => {
	it.each([
		["model id", "vision-id"],
		["model name", "Vision Name"],
		["provider", "Provider Two"],
	])("searches a small catalog by %s and labels model with provider", async (_kind, query) => {
		const user = userEvent.setup();
		const models = [
			{
				providerId: "provider-one",
				providerName: "Provider One",
				modelId: "text-id",
				label: "Text Name",
				supportsImages: false,
				createdAt: "2026-01-01",
			},
			{
				providerId: "provider-two",
				providerName: "Provider Two",
				modelId: "vision-id",
				label: "Vision Name",
				supportsImages: true,
				createdAt: "2026-01-01",
			},
		];
		const view = render(() => (
			<ModelSelector
				models={models}
				value={null}
				class="field"
				label="Test models"
				onModelChange={() => undefined}
			/>
		));
		await user.click(screen.getByLabelText("Test models"));
		const input = screen.getByPlaceholderText(zhCN.settings.searchModels);
		await user.type(input, query);
		expect(input).toHaveValue(query);
		expect(screen.getByRole("button", { name: /Test models/ })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await waitFor(() => expect(screen.getByText("Vision Name (Provider Two)")).toBeVisible());
		expect(screen.getByText("Text Name (Provider One)")).not.toBeVisible();
		view.unmount();
	});
});
