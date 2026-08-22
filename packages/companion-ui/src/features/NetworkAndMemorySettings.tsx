import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { Show } from "solid-js";
import { createNetworkMemoryWorkflow, PROXY_MODES } from "../stores/setup-workflows.js";
import { EmbeddingSettings } from "./EmbeddingSettings.js";
import { useCompanionStore } from "../stores/companion.js";

/**
 * Product network / memory-vector / download-mirror settings. These are
 * app-level settings persisted in the app_settings row; changing the vector
 * service or the mirror requires a restart, while the proxy applies live.
 */
export function NetworkAndMemorySettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = createNetworkMemoryWorkflow(store, t);
	const {
		proxyMode,
		proxyUrl,
		setProxyMode,
		setProxyUrl,
		saving,
		error,
		feedback,
		save,
	} = workflow;

	return (
		<section class="net-settings" aria-label={t("settings.networkSection")}>
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

			<h4>{t("settings.networkSection")}</h4>
			<Select
				options={[...PROXY_MODES]}
				value={proxyMode()}
				optionTextValue={(mode) => t(`settings.proxyModes.${mode}`)}
				onChange={(mode) => mode && setProxyMode(mode)}
				placeholder={t("settings.proxyMode")}
				aria-label={t("settings.proxyMode")}
				itemComponent={(props) => (
					<Select.Item item={props.item} class="select-item">
						<Select.ItemLabel>{props.item.rawValue}</Select.ItemLabel>
					</Select.Item>
				)}
			>
				<Select.Trigger class="select-trigger" aria-label={t("settings.proxyMode")}>
					<Select.Value<"direct" | "auto" | "manual">>
						{(state) => t(`settings.proxyModes.${state.selectedOption()}`)}
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
						onInput={(event) => setProxyUrl(event.currentTarget.value)}
					/>
				</TextField>
			</Show>

			<h4>{t("settings.memoryVectorSection")}</h4>
			<EmbeddingSettings mode="settings" />


			<div class="setting-actions">
				<Button type="button" class="primary-tool" disabled={saving()} onClick={() => void save()}>
					{t("settings.saveNetwork")}
				</Button>
			</div>
		</section>
	);
}
