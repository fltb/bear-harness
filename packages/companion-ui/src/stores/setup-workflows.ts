import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Namespace, TFunction } from "i18next";
import type {
	CharacterOnboardingStep,
	ConfiguredModel,
	ProviderLoginResult,
	SettingsPatch,
} from "./companion.js";
import type { CompanionStore } from "./companion.js";
const VECTOR_PROVIDERS = ["none", "remote", "local"] as const;
const PROXY_MODES = ["direct", "auto", "manual"] as const;
const VECTOR_PRESETS = [
	{ value: "BAAI/bge-m3", key: "bge-m3", dimensions: 1024 },
	{ value: "Qwen/Qwen3-Embedding-8B", key: "qwen3-embedding", dimensions: 1024 },
	{ value: "text-embedding-v4", key: "tongyi-v4", dimensions: 1024 },
	{ value: "text-embedding-3-small", key: "openai-3-small", dimensions: 1536 },
] as const;
type Translate = TFunction<Namespace, undefined>;
type VectorProvider = (typeof VECTOR_PROVIDERS)[number];
type ProxyMode = (typeof PROXY_MODES)[number];

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
function hasMethod<T extends (...args: never[]) => unknown>(value: unknown): value is T {
	return typeof value === "function";
}

function routeOptionId(route: { providerId: string; modelId: string }): string {
	return `${route.providerId}\u0000${route.modelId}`;
}


