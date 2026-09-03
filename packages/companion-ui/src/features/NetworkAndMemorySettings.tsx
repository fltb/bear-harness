import { i18n, useTranslation } from "@bear-harness/i18n";
import { Show } from "solid-js";
import { markSelectPortalTopLayer } from "../lib/select-portal.js";
import { useCompanionStore } from "../stores/companion.js";
import { createNetworkMemoryWorkflow } from "../stores/setup-workflows.js";
import { Button, Select, TextField } from "../ui/primitives.js";
import { EmbeddingSettings } from "./EmbeddingSettings.js";

/**
 * Product network / memory-vector / download-mirror settings. These are
 * app-level settings persisted in the app_settings row; changing the vector
 * service, download source, and proxy all apply through Host-owned settings.
 */
export function NetworkAndMemorySettings(props: { section?: "network" | "memory" }) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = createNetworkMemoryWorkflow(store, t);
	const { proxyMode, proxyUrl, setProxyMode, setProxyUrl, saving, error, feedback, save } =
		workflow;
	const proxyModes = () => [{ id: "direct" as const }, { id: "auto" as const }, { id: "manual" as const }];
	const selectedProxyMode = () => proxyModes().find((mode) => mode.id === proxyMode()) ?? null;

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

			<Show when={props.section !== "memory"}>
				<section
					class="settings-section settings-page-section"
					aria-labelledby="network-settings-heading"
				>
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
							disabled={saving()}
							placeholder={t("settings.proxyMode")}
							aria-label={t("settings.proxyMode")}
							itemComponent={(props) => (
								<Select.Item item={props.item} class="select-item">
									<Select.ItemLabel>
										{t(`settings.proxyModes.${props.item.rawValue.id}`)}
									</Select.ItemLabel>
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
							<Select.Portal ref={markSelectPortalTopLayer}>
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
									disabled={saving()}
									onInput={(event) => setProxyUrl(event.currentTarget.value)}
								/>
							</TextField>
						</Show>
					</div>
					<div class="settings-actions">
						<Button
							type="button"
							data-variant="primary"
							disabled={saving()}
							onClick={() => void save()}
						>
							{t("settings.saveNetwork")}
						</Button>
					</div>
				</section>
			</Show>

			<Show when={props.section !== "network"}>
				<section
					class="settings-section settings-page-section"
					aria-labelledby="memory-vector-settings-heading"
				>
					<header class="settings-section-header">
						<h4 id="memory-vector-settings-heading">{t("settings.memoryVectorSection")}</h4>
					</header>
					<EmbeddingSettings mode="settings" />
				</section>
			</Show>
		</div>
	);
}
