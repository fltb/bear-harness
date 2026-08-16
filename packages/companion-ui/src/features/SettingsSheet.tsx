import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
	type ProductLocale,
	productLocale,
	setProductLocale,
	supportedProductLocales,
	t,
} from "../i18n.js";
import { ModelPresetField, ProviderSelectionField } from "../ModelSelectionFields.js";
import type { ProviderLoginResult } from "../stores/companion.js";
import { useCompanionStore } from "../stores/companion.js";

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export function SettingsSheet() {
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

			<label class="field">
				<span class="field-label">{t("settings.language")}</span>
				<span class="field-hint">{t("settings.languageHint")}</span>
				<select
					aria-label={t("settings.language")}
					value={productLocale()}
					onChange={(event) => setProductLocale(event.currentTarget.value as ProductLocale)}
				>
					<For each={supportedProductLocales}>
						{(value) => <option value={value}>{t(`settings.localeNames.${value}`)}</option>}
					</For>
				</select>
			</label>

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
									<button
										type="button"
										data-variant="secondary"
										disabled={saving() || !providerId()}
										onClick={() => void beginOauth()}
									>
										{t("settings.loginWithBrowser")}
									</button>
									<Show when={oauth()?.prompt}>
										{(prompt) => (
											<label class="field">
												<span class="field-label">{prompt().message}</span>
												<input
													value={oauthAnswer()}
													onInput={(event) => setOauthAnswer(event.currentTarget.value)}
												/>
												<button
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
												</button>
											</label>
										)}
									</Show>
								</div>
							}
						>
							<label class="field">
								<span class="field-label">{t("settings.apiKeyLabel")}</span>
								<input
									type="password"
									autocomplete="off"
									placeholder={apiKeyPlaceholder()}
									value={apiKey()}
									onInput={(event) => setApiKey(event.currentTarget.value)}
								/>
								<button
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
								</button>
							</label>
						</Show>
					)}
				</Show>

				<button
					class="advanced-toggle"
					type="button"
					data-variant="secondary"
					aria-expanded={advancedOpen()}
					onClick={() => setAdvancedOpen((open) => !open)}
				>
					{t("settings.advancedToggle")}
				</button>
				<Show when={advancedOpen()}>
					<div class="advanced-model-settings">
						<label class="field">
							<span class="field-label">{t("settings.customBaseUrl")}</span>
							<input
								placeholder={t("settings.customBaseUrlPlaceholder")}
								value={customBaseUrl()}
								onInput={(event) => setCustomBaseUrl(event.currentTarget.value)}
							/>
						</label>
						<button
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
						</button>
						<label class="field">
							<span class="field-label">{t("settings.piConfigLabel")}</span>
							<span class="field-hint">{t("settings.piConfigHint")}</span>
							<textarea
								rows={10}
								aria-label={t("settings.piConfigLabel")}
								placeholder={t("settings.piConfigPlaceholder")}
								value={piConfigJson()}
								onInput={(event) => setPiConfigJson(event.currentTarget.value)}
							/>
						</label>
						<button
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
						</button>
					</div>
				</Show>

				<div class="settings-group-heading">
					<h3>{t("settings.modelPool")}</h3>
					<p class="field-hint">{t("settings.modelPoolHint")}</p>
				</div>
				<div class="model-pool-list">
					<For each={configured()}>
						{(model) => (
							<div class="model-pool-item">
								<span>{model.label}</span>
								<Show when={model.supportsImages}>
									<span class="provider-status">{t("settings.multimodal")}</span>
								</Show>
								<button
									type="button"
									data-semantic="danger"
									data-variant="danger"
									aria-label={`${t("settings.removeModel")} ${model.label}`}
									disabled={saving()}
									onClick={() =>
										void run(
											() => store.model.disable(model.providerId, model.modelId),
											t("settings.modelRemoved"),
										)
									}
								>
									{t("settings.removeModel")}
								</button>
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
				<button
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
				</button>
			</section>
		</div>
	);
}