export function createFirstMeetingWorkflow(store: CompanionStore, t: Translate) {
	const [textAnswer, setTextAnswer] = createSignal("");
	const [submitting, setSubmitting] = createSignal(false);
	const [providerId, setProviderId] = createSignal("");
	const [modelId, setModelId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const [customBaseUrl, setCustomBaseUrl] = createSignal("");
	const [advancedOpen, setAdvancedOpen] = createSignal(false);
	const [piConfigJson, setPiConfigJson] = createSignal("");
	const [importedModels, setImportedModels] = createSignal<ConfiguredModel[]>([]);
	const [setupError, setSetupError] = createSignal<string | null>(null);
	const [setupBusy, setSetupBusy] = createSignal(false);
	const [modelSetupComplete, setModelSetupComplete] = createSignal(false);
	const [connectedProviderId, setConnectedProviderId] = createSignal("");
	const [oauth, setOauth] = createSignal<ProviderLoginResult | null>(null);
	const [oauthAnswer, setOauthAnswer] = createSignal("");
	let submittedStepId: string | null = null;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const flow = createMemo(() => store.character?.character.first_meeting);
	const providers = createMemo(() =>
		hasMethod(store.provider?.providers) ? store.provider.providers() : [],
	);
	const selectedProvider = createMemo(() => providers().find((provider) => provider.id === providerId()));
	const providerConnected = createMemo(() => {
		const status = selectedProvider()?.credentialStatus;
		return status === "stored" || status === "session_only" || connectedProviderId() === providerId();
	});
	const modelApiAvailable = hasMethod(store.model?.loading) && hasMethod(store.model?.data);
	const modelRequired = createMemo(() => {
		if (modelSetupComplete() || store.loading) return false;
		if (!modelApiAvailable) return true;
		return !store.model.loading() && store.model.data()?.defaults?.reply === undefined;
	});
	const memorySetupRequired = createMemo(
		() => modelSetupComplete() && !(store.embedding?.localConfigureMutation?.isSuccess ?? false),
	);
	const currentStep = createMemo<CharacterOnboardingStep | undefined>(() => {
		const definition = flow();
		return definition?.steps.find((step) => step.id === store.onboarding.currentStepId);
	});
	const currentStepIndex = createMemo(() => {
		const definition = flow();
		const step = currentStep();
		return definition && step ? definition.steps.findIndex((item) => item.id === step.id) : -1;
	});
	const currentStepLabel = createMemo(() => {
		const definition = flow();
		const index = currentStepIndex();
		return definition && index >= 0
			? definition.step_label.replaceAll("{step}", String(index + 1)).replaceAll("{total}", String(definition.steps.length))
			: "";
	});
	const visible = createMemo(
		() => store.onboarding.status === "active" && currentStep() !== undefined && !store.loading,
	);
	const conversationVisible = createMemo(() => !modelRequired() && !memorySetupRequired() && visible());
	const onboardingError = createMemo(() => store.error);
	const importedModelDisplay = createMemo(() =>
		importedModels().map((model) => `${model.label} (${model.providerId}/${model.modelId})`),
	);

	const selectProvider = (id: string): void => {
		const provider = providers().find((item) => item.id === id);
		setProviderId(id);
		setModelId("");
		setCustomBaseUrl(provider?.baseUrl ?? "");
		setOauth(null);
		setOauthAnswer("");
		setConnectedProviderId("");
		setSetupError(null);
	};
	const pinModel = async (): Promise<void> => {
		if (!providerId() || !modelId()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.model.enable(
				providerId(),
				modelId(),
				selectedProvider()?.availableModels.find((model) => model.id === modelId())?.name,
			);
			await store.model.setDefaultReply(providerId(), modelId());
			setModelSetupComplete(true);
		} catch (cause) {
			setSetupError(messageOf(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const saveProviderKey = async (): Promise<void> => {
		if (!apiKey().trim()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.provider.setApiKey(providerId(), apiKey().trim());
			setApiKey("");
			setConnectedProviderId(providerId());
			await store.provider.list();
		} catch (cause) {
			setSetupError(messageOf(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const saveProviderBaseUrl = async (): Promise<void> => {
		if (!providerId() || !customBaseUrl().trim()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.provider.overrideBaseUrl({ providerId: providerId(), baseUrl: customBaseUrl().trim() });
			setCustomBaseUrl(customBaseUrl().trim());
			await store.provider.list();
		} catch (cause) {
			setSetupError(messageOf(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const importPiConfig = async (): Promise<void> => {
		if (!piConfigJson().trim()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			const imported = await store.provider.importPiConfig(piConfigJson().trim());
			setImportedModels(imported);
			setPiConfigJson("");
			await store.provider.list();
			const providerIds = new Set(imported.map((model) => model.providerId));
			if (providerIds.size === 1) setProviderId(imported[0]?.providerId ?? "");
			if (imported.length === 1) setModelId(imported[0]?.modelId ?? "");
		} catch (cause) {
			setSetupError(messageOf(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const beginOauth = async (): Promise<void> => {
		setSetupBusy(true);
		setSetupError(null);
		try {
			let state = await store.provider.login(providerId());
			setOauth(state);
			while (!disposed && (state.status === "running" || state.status === "waiting_input")) {
				if (state.status === "waiting_input") break;
				await new Promise((resolve) => setTimeout(resolve, 750));
				state = await store.provider.loginStatus(providerId());
				setOauth(state);
			}
			if (state.prompt?.type === "select" && state.prompt.options?.[0]) setOauthAnswer(state.prompt.options[0].id);
			if (state.status === "completed") {
				setConnectedProviderId(providerId());
				await store.provider.list();
			}
			if (state.status === "failed") setSetupError(state.message ?? t("settings.oauthFailed"));
		} catch (cause) {
			setSetupError(messageOf(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const answerOauth = async (): Promise<void> => {
		if (!oauthAnswer()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.provider.loginAnswer(providerId(), oauthAnswer());
			setOauthAnswer("");
			await beginOauth();
		} catch (cause) {
			setSetupError(messageOf(cause));
			setSetupBusy(false);
		}
	};
	const submit = async (stepId: string, answer?: string): Promise<void> => {
		if (submitting() || submittedStepId === stepId) return;
		submittedStepId = stepId;
		setSubmitting(true);
		try {
			await store.submitOnboarding(stepId, answer);
		} catch (cause) {
			submittedStepId = null;
			throw cause;
		} finally {
			setSubmitting(false);
		}
	};
	createEffect(() => {
		const currentStepId = store.onboarding.currentStepId;
		if (submittedStepId !== null && submittedStepId !== currentStepId) submittedStepId = null;
	});
	createEffect(() => {
		if (hasMethod(store.provider?.list)) {
			void Promise.resolve(store.provider.list()).catch((cause) => setSetupError(messageOf(cause)));
		}
	});

	return {
		textAnswer,
		setTextAnswer,
		submitting,
		providers,
		providerId,
		modelId,
		apiKey,
		setApiKey,
		customBaseUrl,
		setCustomBaseUrl,
		advancedOpen,
		setAdvancedOpen,
		piConfigJson,
		setPiConfigJson,
		importedModels,
		importedModelDisplay,
		setupError,
		setupBusy,
		modelRequired,
		memorySetupRequired,
		selectedProvider,
		providerConnected,
		currentStep,
		currentStepIndex,
		currentStepLabel,
		flow,
		visible,
		conversationVisible,
		onboardingError,
		oauth,
		oauthAnswer,
		setOauthAnswer,
		selectProvider,
		setModelId,
		pinModel,
		saveProviderKey,
		saveProviderBaseUrl,
		importPiConfig,
		beginOauth,
		answerOauth,
		submit,
	};
}

export function createSettingsWorkflow(store: CompanionStore, t: Translate) {
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);
	const [providerId, setProviderId] = createSignal("");
	const [modelId, setModelId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const [oauth, setOauth] = createSignal<ProviderLoginResult | null>(null);
	const [oauthAnswer, setOauthAnswer] = createSignal("");
	const [advancedOpen, setAdvancedOpen] = createSignal(false);
	const [customBaseUrl, setCustomBaseUrl] = createSignal("");
	const [piConfigJson, setPiConfigJson] = createSignal("");
	const [importedModels, setImportedModels] = createSignal<ConfiguredModel[]>([]);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const providers = createMemo(() =>
		hasMethod(store.provider?.providers) ? store.provider.providers() : [],
	);
	const configured = createMemo(() => {
		const modelData = hasMethod(store.model?.data) ? store.model.data() : undefined;
		const models = hasMethod(store.model?.models) ? store.model.models() : [];
		return Array.isArray(modelData?.models) && modelData.models.length ? modelData.models : models;
	});
	const selectedProvider = createMemo(() => providers().find((provider) => provider.id === providerId()));
	const selectedConfigured = createMemo(() =>
		configured().some((model) => model.providerId === providerId() && model.modelId === modelId()),
	);
	const modelOptions = createMemo(() => configured().map((model) => routeOptionId(model)));
	const defaultReplyModel = createMemo(() => {
		const route = hasMethod(store.model?.data) ? store.model.data()?.defaults?.reply : undefined;
		return route ? configured().find((model) => model.providerId === route.providerId && model.modelId === route.modelId) : undefined;
	});
	const defaultReplyOption = createMemo(() => {
		const model = defaultReplyModel();
		return model ? routeOptionId(model) : null;
	});
	const visionOptions = createMemo(() => ["auto", ...configured().filter((model) => model.supportsImages).map(routeOptionId)]);
	const selectedVisionOption = createMemo(() => {
		const vision = hasMethod(store.model?.data) ? store.model.data()?.defaults?.vision : undefined;
		return !vision || vision.mode === "auto" || !vision.route ? "auto" : routeOptionId(vision.route);
	});
	const apiKeyPlaceholder = createMemo(() => {
		const status = selectedProvider()?.credentialStatus;
		return status === "stored" || status === "session_only" ? t("settings.apiKeyStoredPlaceholder") : undefined;
	});
	const importedModelDisplay = createMemo(() => importedModels().map((model) => `${model.label} (${model.providerName ?? model.providerId})`));

	const run = async (action: () => Promise<unknown>, success: string): Promise<void> => {
		setSaving(true);
		setError(null);
		setFeedback(null);
		try {
			await action();
			setFeedback(success);
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	};
	const selectProvider = (id: string): void => {
		const provider = providers().find((item) => item.id === id);
		setProviderId(id);
		setModelId("");
		setCustomBaseUrl(provider?.baseUrl ?? "");
		setOauth(null);
		setOauthAnswer("");
	};
	const beginOauth = async (): Promise<void> => {
		setSaving(true);
		setError(null);
		try {
			let state = await store.provider.login(providerId());
			setOauth(state);
			while (!disposed && (state.status === "running" || state.status === "waiting_input")) {
				if (state.status === "waiting_input") break;
				await new Promise((resolve) => setTimeout(resolve, 750));
				state = await store.provider.loginStatus(providerId());
				setOauth(state);
			}
			if (state.prompt?.type === "select" && state.prompt.options?.[0]) setOauthAnswer(state.prompt.options[0].id);
			if (state.status === "completed") {
				setFeedback(t("settings.oauthConnected"));
				await store.provider.list();
			}
			if (state.status === "failed") setError(state.message ?? t("settings.oauthFailed"));
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	};
	const saveApiKey = (): Promise<void> =>
		run(async () => {
			await store.provider.setApiKey(providerId(), apiKey());
			setApiKey("");
			await store.provider.list();
		}, t("settings.keySaved"));
	const saveBaseUrl = (): Promise<void> =>
		run(async () => {
			await store.provider.overrideBaseUrl({ providerId: providerId(), baseUrl: customBaseUrl() });
			setCustomBaseUrl(customBaseUrl().trim());
		}, t("settings.customSaved"));
	const importPiConfig = (): Promise<void> =>
		run(async () => {
			const imported = await store.provider.importPiConfig(piConfigJson());
			setImportedModels(imported);
			setPiConfigJson("");
			await store.provider.list();
		}, t("settings.piConfigImported"));
	const answerOauth = (): Promise<void> =>
		run(async () => {
			await store.provider.loginAnswer(providerId(), oauthAnswer());
			setOauthAnswer("");
		}, t("settings.oauthConnected"));
	const setDefaultReply = (id: string | null): Promise<void> => {
		const model = id ? configured().find((item) => routeOptionId(item) === id) : undefined;
		return run(
			() => (model ? store.model.setDefaultReply(model.providerId, model.modelId) : store.model.clearDefaultReply()),
			t("settings.defaultReplyUpdated"),
		);
	};
	const setVisionModel = (id: string | null): Promise<void> => {
		const model = id && id !== "auto" ? configured().find((item) => routeOptionId(item) === id) : undefined;
		return run(
			() => (model ? store.model.setMultimodalFallback(model.providerId, model.modelId) : store.model.setVisionAuto()),
			t("settings.imageReaderUpdated"),
		);
	};
	const removeModel = (model: ConfiguredModel): Promise<void> =>
		run(() => store.model.disable(model.providerId, model.modelId), t("settings.modelRemoved"));
	const addModel = (): Promise<void> =>
		run(
			() =>
				store.model.enable(
					providerId(),
					modelId(),
					selectedProvider()?.availableModels.find((model) => model.id === modelId())?.name,
				),
			t("settings.modelAdded"),
		);
	createEffect(() => {
		const requests: Promise<unknown>[] = [];
		if (hasMethod(store.provider?.list)) requests.push(Promise.resolve(store.provider.list()));
		if (hasMethod(store.model?.list)) requests.push(Promise.resolve(store.model.list()));
		if (requests.length > 0) void Promise.all(requests).catch((cause) => setError(messageOf(cause)));
	});

	return {
		saving,
		error,
		feedback,
		providers,
		providerId,
		modelId,
		apiKey,
		setApiKey,
		oauth,
		oauthAnswer,
		setOauthAnswer,
		advancedOpen,
		setAdvancedOpen,
		customBaseUrl,
		setCustomBaseUrl,
		piConfigJson,
		setPiConfigJson,
		importedModels,
		importedModelDisplay,
		configured,
		modelOptions,
		selectedProvider,
		selectedConfigured,
		defaultReplyModel,
		defaultReplyOption,
		visionOptions,
		selectedVisionOption,
		apiKeyPlaceholder,
		modelDisplayName: (model: ConfiguredModel) => `${model.label} (${model.providerName ?? model.providerId})`,
		modelByOptionId: (id: string) => configured().find((model) => routeOptionId(model) === id),
		selectProvider,
		setModelId,
		run,
		beginOauth,
		saveApiKey,
		saveBaseUrl,
		importPiConfig,
		answerOauth,
		setDefaultReply,
		setVisionModel,
		removeModel,
		addModel,
	};
}

export function createNetworkMemoryWorkflow(store: CompanionStore, t: Translate) {
	const [proxyMode, setProxyMode] = createSignal<ProxyMode>("direct");
	const [proxyUrl, setProxyUrl] = createSignal("");
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);
	const [initialized, setInitialized] = createSignal(false);
	const settingsPatch = createMemo<SettingsPatch>(() => ({
		networkProxy: {
			mode: proxyMode(),
			...(proxyMode() === "manual" && proxyUrl().trim() ? { url: proxyUrl().trim() } : {}),
		},
	}));
	createEffect(() => {
		const settings = store.settings;
		if (initialized() || !settings || !hasMethod(settings.data)) return;
		const proxy = settings.data()?.networkProxy;
		if (!proxy) return;
		setProxyMode(proxy.mode);
		setProxyUrl(proxy.url ?? "");
		setInitialized(true);
	});
	const save = async (): Promise<void> => {
		setSaving(true);
		setError(null);
		setFeedback(null);
		try {
			await store.settings.set(settingsPatch());
			setFeedback(t("settings.saved"));
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	};
	return {
		proxyMode,
		proxyUrl,
		setProxyMode,
		setProxyUrl,
		saving,
		error,
		feedback,
		save,
	};
}

export { PROXY_MODES, VECTOR_PRESETS, VECTOR_PROVIDERS };
export type { ProxyMode, VectorProvider };
