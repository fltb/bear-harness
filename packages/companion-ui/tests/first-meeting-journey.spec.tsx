import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { FirstMeeting } from "../src/FirstMeeting.js";
import { type CompanionStore, DesktopProvider } from "../src/stores/companion.js";
import { THEMED_CHARACTER } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const candidate = {
	id: "openai",
	name: "OpenAI",
	source: "builtin" as const,
	added: false,
	authMethods: [{ type: "api_key" as const, name: "OpenAI API key" }],
	credentialStatus: "missing" as const,
	availableModels: [{ id: "reply", name: "Reply", supportsImages: false, cost: FREE }],
	unavailable: [],
};
const addedProvider = {
	id: "relay",
	name: "Relay",
	source: "custom" as const,
	added: true,
	baseUrl: "https://relay.example/v1",
	authMethods: [{ type: "api_key" as const, name: "Relay API key" }],
	credentialStatus: "stored" as const,
	availableModels: [{ id: "reply", name: "Reply", supportsImages: false, cost: FREE }],
	unavailable: [],
};
const replyModel = {
	providerId: "relay",
	providerName: "Relay",
	modelId: "reply",
	label: "Reply",
	supportsImages: false,
	createdAt: "2026-01-01",
};
const imageModel = {
	providerId: "relay",
	providerName: "Relay",
	modelId: "image",
	label: "Image Reader",
	supportsImages: true,
	createdAt: "2026-01-01",
};
type ProviderFixture = typeof candidate | typeof addedProvider;

type EmbeddingOptions = {
	configure?: (params: { provider: "none" | "local"; candidateId?: string }) => Promise<unknown>;
};
type EmbeddingFixture = {
	localConfigureMutation: {
		mutateAsync: (params: { provider: "none" | "local"; candidateId?: string }) => Promise<unknown>;
		readonly isSuccess: boolean;
	};
	settingsQuery: unknown;
	capabilitiesQuery: unknown;
	settingsMutation: unknown;
};
function embeddingBinding(options: EmbeddingOptions = {}) {
	const configure = options.configure ?? vi.fn(async () => ({ ready: true }));
	const [settings, setSettings] = createSignal<Record<string, unknown>>({
		relationshipMemoryEnabled: false,
		networkProxy: { mode: "direct" },
		memoryVectorService: { enabled: true, provider: "local", localModel: "test-embedding" },
		modelDownloadSource: { type: "official" },
	});
	const [error, setError] = createSignal<unknown>(null);
	const [success, setSuccess] = createSignal(false);
	const localConfigureMutation = {
		mutateAsync: vi.fn(async (params: { provider: "none" | "local"; candidateId?: string }) => {
			setError(null);
			try {
				const result = await configure(params);
				setSuccess(true);
				return result;
			} catch (cause) {
				setError(cause);
				throw cause;
			}
		}),
		isPending: false,
		get error() {
			return error();
		},
		get isSuccess() {
			return success();
		},
	};
	return {
		settingsQuery: {
			get data() {
				return { settings: settings() };
			},
			isPending: false,
			error: null,
		},
		capabilitiesQuery: {
			data: {
				networkProxyModes: [{ id: "direct" }, { id: "auto" }, { id: "manual" }],
				memoryVectorProviders: [
					{ id: "none", onboarding: true },
					{ id: "local", onboarding: true },
					{ id: "remote", onboarding: false },
				],
				memoryVectorPresets: [],
				localEmbeddingCandidates: [
					{ id: "test-embedding", name: "Test embedding", dimensions: 768, isDefault: true },
				],
			},
			isPending: false,
			error: null,
		},
		settingsMutation: {
			mutateAsync: vi.fn(async (value: Record<string, unknown>) => {
				setSettings((current) => ({ ...current, memoryVectorService: value }));
				return { ok: true };
			}),
			isPending: false,
			error: null,
			isSuccess: false,
		},
		downloadState: () => ({ status: "idle", downloadedBytes: 0 }),
		localConfigureMutation,
	};
}

function renderMeeting(store: Partial<CompanionStore>) {
	return render(() => (
		<DesktopProvider store={store as CompanionStore}>
			<FirstMeeting />
		</DesktopProvider>
	));
}
function first<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("expected a matching element");
	return value;
}

