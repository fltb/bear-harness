import {
	i18n,
	type ProductLocale,
	setProductLocale,
	supportedProductLocales,
	useLanguage,
	useTranslation,
} from "@bear-harness/i18n";
import { createSignal, For, Show } from "solid-js";
import { markSelectPortalTopLayer } from "../lib/select-portal.js";
import { Button, Select } from "../ui/primitives.js";
import { ArchivedConversationSettings } from "./ArchivedConversationSettings.js";
import { ExternalAgentSettings } from "./ExternalAgentSettings.js";
import { NetworkAndMemorySettings } from "./NetworkAndMemorySettings.js";
import { SystemModelSettings } from "./SystemModelSettings.js";

export type SettingsPage = "general" | "archived" | "providers" | "agents" | "network" | "memory";

export function SettingsSheet(
	props: { initialPage?: SettingsPage; onPageChange?: (page: SettingsPage) => void } = {},
) {
	const [t] = useTranslation(undefined, { i18n });
	const [currentLocale] = useLanguage(() => i18n);
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [localPage, setLocalPage] = createSignal<SettingsPage>(props.initialPage ?? "general");
	const page = () => props.initialPage ?? localPage();
	const setPage = (nextPage: SettingsPage) => {
		setLocalPage(nextPage);
		props.onPageChange?.(nextPage);
	};
	const pages = () => [
		{ id: "general" as const, label: t("settings.language") },
		{ id: "archived" as const, label: t("sidebar.archivedConversations") },
		{ id: "providers" as const, label: t("settings.systemModelSettings") },
		{ id: "agents" as const, label: t("settings.workAgent") },
		{ id: "network" as const, label: t("settings.networkSection") },
		{ id: "memory" as const, label: t("settings.memoryVectorSection") },
	];

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
		<div class="settings-workbench">
			<nav class="settings-navigation" aria-label={t("sidebar.systemSettings")}>
				<p class="drawer-note">{t("settings.note")}</p>
				<Select<SettingsPage>
					options={pages().map((item) => item.id)}
					value={page()}
					optionTextValue={(id) => pages().find((item) => item.id === id)?.label ?? id}
					onChange={(nextPage) => nextPage && setPage(nextPage)}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>
								{pages().find((item) => item.id === itemProps.item.rawValue)?.label}
							</Select.ItemLabel>
						</Select.Item>
					)}
					class="settings-mobile-picker"
				>
					<Select.Trigger class="select-trigger" aria-label={t("sidebar.systemSettings")}>
						<Select.Value<SettingsPage> class="select-value">
							{(state) => pages().find((item) => item.id === state.selectedOption())?.label}
						</Select.Value>
					</Select.Trigger>
					<Select.Portal ref={markSelectPortalTopLayer}>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
				<div class="settings-navigation-list">
					<For each={pages()}>
						{(item) => (
							<Button
								type="button"
								aria-current={page() === item.id ? "page" : undefined}
								onClick={() => setPage(item.id)}
							>
								{item.label}
							</Button>
						)}
					</For>
				</div>
			</nav>
			<div class="settings-page" data-settings-page={page()}>
				<Show when={error()}>
					{(message) => (
						<p class="status-line err" role="alert">
							{message()}
						</p>
					)}
				</Show>

				<Show when={page() === "general"}>
					<section class="settings-page-section" aria-labelledby="general-settings-title">
						<header class="settings-page-header">
							<h3 id="general-settings-title">{t("settings.language")}</h3>
							<p>{t("settings.languageHint")}</p>
						</header>
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
							<Select.Trigger class="select-trigger" aria-label={t("settings.language")}>
								<Select.Value<ProductLocale> class="select-value">
									{(state) => {
										const locale = state.selectedOption();
										return locale ? t(`settings.localeNames.${locale}`) : "";
									}}
								</Select.Value>
							</Select.Trigger>
							<Select.Portal ref={markSelectPortalTopLayer}>
								<Select.Content class="select-content">
									<Select.Listbox class="select-listbox" />
								</Select.Content>
							</Select.Portal>
						</Select>
					</section>
				</Show>
				<Show when={page() === "archived"}>
					<ArchivedConversationSettings />
				</Show>
				<Show when={page() === "providers"}>
					<SystemModelSettings />
				</Show>
				<Show when={page() === "agents"}>
					<ExternalAgentSettings />
				</Show>
				<Show when={page() === "network"}>
					<NetworkAndMemorySettings section="network" />
				</Show>
				<Show when={page() === "memory"}>
					<NetworkAndMemorySettings section="memory" />
				</Show>
			</div>
		</div>
	);
}
