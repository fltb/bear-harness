import {
	i18n,
	type ProductLocale,
	setProductLocale,
	supportedProductLocales,
	useLanguage,
	useTranslation,
} from "@bear-harness/i18n";
import { Select } from "@kobalte/core/select";
import { createSignal, Show } from "solid-js";
import { ConversationModelSettings } from "./ConversationModelSettings.js";
import { NetworkAndMemorySettings } from "./NetworkAndMemorySettings.js";
import { SystemModelSettings } from "./SystemModelSettings.js";

export function SettingsSheet() {
	const [t] = useTranslation(undefined, { i18n });
	const [currentLocale] = useLanguage(() => i18n);
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const changeLocale = async (locale: ProductLocale): Promise<void> => {
		setSaving(true);
		setError(null);
		try {
			await setProductLocale(locale);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div class="sheet-panel">
			<p class="drawer-note">{t("settings.note")}</p>
			<Show when={error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{message()}
					</p>
				)}
			</Show>

			<Select
				options={[...supportedProductLocales]}
				value={currentLocale() as ProductLocale}
				optionTextValue={(locale) => t(`settings.localeNames.${locale}`)}
				disabled={saving()}
				onChange={(locale) => locale && void changeLocale(locale)}
				itemComponent={(itemProps) => (
					<Select.Item item={itemProps.item} class="select-item">
						<Select.ItemLabel>
							{t(`settings.localeNames.${itemProps.item.rawValue}`)}
						</Select.ItemLabel>
					</Select.Item>
				)}
				class="field"
			>
				<Select.Label class="field-label">{t("settings.language")}</Select.Label>
				<span class="field-hint">{t("settings.languageHint")}</span>
				<Select.Trigger class="select-trigger" aria-label={t("settings.language")}>
					<Select.Value<ProductLocale> class="select-value">
						{(state) => {
							const locale = state.selectedOption();
							return locale ? t(`settings.localeNames.${locale}`) : "";
						}}
					</Select.Value>
				</Select.Trigger>
				<Select.Portal>
					<Select.Content class="select-content">
						<Select.Listbox class="select-listbox" />
					</Select.Content>
				</Select.Portal>
			</Select>

			<ConversationModelSettings />
			<SystemModelSettings />
			<NetworkAndMemorySettings />
		</div>
	);
}
