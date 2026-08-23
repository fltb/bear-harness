import { i18n, useTranslation } from "@bear-harness/i18n";
import { ProviderSetup } from "./ProviderSetup.js";

/** System-level provider membership and credentials. Model choices live in shared model fields. */
export function SystemModelSettings() {
	const [t] = useTranslation(undefined, { i18n });
	return (
		<section class="model-settings" aria-labelledby="system-model-settings-heading">
			<div class="settings-group-heading">
				<h3 id="system-model-settings-heading">{t("settings.systemModelSettings")}</h3>
				<p class="field-hint">{t("settings.systemModelSettingsHint")}</p>
			</div>
			<ProviderSetup class="system-provider-setup" />
		</section>
	);
}
