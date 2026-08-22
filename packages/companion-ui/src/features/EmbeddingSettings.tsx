import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Checkbox } from "@kobalte/core/checkbox";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { Show } from "solid-js";
import type { LocalEmbeddingCandidate, SettingsData } from "../stores/companion.js";
import { useCompanionStore } from "../stores/companion.js";
import { VECTOR_PRESETS, VECTOR_PROVIDERS, type VectorProvider } from "../stores/setup-workflows.js";

/** Shared embedding controls bound directly to the Host-backed query state. */
export function EmbeddingSettings(props: { mode: "onboarding" | "settings" }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const embedding = store.embedding;
	const onboarding = props.mode === "onboarding";
	const settings = () => embedding.settingsQuery.data?.settings;
	const vector = () => settings()?.memoryVectorService;
	const candidates = () => embedding.catalogQuery.data?.candidates ?? [];
	const configuringLocal = () => embedding.localConfigureMutation.isPending;
	const localSelected = () => vector()?.provider === "local";
	const actionLabel = () => {
		if (configuringLocal()) return t("settings.downloadingLocalModel");
		if (localSelected()) return t("settings.downloadAndEnableLocalModel");
		return onboarding ? t("messages.continue") : t("settings.saveNetwork");
	};
	const saveVector = (value: SettingsData["memoryVectorService"]): void => {
		void embedding.settingsMutation.mutateAsync(value);
	};
	const changeProvider = (provider: VectorProvider): void => {
		if (provider === "local") {
			const candidate =
				candidates().find((item) => item.isDefault) ?? candidates()[0];
			if (candidate) {
				void embedding.localConfigureMutation.mutateAsync({
					provider: "local",
					candidateId: candidate.id,
				});
			}
			return;
		}
		if (provider === "none") {
			void embedding.localConfigureMutation.mutateAsync({ provider: "none" });
			return;
		}
		saveVector({ ...(vector() ?? { enabled: true }), provider });
	};

	return (
		<section class="embedding-settings" aria-label={t("settings.memoryVectorSection")}>
			<Show when={!onboarding}>
				<Checkbox
					checked={vector()?.enabled ?? false}
					onChange={(enabled) => {
						if (!enabled && vector()?.provider === "local") {
							void embedding.localConfigureMutation.mutateAsync({ provider: "none" });
							return;
						}
						saveVector({
							...(vector() ?? { provider: "none" as const, enabled: false }),
							enabled,
						});
					}}
				>
					<Checkbox.Input /><Checkbox.Control /><Checkbox.Label>{t("settings.memoryVectorEnabled")}</Checkbox.Label>
				</Checkbox>
			</Show>
			<Show when={onboarding || vector()?.enabled}>
				<Select<VectorProvider>
					options={[...(onboarding ? (["local", "none"] as const) : VECTOR_PROVIDERS)]}
					value={vector()?.provider ?? "none"}
					onChange={(provider) => provider && changeProvider(provider)}
					optionTextValue={(provider) => t(`settings.vectorProviders.${provider}` as never)}
					itemComponent={(itemProps) => <Select.Item item={itemProps.item} class="select-item"><Select.ItemLabel>{t(`settings.vectorProviders.${itemProps.item.rawValue}` as never)}</Select.ItemLabel></Select.Item>}
				>
					<Select.Label class="field-label">{t("settings.vectorProvider")}</Select.Label>
					<Select.Trigger class="select-trigger" aria-label={t("settings.vectorProvider")}><Select.Value /></Select.Trigger>
					<Select.Portal><Select.Content class="select-content"><Select.Listbox class="select-listbox" /></Select.Content></Select.Portal>
				</Select>
				<Show when={vector()?.provider === "local"}>
					<Select<LocalEmbeddingCandidate>
						options={[...candidates()]}
						value={candidates().find((candidate) => candidate.id === vector()?.localModel) ?? null}
						optionValue="id" optionTextValue={(candidate) => candidate.name}
						onChange={(candidate) => candidate && void embedding.localConfigureMutation.mutateAsync({ provider: "local", candidateId: candidate.id })}
						itemComponent={(itemProps) => <Select.Item item={itemProps.item} class="select-item"><Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel></Select.Item>}
					>
						<Select.Label class="field-label">{t("settings.localModel")}</Select.Label>
						<Select.Trigger class="select-trigger" aria-label={t("settings.localModel")}><Select.Value /></Select.Trigger>
						<Select.Portal><Select.Content class="select-content"><Select.Listbox class="select-listbox" /></Select.Content></Select.Portal>
					</Select>
					<Show when={!onboarding}>
						<h5>{t("settings.downloadMirrorSection")}</h5>
						<TextField class="setting-field"><TextField.Label>{t("settings.downloadMirrorLabel")}</TextField.Label><TextField.Input type="text" value={settings()?.modelDownloadMirror?.endpoint ?? ""} onInput={(event) => void embedding.settingsMutation.mutateAsync({ endpoint: event.currentTarget.value || undefined })} /></TextField>
					</Show>
				</Show>
				<Show when={!onboarding && vector()?.provider === "remote"}>
					<Select options={[...VECTOR_PRESETS]} optionTextValue={(preset) => t(`settings.vectorPresetLabels.${preset.key}` as never)} onChange={(preset) => preset && saveVector({ ...(vector() ?? { enabled: true, provider: "remote" as const }), model: preset.value, dimensions: preset.dimensions })}><Select.Label class="field-label">{t("settings.vectorPreset")}</Select.Label><Select.Trigger class="select-trigger" aria-label={t("settings.vectorPreset")}><Select.Value /></Select.Trigger><Select.Portal><Select.Content class="select-content"><Select.Listbox class="select-listbox" /></Select.Content></Select.Portal></Select>
					<TextField class="setting-field"><TextField.Label>{t("settings.customBaseUrl")}</TextField.Label><TextField.Input type="text" value={vector()?.baseUrl ?? ""} onInput={(event) => saveVector({ ...(vector() ?? { enabled: true, provider: "remote" as const }), baseUrl: event.currentTarget.value })} /></TextField>
					<TextField class="setting-field"><TextField.Label>{t("settings.vectorModel")}</TextField.Label><TextField.Input type="text" value={vector()?.model ?? ""} onInput={(event) => saveVector({ ...(vector() ?? { enabled: true, provider: "remote" as const }), model: event.currentTarget.value })} /></TextField>
					<TextField class="setting-field"><TextField.Label>{t("settings.vectorDimensions")}</TextField.Label><TextField.Input type="number" value={vector()?.dimensions ?? 1024} onInput={(event) => saveVector({ ...(vector() ?? { enabled: true, provider: "remote" as const }), dimensions: Number(event.currentTarget.value) || 0 })} /></TextField>
				</Show>
			</Show>
			<Show when={configuringLocal()}>
				<p class="status-line" role="status">{t("settings.localModelDownloadStatus")}</p>
			</Show>
			<Show when={embedding.localConfigureMutation.isSuccess && localSelected()}>
				<p class="status-line ok" role="status">{t("settings.localModelReady")}</p>
			</Show>
			<Show when={embedding.settingsMutation.error ?? embedding.localConfigureMutation.error}>{(error) => <p class="status-line err" role="alert">{String(error())}</p>}</Show>
			<Button
				type="button"
				class="primary-tool"
				disabled={embedding.settingsMutation.isPending || embedding.localConfigureMutation.isPending}
				aria-label={actionLabel()}
				onClick={() => {
					const current = vector();
					if (current?.provider === "local" || onboarding) {
						void embedding.localConfigureMutation.mutateAsync(
							current?.provider === "local"
								? { provider: "local", candidateId: current.localModel }
								: { provider: "none" },
						);
					} else if (current) {
						void saveVector(current);
					}
				}}
			>
				{actionLabel()}
			</Button>
		</section>
	);
}
