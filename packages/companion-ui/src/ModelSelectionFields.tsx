import { i18n, useTranslation } from "@bear-harness/i18n";
import { Select } from "@kobalte/core/select";
import type { ProviderInfo } from "./stores/ipc.js";

export function ProviderSelectionField(props: {
	providers: readonly ProviderInfo[];
	providerId: string;
	class: string;
	onProviderChange: (providerId: string) => void;
}) {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<Select<ProviderInfo>
			options={[...props.providers]}
			value={props.providers.find((provider) => provider.id === props.providerId) ?? null}
			optionValue="id"
			optionTextValue="name"
			placeholder={t("settings.chooseService")}
			onChange={(provider) => props.onProviderChange(provider?.id ?? "")}
			itemComponent={(itemProps) => (
				<Select.Item item={itemProps.item} class="select-item">
					<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
				</Select.Item>
			)}
			class={props.class}
		>
			<Select.Label class="field-label">{t("settings.serviceLabel")}</Select.Label>
			<Select.Trigger class="select-trigger" aria-label={t("settings.serviceLabel")}>
				<Select.Value<ProviderInfo> class="select-value">
					{(state) => state.selectedOption()?.name}
				</Select.Value>
				<Select.Icon class="select-icon" aria-hidden="true">
					v
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content class="select-content">
					<Select.Listbox class="select-listbox" />
				</Select.Content>
			</Select.Portal>
		</Select>
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
	const [t] = useTranslation(undefined, { i18n });
	const models = () => props.provider?.availableModels ?? [];
	return (
		<Select<ProviderInfo["availableModels"][number]>
			options={models()}
			value={models().find((model) => model.id === props.modelId) ?? null}
			optionValue="id"
			optionTextValue="name"
			placeholder={t("settings.chooseModel")}
			disabled={props.disabled || !props.provider}
			onChange={(model) => props.onModelChange(model?.id ?? "")}
			itemComponent={(itemProps) => (
				<Select.Item item={itemProps.item} class="select-item">
					<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
				</Select.Item>
			)}
			class={props.class}
		>
			<Select.Label class="field-label">{props.modelLabel}</Select.Label>
			<Select.Trigger class="select-trigger" aria-label={props.modelLabel}>
				<Select.Value<ProviderInfo["availableModels"][number]> class="select-value">
					{(state) => state.selectedOption()?.name}
				</Select.Value>
				<Select.Icon class="select-icon" aria-hidden="true">
					v
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content class="select-content">
					<Select.Listbox class="select-listbox" />
				</Select.Content>
			</Select.Portal>
		</Select>
	);
}
