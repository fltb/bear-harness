import {
	i18n,
	type ProductLocale,
	setProductLocale,
	supportedProductLocales,
	useLanguage,
	useTranslation,
} from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ModelPresetField, ProviderSelectionField } from "../ModelSelectionFields.js";
import type { ProviderLoginResult } from "../stores/companion.js";
import { useCompanionStore } from "../stores/companion.js";
import type { ConfiguredModel } from "../stores/ipc.js";

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export function SettingsSheet() {
	const [t] = useTranslation(undefined, { i18n });
	const [currentLocale] = useLanguage(() => i18n);
	const store = useCompanionStore();
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [feedback, setFeedback] = createSignal<string | null>(null);
	const [providerId, setProviderId] = createSignal("");
	const [modelId, setModelId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const [oauth, setOauth] = createSignal<ProviderLoginResult | null>(null);
	const [oauthAnswer, setOauthAnswer] = createSignal("");
	const [advancedOpen, setAdvancedOpen] = createSignal(false);
	const [customBaseUrl, setCustomBaseUrl] = createSignal("");
	const [piConfigJson, setPiConfigJson] = createSignal("");
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const providers = () => store.provider.providers();
	const selectedProvider = () => providers().find((provider) => provider.id === providerId());
	const configured = () => store.model.models();
	const selectedConfigured = () =>
		configured().some((model) => model.providerId === providerId() && model.modelId === modelId());
	const modelDisplayName = (model: ConfiguredModel) =>
		`${model.label} (${model.providerName ?? model.providerId})`;
	const routeOptionId = (route: { providerId: string; modelId: string }) =>
		`${route.providerId}\u0000${route.modelId}`;
	const modelOptionId = (model: ConfiguredModel) => routeOptionId(model);
	const modelByOptionId = (id: string) => configured().find((model) => modelOptionId(model) === id);
	const defaultReplyModel = () => {
		const route = store.model.data().defaults.reply;
		return route
			? configured().find(
					(model) => model.providerId === route.providerId && model.modelId === route.modelId,
				)
			: undefined;
	};
	const visionOptions = () => [
		"auto",
		...configured()
			.filter((model) => model.supportsImages)
			.map(modelOptionId),
	];
	const selectedVisionOption = (): string => {
		const vision = store.model.data().defaults.vision;
		return vision.mode === "auto" ? "auto" : routeOptionId(vision.route);
	};
	const apiKeyPlaceholder = () => {
		const status = selectedProvider()?.credentialStatus;
		return status === "stored" || status === "session_only"
			? t("settings.apiKeyStoredPlaceholder")
			: undefined;
	};

	onMount(() => {
		void Promise.all([store.provider.list(), store.model.list()]);
	});

	async function run(action: () => Promise<unknown>, success: string): Promise<void> {
		setSaving(true);
		setError(null);
		setFeedback(null);
		try {
			await action();
			setFeedback(success);
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	}

	async function beginOauth(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			let state = await store.provider.login(providerId());
			setOauth(state);
			while (!disposed && (state.status === "running" || state.status === "waiting_input")) {
				if (state.status === "waiting_input") break;
				await new Promise((resolve) => setTimeout(resolve, 750));
				state = await store.provider.loginStatus(providerId());
				setOauth(state);
			}
			if (state.prompt?.type === "select" && state.prompt.options?.[0])
				setOauthAnswer(state.prompt.options[0].id);
			if (state.status === "completed") {
				setFeedback(t("settings.oauthConnected"));
				await store.provider.list();
			}
			if (state.status === "failed") setError(state.message ?? t("settings.oauthFailed"));
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	}

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
				onChange={(locale) => locale && setProductLocale(locale)}
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
					onProviderChange={(id) => {
						setProviderId(id);
						setModelId("");
					}}
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
													onClick={() =>
														void run(
															() => store.provider.loginAnswer(providerId(), oauthAnswer()),
															t("settings.oauthConnected"),
														)
													}
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
									onClick={() =>
										void run(async () => {
											await store.provider.setApiKey(providerId(), apiKey());
											setApiKey("");
											await store.provider.list();
										}, t("settings.keySaved"))
									}
								>
									{t("settings.saveKey")}
								</Button>
							</TextField>
						</Show>
					)}
				</Show>

				<Button
					class="advanced-toggle"
					type="button"
					data-variant="secondary"
					aria-expanded={advancedOpen()}
					onClick={() => setAdvancedOpen((open) => !open)}
				>
					{t("settings.advancedToggle")}
				</Button>
				<Show when={advancedOpen()}>
					<div class="advanced-model-settings">
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
							onClick={() =>
								void run(async () => {
									await store.provider.overrideBaseUrl({
										providerId: providerId(),
										baseUrl: customBaseUrl(),
									});
									setCustomBaseUrl("");
								}, t("settings.customSaved"))
							}
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
							onClick={() =>
								void run(async () => {
									await store.provider.importPiConfig(piConfigJson());
									setPiConfigJson("");
									await store.provider.list();
								}, t("settings.piConfigImported"))
							}
						>
							{t("settings.piConfigImport")}
						</Button>
					</div>
				</Show>

				<div class="settings-group-heading">
					<h3>{t("settings.modelPool")}</h3>
					<p class="field-hint">{t("settings.modelPoolHint")}</p>
				</div>
				<Select
					class="field"
					options={configured().map(modelOptionId)}
					value={defaultReplyModel() ? modelOptionId(defaultReplyModel() as ConfiguredModel) : null}
					optionTextValue={(id) => {
						const model = modelByOptionId(id);
						return model ? modelDisplayName(model) : id;
					}}
					placeholder={t("settings.noDefaultReplyModel")}
					onChange={(id) => {
						const model = id ? modelByOptionId(id) : undefined;
						void run(
							() =>
								model
									? store.model.setDefaultReply(model.providerId, model.modelId)
									: store.model.clearDefaultReply(),
							t("settings.defaultReplyUpdated"),
						);
					}}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>
								{modelDisplayName(modelByOptionId(itemProps.item.rawValue) as ConfiguredModel)}
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
						const model = id && id !== "auto" ? modelByOptionId(id) : undefined;
						void run(
							() =>
								model
									? store.model.setMultimodalFallback(model.providerId, model.modelId)
									: store.model.setVisionAuto(),
							t("settings.imageReaderUpdated"),
						);
					}}
					itemComponent={(itemProps) => (
						<Select.Item item={itemProps.item} class="select-item">
							<Select.ItemLabel>
								{itemProps.item.rawValue === "auto"
									? t("settings.visionModelAuto")
									: modelDisplayName(modelByOptionId(itemProps.item.rawValue) as ConfiguredModel)}
							</Select.ItemLabel>
						</Select.Item>
					)}
				>
					<Select.Label class="field-label">{t("settings.visionModel")}</Select.Label>
					<p class="field-hint">{t("settings.visionModelHint")}</p>
					<Select.Trigger class="select-trigger">
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
									onClick={() =>
										void run(
											() => store.model.disable(model.providerId, model.modelId),
											t("settings.modelRemoved"),
										)
									}
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
					onClick={() =>
						void run(
							() =>
								store.model.enable(
									providerId(),
									modelId(),
									selectedProvider()?.availableModels.find((model) => model.id === modelId())?.name,
								),
							t("settings.modelAdded"),
						)
					}
				>
					{selectedConfigured() ? t("settings.modelAvailable") : t("settings.addModel")}
				</Button>
			</section>
		</div>
	);
}
