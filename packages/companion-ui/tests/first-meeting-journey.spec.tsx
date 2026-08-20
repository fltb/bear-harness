import { zhCN } from "@bear-harness/i18n/locales";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { FirstMeeting } from "../src/FirstMeeting.js";
import { CompanionApp } from "../src/index.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

function renderMeeting(store: Partial<CompanionStore>) {
	return render(() => (
		<DesktopProvider store={store as CompanionStore}>
			<FirstMeeting />
		</DesktopProvider>
	));
}

function baseStore(): Partial<CompanionStore> {
	return {
		loading: false,
		error: null,
		onboarding: {
			status: "complete",
			eventSeq: 1,
			stateData: {
				schema_version: 1,
				flow_version: 1,
				answers: {},
				decisions: {},
			},
		},
		provider: {
			providers: () => [],
			list: () => Promise.resolve({ providers: [] }),
		} as never,
		model: {
			loading: () => false,
			models: () => [{ modelId: "model" }],
			data: () => ({ defaults: { reply: { providerId: "provider", modelId: "model" } } }),
		} as never,
	};
}

describe("first meeting journeys", () => {
	it("projects the authoritative onboarding RPC response into the rendered app", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const active = {
			status: "active" as const,
			currentStepId: "hello",
			eventSeq: 20,
			stateData: {
				schema_version: 1 as const,
				flow_version: 1,
				answers: {},
				decisions: {},
			},
		};
		const complete = {
			...active,
			status: "complete" as const,
			currentStepId: undefined,
			eventSeq: 21,
		};
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 20,
					onboarding: active,
					character: THEMED_CHARACTER,
					model: {
						pool: {
							models: [
								{
									providerId: "configured-provider",
									modelId: "configured",
									label: "Configured",
									supportsImages: false,
									createdAt: "2026-01-01",
								},
							],
						},
						defaults: { vision: { mode: "auto" } },
					},
				},
			}),
		);
		client.onboarding.get = vi.fn(() => Promise.resolve({ ok: true as const, data: active }));
		client.onboarding.submit = vi.fn(() => Promise.resolve({ ok: true as const, data: complete }));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const dialog = await screen.findByRole("dialog", { name: "Introduction" });
		await user.click(within(dialog).getByRole("button", { name: "Continue" }));
		await waitFor(() => expect(dialog).not.toBeInTheDocument());
	});

	it("submits an onboarding step only once when its action is double-clicked", async () => {
		const user = userEvent.setup();
		const submitOnboarding = vi.fn(() => Promise.resolve());
		renderMeeting({
			...baseStore(),
			character: THEMED_CHARACTER,
			onboarding: {
				status: "active",
				currentStepId: "hello",
				eventSeq: 1,
				stateData: {
					schema_version: 1,
					flow_version: 1,
					answers: {},
					decisions: {},
				},
			},
			submitOnboarding,
		});

		await user.dblClick(screen.getByRole("button", { name: "Continue" }));
		expect(submitOnboarding).toHaveBeenCalledTimes(1);
		expect(submitOnboarding).toHaveBeenCalledWith("hello", undefined);
	});

	it("connects an API-key provider before selecting and enabling one of its models", async () => {
		const user = userEvent.setup();
		const setApiKey = vi.fn(() => Promise.resolve());
		const enable = vi.fn(() => Promise.resolve());
		const [defaults, setDefaults] = createSignal<{
			reply?: { providerId: string; modelId: string };
		}>({});
		const saveMemorySettings = vi.fn(() => Promise.resolve());
		const setDefaultReply = vi.fn(async (providerId: string, modelId: string) => {
			setDefaults({ reply: { providerId, modelId } });
		});
		const provider = {
			id: "openai-relay",
			name: "OpenAI Relay",
			authType: "api_key" as const,
			credentialStatus: "missing" as const,
			availableModels: [{ id: "gpt-test", name: "GPT Test" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list: () => Promise.resolve({ providers: [provider] }),
				setApiKey,
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: defaults() }),
				enable,
				setDefaultReply,
			} as never,
			settings: {
				set: saveMemorySettings,
			} as never,
		});

		const dialog = await screen.findByRole("dialog", {
			name: zhCN.modelSetup.dialogLabel,
		});
		const service = within(dialog).getByRole("button", {
			name: new RegExp(zhCN.settings.serviceLabel),
		});
		expect(service).toHaveValue("");
		await selectKobalteOption(user, service, "openai-relay");
		const modelBeforeConnection = within(dialog).getByRole("button", {
			name: new RegExp(zhCN.modelSetup.modelLabel),
		});
		expect(modelBeforeConnection).toBeEnabled();
		await selectKobalteOption(user, modelBeforeConnection, "gpt-test");
		await user.type(within(dialog).getByLabelText(zhCN.settings.apiKeyLabel), "secret-key");
		const connect = within(dialog).getByRole("button", {
			name: zhCN.settings.saveKey,
		});
		expect(connect).toHaveAttribute("data-variant", "primary");
		await user.click(connect);
		expect(setApiKey).toHaveBeenCalledWith("openai-relay", "secret-key");
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		expect(enable).toHaveBeenCalledWith("openai-relay", "gpt-test", "GPT Test");
		expect(setDefaultReply).toHaveBeenCalledWith("openai-relay", "gpt-test");
		const memorySetup = await screen.findByRole("dialog", {
			name: zhCN.settings.memoryVectorSection,
		});
		expect(within(memorySetup).getByLabelText(zhCN.settings.localModel)).toBeVisible();
		await user.click(within(memorySetup).getByRole("button", { name: zhCN.messages.continue }));
		expect(saveMemorySettings).toHaveBeenCalledWith({
			memoryVectorService: {
				enabled: true,
				provider: "local",
				localModel: "embeddinggemma",
			},
		});
		await waitFor(() => expect(memorySetup).not.toBeInTheDocument());
	});

	it("configures a relay URL and imports Pi providers from initial setup", async () => {
		const user = userEvent.setup();
		const overrideBaseUrl = vi.fn(() => Promise.resolve());
		const importPiConfig = vi.fn(() =>
			Promise.resolve([
				{
					providerId: "local",
					modelId: "local-model",
					label: "Local model",
					supportsImages: false,
					createdAt: "2026-01-01",
				},
			]),
		);
		const list = vi.fn(() => Promise.resolve({ providers: [] }));
		const provider = {
			id: "openai",
			name: "OpenAI",
			authType: "api_key" as const,
			credentialStatus: "missing" as const,
			availableModels: [{ id: "gpt-test", name: "GPT Test" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list,
				overrideBaseUrl,
				importPiConfig,
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: {} }),
			} as never,
		});

		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await user.click(within(dialog).getByRole("button", { name: zhCN.settings.advancedToggle }));
		const service = dialog.querySelector<HTMLButtonElement>(
			`button[aria-label="${zhCN.settings.serviceLabel}"]`,
		);
		expect(service).not.toBeNull();
		await selectKobalteOption(user, service as HTMLButtonElement, "openai");
		await user.type(
			within(dialog).getByLabelText(zhCN.settings.customBaseUrl),
			"https://relay.example/v1",
		);
		await user.click(within(dialog).getByRole("button", { name: zhCN.settings.customSave }));
		expect(overrideBaseUrl).toHaveBeenCalledWith({
			providerId: "openai",
			baseUrl: "https://relay.example/v1",
		});

		const config = '{"providers":{"local":{"baseUrl":"http://127.0.0.1:11434/v1"}}}';
		fireEvent.input(within(dialog).getByLabelText(zhCN.settings.piConfigLabel), {
			target: { value: config },
		});
		await user.click(within(dialog).getByRole("button", { name: zhCN.settings.piConfigImport }));
		expect(importPiConfig).toHaveBeenCalledWith(config);
		expect(list).toHaveBeenCalledTimes(3);
	});

	it("shows one primary action and no key field when the provider credential is stored", async () => {
		const user = userEvent.setup();
		const enable = vi.fn(() => Promise.resolve());
		const provider = {
			id: "stored-relay",
			name: "Stored Relay",
			authType: "api_key" as const,
			credentialStatus: "stored" as const,
			availableModels: [{ id: "stored-model", name: "Stored Model" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list: () => Promise.resolve({ providers: [provider] }),
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: {} }),
				enable,
				setDefaultReply: vi.fn(),
			} as never,
		});

		const dialog = await screen.findByRole("dialog", {
			name: zhCN.modelSetup.dialogLabel,
		});
		expect(within(dialog).queryByLabelText(zhCN.settings.apiKeyLabel)).not.toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", {
				name: zhCN.modelSetup.continue,
			}),
		).toBeNull();
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", {
				name: new RegExp(zhCN.settings.serviceLabel),
			}),
			"stored-relay",
		);
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", {
				name: new RegExp(zhCN.modelSetup.modelLabel),
			}),
			"stored-model",
		);
		const action = within(dialog).getByRole("button", {
			name: zhCN.modelSetup.continue,
		});
		expect(action).toHaveAttribute("data-variant", "primary");
		await user.click(action);
		expect(enable).toHaveBeenCalledWith("stored-relay", "stored-model", "Stored Model");
	});

	it("keeps model setup open and reports both typed and untyped model failures", async () => {
		const user = userEvent.setup();
		const enable = vi
			.fn()
			.mockRejectedValueOnce(new Error("Model unavailable"))
			.mockRejectedValueOnce("Relay rejected model");
		const provider = {
			id: "stored-relay",
			name: "Stored Relay",
			authType: "api_key" as const,
			credentialStatus: "stored" as const,
			availableModels: [{ id: "stored-model", name: "Stored Model" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list: () => Promise.resolve({ providers: [provider] }),
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: {} }),
				enable,
				setDefaultReply: vi.fn(),
			} as never,
		});
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"stored-relay",
		);
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", { name: new RegExp(zhCN.modelSetup.modelLabel) }),
			"stored-model",
		);
		const connect = within(dialog).getByRole("button", { name: zhCN.modelSetup.continue });
		await user.click(connect);
		expect(await within(dialog).findByRole("alert")).toHaveTextContent("Model unavailable");
		await user.click(connect);
		expect(await within(dialog).findByRole("alert")).toHaveTextContent("Relay rejected model");
		expect(dialog).toBeInTheDocument();
	});

	it("reports typed and untyped credential failures without exposing the key", async () => {
		const user = userEvent.setup();
		const setApiKey = vi
			.fn()
			.mockRejectedValueOnce(new Error("Credential vault unavailable"))
			.mockRejectedValueOnce("Provider refused credential");
		const provider = {
			id: "relay",
			name: "Relay",
			authType: "api_key" as const,
			credentialStatus: "missing" as const,
			availableModels: [{ id: "model", name: "Model" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list: () => Promise.resolve({ providers: [provider] }),
				setApiKey,
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: {} }),
			} as never,
		});
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", { name: new RegExp(zhCN.settings.serviceLabel) }),
			"relay",
		);
		const key = within(dialog).getByLabelText(zhCN.settings.apiKeyLabel);
		const save = within(dialog).getByRole("button", { name: zhCN.settings.saveKey });
		await user.type(key, "not-logged");
		await user.click(save);
		expect(await within(dialog).findByRole("alert")).toHaveTextContent(
			"Credential vault unavailable",
		);
		await user.click(save);
		expect(await within(dialog).findByRole("alert")).toHaveTextContent(
			"Provider refused credential",
		);
		expect(setApiKey).toHaveBeenNthCalledWith(2, "relay", "not-logged");
	});

	it("submits role-package text and choice steps without hardcoded story copy", async () => {
		const user = userEvent.setup();
		const submitText = vi.fn(() => Promise.resolve());
		const textCharacter = {
			...THEMED_CHARACTER,
			character: {
				...THEMED_CHARACTER.character,
				first_meeting: {
					version: 1,
					step_label: "Step {step}/{total}",
					dialog_label: "Text introduction",
					error_prefix: "Error: ",
					completion: { conversation_title: "Text conversation" },
					steps: [
						{
							id: "name",
							kind: "text" as const,
							heading: "Your name",
							body: "Tell me your name",
							input_label: "Preferred name",
							input_placeholder: "Name",
							min_length: 2,
							max_length: 12,
							submit_label: "Confirm name",
						},
					],
				},
			},
		};
		const view = renderMeeting({
			...baseStore(),
			character: textCharacter,
			onboarding: {
				status: "active",
				currentStepId: "name",
				eventSeq: 1,
				stateData: {
					schema_version: 1,
					flow_version: 1,
					answers: {},
					decisions: {},
				},
			},
			submitOnboarding: submitText,
		});
		await user.type(screen.getByRole("textbox", { name: "Preferred name" }), "林舟");
		await user.click(screen.getByRole("button", { name: "Confirm name" }));
		expect(submitText).toHaveBeenCalledWith("name", "林舟");
		view.unmount();

		const submitChoice = vi.fn(() => Promise.resolve());
		renderMeeting({
			...baseStore(),
			character: {
				...textCharacter,
				character: {
					...textCharacter.character,
					first_meeting: {
						...textCharacter.character.first_meeting,
						dialog_label: "Choice introduction",
						steps: [
							{
								id: "relation",
								kind: "choice" as const,
								heading: "Relationship",
								body: "Choose one",
								choices: [
									{
										value: "partner",
										label: "Partner",
										description: "Work together",
									},
								],
							},
						],
					},
				},
			},
			onboarding: {
				status: "active",
				currentStepId: "relation",
				eventSeq: 1,
				stateData: {
					schema_version: 1,
					flow_version: 1,
					answers: {},
					decisions: {},
				},
			},
			submitOnboarding: submitChoice,
		});
		await user.click(screen.getByRole("button", { name: /Partner/ }));
		expect(submitChoice).toHaveBeenCalledWith("relation", "partner");
	});

	it("completes browser OAuth and pins the authenticated model", async () => {
		const user = userEvent.setup();
		const pin = vi.fn(() => Promise.resolve());
		const login = vi.fn(() =>
			Promise.resolve({ providerId: "oauth", status: "completed" as const }),
		);
		const provider = {
			id: "oauth",
			name: "OAuth Provider",
			authType: "oauth" as const,
			credentialStatus: "missing" as const,
			availableModels: [{ id: "oauth-model", name: "OAuth Model" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list: () => Promise.resolve({ providers: [provider] }),
				login,
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: {} }),
				enable: pin,
				setDefaultReply: vi.fn(),
			} as never,
		});
		const dialog = await screen.findByRole("dialog", {
			name: zhCN.modelSetup.dialogLabel,
		});
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", {
				name: new RegExp(zhCN.settings.serviceLabel),
			}),
			"oauth",
		);
		await user.click(
			within(dialog).getByRole("button", {
				name: zhCN.settings.loginWithBrowser,
			}),
		);
		expect(login).toHaveBeenCalledWith("oauth");
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", { name: new RegExp(zhCN.modelSetup.modelLabel) }),
			"oauth-model",
		);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await waitFor(() => expect(pin).toHaveBeenCalledWith("oauth", "oauth-model", "OAuth Model"));
	});

	it("answers an OAuth provider prompt before pinning the model", async () => {
		const user = userEvent.setup();
		const pin = vi.fn(() => Promise.resolve());
		const login = vi
			.fn()
			.mockResolvedValueOnce({
				providerId: "oauth",
				status: "waiting_input" as const,
				prompt: {
					type: "select" as const,
					message: "Choose account",
					options: [{ id: "account-1", label: "Account One" }],
				},
			})
			.mockResolvedValueOnce({
				providerId: "oauth",
				status: "completed" as const,
			});
		const loginAnswer = vi.fn(() =>
			Promise.resolve({ providerId: "oauth", status: "running" as const }),
		);
		const provider = {
			id: "oauth",
			name: "OAuth Provider",
			authType: "oauth" as const,
			credentialStatus: "missing" as const,
			availableModels: [{ id: "oauth-model", name: "OAuth Model" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list: () => Promise.resolve({ providers: [provider] }),
				login,
				loginAnswer,
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: {} }),
				enable: pin,
				setDefaultReply: vi.fn(),
			} as never,
		});
		const dialog = await screen.findByRole("dialog", {
			name: zhCN.modelSetup.dialogLabel,
		});
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", {
				name: new RegExp(zhCN.settings.serviceLabel),
			}),
			"oauth",
		);
		await user.click(
			within(dialog).getByRole("button", {
				name: zhCN.settings.loginWithBrowser,
			}),
		);
		await user.click(
			await screen.findByRole("button", {
				name: zhCN.settings.oauthSubmit,
			}),
		);
		expect(loginAnswer).toHaveBeenCalledWith("oauth", "account-1");
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", { name: new RegExp(zhCN.modelSetup.modelLabel) }),
			"oauth-model",
		);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await waitFor(() => expect(pin).toHaveBeenCalledWith("oauth", "oauth-model", "OAuth Model"));
	});

	it("shows the provider's OAuth failure message", async () => {
		const user = userEvent.setup();
		const login = vi
			.fn()
			.mockResolvedValueOnce({
				providerId: "oauth",
				status: "failed" as const,
				message: "Denied",
			})
			.mockResolvedValueOnce({ providerId: "oauth", status: "failed" as const })
			.mockRejectedValueOnce(new Error("OAuth transport failed"))
			.mockRejectedValueOnce("OAuth relay failed");
		const provider = {
			id: "oauth",
			name: "OAuth Provider",
			authType: "oauth" as const,
			credentialStatus: "missing" as const,
			availableModels: [{ id: "oauth-model", name: "OAuth Model" }],
		};
		renderMeeting({
			...baseStore(),
			provider: {
				providers: () => [provider],
				list: () => Promise.resolve({ providers: [provider] }),
				login,
			} as never,
			model: {
				loading: () => false,
				models: () => [],
				data: () => ({ defaults: {} }),
				enable: vi.fn(),
				setDefaultReply: vi.fn(),
			} as never,
		});
		const dialog = await screen.findByRole("dialog", {
			name: zhCN.modelSetup.dialogLabel,
		});
		await selectKobalteOption(
			user,
			within(dialog).getByRole("button", {
				name: new RegExp(zhCN.settings.serviceLabel),
			}),
			"oauth",
		);
		const loginButton = within(dialog).getByRole("button", {
			name: zhCN.settings.loginWithBrowser,
		});
		await user.click(loginButton);
		expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
		await user.click(loginButton);
		expect(await screen.findByRole("alert")).toHaveTextContent(zhCN.settings.oauthFailed);
		await user.click(loginButton);
		expect(await screen.findByRole("alert")).toHaveTextContent("OAuth transport failed");
		await user.click(loginButton);
		expect(await screen.findByRole("alert")).toHaveTextContent("OAuth relay failed");
	});
});
