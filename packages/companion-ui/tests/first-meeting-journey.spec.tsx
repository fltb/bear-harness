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
		conversationHistoryReadEnabled: false,
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

async function providerTile(
	dialog: HTMLElement,
	provider: Pick<ProviderFixture, "id" | "name">,
): Promise<HTMLElement> {
	return within(dialog).findByRole("button", { name: new RegExp(provider.name) });
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
	const [defaults, setDefaults] = createSignal<Record<string, unknown>>(options.defaults ?? {});
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
			stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
		},
		error: null,
		character: THEMED_CHARACTER,
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
			data: () => ({ defaults: defaults() }),
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
	};
}

describe("Host-backed first-run setup", () => {
	it("shows model settings immediately after the Host reports an added provider", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore();
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await user.click(await providerTile(dialog, candidate));
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
			expect(setup.store.model?.setDefaultReply).toHaveBeenCalledWith("relay", "reply"),
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
		await waitFor(() =>
			expect(setup.store.model?.setDefaultReply).toHaveBeenCalledWith("relay", "reply"),
		);
	});

	it("accepts the Host-backed automatic image fallback without a second confirmation", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore();
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await user.click(await providerTile(dialog, candidate));
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
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("supports selecting an image model and gates role onboarding on embedding success", async () => {
		const user = userEvent.setup();
		const configure = vi.fn(async () => ({ ready: true }));
		const setup = firstRunStore({ embedding: embeddingBinding({ configure }) });
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await user.click(await providerTile(dialog, candidate));
		await user.type(first(within(dialog).getAllByLabelText(zhCN.settings.apiKeyLabel)), "secret");
		await user.click(
			first(within(dialog).getAllByRole("button", { name: zhCN.settings.addProvider })),
		);
		await selectKobalteOption(user, within(dialog).getByLabelText(zhCN.modelSetup.modelLabel), {
			label: "Reply (Relay)",
		});
		await waitFor(() =>
			expect(setup.store.model?.setDefaultReply).toHaveBeenCalledWith("relay", "reply"),
		);
		await selectKobalteOption(user, within(dialog).getByLabelText(zhCN.settings.visionModel), {
			label: "Image Reader (Relay)",
		});
		await waitFor(() =>
			expect(setup.store.model?.setMultimodalFallback).toHaveBeenCalledWith("relay", "image"),
		);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		expect(
			screen.queryByRole("dialog", { name: THEMED_CHARACTER.character.first_meeting.dialog_label }),
		).not.toBeInTheDocument();
		const embedding = setup.store.embedding as {
			localConfigureMutation: {
				mutateAsync: (params: {
					provider: "none" | "local";
					candidateId?: string;
				}) => Promise<unknown>;
				isSuccess: boolean;
			};
		};
		await embedding.localConfigureMutation.mutateAsync({
			provider: "local",
			candidateId: "test-embedding",
		});
		expect(configure).toHaveBeenCalledWith({ provider: "local", candidateId: "test-embedding" });
		expect(embedding.localConfigureMutation.isSuccess).toBe(true);
	});

	it("selects a candidate from the Pattern 04 tiles, configures through the shared ProviderSetup, then picks reply and image readers in one model stage", async () => {
		const user = userEvent.setup();
		const setup = firstRunStore();
		renderMeeting(setup.store);
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });

		const tile = within(dialog).getByRole("button", { name: /OpenAI/ });
		expect(tile).toHaveAttribute("data-provider-tile", "openai");
		await user.click(tile);
		expect(tile).toHaveAttribute("aria-pressed", "true");

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
