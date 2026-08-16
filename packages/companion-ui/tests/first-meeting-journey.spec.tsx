import { productUi } from "@bear-harness/product-config";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FirstMeeting } from "../src/FirstMeeting.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { THEMED_CHARACTER } from "./fixtures.js";

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
			stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
		},
		provider: {
			providers: () => [],
			list: () => Promise.resolve({ providers: [] }),
		} as never,
		voice: {
			loading: () => false,
			activeStackId: () => "stack-1",
		} as never,
	};
}

describe("first meeting journeys", () => {
	it("saves an API key and pins the selected provider model before onboarding", async () => {
		const user = userEvent.setup();
		const setApiKey = vi.fn(() => Promise.resolve());
		const pin = vi.fn(() => Promise.resolve());
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
			voice: { loading: () => false, activeStackId: () => undefined, pin } as never,
		});

		const dialog = await screen.findByRole("dialog", { name: productUi.modelSetup.dialogLabel });
		await user.type(within(dialog).getByLabelText(productUi.settings.apiKeyLabel), "secret-key");
		await user.click(within(dialog).getByRole("button", { name: productUi.modelSetup.continue }));
		expect(setApiKey).toHaveBeenCalledWith("openai-relay", "secret-key");
		expect(pin).toHaveBeenCalledWith("openai-relay", "gpt-test", "OpenAI Relay");
	});

	it("shows one primary action and no key field when the provider credential is stored", async () => {
		const user = userEvent.setup();
		const pin = vi.fn(() => Promise.resolve());
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
			voice: { loading: () => false, activeStackId: () => undefined, pin } as never,
		});

		const dialog = await screen.findByRole("dialog", { name: productUi.modelSetup.dialogLabel });
		expect(within(dialog).queryByLabelText(productUi.settings.apiKeyLabel)).not.toBeInTheDocument();
		const actions = within(dialog).getAllByRole("button", { name: productUi.modelSetup.continue });
		expect(actions).toHaveLength(1);
		await user.click(actions[0]);
		expect(pin).toHaveBeenCalledWith("stored-relay", "stored-model", "Stored Relay");
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
				stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
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
								choices: [{ value: "partner", label: "Partner", description: "Work together" }],
							},
						],
					},
				},
			},
			onboarding: {
				status: "active",
				currentStepId: "relation",
				eventSeq: 1,
				stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
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
			voice: { loading: () => false, activeStackId: () => undefined, pin } as never,
		});
		const dialog = await screen.findByRole("dialog", { name: productUi.modelSetup.dialogLabel });
		await user.click(
			within(dialog).getByRole("button", { name: productUi.settings.loginWithBrowser }),
		);
		expect(login).toHaveBeenCalledWith("oauth");
		await waitFor(() => expect(pin).toHaveBeenCalledWith("oauth", "oauth-model", "OAuth Provider"));
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
			.mockResolvedValueOnce({ providerId: "oauth", status: "completed" as const });
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
			voice: { loading: () => false, activeStackId: () => undefined, pin } as never,
		});
		const dialog = await screen.findByRole("dialog", { name: productUi.modelSetup.dialogLabel });
		await user.click(
			within(dialog).getByRole("button", { name: productUi.settings.loginWithBrowser }),
		);
		await user.click(await screen.findByRole("button", { name: productUi.settings.oauthSubmit }));
		expect(loginAnswer).toHaveBeenCalledWith("oauth", "account-1");
		await waitFor(() => expect(pin).toHaveBeenCalledWith("oauth", "oauth-model", "OAuth Provider"));
	});

	it("shows the provider's OAuth failure message", async () => {
		const user = userEvent.setup();
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
				login: () =>
					Promise.resolve({ providerId: "oauth", status: "failed" as const, message: "Denied" }),
			} as never,
			voice: { loading: () => false, activeStackId: () => undefined, pin: vi.fn() } as never,
		});
		const dialog = await screen.findByRole("dialog", { name: productUi.modelSetup.dialogLabel });
		await user.click(
			within(dialog).getByRole("button", { name: productUi.settings.loginWithBrowser }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
	});
});
