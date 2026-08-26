import { i18n, useTranslation } from "@bear-harness/i18n";
import { Show } from "solid-js";
import { useCompanionStore } from "../stores/companion.js";
import { createConversationModelSettingsWorkflow } from "../stores/setup-workflows.js";
import { ModelSelector, modelRouteKey } from "./ModelSelector.js";

/** Conversation-scoped reply and image-reader model controls. */
export function ConversationModelSettings() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = createConversationModelSettingsWorkflow(store, t);

	const currentModel = () => {
		const id = workflow.selectedCurrentReplyOption();
		return id ? (workflow.modelByOptionId(id) ?? null) : null;
	};
	const visionModel = () => {
		const id = workflow.selectedVisionOption();
		return id === "reply" ? null : (workflow.modelByOptionId(id) ?? null);
	};

	return (
		<section class="model-settings conversation-model-settings">
			<div class="settings-group-heading">
				<h3>{t("settings.conversationModelSettings")}</h3>
				<p class="field-hint">{t("settings.conversationModelSettingsHint")}</p>
			</div>

			<Show when={workflow.feedback()}>
				{(value) => (
					<p class="status-line ok" role="status">
						{value()}
					</p>
				)}
			</Show>
			<Show when={workflow.error()}>
				{(value) => (
					<p class="status-line err" role="alert">
						{value()}
					</p>
				)}
			</Show>

			<ModelSelector
				models={workflow.configured()}
				value={currentModel()}
				class="field"
				label={t("settings.currentReplyModel")}
				disabled={workflow.saving() || store.activeConversationId === null}
				onModelChange={(model) => {
					const id = model ? modelRouteKey(model) : null;
					if (id !== workflow.selectedCurrentReplyOption()) void workflow.selectCurrentReply(id);
				}}
			/>
			<p class="field-hint">{t("settings.currentReplyModelHint")}</p>
			<Show when={store.activeConversationId === null}>
				<p class="field-hint">{t("settings.noActiveConversationModel")}</p>
			</Show>

			<ModelSelector
				models={workflow.configured().filter((model) => model.supportsImages)}
				value={visionModel()}
				class="field"
				label={t("settings.visionModel")}
				autoLabel={t("settings.visionModelAuto")}
				includeAuto
				disabled={workflow.saving()}
				onModelChange={(model) => {
					const id = model ? modelRouteKey(model) : "reply";
					if (id !== workflow.selectedVisionOption()) void workflow.setVisionModel(id);
				}}
			/>
			<p class="field-hint">{t("settings.visionModelHint")}</p>
		</section>
	);
}
