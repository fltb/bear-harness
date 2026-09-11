import { zhCN } from "@bear-harness/i18n/locales";
import type {
	ConfiguredModel,
	InvalidationNotice,
	ModelDefaultsGetResponse,
	OnboardingResponse,
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

function firstRunHost(
	options: {
		providers?: ProviderInfo[];
		models?: ConfiguredModel[];
		defaults?: SystemModelDefaultsGetResponse;
		stage?: SettingsData["firstRunStage"];
		roleDefaults?: ModelDefaultsGetResponse;
		platform?: string;
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
		firstRunStage: options.stage ?? "model",
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
	let defaults: ModelDefaultsGetResponse = options.roleDefaults ?? {
		vision: { mode: "auto" },
		onboardingComplete: false,
	};
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
							<FirstMeeting platform={options.platform} />
						</DesktopProvider>
					);
				})()}
			</QueryClientProvider>
		));
		return { ...view, store, queryClient };
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
	const editor = within(dialog).getByRole("region", { name: candidate.name });
	await user.type(within(editor).getByLabelText(zhCN.settings.apiKeyLabel), "secret");
	await user.click(within(editor).getByRole("button", { name: zhCN.settings.addProvider }));
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

async function continuePastLicense(user: UserEvent, windows = false) {
	const dialog = await screen.findByRole("dialog", { name: zhCN.licenseNotice.dialogLabel });
	const confirmation = within(dialog).getByRole("checkbox", {
		name: windows ? zhCN.licenseNotice.confirmWindows : zhCN.licenseNotice.confirmBear,
	});
	const continueButton = within(dialog).getByRole("button", {
		name: zhCN.licenseNotice.continue,
	});
	expect(continueButton).toBeDisabled();
	await user.click(confirmation);
	expect(continueButton).toBeEnabled();
	await user.click(continueButton);
	return screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
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
	it("requires Bear GPLv3 acknowledgement first and omits Windows licenses on macOS/Linux", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost({ platform: "darwin" });
		setup.mount();
		const dialog = await screen.findByRole("dialog", { name: zhCN.licenseNotice.dialogLabel });
		expect(
			within(dialog).getByRole("heading", { name: zhCN.licenseNotice.bearTitle }),
		).toBeVisible();
		expect(within(dialog).queryByText(zhCN.licenseNotice.gitTitle)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).not.toBeInTheDocument();
		await continuePastLicense(user);
		expect(setup.client.systemOnboarding.completeModel).not.toHaveBeenCalled();
	});

	it("shows Git for Windows licensing and carries both acknowledgements into setup", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost({
			platform: "win32",
			providers: [addedProvider],
			models: [replyModel],
		});
		setup.mount();
		const license = await screen.findByRole("dialog", { name: zhCN.licenseNotice.dialogLabel });
		expect(
			within(license).getByRole("heading", { name: zhCN.licenseNotice.gitTitle }),
		).toBeVisible();
		const model = await continuePastLicense(user, true);
		await selectReply(user, model);
		await user.click(within(model).getByRole("button", { name: zhCN.modelSetup.continue }));
		await waitFor(() =>
			expect(setup.client.systemOnboarding.completeModel).toHaveBeenCalledWith({
				reply: replyRoute,
				vision: { mode: "auto" },
				licensesAcknowledged: {
					bear: "GPL-3.0-only",
					gitForWindows: "GPL-2.0-only",
				},
			}),
		);
	});

	it("never mounts onboarding while completed role projections arrive separately", async () => {
		const setup = firstRunHost({
			stage: "role",
			roleDefaults: { reply: replyRoute, vision: { mode: "auto" }, onboardingComplete: true },
		});
		let releaseDefaults!: () => void;
		let releaseOnboarding!: () => void;
		const defaultsPending = new Promise<void>((resolve) => {
			releaseDefaults = resolve;
		});
		const onboardingPending = new Promise<void>((resolve) => {
			releaseOnboarding = resolve;
		});
		const getDefaults = setup.client.model.defaultsGet;
		setup.client.model.defaultsGet = vi.fn(async () => {
			await defaultsPending;
			return getDefaults();
		});
		setup.client.onboarding.get = vi.fn(async () => {
			await onboardingPending;
			return {
				ok: true as const,
				data: { status: "complete" as const, stateData: { answers: {} } },
			};
		});
		const mountedDialogs: Element[] = [];
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (!(node instanceof HTMLElement)) continue;
					// Include the added root and detached transient dialogs, not only
					// descendants that remain mounted when this callback is delivered.
					const addedTree = document.createElement("div");
					addedTree.append(node.cloneNode(true));
					mountedDialogs.push(...within(addedTree).queryAllByRole("dialog", { hidden: true }));
				}
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
		try {
			const { store } = setup.mount();
			await waitFor(() => expect(store.settings.data()?.firstRunStage).toBe("role"));
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			releaseDefaults();
			await waitFor(() => expect(store.model.data().defaults.onboardingComplete).toBe(true));
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			releaseOnboarding();
			await waitFor(() => expect(store.characterSetupReady).toBe(true));
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(mountedDialogs).toEqual([]);
		} finally {
			observer.disconnect();
			releaseDefaults();
			releaseOnboarding();
		}
	});

	it("waits for system authority before showing the required setup layer", async () => {
		const setup = firstRunHost({
			roleDefaults: { reply: replyRoute, vision: { mode: "auto" }, onboardingComplete: true },
		});
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const getSettings = setup.client.settings.get;
		setup.client.settings.get = vi.fn(async () => {
			await pending;
			return getSettings();
		});
		const { store } = setup.mount();
		await waitFor(() => expect(store.onboarding.status).toBe("active"));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		release();
		await screen.findByRole("dialog", { name: zhCN.licenseNotice.dialogLabel });
		expect(screen.queryByRole("dialog", { name: "Introduction" })).not.toBeInTheDocument();
	});

	it("keeps confirmed incomplete onboarding and its draft during a same-character refetch", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost({
			stage: "role",
			roleDefaults: { reply: replyRoute, vision: { mode: "auto" }, onboardingComplete: true },
		});
		setup.client.snapshot.get = vi.fn(async () => ({
			ok: true as const,
			data: {
				onboarding: {
					status: "active" as const,
					currentStepId: "hello",
					stateData: { answers: {} },
				},
				character: {
					...THEMED_CHARACTER,
					character: {
						...THEMED_CHARACTER.character,
						first_meeting: {
							...THEMED_CHARACTER.character.first_meeting,
							steps: [
								{
									id: "hello",
									kind: "text" as const,
									heading: "Hello",
									body: "Welcome",
									answer_key: "name",
									input_label: "Your name",
									input_placeholder: "Name",
									min_length: 1,
									max_length: 64,
									submit_label: "Continue",
								},
							],
						},
					},
				},
			},
		}));
		const { queryClient } = setup.mount();
		const dialog = await screen.findByRole("dialog", { name: "Introduction" });
		await user.type(within(dialog).getByRole("textbox", { name: "Your name" }), "Unsaved name");
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const getDefaults = setup.client.model.defaultsGet;
		setup.client.model.defaultsGet = vi.fn(async () => {
			await pending;
			return getDefaults();
		});
		const refresh = queryClient.invalidateQueries({ queryKey: ["models", "defaults"] });
		await waitFor(() =>
			expect(queryClient.isFetching({ queryKey: ["models", "defaults"] })).toBe(1),
		);
		expect(dialog).toBeVisible();
		expect(within(dialog).getByRole("textbox", { name: "Your name" })).toHaveValue("Unsaved name");
		release();
		await refresh;
		expect(dialog).toBeVisible();
		expect(within(dialog).getByRole("textbox", { name: "Your name" })).toHaveValue("Unsaved name");
	});

	it("does not borrow a previous character's completion while the new projection loads", async () => {
		const setup = firstRunHost({
			stage: "role",
			roleDefaults: { reply: replyRoute, vision: { mode: "auto" }, onboardingComplete: true },
		});
		let character = THEMED_CHARACTER;
		let onboarding: OnboardingResponse = { status: "complete", stateData: { answers: {} } };
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		setup.client.snapshot.get = vi.fn(async () => ({
			ok: true as const,
			data: { character, onboarding },
		}));
		setup.client.onboarding.get = vi.fn(async () => {
			if (character.id !== THEMED_CHARACTER.id) await pending;
			return { ok: true as const, data: onboarding };
		});
		setup.client.character.activate = vi.fn(async () => {
			character = { ...THEMED_CHARACTER, id: "second-character" };
			onboarding = { status: "active", currentStepId: "hello", stateData: { answers: {} } };
			return { ok: true as const, data: { character } };
		});
		const { store } = setup.mount();
		await waitFor(() => expect(store.characterSetupReady).toBe(true));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		const activation = store.characters.activate("second-character");
		await waitFor(() => expect(store.character?.id).toBe("second-character"));
		expect(store.characterSetupReady).toBe(false);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		release();
		await activation;
		await screen.findByRole("dialog", { name: "Introduction" });
	});

	it("shows a failed readiness request without inventing incomplete onboarding", async () => {
		const setup = firstRunHost({ stage: "role" });
		setup.client.model.defaultsGet = vi.fn(async () => {
			throw new Error("role defaults unavailable");
		});
		const { queryClient } = setup.mount();
		expect(await screen.findByRole("alert")).toHaveTextContent("role defaults unavailable");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		setup.client.model.defaultsGet = vi.fn(async () => ({
			ok: true as const,
			data: { vision: { mode: "auto" as const }, onboardingComplete: false },
		}));
		await queryClient.invalidateQueries({ queryKey: ["models", "defaults"] });
		await screen.findByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows synced model settings only after the Host publishes the added provider", async () => {
		const user = userEvent.setup();
		const setup = firstRunHost();
		const { store } = setup.mount();
		const dialog = await continuePastLicense(user);
		await selectProvider(user, dialog);
		const editor = within(dialog).getByRole("region", { name: candidate.name });
		await user.type(within(editor).getByLabelText(zhCN.settings.apiKeyLabel), "secret");
		await user.type(
			within(editor).getByLabelText(zhCN.settings.customBaseUrl),
			"https://relay.example/v1",
		);
		setup.holdProviderList();
		await user.click(within(editor).getByRole("button", { name: zhCN.settings.addProvider }));
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
		const dialog = await continuePastLicense(user);
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
			licensesAcknowledged: { bear: "GPL-3.0-only" },
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
		const dialog = await continuePastLicense(user);
		await selectReply(user, dialog);
		await user.click(within(dialog).getByRole("button", { name: zhCN.modelSetup.continue }));
		await waitFor(() =>
			expect(setup.client.systemOnboarding.completeModel).toHaveBeenCalledWith({
				reply: replyRoute,
				vision: { mode: "auto" },
				licensesAcknowledged: { bear: "GPL-3.0-only" },
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
		const dialog = await continuePastLicense(user);
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
		const dialog = await continuePastLicense(user);
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
		const dialog = await continuePastLicense(user);
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
			licensesAcknowledged: { bear: "GPL-3.0-only" },
		});
		expect(store.model.data()?.systemDefaults).toEqual({
			reply: replyRoute,
			vision: { mode: "manual", route: { providerId: "openai", modelId: "image" } },
		});
		expect(setup.client.model.systemDefaultsSet).not.toHaveBeenCalled();
		expect(setup.client.settings.set).not.toHaveBeenCalled();
	});
});