async function selectProvider(
	user: ReturnType<typeof userEvent.setup>,
	dialog: HTMLElement,
	provider: Pick<ProviderFixture, "id" | "name">,
): Promise<void> {
	await selectKobalteOption(
		user,
		within(dialog).getByLabelText(zhCN.settings.providerLabel),
		provider.name,
	);
}

function firstRunStore(
	options: {
		embedding?: EmbeddingFixture;
		providers?: ProviderFixture[];
		models?: Array<typeof replyModel | typeof imageModel>;
		defaults?: Record<string, unknown>;
	} = {},
) {
	const initialProviders = options.providers ?? [candidate];
	const [providers, setProviders] = createSignal<ProviderFixture[]>(initialProviders);
	const [models, setModels] = createSignal<Array<typeof replyModel | typeof imageModel>>(
		options.models ?? [],
	);
	const [defaults, setDefaults] = createSignal<Record<string, unknown>>({
		vision: { mode: "auto" },
		onboardingComplete: false,
	});
	const [systemDefaults, setSystemDefaultsState] = createSignal<Record<string, unknown>>({
		vision: { mode: "auto" },
		...options.defaults,
	});
	const [firstRunStage, setFirstRunStage] = createSignal<"model" | "embedding" | "role">("model");
	let hostProviders: ProviderFixture[] = initialProviders;
	let publishProviderProjection = true;
	const setApiKey = vi.fn(async () => {
		hostProviders = [{ ...candidate, added: true, credentialStatus: "stored" as const }];
		setModels([replyModel, imageModel]);
	});
	const list = vi.fn(async () => {
		if (publishProviderProjection) setProviders(hostProviders);
		return { providers: providers() };
	});
	const overrideBaseUrl = vi.fn(async () => undefined);
	const store: Partial<CompanionStore> = {
		loading: false,
		onboarding: {
			status: "active",
			currentStepId: "hello",
			eventSeq: 1,
			stateData: { answers: {}, decisions: {} },
		},
		error: null,
		character: THEMED_CHARACTER,
		settings: {
			data: () => ({
				firstRunStage: firstRunStage(),
				relationshipMemoryEnabled: false,
				networkProxy: { mode: "direct" },
				memoryVectorService: { enabled: false, provider: "none" },
				modelDownloadSource: { type: "official" },
			}),
			get: vi.fn(async () => {
				const value = store.settings?.data();
				if (!value) throw new Error("settings unavailable");
				return value;
			}),
			set: vi.fn(async (patch) => {
				if (patch.firstRunStage) setFirstRunStage(patch.firstRunStage);
			}),
		},
		provider: {
			providers,
			list,
			setApiKey,
			overrideBaseUrl,
			importPiConfig: vi.fn(async () => []),
			customUpsert: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
		} as never,
		model: {
			models,
			data: () => ({ defaults: defaults(), systemDefaults: systemDefaults() }),
			setDefaultReply: vi.fn(async (providerId: string, modelId: string) =>
				setDefaults((current) => ({ ...current, reply: { providerId, modelId } })),
			),
			setVisionAuto: vi.fn(async () =>
				setDefaults((current) => ({ ...current, vision: { mode: "auto" } })),
			),
			setMultimodalFallback: vi.fn(async (providerId: string, modelId: string) =>
				setDefaults((current) => ({
					...current,
					vision: { mode: "manual", route: { providerId, modelId } },
				})),
			),
			setSystemDefaults: vi.fn(async (reply, vision) => setSystemDefaultsState({ reply, vision })),
			initializeDefaults: vi.fn(async () =>
				setDefaults({ ...systemDefaults(), onboardingComplete: false }),
			),
			completeDefaultsOnboarding: vi.fn(async () =>
				setDefaults((current) => ({ ...current, onboardingComplete: true })),
			),
		} as never,
		embedding: (options.embedding ?? embeddingBinding()) as never,
	};
	return {
		store,
		providers,
		models,
		setApiKey,
		overrideBaseUrl,
		holdProviderList: () => {
			publishProviderProjection = false;
		},
		publishProviderList: () => {
			publishProviderProjection = true;
			void list();
		},
		firstRunStage,
		setFirstRunStage,
	};
}

