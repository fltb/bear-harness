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
	const [systemReplyDraft, setSystemReplyDraft] = createSignal<{
		providerId: string;
		modelId: string;
	}>();
	const [systemVisionDraft, setSystemVisionDraft] = createSignal<{
		providerId: string;
		modelId: string;
	} | null>();
	let submittedStepId: string | null = null;

	const flow = createMemo(() => store.character?.character.first_meeting);
	const configuredModels = createMemo(() =>
		(hasMethod(store.model?.models) ? store.model.models() : []).filter(
			(model) => model.enabled && model.readiness === "ready",
		),
	);
	const modelData = createMemo(() =>
		hasMethod(store.model?.data) ? store.model.data() : undefined,
	);
	const modelDefaults = createMemo(() => modelData()?.defaults);
	const systemModelDefaults = createMemo(() => modelData()?.systemDefaults);
	const firstRunStage = createMemo(() => store.settings?.data?.()?.firstRunStage);
	const modelRequired = createMemo(() => firstRunStage() === "model");
	const roleModelRequired = createMemo(
		() =>
			firstRunStage() === "role" &&
			(!modelDefaults()?.reply || modelDefaults()?.onboardingComplete !== true),
	);
	const selectedReplyModel = createMemo(() => {
		const reply = modelRequired()
			? (systemReplyDraft() ?? systemModelDefaults()?.reply)
			: modelDefaults()?.reply;
		return reply
			? (configuredModels().find((model) => routeOptionId(model) === routeOptionId(reply)) ?? null)
			: null;
	});
	const selectedVisionModel = createMemo(() => {
		const persistedVision = (modelRequired() ? systemModelDefaults() : modelDefaults())?.vision;
		const vision = modelRequired()
			? systemVisionDraft() === undefined
				? persistedVision?.mode === "manual"
					? persistedVision.route
					: null
				: systemVisionDraft()
			: persistedVision?.mode === "manual"
				? persistedVision.route
				: null;
		return vision
			? (configuredModels().find((model) => routeOptionId(model) === routeOptionId(vision)) ?? null)
			: null;
	});
	const modelError = createMemo(() => {
		const error = hasMethod(store.model?.error) ? store.model.error() : null;
		return error === null || error === undefined ? null : messageOf(error);
	});
	const memorySetupRequired = createMemo(() => firstRunStage() === "embedding");
	const currentOnboardingStepId = createMemo(() =>
		store.onboarding.status === "active" ? store.onboarding.currentStepId : undefined,
	);
	const currentStep = createMemo<CharacterOnboardingStep | undefined>(() => {
		const definition = flow();
		return definition?.steps.find((step) => step.id === currentOnboardingStepId());
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
		() => store.onboarding.status === "active" && currentStep() !== undefined,
	);
	const conversationVisible = createMemo(
		() => !modelRequired() && !memorySetupRequired() && !roleModelRequired() && visible(),
	);
	const onboardingError = createMemo(() => store.error);

	const saveModelDefault = async (action: () => Promise<void>): Promise<boolean> => {
		if (setupBusy()) return false;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await action();
			return true;
		} catch (cause) {
			setSetupError(messageOf(cause));
			return false;
		} finally {
			setSetupBusy(false);
		}
	};
	const selectReplyModel = (model: ConfiguredModel): Promise<boolean> => {
		if (modelRequired()) {
			setSystemReplyDraft({ providerId: model.providerId, modelId: model.modelId });
			if (model.supportsImages) setSystemVisionDraft(null);
			return Promise.resolve(true);
		}
		return saveModelDefault(() => store.model.setDefaultReply(model.providerId, model.modelId));
	};
	const selectVisionModel = (model: ConfiguredModel | null): Promise<boolean> => {
		if (modelRequired()) {
			setSystemVisionDraft(model ? { providerId: model.providerId, modelId: model.modelId } : null);
			return Promise.resolve(true);
		}
		return saveModelDefault(() =>
			model
				? store.model.setMultimodalFallback(model.providerId, model.modelId)
				: store.model.setVisionAuto(),
		);
	};
	const completeModelSetup = (): void => {
		const selectedReply = selectedReplyModel();
		if (!selectedReply || setupBusy()) return;
		void saveModelDefault(async () => {
			if (modelRequired()) {
				const reply = {
					providerId: selectedReply.providerId,
					modelId: selectedReply.modelId,
				};
				const selectedVision = selectedVisionModel();
				const vision =
					selectedReply.supportsImages || !selectedVision
						? ({ mode: "auto" } as const)
						: ({
								mode: "manual",
								route: {
									providerId: selectedVision.providerId,
									modelId: selectedVision.modelId,
								},
							} as const);
				await store.model.completeSystemOnboarding(reply, vision);
				return;
			}
			await store.model.completeDefaultsOnboarding();
		});
	};
	const completeMemorySetup = (): Promise<boolean> =>
		saveModelDefault(async () => {
			await store.embedding.completeEmbeddingMutation.mutateAsync({ choice: "none" });
		});
	const submit = async (stepId: string, answer?: string): Promise<void> => {
		if (submittedStepId !== currentOnboardingStepId()) submittedStepId = null;
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
		roleModelRequired,
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
			setProxyMode(undefined);
			setProxyUrl(undefined);
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
