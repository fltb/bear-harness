import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { Show } from "solid-js";
import { createNetworkMemoryWorkflow } from "../stores/setup-workflows.js";
import { EmbeddingSettings } from "./EmbeddingSettings.js";
import { useCompanionStore } from "../stores/companion.js";

/**
 * Product network / memory-vector / download-mirror settings. These are
 * app-level settings persisted in the app_settings row; changing the vector
 * service, download source, and proxy all apply through Host-owned settings.
 */
export function NetworkAndMemorySettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = createNetworkMemoryWorkflow(store, t);
	const { proxyMode, proxyUrl, setProxyMode, setProxyUrl, saving, error, feedback, save } =
		workflow;
	const proxyModes = () => store.embedding.capabilitiesQuery.data?.networkProxyModes ?? [];
	const selectedProxyMode = () => proxyModes().find((mode) => mode.id === proxyMode()) ?? null;
	const capabilitiesReady = () => store.embedding.capabilitiesQuery.data !== undefined;

	return (
		<div class="settings-stack">
			<Show when={feedback()}>
				<p class="status-line ok" role="status">
					{feedback()}
				</p>
			</Show>
			<Show when={error()}>
				<p class="status-line err" role="alert">
					{error()}
				</p>
			</Show>

			<section class="settings-section" aria-labelledby="network-settings-heading">
				<header class="settings-section-header">
					<h4 id="network-settings-heading">{t("settings.networkSection")}</h4>
				</header>
				<div class="settings-fields">
					<Select
						class="setting-select"
						options={proxyModes()}
						value={selectedProxyMode()}
						optionValue="id"
						optionTextValue={(mode) => t(`settings.proxyModes.${mode.id}`)}
						onChange={(mode) => mode && setProxyMode(mode.id)}
						disabled={!capabilitiesReady() || proxyModes().length === 0}
						placeholder={t("settings.proxyMode")}
						aria-label={t("settings.proxyMode")}
						itemComponent={(props) => (
							<Select.Item item={props.item} class="select-item">
								<Select.ItemLabel>{props.item.rawValue.id}</Select.ItemLabel>
							</Select.Item>
						)}
					>
						<Select.Trigger class="select-trigger" aria-label={t("settings.proxyMode")}>
							<Select.Value<{ id: "direct" | "auto" | "manual" }>>
								{(state) => {
									const mode = state.selectedOption();
									return mode ? t(`settings.proxyModes.${mode.id}`) : "";
								}}
							</Select.Value>
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="select-content">
								<Select.Listbox class="select-listbox" />
							</Select.Content>
						</Select.Portal>
					</Select>
					<Show when={proxyMode() === "manual"}>
						<TextField class="setting-field">
							<TextField.Label>{t("settings.proxyUrl")}</TextField.Label>
							<TextField.Input
								type="text"
								placeholder="http://127.0.0.1:7890"
								value={proxyUrl()}
								disabled={!capabilitiesReady()}
								onInput={(event) => setProxyUrl(event.currentTarget.value)}
							/>
						</TextField>
					</Show>
				</div>
				<div class="settings-actions">
					<Button
						type="button"
						class="primary-tool"
						disabled={saving() || !capabilitiesReady() || proxyModes().length === 0}
						onClick={() => void save()}
					>
						{t("settings.saveNetwork")}
					</Button>
				</div>
			</section>

			<section class="settings-section" aria-labelledby="memory-vector-settings-heading">
				<header class="settings-section-header">
					<h4 id="memory-vector-settings-heading">{t("settings.memoryVectorSection")}</h4>
				</header>
				<EmbeddingSettings mode="settings" />
			</section>
		</div>
	);
}
