import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Checkbox } from "@kobalte/core/checkbox";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, Show } from "solid-js";
import type {
	LocalEmbeddingCandidate,
	SettingsCapabilities,
	SettingsData,
} from "../stores/companion.js";
import { useCompanionStore } from "../stores/companion.js";

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
	const [remoteBaseUrlDraft, setRemoteBaseUrlDraft] = createSignal<string | null>(null);
	const [remoteModelDraft, setRemoteModelDraft] = createSignal<string | null>(null);
	const [remoteDimensionsDraft, setRemoteDimensionsDraft] = createSignal<string | null>(null);
	const [mirrorDraft, setMirrorDraft] = createSignal<string | null>(null);
	const settings = () => embedding.settingsQuery.data?.settings;
	const vector = () => settings()?.memoryVectorService;
	const capabilities = () => embedding.capabilitiesQuery.data;
	const providerOptions = () =>
		(capabilities()?.memoryVectorProviders ?? []).filter(
			(provider) => !onboarding || provider.onboarding,
		);
	const candidates = () => capabilities()?.localEmbeddingCandidates ?? [];
	const presets = () => capabilities()?.memoryVectorPresets ?? [];
	const configuringLocal = () => embedding.localConfigureMutation.isPending;
	const savingSettings = () => embedding.settingsMutation.isPending;
	const providerId = () =>
		(onboarding ? (onboardingProviderId() ?? vector()?.provider) : vector()?.provider) as
			| SettingsCapabilities["memoryVectorProviders"][number]["id"]
			| undefined;
	const localSelected = () => providerId() === "local";
	const capabilitiesReady = () => capabilities() !== undefined;
	const selectedProvider = () =>
		onboarding && onboardingProviderId() === null
			? null
			: (providerOptions().find((provider) => provider.id === providerId()) ?? null);
	const selectedCandidate = () =>
		candidates().find(
			(candidate) => candidate.id === (onboarding ? onboardingCandidateId() : vector()?.localModel),
		) ?? null;
	const onboardingChoiceReady = () =>
		!onboarding ||
		onboardingProviderId() === "none" ||
		(onboardingProviderId() === "local" && onboardingCandidateId() !== null);
	const selectedPreset = () =>
		presets().find(
			(preset) => preset.model === vector()?.model && preset.dimensions === vector()?.dimensions,
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
				return;
			}
			if (provider === "local") {
				const candidate = candidates().find((item) => item.isDefault) ?? candidates()[0];
				if (candidate) {
					await embedding.localConfigureMutation.mutateAsync({
						provider: "local",
						candidateId: candidate.id,
					});
				}
				return;
			}
			if (provider === "none") {
				await embedding.localConfigureMutation.mutateAsync({ provider: "none" });
				return;
			}
			await embedding.settingsMutation.mutateAsync({ ...current, provider });
		} catch {
			// The mutation bindings expose the error to the settings surface.
		} finally {
			setRequestedProviderId(null);
		}
	};
	const saveEmbedding = async (): Promise<void> => {
		const mirror = mirrorDraft();
		if (mirror !== null) {
			await embedding.settingsMutation.mutateAsync({ endpoint: mirror || undefined });
			setMirrorDraft(null);
		}
		const current = vector();
		if (!current || !capabilitiesReady()) return;
		if (onboarding) {
			if (onboardingProviderId() === "none") {
				await embedding.localConfigureMutation.mutateAsync({ provider: "none" });
				return;
			}
			const candidate = selectedCandidate();
			if (onboardingProviderId() === "local" && candidate) {
				await embedding.localConfigureMutation.mutateAsync({
					provider: "local",
					candidateId: candidate.id,
				});
			}
			return;
		}
		if (
			current.provider === "local" &&
			candidates().some((candidate) => candidate.id === current.localModel)
		) {
			await embedding.localConfigureMutation.mutateAsync({
				provider: "local",
				candidateId: current.localModel,
			});
			return;
		}
		const baseUrl = remoteBaseUrlDraft();
		const model = remoteModelDraft();
		const dimensions = remoteDimensionsDraft();
		await saveVector({
			...current,
			...(baseUrl !== null ? { baseUrl } : {}),
			...(model !== null ? { model } : {}),
			...(dimensions !== null ? { dimensions: Number(dimensions) || 0 } : {}),
		});
		setRemoteBaseUrlDraft(null);
		setRemoteModelDraft(null);
		setRemoteDimensionsDraft(null);
	};

	return (
		<section class="embedding-settings" aria-label={t("settings.memoryVectorSection")}>
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
				<Select
					options={providerOptions()}
					value={selectedProvider()}
					optionValue="id"
					onChange={(provider) => {
						if (
							!provider ||
							(provider.id === providerId() && !(onboarding && onboardingProviderId() === null)) ||
							requestedProviderId() !== null
						)
							return;
						setRequestedProviderId(provider.id);
						queueMicrotask(() => void changeProvider(provider.id));
					}}
					optionTextValue={(provider) => t(`settings.vectorProviders.${provider.id}` as never)}
					disabled={
						!capabilitiesReady() ||
						providerOptions().length === 0 ||
						savingSettings() ||
						configuringLocal() ||
						requestedProviderId() !== null
					}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>
								{t(`settings.vectorProviders.${itemProps.item.rawValue.id}` as never)}
							</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Label class="field-label">{t("settings.vectorProvider")}</Select.Label>
					<Select.Trigger class="select-trigger" aria-label={t("settings.vectorProvider")}>
						<Select.Value<SettingsCapabilities["memoryVectorProviders"][number]>>
							{(state) => {
								const provider = state.selectedOption();
								return provider ? t(`settings.vectorProviders.${provider.id}` as never) : "";
							}}
						</Select.Value>
					</Select.Trigger>
					<Select.Portal>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
				<Show when={localSelected()}>
					<Select<LocalEmbeddingCandidate>
						options={candidates()}
						value={selectedCandidate()}
						optionValue="id"
						optionTextValue={(candidate) => candidate.name}
						onChange={(candidate) => {
							if (!candidate || candidate.id === selectedCandidate()?.id) return;
							if (onboarding) {
								setOnboardingCandidateId(candidate.id);
								return;
							}
							void embedding.localConfigureMutation.mutateAsync({
								provider: "local",
								candidateId: candidate.id,
							});
						}}
						disabled={!capabilitiesReady() || candidates().length === 0 || configuringLocal()}
						itemComponent={(itemProps) => (
							<Select.Item item={itemProps.item} class="select-item">
								<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Label class="field-label">{t("settings.localModel")}</Select.Label>
						<Select.Trigger class="select-trigger" aria-label={t("settings.localModel")}>
							<Select.Value<LocalEmbeddingCandidate>>
								{(state) => state.selectedOption()?.name ?? ""}
							</Select.Value>
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<Show when={!onboarding}>
						<h5>{t("settings.downloadMirrorSection")}</h5>
						<TextField class="setting-field">
							<TextField.Label>{t("settings.downloadMirrorLabel")}</TextField.Label>
							<TextField.Input
								type="text"
								value={mirrorDraft() ?? settings()?.modelDownloadMirror?.endpoint ?? ""}
								onInput={(event) => setMirrorDraft(event.currentTarget.value)}
							/>
						</TextField>
					</Show>
				</Show>
				<Show when={!onboarding && vector()?.provider === "remote"}>
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
									return preset ? t(`settings.vectorPresetLabels.${preset.id}` as never) : "";
								}}
							</Select.Value>
						</Select.Trigger>
						<Select.Portal>
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
			<Show when={configuringLocal()}>
				<p class="status-line" role="status">
					{t("settings.localModelDownloadStatus")}
				</p>
			</Show>
			<Show when={embedding.localConfigureMutation.isSuccess && localSelected()}>
				<p class="status-line ok" role="status">
					{t("settings.localModelReady")}
				</p>
			</Show>
			<Show when={embedding.settingsMutation.error ?? embedding.localConfigureMutation.error}>
				{(error) => (
					<p class="status-line err" role="alert">
						{String(error())}
					</p>
				)}
			</Show>
			<Button
				type="button"
				class="primary-tool"
				disabled={
					!capabilitiesReady() || savingSettings() || configuringLocal() || !onboardingChoiceReady()
				}
				aria-label={actionLabel()}
				onClick={() => void saveEmbedding().catch(() => undefined)}
			>
				{actionLabel()}
			</Button>
		</section>
	);
}
