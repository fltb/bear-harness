import { zhCN } from "@bear-harness/i18n/locales";
import type {
	ConfiguredModel,
	InvalidationNotice,
	ModelDefaultsGetResponse,
	ProviderInfo,
	SettingsData,
	SystemModelDefaultsGetResponse,
} from "@bear-harness/protocol";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FirstMeeting } from "../src/FirstMeeting.js";
import {
	type CompanionStore,
	createCompanionStore,
	DesktopProvider,
} from "../src/stores/companion.js";
import { createTestClient, THEMED_CHARACTER } from "./fixtures.js";
import { selectKobalteOption } from "./kobalte-helpers.js";

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const candidate: ProviderInfo = {
	id: "openai",
	name: "OpenAI",
	source: "builtin",
	added: false,
	authMethods: [{ type: "api_key", name: "OpenAI API key" }],
	credentialStatus: "missing",
	availableModels: [{ id: "reply", name: "Reply", supportsImages: false, cost: FREE }],
	unavailable: [],
};
const addedProvider: ProviderInfo = {
	...candidate,
	added: true,
	credentialStatus: "stored",
};
const replyModel: ConfiguredModel = {
	providerId: "openai",
	providerName: "OpenAI",
	modelId: "reply",
	label: "Reply",
	supportsImages: false,
	createdAt: "2026-01-01",
	enabled: true,
	readiness: "ready",
};
const imageModel: ConfiguredModel = {
	...replyModel,
	modelId: "image",
	label: "Image Reader",
	supportsImages: true,
};
const replyRoute = { providerId: "openai", modelId: "reply" };

function first<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("expected a matching element");
	return value;
}

function firstRunHost(
	options: {
		providers?: ProviderInfo[];
		models?: ConfiguredModel[];
		defaults?: SystemModelDefaultsGetResponse;
	} = {},
) {
	const { client } = createTestClient();
	const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
	const notices: InvalidationNotice[] = [];
	let receiveNotice: ((notice: InvalidationNotice | undefined) => void) | undefined;
	client.invalidations.stream = async function* (signal) {
		while (!signal.aborted) {
			const notice =
				notices.shift() ??
				(await new Promise<InvalidationNotice | undefined>((resolve) => {
					const abort = () => {
						if (receiveNotice === deliver) receiveNotice = undefined;
						resolve(undefined);
					};
					const deliver = (value: InvalidationNotice | undefined) => {
						signal.removeEventListener("abort", abort);
						resolve(value);
					};
					receiveNotice = deliver;
					signal.addEventListener("abort", abort, { once: true });
				}));
			if (notice && !signal.aborted) yield notice;
		}
	};
	const publishDefaults = () => {
		const notice: InvalidationNotice = { keys: [["models", "defaults"]] };
		const deliver = receiveNotice;
		if (deliver) {
			receiveNotice = undefined;
			deliver(notice);
		} else notices.push(notice);
	};
	let settings: SettingsData = {
		firstRunStage: "model",
		relationshipMemoryEnabled: false,
		networkProxy: { mode: "direct" },
		memoryVectorService: { enabled: false, provider: "none" },
		modelDownloadSource: { type: "official" },
	};
	let providers = options.providers ?? [candidate];
	let models = options.models ?? [];
	let systemDefaults: SystemModelDefaultsGetResponse = options.defaults ?? {
		vision: { mode: "auto" },
	};
	let defaults: ModelDefaultsGetResponse = { vision: { mode: "auto" }, onboardingComplete: false };
	let publishProviderProjection = true;
	let providerAdded = false;
	client.settings.get = vi.fn(() => ok({ settings }));
	client.provider.list = vi.fn(() => {
		if (providerAdded && publishProviderProjection) providers = [addedProvider];
		return ok({ providers });
	});
	client.provider.setApiKey = vi.fn(() => {
		providerAdded = true;
		return ok(null);
	});
	client.model.poolGet = vi.fn(() => {
		if (providerAdded && publishProviderProjection) models = [replyModel, imageModel];
		return ok({ models });
	});
	client.model.systemDefaultsGet = vi.fn(() => ok(systemDefaults));
	client.model.defaultsGet = vi.fn(() => ok(defaults));
	client.model.defaultsSetReply = vi.fn(({ reply }) => {
		const { reply: _previous, ...rest } = defaults;
		defaults = { ...rest, ...(reply ? { reply } : {}) };
		return ok(defaults);
	});
	client.model.defaultsSetVision = vi.fn((vision) => {
		defaults = { ...defaults, vision };
		return ok(defaults);
	});
	client.model.defaultsCompleteOnboarding = vi.fn(() => {
		defaults = { ...defaults, onboardingComplete: true };
		return ok(defaults);
	});
	client.systemOnboarding.completeModel = vi.fn(({ reply, vision }) => {
		systemDefaults = { reply, vision };
		settings = { ...settings, firstRunStage: "embedding" };
		defaults = { ...systemDefaults, onboardingComplete: false };
		publishDefaults();
		return ok({ settings, defaults: systemDefaults });
	});
	client.systemOnboarding.completeEmbedding = vi.fn(() => {
		settings = { ...settings, firstRunStage: "role" };
		return ok({ settings });
	});
	client.onboarding.get = vi.fn(() =>
		ok({
			status: "active" as const,
			currentStepId: "hello",
			stateData: { answers: {}, decisions: {} },
		}),
	);
	const mount = () => {
		let store!: CompanionStore;
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = render(() => (
			<QueryClientProvider client={queryClient}>
				{(() => {
					store = createCompanionStore(client);
					return (
						<DesktopProvider store={store}>
							<FirstMeeting />
						</DesktopProvider>
					);
				})()}
			</QueryClientProvider>
		));
		return { ...view, store };
	};
	return {
		client,
		mount,
		holdProviderList: () => {
			publishProviderProjection = false;
		},
		publishProviderList: async (store: CompanionStore) => {
			publishProviderProjection = true;
			await Promise.all([store.provider.list(), store.model.list()]);
		},
	};
}

