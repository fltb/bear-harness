import { For } from "solid-js";
import { t } from "./i18n.js";
import type { ProviderInfo } from "./stores/ipc.js";

export function ProviderSelectionField(props: {
	providers: readonly ProviderInfo[];
	providerId: string;
	class: string;
	onProviderChange: (providerId: string) => void;
}) {
	return (
		<label class={props.class}>
			<span>{t("settings.serviceLabel")}</span>
			<select
				aria-label={t("settings.serviceLabel")}
				value={props.providerId}
				onChange={(event) => props.onProviderChange(event.currentTarget.value)}
			>
				<option value="" disabled>
					{t("settings.chooseService")}
				</option>
				<For each={props.providers}>
					{(provider) => <option value={provider.id}>{provider.name}</option>}
				</For>
			</select>
		</label>
	);
}

export function ModelPresetField(props: {
	provider?: ProviderInfo;
	modelId: string;
	class: string;
	modelLabel: string;
	disabled?: boolean;
	onModelChange: (modelId: string) => void;
}) {
	return (
		<label class={props.class}>
			<span>{props.modelLabel}</span>
			<select
				aria-label={props.modelLabel}
				value={props.modelId}
				disabled={props.disabled || !props.provider}
				onChange={(event) => props.onModelChange(event.currentTarget.value)}
			>
				<option value="" disabled>
					{t("settings.chooseModel")}
				</option>
				<For each={props.provider?.availableModels ?? []}>
					{(model) => <option value={model.id}>{model.name}</option>}
				</For>
			</select>
		</label>
	);
}
