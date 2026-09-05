import { i18n, useTranslation } from "@bear-harness/i18n";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { createSignal, Show } from "solid-js";
import { Icon } from "../Icon.js";
import { useCompanionStore } from "../stores/companion.js";
import { Button, Dialog } from "../ui/primitives.js";
import { ModelSelector, modelRouteKey } from "./ModelSelector.js";
import { AddProviderForm, ProviderList } from "./ProviderSetup.js";

/** Installation-wide provider membership, credentials and defaults for newly created characters. */
export function SystemModelSettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [addingProvider, setAddingProvider] = createSignal(false);
	const models = () =>
		store.model.models().filter((model) => model.enabled && model.readiness === "ready");
	const defaults = () => store.model.data().systemDefaults;
	const visionRoute = () => {
		const vision = defaults().vision;
		return vision.mode === "manual" ? vision.route : undefined;
	};
	const byRoute = (route?: { providerId: string; modelId: string }) =>
		route
			? (models().find((model) => modelRouteKey(model) === modelRouteKey(route)) ?? null)
			: null;
	const replyModel = () => byRoute(defaults().reply);
	const save = async (
		reply: { providerId: string; modelId: string },
		vision: Parameters<typeof store.model.setSystemDefaults>[1],
	) => {
		setSaving(true);
		setError(null);
		try {
			await store.model.setSystemDefaults(reply, vision);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};
	return (
		<section class="model-settings" aria-labelledby="system-model-settings-heading">
			<div class="settings-group-heading">
				<h3 id="system-model-settings-heading">{t("settings.systemModelSettings")}</h3>
				<p class="field-hint">{t("settings.systemModelSettingsHint")}</p>
			</div>
			<div class="settings-group-heading provider-settings-heading">
				<h4>{t("settings.providerSetupLabel")}</h4>
				<Button type="button" data-variant="primary" onClick={() => setAddingProvider(true)}>
					{t("settings.addProvider")}
				</Button>
			</div>
			<ProviderList />
			<Dialog open={addingProvider()} onOpenChange={setAddingProvider}>
				<Dialog.Portal>
					<Dialog.Overlay class="confirmation-overlay" />
					<Dialog.Content class="provider-add-dialog">
						<Dialog.Title>{t("settings.addProvider")}</Dialog.Title>
						<AddProviderForm onAdded={() => setAddingProvider(false)} />
						<Dialog.CloseButton
							class="backstage-close provider-add-dialog-close"
							aria-label={t("backstage.close")}
						>
							<Icon icon={faXmark} />
						</Dialog.CloseButton>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
			<Show when={error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<ModelSelector
				models={models()}
				value={replyModel()}
				class="field"
				label={t("settings.systemDefaultReplyModel")}
				disabled={saving()}
				onModelChange={(model) => {
					if (model)
						void save(
							{ providerId: model.providerId, modelId: model.modelId },
							model.supportsImages ? { mode: "auto" } : defaults().vision,
						);
				}}
			/>
			<p class="field-hint">{t("settings.systemDefaultReplyModelHint")}</p>
			<Show when={defaults().reply && replyModel()?.supportsImages !== true}>
				<ModelSelector
					models={models().filter((model) => model.supportsImages)}
					value={byRoute(visionRoute())}
					class="field"
					label={t("settings.systemDefaultVisionModel")}
					autoLabel={t("settings.noFallback")}
					includeAuto
					disabled={saving()}
					onModelChange={(model) => {
						const reply = defaults().reply;
						if (!reply) return;
						void save(
							reply,
							model
								? {
										mode: "manual",
										route: { providerId: model.providerId, modelId: model.modelId },
									}
								: { mode: "auto" },
						);
					}}
				/>
				<p class="field-hint">{t("settings.systemDefaultVisionModelHint")}</p>
			</Show>
			<Show when={replyModel()?.supportsImages === true}>
				<p class="field-hint">{t("settings.visionModelNative")}</p>
			</Show>
		</section>
	);
}