describe("Host-backed first-run setup", () => {
	it("shows model settings immediately after the Host reports an added provider", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore();
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectProvider(user, dialog, candidate);
		const apiKeyInput = first(within(dialog).getAllByLabelText(zhCN.settings.apiKeyLabel));
		expect(
			within(dialog).queryByRole("button", { name: zhCN.messages.continue }),
		).not.toBeInTheDocument();
		await user.type(apiKeyInput, "secret");
		await user.type(
			first(within(dialog).getAllByLabelText(zhCN.settings.customBaseUrl)),
			"https://relay.example/v1",
		);
		setup.holdProviderList();
		await user.click(
			first(
				within(dialog)
					.getAllByRole("button", { name: zhCN.settings.addProvider })
					.filter((button) => !button.hasAttribute("disabled")),
			),
		);
		await waitFor(() => expect(setup.setApiKey).toHaveBeenCalledWith("openai", "secret"));
		expect(setup.providers()[0]?.added).toBe(false);
		expect(setup.overrideBaseUrl).toHaveBeenCalledWith({
			providerId: "openai",
			baseUrl: "https://relay.example/v1",
		});
		setup.publishProviderList();
		await waitFor(() => expect(setup.providers()[0]?.added).toBe(true));
		const model = await within(dialog).findByLabelText(zhCN.modelSetup.modelLabel);
		const finish = within(dialog).getByRole("button", { name: zhCN.modelSetup.continue });
		expect(finish).toBeDisabled();
		await selectKobalteOption(user, model, { label: "Reply (Relay)" });
		await waitFor(() =>
			expect(setup.store.model?.setSystemDefaults).toHaveBeenCalledWith(
				{ providerId: "relay", modelId: "reply" },
				{ mode: "auto" },
			),
		);
		expect(finish).toBeEnabled();
	});
	it("reuses an existing Host provider and exposes its synced models without Provider setup", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore({ providers: [addedProvider], models: [replyModel, imageModel] });
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		expect(
			within(dialog).queryByRole("region", { name: zhCN.settings.providerSetupLabel }),
		).not.toBeInTheDocument();
		const reply = await within(dialog).findByLabelText(zhCN.modelSetup.modelLabel);
		await selectKobalteOption(user, reply, { label: "Reply (Relay)" });
		await waitFor(() => expect(setup.store.model?.setSystemDefaults).toHaveBeenCalled());
	});

	it("accepts the Host-backed automatic image fallback without a second confirmation", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore();
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectProvider(user, dialog, candidate);
		await user.type(first(within(dialog).getAllByLabelText(zhCN.settings.apiKeyLabel)), "secret");
		await user.click(
			first(within(dialog).getAllByRole("button", { name: zhCN.settings.addProvider })),
		);
		const model = await within(dialog).findByLabelText(zhCN.modelSetup.modelLabel);
		expect(
			within(dialog).queryByRole("button", { name: zhCN.messages.continue }),
		).not.toBeInTheDocument();
		await selectKobalteOption(user, model, { label: "Reply (Relay)" });
		const finish = within(dialog).getByRole("button", { name: zhCN.modelSetup.continue });
		await waitFor(() => expect(finish).toBeEnabled());
		await user.click(finish);
		await waitFor(() => expect(setup.firstRunStage()).toBe("embedding"));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("restores the Host-owned setup stage after the renderer remounts", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore({
			providers: [addedProvider],
			models: [replyModel],
			defaults: { reply: { providerId: "relay", modelId: "reply" } },
		});
		const firstRender = renderMeeting(setup.store);
		const modelDialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await user.click(within(modelDialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await waitFor(() => expect(setup.firstRunStage()).toBe("embedding"));
		firstRender.unmount();

		renderMeeting(setup.store);
		expect(
			screen.queryByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).not.toBeInTheDocument();
		expect(
			await screen.findByRole("dialog", { name: zhCN.settings.memoryVectorSection }),
		).toBeVisible();

		setup.setFirstRunStage("role");
		const roleModelDialog = await screen.findByRole("dialog", {
			name: zhCN.modelSetup.dialogLabel,
		});
		expect(
			within(roleModelDialog).getByRole("heading", { name: zhCN.modelSetup.roleTitle }),
		).toBeVisible();
		await user.click(
			within(roleModelDialog).getByRole("button", { name: zhCN.modelSetup.confirmRole }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("dialog", {
					name: THEMED_CHARACTER.character.first_meeting.dialog_label,
				}),
			).toBeVisible(),
		);
	});

	it("hands missing Embedding setup to Settings without embedding a system form", async () => {
		const user = userEvent.setup();
		const configure = vi.fn(async () => ({ ready: true }));
		const setup = firstRunStore({ embedding: embeddingBinding({ configure }) });
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectProvider(user, dialog, candidate);
		await user.type(first(within(dialog).getAllByLabelText(zhCN.settings.apiKeyLabel)), "secret");
		await user.click(
			first(within(dialog).getAllByRole("button", { name: zhCN.settings.addProvider })),
		);
		await selectKobalteOption(user, within(dialog).getByLabelText(zhCN.modelSetup.modelLabel), {
			label: "Reply (Relay)",
		});
		await waitFor(() => expect(setup.store.model?.setSystemDefaults).toHaveBeenCalled());
		await selectKobalteOption(user, within(dialog).getByLabelText(zhCN.settings.visionModel), {
			label: "Image Reader (Relay)",
		});
		await waitFor(() =>
			expect(setup.store.model?.setSystemDefaults).toHaveBeenLastCalledWith(
				{ providerId: "relay", modelId: "reply" },
				{
					mode: "manual",
					route: { providerId: "relay", modelId: "image" },
				},
			),
		);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		expect(
			screen.queryByRole("dialog", { name: THEMED_CHARACTER.character.first_meeting.dialog_label }),
		).not.toBeInTheDocument();
		const handoff = await screen.findByRole("dialog", {
			name: zhCN.settings.memoryVectorSection,
		});
		expect(
			within(handoff).getByRole("button", { name: zhCN.sidebar.systemSettings }),
		).toBeVisible();
		expect(within(handoff).getByRole("button", { name: zhCN.messages.continue })).toBeVisible();
		expect(within(handoff).queryByRole("combobox")).not.toBeInTheDocument();
		expect(configure).not.toHaveBeenCalled();

		await user.click(within(handoff).getByRole("button", { name: zhCN.messages.continue }));
		await waitFor(() => expect(setup.firstRunStage()).toBe("role"));
		const roleModelDialog = await screen.findByRole("dialog", {
			name: zhCN.modelSetup.dialogLabel,
		});
		await user.click(
			within(roleModelDialog).getByRole("button", { name: zhCN.modelSetup.confirmRole }),
		);
		expect(
			await screen.findByRole("dialog", {
				name: THEMED_CHARACTER.character.first_meeting.dialog_label,
			}),
		).toBeVisible();
	});

	it("selects a provider progressively, configures it, then picks reply and image readers in one model stage", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore();
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });

		await selectProvider(user, dialog, candidate);
		expect(within(dialog).getByLabelText(zhCN.settings.providerLabel)).toHaveTextContent("OpenAI");

		const apiKeyInput = first(within(dialog).getAllByLabelText(zhCN.settings.apiKeyLabel));
		expect(apiKeyInput).toBeVisible();
		await user.type(apiKeyInput, "secret");
		const addProvider = first(
			within(dialog)
				.getAllByRole("button", { name: zhCN.settings.addProvider })
				.filter((button) => !button.hasAttribute("disabled")),
		);
		await user.click(addProvider);
		await waitFor(() => expect(setup.setApiKey).toHaveBeenCalledWith("openai", "secret"));
		const reply = await within(dialog).findByLabelText(zhCN.modelSetup.modelLabel);

		// The model stage drops the ProviderSetup surface and keeps both pickers together.
		expect(
			within(dialog).queryByRole("region", { name: zhCN.settings.providerSetupLabel }),
		).not.toBeInTheDocument();
		await selectKobalteOption(user, reply, { label: "Reply (Relay)" });
		expect(within(dialog).getByLabelText(zhCN.settings.visionModel)).toBeInTheDocument();
		expect(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue })).toBeEnabled();
	});
});
