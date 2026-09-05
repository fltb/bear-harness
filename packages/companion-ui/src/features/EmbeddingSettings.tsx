import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, createSignal, For, Show } from "solid-js";
import { markSelectPortalTopLayer } from "../lib/select-portal.js";
import { useCompanionStore } from "../stores/companion.js";
import type {
	CompleteEmbeddingValue,
	LocalEmbeddingTargetValue,
	ModelDownloadSourceValue,
} from "../stores/supplementary-api.js";
import { Button, RadioGroup, Select, TextField } from "../ui/primitives.js";
import { DownloadProgress } from "./DownloadProgress.js";

function optionName(option: unknown): string {
	if (!option || typeof option !== "object" || !("name" in option)) return "";
	const name = option.name;
	return typeof name === "string" ? name : "";
}

const CUSTOM_LOCAL_MODEL_OPTION_ID = "__custom_local_embedding__";

/** Memory configuration and local-model acquisition share one Host-backed flow. */
export function EmbeddingSettings(props: {
	mode: "onboarding" | "settings";
	onComplete?: () => Promise<void> | void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	const embedding = useCompanionStore().embedding;
	const settings = () => embedding.settingsQuery.data?.settings;
	const vector = () => settings()?.memoryVectorService;
	const capabilities = () => embedding.capabilitiesQuery.data;
	const inventory = () => embedding.inventoryQuery.data;
	const acquisition = embedding.acquisitionState;
	const onboarding = () => props.mode === "onboarding" || settings()?.firstRunStage === "embedding";

	const [providerDraft, setProviderDraft] = createSignal<"none" | "local" | "remote" | null>(null);
	const [candidateDraft, setCandidateDraft] = createSignal<string | null>(null);
	const [localModeDraft, setLocalModeDraft] = createSignal<"builtin" | "custom" | null>(null);
	const [customPathDraft, setCustomPathDraft] = createSignal<string | null>(null);
	const [customDimensionsDraft, setCustomDimensionsDraft] = createSignal<string | null>(null);
	const [sourceTypeDraft, setSourceTypeDraft] = createSignal<
		"official" | "hf-mirror" | "custom" | null
	>(null);
	const [customSourceDraft, setCustomSourceDraft] = createSignal<string | null>(null);
	const [remoteBaseUrlDraft, setRemoteBaseUrlDraft] = createSignal<string | null>(null);
	const [remoteApiKeyDraft, setRemoteApiKeyDraft] = createSignal<string | null>(null);
	const [remoteModelDraft, setRemoteModelDraft] = createSignal<string | null>(null);
	const [remoteDimensionsDraft, setRemoteDimensionsDraft] = createSignal<string | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [cancelling, setCancelling] = createSignal(false);

	const providers = createMemo(() =>
		(capabilities()?.memoryVectorProviders ?? []).filter(
			(provider) => !onboarding() || provider.onboarding,
		),
	);
	const candidates = createMemo(() => inventory()?.candidates ?? []);
	const presets = createMemo(() => capabilities()?.memoryVectorPresets ?? []);
	const providerId = () => providerDraft() ?? (onboarding() ? undefined : vector()?.provider);
	const localMode = () => localModeDraft() ?? (vector()?.customPath ? "custom" : "builtin");
	const selectedCandidate = () => {
		const id = candidateDraft() ?? vector()?.localModel;
		return (
			candidates().find((candidate) => candidate.id === id) ??
			candidates().find((candidate) => candidate.isDefault) ??
			candidates()[0]
		);
	};
	const sourceType = () => sourceTypeDraft() ?? settings()?.modelDownloadSource.type ?? "official";
	const storedCustomSource = () => {
		const source = settings()?.modelDownloadSource;
		return source?.type === "custom" ? source.endpoint : "";
	};
	const source = (): ModelDownloadSourceValue | undefined => {
		const selected = sourceType();
		if (selected === "custom") {
			const endpoint = (customSourceDraft() ?? storedCustomSource()).trim();
			return endpoint ? { type: "custom", endpoint } : undefined;
		}
		if (selected === "hf-mirror") return { type: "hf-mirror" };
		return { type: "official" };
	};
	const target = (): LocalEmbeddingTargetValue | undefined => {
		if (localMode() === "custom") {
			const customPath = (customPathDraft() ?? vector()?.customPath ?? "").trim();
			const dimensions = Number(customDimensionsDraft() ?? vector()?.dimensions ?? 0);
			return customPath && Number.isInteger(dimensions) && dimensions > 0
				? { kind: "custom", customPath, dimensions }
				: undefined;
		}
		return selectedCandidate()?.target;
	};
	const sameTarget = (left?: LocalEmbeddingTargetValue, right?: LocalEmbeddingTargetValue) =>
		left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
	const acquiredTarget = () => {
		const state = acquisition();
		return state.phase === "completed" ? state.target : undefined;
	};
	const acquisitionTotalBytes = () => {
		const state = acquisition();
		return "totalBytes" in state ? state.totalBytes : undefined;
	};
	const acquisitionError = () => {
		const state = acquisition();
		return state.phase === "failed" || state.phase === "interrupted" ? state.errorCode : undefined;
	};
	const localReady = () =>
		localMode() === "custom" ||
		selectedCandidate()?.installed === true ||
		(acquisition().phase === "completed" && sameTarget(acquiredTarget(), target()));
	const activeLocal = () =>
		vector()?.enabled === true &&
		vector()?.provider === "local" &&
		sameTarget(inventory()?.activeTarget, target());
	const remoteConfiguration = () => {
		const baseUrl = (remoteBaseUrlDraft() ?? vector()?.baseUrl ?? "").trim();
		const model = (remoteModelDraft() ?? vector()?.model ?? "").trim();
		const dimensions = Number(remoteDimensionsDraft() ?? vector()?.dimensions ?? 0);
		const apiKey = remoteApiKeyDraft()?.trim();
		if (!baseUrl || !model || !Number.isInteger(dimensions) || dimensions <= 0) return undefined;
		if (!apiKey && vector()?.hasCredential !== true) return undefined;
		return { baseUrl, model, dimensions, ...(apiKey ? { apiKey } : {}) };
	};
	const busy = () =>
		embedding.settingsMutation.isPending ||
		embedding.acquisitionStartMutation.isPending ||
		embedding.activateLocalMutation.isPending ||
		embedding.completeEmbeddingMutation.isPending ||
		cancelling();
	const acquisitionRunning = () =>
		["preparing", "downloading", "validating"].includes(acquisition().phase);
	const canSubmit = () => {
		if (!providerId()) return false;
		if (providerId() === "none") return true;
		if (providerId() === "remote") return remoteConfiguration() !== undefined;
		return target() !== undefined && (localMode() === "custom" || source() !== undefined);
	};

	const clearDrafts = () => {
		setProviderDraft(null);
		setCandidateDraft(null);
		setLocalModeDraft(null);
		setCustomPathDraft(null);
		setCustomDimensionsDraft(null);
		setSourceTypeDraft(null);
		setCustomSourceDraft(null);
		setRemoteBaseUrlDraft(null);
		setRemoteApiKeyDraft(null);
		setRemoteModelDraft(null);
		setRemoteDimensionsDraft(null);
	};
	const finish = async (choice: CompleteEmbeddingValue) => {
		if (onboarding()) await embedding.completeEmbeddingMutation.mutateAsync(choice);
		else if (choice.choice === "none")
			await embedding.settingsMutation.mutateAsync({ enabled: false, provider: "none" });
		else if (choice.choice === "remote")
			await embedding.settingsMutation.mutateAsync({
				enabled: true,
				provider: "remote",
				...choice.configuration,
			});
		else await embedding.activateLocalMutation.mutateAsync(choice.target);
		clearDrafts();
		await props.onComplete?.();
	};
	const submit = async () => {
		setError(null);
		try {
			if (providerId() === "none") return await finish({ choice: "none" });
			if (providerId() === "remote") {
				const configuration = remoteConfiguration();
				if (configuration) await finish({ choice: "remote", configuration });
				return;
			}
			const selectedTarget = target();
			if (!selectedTarget) return;
			if (!localReady()) {
				const selectedSource = source();
				if (selectedSource)
					await embedding.acquisitionStartMutation.mutateAsync({
						target: selectedTarget,
						source: selectedSource,
					});
				return;
			}
			await finish({ choice: "local", target: selectedTarget });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const cancel = async () => {
		setError(null);
		setCancelling(true);
		try {
			await embedding.cancelAcquisition();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setCancelling(false);
		}
	};
	const actionLabel = () => {
		if (busy()) return t("settings.loading");
		if (providerId() === "local" && !localReady()) return t("settings.downloadAndEnableLocalModel");
		if (providerId() === "local" && activeLocal()) return t("settings.localModelEnabled");
		if (providerId() === "local") return t("settings.enableLocalModel");
		return onboarding() ? t("messages.continue") : t("settings.saveEmbedding");
	};
	const localModelOptions = createMemo(() => [
		...candidates().map((candidate) => ({
			id: candidate.id,
			name: candidate.name,
			kind: "candidate" as const,
		})),
		{
			id: CUSTOM_LOCAL_MODEL_OPTION_ID,
			name: t("settings.localModels.custom"),
			kind: "custom" as const,
		},
	]);
	const sourceOptions = createMemo(() => [
		{ id: "official" as const, name: t("settings.downloadSources.official") },
		{ id: "hf-mirror" as const, name: t("settings.downloadSources.hfMirror") },
		{ id: "custom" as const, name: t("settings.downloadSources.custom") },
	]);

	return (
		<div class="embedding-settings">
			<RadioGroup
				class="settings-choice-group"
				value={providerId()}
				disabled={busy()}
				onChange={(value) => value && setProviderDraft(value as "none" | "local" | "remote")}
			>
				<RadioGroup.Label class="field-label">{t("settings.vectorProvider")}</RadioGroup.Label>
				<div class="settings-choice-options">
					<For each={providers()}>
						{(provider) => (
							<RadioGroup.Item class="settings-choice-option" value={provider.id}>
								<RadioGroup.ItemInput />
								<RadioGroup.ItemControl class="settings-choice-control">
									<RadioGroup.ItemIndicator class="settings-choice-indicator" />
								</RadioGroup.ItemControl>
								<RadioGroup.ItemLabel>
									{t(`settings.vectorProviders.${provider.id}` as never)}
								</RadioGroup.ItemLabel>
							</RadioGroup.Item>
						)}
					</For>
				</div>
			</RadioGroup>

			<Show when={providerId() === "local"}>
				<Select
					options={localModelOptions()}
					value={
						localMode() === "custom"
							? (localModelOptions().find((option) => option.id === CUSTOM_LOCAL_MODEL_OPTION_ID) ??
								null)
							: (localModelOptions().find((option) => option.id === selectedCandidate()?.id) ??
								null)
					}
					optionValue="id"
					optionTextValue={(option) => option.name}
					onChange={(option) => {
						if (!option) return;
						if (option.kind === "custom") {
							setLocalModeDraft("custom");
							return;
						}
						setLocalModeDraft("builtin");
						setCandidateDraft(option.id);
					}}
					disabled={busy() || localModelOptions().length === 0}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Label class="field-label">{t("settings.localModel")}</Select.Label>
					<Select.Trigger class="select-trigger" aria-label={t("settings.localModel")}>
						<Select.Value>
							{(state) => optionName(state.selectedOption()) || t("settings.notSelected")}
						</Select.Value>
					</Select.Trigger>
					<Select.Portal ref={markSelectPortalTopLayer}>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
				<Show when={localMode() === "builtin"}>
					<Select
						options={sourceOptions()}
						value={sourceOptions().find((option) => option.id === sourceType()) ?? null}
						optionValue="id"
						optionTextValue={(option) => option.name}
						onChange={(option) => option && setSourceTypeDraft(option.id)}
						disabled={busy()}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Label class="field-label">{t("settings.downloadMirrorLabel")}</Select.Label>
						<Select.Trigger class="select-trigger" aria-label={t("settings.downloadMirrorLabel")}>
							<Select.Value>{(state) => optionName(state.selectedOption())}</Select.Value>
						</Select.Trigger>
						<Select.Portal ref={markSelectPortalTopLayer}>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<Show when={sourceType() === "custom"}>
						<TextField class="setting-field">
							<TextField.Label>{t("settings.downloadMirrorLabel")}</TextField.Label>
							<TextField.Input
								value={customSourceDraft() ?? storedCustomSource()}
								onInput={(event) => setCustomSourceDraft(event.currentTarget.value)}
							/>
						</TextField>
					</Show>
				</Show>
				<Show when={localMode() === "custom"}>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.localCustomPath")}</TextField.Label>
						<TextField.Input
							value={customPathDraft() ?? vector()?.customPath ?? ""}
							onInput={(event) => setCustomPathDraft(event.currentTarget.value)}
						/>
					</TextField>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.vectorDimensions")}</TextField.Label>
						<TextField.Input
							type="number"
							value={customDimensionsDraft() ?? String(vector()?.dimensions ?? "")}
							onInput={(event) => setCustomDimensionsDraft(event.currentTarget.value)}
						/>
					</TextField>
				</Show>
				<p class="field-hint">{t("settings.memoryVectorLocalNote")}</p>
				<Show when={acquisitionRunning()}>
					<DownloadProgress
						label={
							acquisition().phase === "validating"
								? t("settings.downloadValidating")
								: t("settings.downloadingLocalModel")
						}
						downloadedBytes={acquisition().downloadedBytes}
						totalBytes={acquisitionTotalBytes()}
						cancelLabel={
							cancelling() ? t("settings.downloadCancelling") : t("settings.downloadCancel")
						}
						cancelling={cancelling()}
						onCancel={() => void cancel()}
					/>
				</Show>
				<Show when={acquisition().phase === "cancelled"}>
					<p role="status">{t("settings.downloadCancelled")}</p>
				</Show>
			</Show>

			<Show when={providerId() === "remote"}>
				<Select
					options={presets()}
					value={null}
					placeholder={t("settings.notSelected")}
					optionValue="id"
					optionTextValue={(preset) => t(`settings.vectorPresetLabels.${preset.id}` as never)}
					onChange={(preset) => {
						if (!preset) return;
						setRemoteModelDraft(preset.model);
						setRemoteDimensionsDraft(String(preset.dimensions));
					}}
					disabled={busy()}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>
								{itemProps.item.rawValue
									? t(`settings.vectorPresetLabels.${itemProps.item.rawValue.id}` as never)
									: ""}
							</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Label class="field-label">{t("settings.vectorPreset")}</Select.Label>
					<Select.Trigger class="select-trigger" aria-label={t("settings.vectorPreset")}>
						<Select.Value>{() => t("settings.notSelected")}</Select.Value>
					</Select.Trigger>
					<Select.Portal ref={markSelectPortalTopLayer}>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
				<TextField class="setting-field">
					<TextField.Label>{t("settings.customBaseUrl")}</TextField.Label>
					<TextField.Input
						value={remoteBaseUrlDraft() ?? vector()?.baseUrl ?? ""}
						onInput={(event) => setRemoteBaseUrlDraft(event.currentTarget.value)}
					/>
				</TextField>
				<TextField class="setting-field">
					<TextField.Label>{t("settings.apiKeyLabel")}</TextField.Label>
					<TextField.Input
						type="password"
						value={remoteApiKeyDraft() ?? ""}
						placeholder={
							vector()?.hasCredential ? t("settings.apiKeyStoredPlaceholder") : undefined
						}
						onInput={(event) => setRemoteApiKeyDraft(event.currentTarget.value)}
					/>
				</TextField>
				<TextField class="setting-field">
					<TextField.Label>{t("settings.vectorModel")}</TextField.Label>
					<TextField.Input
						value={remoteModelDraft() ?? vector()?.model ?? ""}
						onInput={(event) => setRemoteModelDraft(event.currentTarget.value)}
					/>
				</TextField>
				<TextField class="setting-field">
					<TextField.Label>{t("settings.vectorDimensions")}</TextField.Label>
					<TextField.Input
						type="number"
						value={remoteDimensionsDraft() ?? String(vector()?.dimensions ?? "")}
						onInput={(event) => setRemoteDimensionsDraft(event.currentTarget.value)}
					/>
				</TextField>
			</Show>

			<div class="settings-actions">
				<Button
					type="button"
					data-variant="primary"
					disabled={busy() || !canSubmit() || (providerId() === "local" && activeLocal())}
					onClick={() => void submit()}
				>
					{actionLabel()}
				</Button>
			</div>
			<Show
				when={
					error() ??
					acquisitionError() ??
					embedding.settingsMutation.error ??
					embedding.activateLocalMutation.error ??
					embedding.completeEmbeddingMutation.error
				}
			>
				{(message) => (
					<p class="status-line err" role="alert">
						{String(message())}
					</p>
				)}
			</Show>
		</div>
	);
}
