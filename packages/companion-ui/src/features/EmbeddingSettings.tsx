import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Checkbox } from "@kobalte/core/checkbox";
import { RadioGroup } from "@kobalte/core/radio-group";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, For, Show } from "solid-js";
import { markSelectPortalTopLayer } from "../lib/select-portal.js";
import { createStableSnapshot } from "../lib/stable-snapshot.js";
import type { SettingsCapabilities, SettingsData } from "../stores/companion.js";
import { useCompanionStore } from "../stores/companion.js";

import { DownloadProgress } from "./DownloadProgress.js";

/** Shared embedding controls bound directly to the Host-backed query state. */
export function EmbeddingSettings(props: { mode: "onboarding" | "settings" }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const embedding = store.embedding;
	const onboarding = props.mode === "onboarding";
	const [requestedPresetId, setRequestedPresetId] = createSignal<string | null>(null);
	const [requestedProviderId, setRequestedProviderId] = createSignal<string | null>(null);
	const [onboardingProviderId, setOnboardingProviderId] = createSignal<
		SettingsCapabilities["memoryVectorProviders"][number]["id"] | null
	>(null);
	const [onboardingCandidateId, setOnboardingCandidateId] = createSignal<string | null>(null);
	const [settingsProviderId, setSettingsProviderId] = createSignal<
		SettingsCapabilities["memoryVectorProviders"][number]["id"] | null
	>(null);
	const [settingsCandidateId, setSettingsCandidateId] = createSignal<string | null>(null);
	const [remoteBaseUrlDraft, setRemoteBaseUrlDraft] = createSignal<string | null>(null);
	const [remoteApiKeyDraft, setRemoteApiKeyDraft] = createSignal<string | null>(null);
	const [remoteModelDraft, setRemoteModelDraft] = createSignal<string | null>(null);
	const [remoteDimensionsDraft, setRemoteDimensionsDraft] = createSignal<string | null>(null);
	const [localModelMode, setLocalModelMode] = createSignal<"builtin" | "custom" | null>(null);
	const [customModelDraft, setCustomModelDraft] = createSignal<string | null>(null);
	const [downloadSourceType, setDownloadSourceType] = createSignal<
		"official" | "hf-mirror" | "custom" | null
	>(null);
	const [customMirrorDraft, setCustomMirrorDraft] = createSignal<string | null>(null);
	const settings = () => embedding.settingsQuery.data?.settings;
	const vector = () => settings()?.memoryVectorService;
	const capabilities = createStableSnapshot(() => embedding.capabilitiesQuery.data);
	const providerOptions = () => capabilities()?.memoryVectorProviders ?? [];
	const candidates = () => capabilities()?.localEmbeddingCandidates ?? [];
	const presets = () => capabilities()?.memoryVectorPresets ?? [];
	const configuringLocal = () => embedding.localConfigureMutation.isPending;
	const download = embedding.downloadState;
	const [cancelling, setCancelling] = createSignal(false);
	const [downloadError, setDownloadError] = createSignal<string | null>(null);

	const cancelDownload = async () => {
		setDownloadError(null);
		setCancelling(true);
		try {
			await embedding.cancelDownload();
		} catch (error) {
			setDownloadError(String(error));
		} finally {
			setCancelling(false);
		}
	};
	const downloadLabel = () => {
		if (cancelling()) return t("settings.downloadCancelling");
		if (download().status === "validating") return t("settings.downloadValidating");
		if (download().status === "activating") return t("settings.downloadActivating");
		if (download().status === "downloading") return t("settings.downloadingLocalModel");
		return t("settings.localModelDownloadStatus");
	};
	const localModelOptions = createStableSnapshot(() => [
		{ id: "builtin" as const, name: candidates()[0]?.name ?? "EmbeddingGemma" },
		{ id: "custom" as const, name: t("settings.localModels.custom") },
	]);
	const downloadSourceOptions = createStableSnapshot(() => [
		{ id: "official" as const, name: t("settings.downloadSources.official") },
		{ id: "hf-mirror" as const, name: t("settings.downloadSources.hfMirror") },
		{ id: "custom" as const, name: t("settings.downloadSources.custom") },
	]);
	const savingSettings = () => embedding.settingsMutation.isPending;
	const providerId = () =>
		(onboarding ? onboardingProviderId() : (settingsProviderId() ?? vector()?.provider)) as
			| SettingsCapabilities["memoryVectorProviders"][number]["id"]
			| undefined;
	const localSelected = () => providerId() === "local";
	const capabilitiesReady = () => capabilities() !== undefined;
	const selectedCandidate = () =>
		candidates().find(
			(candidate) =>
				candidate.id ===
				(onboarding ? onboardingCandidateId() : (settingsCandidateId() ?? vector()?.localModel)),
		) ?? null;
	const effectiveLocalModelMode = () =>
		localModelMode() ?? (vector()?.customPath ? "custom" : "builtin");
	const effectiveDownloadSourceType = () =>
		downloadSourceType() ?? settings()?.modelDownloadSource.type ?? "official";
	const storedCustomMirror = () => {
		const source = settings()?.modelDownloadSource;
		return source?.type === "custom" ? source.endpoint : "";
	};
	const downloadSourceName = (type: "official" | "hf-mirror" | "custom") =>
		type === "official"
			? t("settings.downloadSources.official")
			: type === "hf-mirror"
				? t("settings.downloadSources.hfMirror")
				: t("settings.downloadSources.custom");
	const remoteChoiceReady = () =>
		providerId() !== "remote" ||
		(Boolean((remoteBaseUrlDraft() ?? vector()?.baseUrl)?.trim()) &&
			Boolean((remoteModelDraft() ?? vector()?.model)?.trim()) &&
			Number(remoteDimensionsDraft() ?? vector()?.dimensions) > 0);
	const onboardingChoiceReady = () =>
		!onboarding ||
		(onboardingProviderId() === "none" && true) ||
		(onboardingProviderId() === "local" &&
			(effectiveLocalModelMode() === "builtin" || Boolean(customModelDraft()?.trim()))) ||
		(onboardingProviderId() === "remote" && remoteChoiceReady());
	const selectedPreset = () =>
		presets().find(
			(preset) =>
				preset.model === (remoteModelDraft() ?? vector()?.model) &&
				preset.dimensions === Number(remoteDimensionsDraft() ?? vector()?.dimensions ?? 0),
		) ?? null;
	const actionLabel = () => {
		if (configuringLocal()) return t("settings.downloadingLocalModel");
		if (localSelected()) return t("settings.downloadAndEnableLocalModel");
		return onboarding ? t("messages.continue") : t("settings.saveNetwork");
	};
	const saveVector = (value: SettingsData["memoryVectorService"]): Promise<unknown> =>
		embedding.settingsMutation.mutateAsync(value);
	const selectPreset = async (
		preset: SettingsCapabilities["memoryVectorPresets"][number],
	): Promise<void> => {
		if (onboarding) {
			setRemoteModelDraft(preset.model);
			setRemoteDimensionsDraft(String(preset.dimensions));
			return;
		}
		const current = vector();
		if (!current) return;
		setRequestedPresetId(preset.id);
		try {
			await embedding.settingsMutation.mutateAsync({
				...current,
				model: preset.model,
				dimensions: preset.dimensions,
			});
		} catch {
			// The mutation binding exposes the error to the settings surface.
		} finally {
			setRequestedPresetId(null);
		}
	};
	const changeProvider = async (
		provider: SettingsCapabilities["memoryVectorProviders"][number]["id"],
	): Promise<void> => {
		const current = vector();
		if (!current) {
			setRequestedProviderId(null);
			return;
		}
		try {
			if (onboarding) {
				setOnboardingProviderId(provider);
				setOnboardingCandidateId(null);
				if (provider === "local") {
					setOnboardingCandidateId(candidates().find((item) => item.isDefault)?.id ?? null);
				}
				return;
			}
			setSettingsProviderId(provider);
			if (provider === "local" && settingsCandidateId() === null) {
				setSettingsCandidateId(candidates().find((item) => item.isDefault)?.id ?? null);
			}
		} catch {
			// The mutation bindings expose the error to the settings surface.
		} finally {
			setRequestedProviderId(null);
		}
	};
	const saveEmbedding = async (): Promise<void> => {
		setCancelling(false);
		setDownloadError(null);
		const sourceType = effectiveDownloadSourceType();
		await embedding.settingsMutation.mutateAsync(
			sourceType === "custom"
				? {
						type: "custom",
						endpoint: (customMirrorDraft() ?? storedCustomMirror()).trim(),
					}
				: { type: sourceType },
		);
		const current = vector();
		if (!current || !capabilitiesReady()) return;
		if (onboarding) {
			if (onboardingProviderId() === "none") {
				await embedding.localConfigureMutation.mutateAsync({ provider: "none" });
				return;
			}
			const candidate = selectedCandidate() ?? candidates().find((item) => item.isDefault) ?? null;
			if (onboardingProviderId() === "local") {
				const customPath = customModelDraft()?.trim();
				if (effectiveLocalModelMode() === "custom" && !customPath) return;
				if (effectiveLocalModelMode() === "builtin" && !candidate) return;
				await embedding.localConfigureMutation.mutateAsync({
					provider: "local",
					...(effectiveLocalModelMode() === "custom"
						? { customPath }
						: { candidateId: candidate?.id }),
				});
			}
			if (onboardingProviderId() === "remote") {
				await saveVector({
					enabled: true,
					provider: "remote",
					baseUrl: remoteBaseUrlDraft()?.trim(),
					apiKey: remoteApiKeyDraft()?.trim() || undefined,
					model: remoteModelDraft()?.trim(),
					dimensions: Number(remoteDimensionsDraft()),
				});
			}
			return;
		}
		const selectedProviderId = providerId();
		if (selectedProviderId === "local") {
			const candidate = selectedCandidate() ?? candidates().find((item) => item.isDefault) ?? null;
			const customPath = (customModelDraft() ?? vector()?.customPath ?? "").trim();
			if (effectiveLocalModelMode() === "custom" && !customPath) return;
			if (effectiveLocalModelMode() === "builtin" && !candidate) return;
			await embedding.localConfigureMutation.mutateAsync({
				provider: "local",
				...(effectiveLocalModelMode() === "custom"
					? { customPath }
					: { candidateId: candidate?.id }),
			});
			setSettingsProviderId(null);
			setSettingsCandidateId(null);
			return;
		}
		if (selectedProviderId === "none") {
			await embedding.localConfigureMutation.mutateAsync({ provider: "none" });
			return;
		}
		const baseUrl = remoteBaseUrlDraft();
		const model = remoteModelDraft();
		const dimensions = remoteDimensionsDraft();
		await saveVector({
			...current,
			enabled: true,
			provider: "remote",
			...(baseUrl !== null ? { baseUrl } : {}),
			...(remoteApiKeyDraft() !== null ? { apiKey: remoteApiKeyDraft() || undefined } : {}),
			...(model !== null ? { model } : {}),
			...(dimensions !== null ? { dimensions: Number(dimensions) || 0 } : {}),
		});
		setRemoteBaseUrlDraft(null);
		setRemoteApiKeyDraft(null);
		setRemoteModelDraft(null);
		setRemoteDimensionsDraft(null);
	};

	const renderAction = () => (
		<div class="settings-actions">
			<Button
				type="button"
				class="primary-tool"
				disabled={
					!capabilitiesReady() ||
					savingSettings() ||
					configuringLocal() ||
					!onboardingChoiceReady() ||
					!remoteChoiceReady()
				}
				aria-label={actionLabel()}
				onClick={() => void saveEmbedding().catch(() => undefined)}
			>
				{actionLabel()}
			</Button>
		</div>
	);

	return (
		<div class="embedding-settings">
			<Show when={!onboarding}>
				<Checkbox
					checked={vector()?.enabled === true}
					onChange={(enabled) => {
						const current = vector();
						if (!capabilitiesReady() || !current || enabled === current.enabled) return;
						if (!enabled && current.provider === "local") {
							void embedding.localConfigureMutation
								.mutateAsync({ provider: "none" })
								.catch(() => undefined);
							return;
						}
						void saveVector({ ...current, enabled }).catch(() => undefined);
					}}
					disabled={!capabilitiesReady() || savingSettings() || configuringLocal()}
				>
					<Checkbox.Input />
					<Checkbox.Control />
					<Checkbox.Label>{t("settings.memoryVectorEnabled")}</Checkbox.Label>
				</Checkbox>
			</Show>
			<Show when={onboarding || vector()?.enabled}>
				<RadioGroup
					class="settings-choice-group"
					value={providerId()}
					disabled={!capabilitiesReady() || savingSettings() || configuringLocal()}
					onChange={(value) => {
						if (!value || requestedProviderId() !== null) return;
						setRequestedProviderId(
							value as SettingsCapabilities["memoryVectorProviders"][number]["id"],
						);
						queueMicrotask(
							() =>
								void changeProvider(
									value as SettingsCapabilities["memoryVectorProviders"][number]["id"],
								),
						);
					}}
				>
					<RadioGroup.Label class="field-label">{t("settings.vectorProvider")}</RadioGroup.Label>
					<div class="settings-choice-options">
						<For each={providerOptions()}>
							{(provider) => (
								<RadioGroup.Item class="settings-choice-option" value={provider.id}>
									<RadioGroup.ItemInput />
									<RadioGroup.ItemControl>
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
				<Show when={localSelected()}>
					<Select
						options={localModelOptions()}
						value={
							localModelOptions().find((option) => option.id === effectiveLocalModelMode()) ?? null
						}
						optionValue="id"
						optionTextValue={(choice) => choice.name}
						onChange={(choice) => choice && setLocalModelMode(choice.id)}
						disabled={!capabilitiesReady() || candidates().length === 0 || configuringLocal()}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Label class="field-label">{t("settings.localModel")}</Select.Label>
						<Select.Trigger class="select-trigger" aria-label={t("settings.localModel")}>
							<Select.Value>
								{(state) =>
									(state.selectedOption() as { name?: string } | undefined)?.name ??
									t("settings.notSelected")
								}
							</Select.Value>
						</Select.Trigger>
						<Select.Portal ref={markSelectPortalTopLayer}>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<Show when={effectiveLocalModelMode() === "custom"}>
						<TextField class="setting-field">
							<TextField.Label>{t("settings.localCustomPath")}</TextField.Label>
							<TextField.Input
								disabled={configuringLocal() || savingSettings()}
								value={customModelDraft() ?? vector()?.customPath ?? ""}
								onInput={(event) => setCustomModelDraft(event.currentTarget.value)}
							/>
						</TextField>
					</Show>
					<p class="field-hint">{t("settings.memoryVectorLocalNote")}</p>
					<h5>{t("settings.downloadMirrorSection")}</h5>
					<Select
						options={downloadSourceOptions()}
						value={
							downloadSourceOptions().find(
								(option) => option.id === effectiveDownloadSourceType(),
							) ?? null
						}
						optionValue="id"
						optionTextValue={(source) => source.name}
						onChange={(source) => source && setDownloadSourceType(source.id)}
						disabled={configuringLocal() || savingSettings()}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Label class="field-label">{t("settings.downloadMirrorLabel")}</Select.Label>
						<Select.Trigger class="select-trigger" aria-label={t("settings.downloadMirrorLabel")}>
							<Select.Value>
								{(state) =>
									(state.selectedOption() as { name?: string } | undefined)?.name ??
									downloadSourceName(effectiveDownloadSourceType())
								}
							</Select.Value>
						</Select.Trigger>
						<Select.Portal ref={markSelectPortalTopLayer}>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<Show when={effectiveDownloadSourceType() === "custom"}>
						<TextField class="setting-field">
							<TextField.Label>{t("settings.downloadMirrorLabel")}</TextField.Label>
							<TextField.Input
								type="text"
								disabled={configuringLocal() || savingSettings()}
								value={customMirrorDraft() ?? storedCustomMirror()}
								onInput={(event) => setCustomMirrorDraft(event.currentTarget.value)}
							/>
						</TextField>
					</Show>
					{renderAction()}
					<Show when={configuringLocal()}>
						<DownloadProgress
							label={downloadLabel()}
							downloadedBytes={download().downloadedBytes}
							totalBytes={download().totalBytes}
							cancelLabel={
								cancelling() ? t("settings.downloadCancelling") : t("settings.downloadCancel")
							}
							cancelling={cancelling()}
							onCancel={
								download().status === "activating" ? undefined : () => void cancelDownload()
							}
						/>
					</Show>
				</Show>
				<Show when={providerId() === "remote"}>
					<Select
						options={presets()}
						value={selectedPreset()}
						optionValue="id"
						optionTextValue={(preset) => t(`settings.vectorPresetLabels.${preset.id}` as never)}
						onChange={(preset) => {
							if (preset && requestedPresetId() === null) void selectPreset(preset);
						}}
						disabled={
							!capabilitiesReady() ||
							presets().length === 0 ||
							savingSettings() ||
							requestedPresetId() !== null
						}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>
									{t(`settings.vectorPresetLabels.${itemProps.item.rawValue.id}` as never)}
								</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Label class="field-label">{t("settings.vectorPreset")}</Select.Label>
						<Select.Trigger class="select-trigger" aria-label={t("settings.vectorPreset")}>
							<Select.Value<SettingsCapabilities["memoryVectorPresets"][number]>>
								{(state) => {
									const preset = state.selectedOption();
									return preset
										? t(`settings.vectorPresetLabels.${preset.id}` as never)
										: t("settings.notSelected");
								}}
							</Select.Value>
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
							type="text"
							value={remoteBaseUrlDraft() ?? vector()?.baseUrl ?? ""}
							onInput={(event) => setRemoteBaseUrlDraft(event.currentTarget.value)}
						/>
					</TextField>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.apiKeyLabel")}</TextField.Label>
						<TextField.Input
							type="password"
							value={remoteApiKeyDraft() ?? vector()?.apiKey ?? ""}
							onInput={(event) => setRemoteApiKeyDraft(event.currentTarget.value)}
						/>
					</TextField>
					<TextField class="setting-field">
						<TextField.Label>{t("settings.vectorModel")}</TextField.Label>
						<TextField.Input
							type="text"
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
			</Show>
			<Show when={downloadError()}>
				<p role="alert">{downloadError()}</p>
			</Show>
			<Show when={embedding.localConfigureMutation.isSuccess && localSelected()}>
				<p class="status-line ok" role="status">
					{t("settings.localModelReady")}
				</p>
			</Show>
			<Show when={download().status === "cancelled"}>
				<p role="status">{t("settings.downloadCancelled")}</p>
			</Show>
			<Show
				when={
					embedding.settingsMutation.error ??
					(download().status !== "cancelled" &&
						!cancelling() &&
						embedding.localConfigureMutation.error)
				}
			>
				{(error) => (
					<p class="status-line err" role="alert">
						{String(error())}
					</p>
				)}
			</Show>
			<Show when={!localSelected()}>{renderAction()}</Show>
		</div>
	);
}
