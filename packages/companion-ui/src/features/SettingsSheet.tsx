import {
	i18n,
	type ProductLocale,
	setProductLocale,
	supportedProductLocales,
	useLanguage,
	useTranslation,
} from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Collapsible } from "@kobalte/core/collapsible";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, For, Show } from "solid-js";
import { requestImageReaderFocus, setRequestImageReaderFocus } from "../Composer.js";
import { ModelPresetField, ProviderSelectionField } from "../ModelSelectionFields.js";
import { useCompanionStore } from "../stores/companion.js";
import { createSettingsWorkflow } from "../stores/setup-workflows.js";
import { NetworkAndMemorySettings } from "./NetworkAndMemorySettings.js";

export function SettingsSheet() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const [currentLocale] = useLanguage(() => i18n);
	const workflow = createSettingsWorkflow(store, t);
	const {
		saving,
		error,
		feedback,
		providers,
		providerId,
		modelId,
		apiKey,
		setApiKey,
		oauth,
		oauthAnswer,
		setOauthAnswer,
		advancedOpen,
		setAdvancedOpen,
		customBaseUrl,
		setCustomBaseUrl,
		piConfigJson,
		setPiConfigJson,
		importedModels,
		configured,
		modelOptions,
		selectedProvider,
		selectedConfigured,
		defaultReplyOption,
		visionOptions,
		selectedVisionOption,
		apiKeyPlaceholder,
		modelDisplayName,
		modelByOptionId,
		selectProvider,
		setModelId,
		run,
		beginOauth,
		saveApiKey,
		saveBaseUrl,
		importPiConfig,
		answerOauth,
		setDefaultReply,
		setVisionModel,
		removeModel,
		addModel,
	} = workflow;
	let visionTriggerRef: HTMLButtonElement | undefined;

	// Focus wiring is DOM-only state and remains local to the component.
	createEffect(() => {
		if (requestImageReaderFocus()) {
			setRequestImageReaderFocus(false);
			const trigger = visionTriggerRef;
			if (trigger) window.setTimeout(() => trigger.focus(), 0);
		}
	});

	return (
		<div class="sheet-panel">
			<p class="drawer-note">{t("settings.note")}</p>
			<Show when={feedback()}>
				{(value) => (
					<p class="status-line ok" role="status">
						{value()}
					</p>
				)}
			</Show>
			<Show when={error()}>
				{(value) => (
					<p class="status-line err" role="alert">
						{value()}
					</p>
				)}
			</Show>

			<Select
				options={[...supportedProductLocales]}
				value={currentLocale() as ProductLocale}
				optionTextValue={(locale) => t(`settings.localeNames.${locale}`)}
				onChange={(locale) =>
					locale && void run(() => setProductLocale(locale), t("settings.language"))
				}
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

			<section class="model-settings">
				<div class="settings-group-heading">
					<h3>{t("settings.modelService")}</h3>
					<p class="field-hint">{t("settings.modelServiceHint")}</p>
				</div>

				<ProviderSelectionField
					providers={providers()}
					providerId={providerId()}
					class="field"
					onProviderChange={selectProvider}
				/>

				<Show when={selectedProvider()}>
					{(provider) => (
						<Show
							when={provider().authType === "api_key"}
							fallback={
								<div class="oauth-login">
									<Button
										type="button"
										data-variant="secondary"
										disabled={saving() || !providerId()}
										onClick={() => void beginOauth()}
									>
										{t("settings.loginWithBrowser")}
									</Button>
									<Show when={oauth()?.prompt}>
										{(prompt) => (
											<TextField class="field">
												<TextField.Label class="field-label">{prompt().message}</TextField.Label>
												<TextField.Input
													value={oauthAnswer()}
													onInput={(event) => setOauthAnswer(event.currentTarget.value)}
												/>
												<Button
													type="button"
													data-variant="secondary"
													disabled={!oauthAnswer()}
													onClick={() => void answerOauth()}
												>
													{t("settings.oauthSubmit")}
												</Button>
											</TextField>
										)}
									</Show>
								</div>
							}
						>
							<TextField class="field">
								<TextField.Label class="field-label">{t("settings.apiKeyLabel")}</TextField.Label>
								<TextField.Input
									type="password"
									autocomplete="off"
									placeholder={apiKeyPlaceholder()}
									value={apiKey()}
									onInput={(event) => setApiKey(event.currentTarget.value)}
								/>
								<Button
									type="button"
									data-variant="secondary"
									aria-label={`${t("settings.saveKey")} ${t("settings.apiKeyLabel")}`}
									disabled={saving() || !providerId() || !apiKey()}
									onClick={() => void saveApiKey()}
								>
									{t("settings.saveKey")}
								</Button>
							</TextField>
						</Show>
					)}
				</Show>

				<Collapsible open={advancedOpen()} onOpenChange={setAdvancedOpen}>
					<Collapsible.Trigger class="advanced-toggle">
						{t("settings.advancedToggle")}
						<span class="advanced-chevron" aria-hidden="true">
							⌄
						</span>
					</Collapsible.Trigger>
					<Collapsible.Content class="advanced-model-settings">
						<TextField class="field">
							<TextField.Label class="field-label">{t("settings.customBaseUrl")}</TextField.Label>
							<TextField.Input
								placeholder={t("settings.customBaseUrlPlaceholder")}
								value={customBaseUrl()}
								onInput={(event) => setCustomBaseUrl(event.currentTarget.value)}
							/>
						</TextField>
						<Button
							class="primary-action use-model-button"
							type="button"
							data-variant="primary"
							disabled={saving() || !providerId() || !customBaseUrl()}
							onClick={() => void saveBaseUrl()}
						>
							{t("settings.customSave")}
						</Button>
						<TextField class="field">
							<TextField.Label class="field-label">{t("settings.piConfigLabel")}</TextField.Label>
							<span class="field-hint">{t("settings.piConfigHint")}</span>
							<TextField.TextArea
								rows={10}
								aria-label={t("settings.piConfigLabel")}
								placeholder={t("settings.piConfigPlaceholder")}
								value={piConfigJson()}
								onInput={(event) => setPiConfigJson(event.currentTarget.value)}
							/>
						</TextField>
						<Button
							type="button"
							data-variant="primary"
							disabled={saving() || !piConfigJson().trim()}
							onClick={() => void importPiConfig()}
						>
							{t("settings.piConfigImport")}
						</Button>
						<Show when={importedModels().length > 0}>
							<div class="model-pool-list" aria-label={t("settings.modelPool")}>
								<For each={importedModels()}>
									{(model) => (
										<div class="model-pool-item">
											<span>{modelDisplayName(model)}</span>
										</div>
									)}
								</For>
							</div>
						</Show>
					</Collapsible.Content>
				</Collapsible>

				<div class="settings-group-heading">
					<h3>{t("settings.modelPool")}</h3>
					<p class="field-hint">{t("settings.modelPoolHint")}</p>
				</div>
				<Select
					class="field"
					options={modelOptions()}
					value={workflow.defaultReplyOption()}
					optionTextValue={(id) => {
						const model = modelByOptionId(id);
						return model ? modelDisplayName(model) : id;
					}}
					placeholder={t("settings.noDefaultReplyModel")}
					onChange={(id) => {
						if (id !== defaultReplyOption()) void setDefaultReply(id);
					}}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>
								{modelDisplayName(modelByOptionId(itemProps.item.rawValue)!)}
							</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Label class="field-label">{t("settings.defaultReplyModel")}</Select.Label>
					<p class="field-hint">{t("settings.defaultReplyModelHint")}</p>
					<Select.Trigger class="select-trigger">
						<Select.Value<string> class="select-value">
							{(state) => {
								const model = modelByOptionId(state.selectedOption());
								return model ? modelDisplayName(model) : t("settings.noDefaultReplyModel");
							}}
						</Select.Value>
					</Select.Trigger>
					<Select.Portal>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
				<Select
					class="field"
					options={visionOptions()}
					value={selectedVisionOption()}
					optionTextValue={(id) => {
						if (id === "auto") return t("settings.visionModelAuto");
						const model = modelByOptionId(id);
						return model ? modelDisplayName(model) : id;
					}}
					onChange={(id) => {
						if (id !== selectedVisionOption()) void setVisionModel(id);
					}}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>
								{itemProps.item.rawValue === "auto"
									? t("settings.visionModelAuto")
									: modelDisplayName(modelByOptionId(itemProps.item.rawValue)!)}
							</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Label class="field-label">{t("settings.visionModel")}</Select.Label>
					<p class="field-hint">{t("settings.visionModelHint")}</p>
					<Select.Trigger ref={visionTriggerRef} class="select-trigger">
						<Select.Value<string> class="select-value">
							{(state) => {
								const id = state.selectedOption();
								const model = modelByOptionId(id);
								return id === "auto"
									? t("settings.visionModelAuto")
									: model
										? modelDisplayName(model)
										: id;
							}}
						</Select.Value>
					</Select.Trigger>
					<Select.Portal>
						<Select.Content class="select-content">
							<Select.Listbox class="select-listbox" />
						</Select.Content>
					</Select.Portal>
				</Select>
				<div class="model-pool-list">
					<For each={configured()}>
						{(model) => (
							<div class="model-pool-item">
								<span>{modelDisplayName(model)}</span>
								<Button
									type="button"
									data-semantic="danger"
									data-variant="danger"
									aria-label={`${t("settings.removeModel")} ${modelDisplayName(model)}`}
									disabled={saving()}
									onClick={() => void removeModel(model)}
								>
									{t("settings.removeModel")}
								</Button>
							</div>
						)}
					</For>
				</div>

				<ModelPresetField
					provider={selectedProvider()}
					modelId={modelId()}
					class="field"
					modelLabel={t("settings.modelLabel")}
					onModelChange={setModelId}
				/>
				<Button
					class="primary-action use-model-button"
					type="button"
					data-variant="primary"
					disabled={saving() || !providerId() || !modelId() || selectedConfigured()}
					onClick={() => void addModel()}
				>
					{selectedConfigured() ? t("settings.modelAvailable") : t("settings.addModel")}
				</Button>
			</section>
			<NetworkAndMemorySettings />
		</div>
	);
}
