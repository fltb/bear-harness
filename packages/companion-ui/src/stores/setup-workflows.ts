import type { Namespace, TFunction } from "i18next";
import { createMemo, createSignal } from "solid-js";
import type {
	CharacterOnboardingStep,
	CompanionStore,
	ConfiguredModel,
	SettingsData,
	SettingsPatch,
} from "./companion.js";

type Translate = TFunction<Namespace, undefined>;
type ProxyMode = SettingsData["networkProxy"]["mode"];

function messageOf(value: unknown): string {
	if (value && typeof value === "object" && "message" in value && "reason" in value) {
		const message = value.message;
		const reason = value.reason;
		if (typeof message === "string" && typeof reason === "string") return `${message} (${reason})`;
	}
	return value instanceof Error ? value.message : String(value);
}
function hasMethod<T extends (...args: never[]) => unknown>(value: unknown): value is T {
	return typeof value === "function";
}

function routeOptionId(route: { providerId: string; modelId: string }): string {
	return `${route.providerId}\u0000${route.modelId}`;
}

export function createFirstMeetingWorkflow(store: CompanionStore) {
	const [textAnswer, setTextAnswer] = createSignal("");
	const [submitting, setSubmitting] = createSignal(false);
	const [setupError, setSetupError] = createSignal<string | null>(null);
	const [setupBusy, setSetupBusy] = createSignal(false);
	let submittedStepId: string | null = null;

	const flow = createMemo(() => store.character?.character.first_meeting);
	const configuredModels = createMemo(() =>
		hasMethod(store.model?.models) ? store.model.models() : [],
	);
	const modelDefaults = createMemo(() =>
		hasMethod(store.model?.data) ? store.model.data()?.defaults : undefined,
	);
	const selectedReplyModel = createMemo(() => {
		const reply = modelDefaults()?.reply;
		return reply
			? (configuredModels().find((model) => routeOptionId(model) === routeOptionId(reply)) ?? null)
			: null;
	});
	const selectedVisionModel = createMemo(() => {
		const vision = modelDefaults()?.vision;
		return vision?.mode === "manual"
			? (configuredModels().find((model) => routeOptionId(model) === routeOptionId(vision.route)) ??
					null)
			: null;
	});
	const firstRunStage = createMemo(() => store.settings?.data?.()?.firstRunStage ?? "model");
	const modelRequired = createMemo(
		() => store.onboarding.status === "active" && firstRunStage() === "model" && !store.loading,
	);
	const modelError = createMemo(() => {
		const error = hasMethod(store.model?.error) ? store.model.error() : null;
		return error === null || error === undefined ? null : messageOf(error);
	});
	const memorySetupRequired = createMemo(
		() => store.onboarding.status === "active" && firstRunStage() === "embedding" && !store.loading,
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
			? definition.step_label
					.replaceAll("{step}", String(index + 1))
					.replaceAll("{total}", String(definition.steps.length))
			: "";
	});
	const visible = createMemo(
		() => store.onboarding.status === "active" && currentStep() !== undefined && !store.loading,
	);
	const conversationVisible = createMemo(
		() => !modelRequired() && !memorySetupRequired() && visible(),
	);
	const onboardingError = createMemo(() => store.error);

	const saveModelDefault = async (action: () => Promise<void>): Promise<void> => {
		if (setupBusy()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await action();
		} catch (cause) {
			setSetupError(messageOf(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const selectReplyModel = (model: ConfiguredModel): Promise<void> =>
		saveModelDefault(() => store.model.setDefaultReply(model.providerId, model.modelId));
	const selectVisionModel = (model: ConfiguredModel | null): Promise<void> =>
		saveModelDefault(() =>
			model
				? store.model.setMultimodalFallback(model.providerId, model.modelId)
				: store.model.setVisionAuto(),
		);
	const completeModelSetup = (): void => {
		if (selectedReplyModel() && !setupBusy()) {
			void saveModelDefault(() => store.settings.set({ firstRunStage: "embedding" }));
		}
	};
	const completeMemorySetup = (): Promise<void> => store.settings.set({ firstRunStage: "role" });
	const submit = async (stepId: string, answer?: string): Promise<void> => {
		if (submittedStepId !== store.onboarding.currentStepId) submittedStepId = null;
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

	return {
		textAnswer,
		setTextAnswer,
		submitting,
		setupBusy,
		setupError,
		configuredModels,
		modelError,
		selectedReplyModel,
		selectedVisionModel,
		modelRequired,
		memorySetupRequired,
		currentStep,
		currentStepIndex,
		currentStepLabel,
		flow,
		visible,
		conversationVisible,
		onboardingError,
		selectReplyModel,
		selectVisionModel,
		completeModelSetup,
		completeMemorySetup,
		submit,
	};
}

const VISION_REPLY_OPTION = "reply";

export function createConversationModelSettingsWorkflow(store: CompanionStore, t: Translate) {
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);

	const configured = createMemo(() => {
		const modelData = hasMethod(store.model?.data) ? store.model.data() : undefined;
		const models = hasMethod(store.model?.models) ? store.model.models() : [];
		return Array.isArray(modelData?.models) && modelData.models.length ? modelData.models : models;
	});
	const modelByOptionId = (id: string): ConfiguredModel | undefined =>
		configured().find((model) => routeOptionId(model) === id);
	const selectedCurrentReplyOption = createMemo(() => {
		const selected = hasMethod(store.model?.data) ? store.model.data()?.selected : undefined;
		return selected ? routeOptionId(selected) : null;
	});
	const visionOptions = createMemo(() => [
		VISION_REPLY_OPTION,
		...configured()
			.filter((model) => model.supportsImages)
			.map(routeOptionId),
	]);
	const selectedVisionOption = createMemo(() => {
		const vision = hasMethod(store.model?.data) ? store.model.data()?.defaults?.vision : undefined;
		return !vision || vision.mode === "auto" || !vision.route
			? VISION_REPLY_OPTION
			: routeOptionId(vision.route);
	});

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
	const selectCurrentReply = (id: string | null): Promise<void> => {
		const model = id ? modelByOptionId(id) : undefined;
		const conversationId = store.activeConversationId;
		if (!conversationId || !model) return Promise.resolve();
		return run(
			() => store.model.select(conversationId, model.providerId, model.modelId),
			t("settings.modelSaved"),
		);
	};
	const setVisionModel = (id: string | null): Promise<void> => {
		const model = id && id !== VISION_REPLY_OPTION ? modelByOptionId(id) : undefined;
		return run(
			() =>
				model
					? store.model.setMultimodalFallback(model.providerId, model.modelId)
					: store.model.setVisionAuto(),
			t("settings.imageReaderUpdated"),
		);
	};

	return {
		saving,
		error,
		feedback,
		configured,
		modelByOptionId,
		selectedCurrentReplyOption,
		visionOptions,
		selectedVisionOption,
		selectCurrentReply,
		setVisionModel,
	};
}

export function createNetworkMemoryWorkflow(store: CompanionStore, t: Translate) {
	const [proxyModeDraft, setProxyMode] = createSignal<ProxyMode>();
	const proxyMode = () => proxyModeDraft() ?? store.settings.data()?.networkProxy.mode;
	const [proxyUrlDraft, setProxyUrl] = createSignal<string>();
	const proxyUrl = () => proxyUrlDraft() ?? store.settings.data()?.networkProxy.url ?? "";
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);
	const settingsPatch = createMemo<SettingsPatch>(() => {
		const mode = proxyMode();
		return mode === undefined
			? {}
			: {
					networkProxy: {
						mode,
						...(mode === "manual" && proxyUrl().trim() ? { url: proxyUrl().trim() } : {}),
					},
				};
	});

	const save = async (): Promise<void> => {
		if (proxyMode() === undefined) return;
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