async function selectProvider(user: UserEvent, dialog: HTMLElement) {
	await selectKobalteOption(
		user,
		within(dialog).getByLabelText(zhCN.settings.providerLabel),
		candidate.name,
	);
}

async function addProvider(user: UserEvent, dialog: HTMLElement) {
	await selectProvider(user, dialog);
	await user.type(first(within(dialog).getAllByLabelText(zhCN.settings.apiKeyLabel)), "secret");
	await user.click(
		first(within(dialog).getAllByRole("button", { name: zhCN.settings.addProvider })),
	);
}

async function selectReply(user: UserEvent, dialog: HTMLElement) {
	await selectKobalteOption(
		user,
		await within(dialog).findByLabelText(zhCN.modelSetup.modelLabel),
		{
			label: "Reply · OpenAI",
		},
	);
}

async function confirmRole(user: UserEvent) {
	const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
	await waitFor(() =>
		expect(within(dialog).getByRole("button", { name: zhCN.modelSetup.confirmRole })).toBeEnabled(),
	);
	await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.confirmRole }));
	return screen.findByRole("dialog", {
		name: THEMED_CHARACTER.character.first_meeting.dialog_label,
	});
}

describe("Host-backed first-run setup", () => {
	it("shows synced model settings only after the Host publishes the added provider", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost();
		const { store } = setup.mount();
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectProvider(user, dialog);
		await user.type(first(within(dialog).getAllByLabelText(zhCN.settings.apiKeyLabel)), "secret");
		await user.type(
			first(within(dialog).getAllByLabelText(zhCN.settings.customBaseUrl)),
			"https://relay.example/v1",
		);
		setup.holdProviderList();
		await user.click(
			first(within(dialog).getAllByRole("button", { name: zhCN.settings.addProvider })),
		);
		await waitFor(() =>
			expect(setup.client.provider.overrideBaseUrl).toHaveBeenCalledWith({
				providerId: "openai",
				baseUrl: "https://relay.example/v1",
			}),
		);
		expect(store.provider.providers()[0]?.added).toBe(false);
		expect(within(dialog).queryByLabelText(zhCN.modelSetup.modelLabel)).not.toBeInTheDocument();
		await setup.publishProviderList(store);
		await waitFor(() => expect(store.provider.providers()[0]?.added).toBe(true));
		const finish = await within(dialog).findByRole("button", { name: zhCN.modelSetup.continue });
		expect(finish).toBeDisabled();
		await selectReply(user, dialog);
		expect(finish).toBeEnabled();
		expect(setup.client.systemOnboarding.completeModel).not.toHaveBeenCalled();
		expect(store.model.data()?.systemDefaults.reply).toBeUndefined();
	});

	it("reuses an existing Host provider and exposes synced models without provider setup", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost({ providers: [addedProvider], models: [replyModel, imageModel] });
		setup.mount();
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectReply(user, dialog);
		expect(
			within(dialog).queryByRole("region", { name: zhCN.settings.providerSetupLabel }),
		).not.toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await screen.findByRole("dialog", { name: zhCN.settings.memoryVectorSection });
		expect(setup.client.provider.setApiKey).not.toHaveBeenCalled();
		expect(setup.client.systemOnboarding.completeModel).toHaveBeenCalledWith({
			reply: replyRoute,
			vision: { mode: "auto" },
		});
	});

	it("keeps model setup until Host accepts the automatic image fallback", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost({ providers: [addedProvider], models: [replyModel, imageModel] });
		const complete = setup.client.systemOnboarding.completeModel;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		setup.client.systemOnboarding.completeModel = vi.fn(async (params) => {
			await pending;
			return complete(params);
		});
		const { store } = setup.mount();
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectReply(user, dialog);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await waitFor(() =>
			expect(setup.client.systemOnboarding.completeModel).toHaveBeenCalledWith({
				reply: replyRoute,
				vision: { mode: "auto" },
			}),
		);
		expect(store.settings.data()?.firstRunStage).toBe("model");
		expect(dialog).toBeVisible();
		expect(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue })).toBeDisabled();
		release();
		await screen.findByRole("dialog", { name: zhCN.settings.memoryVectorSection });
		expect(store.settings.data()?.firstRunStage).toBe("embedding");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("restores Host system progress in a fresh renderer before separate character confirmation", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost({
			providers: [addedProvider],
			models: [replyModel],
			defaults: { reply: replyRoute, vision: { mode: "auto" } },
		});
		const firstRender = setup.mount();
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await waitFor(() =>
			expect(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue })).toBeEnabled(),
		);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await screen.findByRole("dialog", { name: zhCN.settings.memoryVectorSection });
		firstRender.unmount();
		const secondRender = setup.mount();
		const handoff = await screen.findByRole("dialog", { name: zhCN.settings.memoryVectorSection });
		expect(
			screen.queryByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).not.toBeInTheDocument();
		await user.click(within(handoff).getByRole("button", { name: zhCN.messages.continue }));
		await waitFor(() =>
			expect(setup.client.systemOnboarding.completeEmbedding).toHaveBeenCalledWith({
				choice: "none",
			}),
		);
		await waitFor(() => expect(secondRender.store.settings.data()?.firstRunStage).toBe("role"));
		secondRender.unmount();
		setup.mount();
		expect(await confirmRole(user)).toBeVisible();
		expect(setup.client.systemOnboarding.completeModel).toHaveBeenCalledTimes(1);
		expect(setup.client.onboarding.submit).not.toHaveBeenCalled();
	});

	it("hands embedding setup to Settings without embedding a system form or completing first meeting", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost({ providers: [addedProvider], models: [replyModel, imageModel] });
		const { store } = setup.mount();
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await selectReply(user, dialog);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		const handoff = await screen.findByRole("dialog", { name: zhCN.settings.memoryVectorSection });
		expect(
			within(handoff).getByRole("button", { name: zhCN.sidebar.systemSettings }),
		).toBeEnabled();
		expect(within(handoff).queryByRole("combobox")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("dialog", { name: THEMED_CHARACTER.character.first_meeting.dialog_label }),
		).not.toBeInTheDocument();
		expect(setup.client.systemOnboarding.completeEmbedding).not.toHaveBeenCalled();
		await user.click(within(handoff).getByRole("button", { name: zhCN.messages.continue }));
		await waitFor(() => expect(store.settings.data()?.firstRunStage).toBe("role"));
		expect(setup.client.systemOnboarding.completeEmbedding).toHaveBeenCalledWith({
			choice: "none",
		});
		expect(await confirmRole(user)).toBeVisible();
		expect(store.settings.data()?.relationshipMemoryEnabled).toBe(false);
		expect(setup.client.onboarding.submit).not.toHaveBeenCalled();
		expect(setup.client.settings.set).not.toHaveBeenCalled();
	});

	it("selects a provider progressively then submits reply and image reader drafts together", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost();
		const { store } = setup.mount();
		const dialog = await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		await addProvider(user, dialog);
		await selectReply(user, dialog);
		expect(
			within(dialog).queryByRole("region", { name: zhCN.settings.providerSetupLabel }),
		).not.toBeInTheDocument();
		await selectKobalteOption(user, within(dialog).getByLabelText(zhCN.settings.visionModel), {
			label: "Image Reader · OpenAI",
		});
		expect(store.model.data()?.systemDefaults.reply).toBeUndefined();
		expect(setup.client.systemOnboarding.completeModel).not.toHaveBeenCalled();
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await screen.findByRole("dialog", { name: zhCN.settings.memoryVectorSection });
		expect(setup.client.systemOnboarding.completeModel).toHaveBeenCalledWith({
			reply: replyRoute,
			vision: { mode: "manual", route: { providerId: "openai", modelId: "image" } },
		});
		expect(store.model.data()?.systemDefaults).toEqual({
			reply: replyRoute,
			vision: { mode: "manual", route: { providerId: "openai", modelId: "image" } },
		});
		expect(setup.client.model.systemDefaultsSet).not.toHaveBeenCalled();
		expect(setup.client.settings.set).not.toHaveBeenCalled();
	});
});
