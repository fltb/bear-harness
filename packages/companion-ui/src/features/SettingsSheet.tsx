import { productUi } from "@bear-harness/product-config";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
	type ProviderLoginResult,
	type SettingsData,
	type SettingsPatch,
	useCompanionStore,
} from "../stores/companion.js";

/**
 * System settings sheet (幕后 · 系统设置).
 *
 * All state comes from the reactive `store.settings.data()`; `get()` loads it
 * on mount and `set()` pushes partial patches through the store, which
 * re-reads `settings.get` so the UI always mirrors the host's canonical
 * state. The store normalizes hostile payloads at the boundary.
 */

const DEFAULT_SETTINGS: SettingsData = {
	relationshipMemoryEnabled: false,
};

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
	const [textFallbackApiKey, setTextFallbackApiKey] = createSignal("");
	const [multimodalFallbackApiKey, setMultimodalFallbackApiKey] = createSignal("");
	const [fallbackCustomKind, setFallbackCustomKind] = createSignal<"text" | "multimodal" | null>(
		null,
	);
	const [fallbackCustomUrl, setFallbackCustomUrl] = createSignal("");
	const [oauth, setOauth] = createSignal<ProviderLoginResult | null>(null);
	const [oauthAnswer, setOauthAnswer] = createSignal("");
	const [advancedOpen, setAdvancedOpen] = createSignal(false);
	const [customBaseUrl, setCustomBaseUrl] = createSignal("");
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const settings = () => store.settings.data() ?? DEFAULT_SETTINGS;
	const loading = () => store.settings.data() === undefined;

	createEffect(() => {
		void store.settings.get();
	});

	onMount(() => {
		void Promise.all([store.provider.list(), store.voice.list()]).then(([data, voice]) => {
			const active = voice.stacks.find((stack) => stack.active);
			const provider =
				data.providers.find((candidate) => candidate.id === active?.providerId) ??
				data.providers[0];
			if (!provider) return;
			setProviderId(provider.id);
			setModelId(
				provider.availableModels.some((model) => model.id === active?.modelId)
					? (active?.modelId ?? "")
					: (provider.availableModels[0]?.id ?? ""),
			);
		});
	});

	const providers = () => store.provider.providers();
	const selectedProvider = () => providers().find((provider) => provider.id === providerId());
	const apiKeyPlaceholder = (provider: string) => {
		const status = providers().find((candidate) => candidate.id === provider)?.credentialStatus;
		return status === "stored" || status === "session_only"
			? productUi.settings.apiKeyStoredPlaceholder
			: undefined;
	};
	const modelRoutes = () =>
		providers().flatMap((provider) =>
			provider.availableModels.map((model) => ({
				provider,
				model,
				value: `${provider.id}:${model.id}`,
			})),
		);
	const routeValue = (route: SettingsData["textFallback"]) =>
		route ? `${route.providerId}:${route.modelId}` : "";
	const setFallback = async (
		key: "textFallback" | "multimodalFallback",
		value: string,
	): Promise<void> => {
		const route = modelRoutes().find((candidate) => candidate.value === value);
		if (!route) return;
		await save(
			{ [key]: { providerId: route.provider.id, modelId: route.model.id } },
			productUi.settings.modelSaved,
		);
	};

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
			if (state.prompt?.type === "select" && state.prompt.options?.[0]) {
				setOauthAnswer(state.prompt.options[0].id);
			}
			if (state.status === "completed") {
				setFeedback(productUi.settings.oauthConnected);
				await store.provider.list();
			}
			if (state.status === "failed") setError(state.message ?? productUi.settings.oauthFailed);
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	}

	async function answerOauth(): Promise<void> {
		setSaving(true);
		try {
			await store.provider.loginAnswer(providerId(), oauthAnswer());
			setOauthAnswer("");
			setSaving(false);
			await beginOauth();
		} catch (cause) {
			setError(messageOf(cause));
			setSaving(false);
		}
	}

	async function save(patch: SettingsPatch, success: string): Promise<void> {
		setSaving(true);
		setError(null);
		setFeedback(null);
		try {
			await store.settings.set(patch);
			setFeedback(success);
		} catch (e) {
			setError(messageOf(e));
		} finally {
			setSaving(false);
		}
	}

	const disabled = () => saving() || loading();
	const enableFallback = (key: "textFallback" | "multimodalFallback", imagesOnly: boolean) => {
		const compatible = (candidate: ReturnType<typeof modelRoutes>[number]) =>
			!imagesOnly || candidate.model.supportsImages;
		const route =
			modelRoutes().find(
				(candidate) => candidate.provider.id === providerId() && compatible(candidate),
			) ?? modelRoutes().find(compatible);
		if (route) void setFallback(key, route.value);
	};
	const changeFallbackProvider = (
		key: "textFallback" | "multimodalFallback",
		provider: string,
		imagesOnly: boolean,
	) => {
		const selected = providers().find((candidate) => candidate.id === provider);
		const model = selected?.availableModels.find(
			(candidate) => !imagesOnly || candidate.supportsImages,
		);
		if (model)
			void save(
				{ [key]: { providerId: provider, modelId: model.id } },
				productUi.settings.modelSaved,
			);
	};
	const saveFallbackKey = async (provider: string, key: string, clear: () => void) => {
		setSaving(true);
		setError(null);
		try {
			await store.provider.setApiKey(provider, key);
			clear();
			setFeedback(productUi.settings.keySaved);
			await store.provider.list();
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	};
	const saveProviderOverride = async (provider: string, baseUrl: string, clear: () => void) => {
		setSaving(true);
		setError(null);
		try {
			await store.provider.overrideBaseUrl({
				providerId: provider,
				baseUrl,
			});
			clear();
			setFeedback(productUi.settings.customSaved);
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div class="sheet-panel">
			<p class="drawer-note">{productUi.settings.note}</p>
			<Show when={loading()}>
				<p class="empty-note">{productUi.settings.loading}</p>
			</Show>
			<Show when={feedback()}>
				<p class="status-line ok" role="status">
					{feedback()}
				</p>
			</Show>
			<Show when={error()}>
				<p class="status-line err" role="alert">
					{error()}
				</p>
			</Show>

			<div class="field">
				<div class="switch-field">
					<div class="switch-text">
						<span class="field-label">{productUi.settings.relationshipMemory}</span>
						<p class="field-hint">{productUi.settings.relationshipMemoryHint}</p>
					</div>
					<button
						type="button"
						class="switch-control"
						role="switch"
						aria-label={productUi.settings.relationshipMemory}
						aria-checked={settings().relationshipMemoryEnabled}
						data-checked={settings().relationshipMemoryEnabled || undefined}
						disabled={disabled()}
						onClick={() => {
							const enabled = !settings().relationshipMemoryEnabled;
							void save(
								{ relationshipMemoryEnabled: enabled },
								enabled
									? productUi.settings.relationshipMemoryEnabled
									: productUi.settings.relationshipMemoryDisabled,
							);
						}}
					>
						<span class="switch-thumb" />
					</button>
				</div>
			</div>

			<section class="model-settings">
				<div class="switch-text">
					<span class="field-label">{productUi.settings.modelService}</span>
					<p class="field-hint">{productUi.settings.modelServiceHint}</p>
				</div>
				<h3 class="model-section-title">{productUi.settings.primaryModelSection}</h3>
				<label class="field">
					<span class="field-label">{productUi.settings.serviceLabel}</span>
					<select
						aria-label={productUi.settings.serviceLabel}
						value={providerId()}
						onChange={(event) => {
							setProviderId(event.currentTarget.value);
							const provider = providers().find((item) => item.id === event.currentTarget.value);
							setModelId(provider?.availableModels[0]?.id ?? "");
						}}
					>
						<For each={providers()}>
							{(provider) => <option value={provider.id}>{provider.name}</option>}
						</For>
					</select>
					<span
						class="provider-status"
						data-connected={selectedProvider()?.credentialStatus !== "missing"}
					>
						{selectedProvider()?.credentialStatus === "stored" ||
						selectedProvider()?.credentialStatus === "session_only"
							? productUi.settings.connected
							: productUi.settings.missingCredential}
					</span>
				</label>
				<Show
					when={selectedProvider()?.authType === "api_key"}
					fallback={
						<div class="oauth-login">
							<button
								type="button"
								disabled={saving() || !providerId()}
								onClick={() => void beginOauth()}
							>
								{productUi.settings.loginWithBrowser}
							</button>
							<Show when={oauth()}>
								{(state) => (
									<div class="field-hint">
										<Show when={state().authUrl ?? state().verificationUri}>
											{(url) => (
												<a href={url()} target="_blank" rel="noreferrer">
													{productUi.settings.oauthOpen}
												</a>
											)}
										</Show>
										<Show when={state().deviceCode}>
											<p>
												{productUi.settings.oauthCode}: <strong>{state().deviceCode}</strong>
											</p>
										</Show>
										<Show when={state().status === "running"}>
											<p>{state().message ?? productUi.settings.oauthWaiting}</p>
										</Show>
										<Show when={state().prompt}>
											{(prompt) => (
												<label class="field">
													<span class="field-label">{prompt().message}</span>
													<Show
														when={prompt().type === "select"}
														fallback={
															<input
																type={prompt().type === "secret" ? "password" : "text"}
																value={oauthAnswer()}
																onInput={(event) => setOauthAnswer(event.currentTarget.value)}
															/>
														}
													>
														<select
															value={oauthAnswer()}
															onChange={(event) => setOauthAnswer(event.currentTarget.value)}
														>
															<For each={prompt().options ?? []}>
																{(option) => <option value={option.id}>{option.label}</option>}
															</For>
														</select>
													</Show>
													<button
														type="button"
														disabled={!oauthAnswer()}
														onClick={() => void answerOauth()}
													>
														{productUi.settings.oauthSubmit}
													</button>
												</label>
											)}
										</Show>
									</div>
								)}
							</Show>
						</div>
					}
				>
					<label class="field">
						<span class="field-label">{productUi.settings.apiKeyLabel}</span>
						<input
							type="password"
							autocomplete="off"
							placeholder={apiKeyPlaceholder(providerId())}
							value={apiKey()}
							onInput={(event) => setApiKey(event.currentTarget.value)}
						/>
						<button
							type="button"
							aria-label={`${productUi.settings.saveKey} ${productUi.settings.apiKeyLabel}`}
							disabled={saving() || !providerId() || !apiKey()}
							onClick={() => {
								setSaving(true);
								setError(null);
								void store.provider
									.setApiKey(providerId(), apiKey())
									.then(() => {
										setApiKey("");
										setFeedback(productUi.settings.keySaved);
									})
									.catch((cause) => setError(messageOf(cause)))
									.finally(() => setSaving(false));
							}}
						>
							{productUi.settings.saveKey}
						</button>
					</label>
				</Show>
				<label class="field">
					<span class="field-label">{productUi.settings.modelLabel}</span>
					<select value={modelId()} onChange={(event) => setModelId(event.currentTarget.value)}>
						<For each={selectedProvider()?.availableModels ?? []}>
							{(model) => <option value={model.id}>{model.name}</option>}
						</For>
					</select>
				</label>
				<button
					class="primary-action use-model-button"
					type="button"
					disabled={saving() || !providerId() || !modelId()}
					onClick={() => {
						setSaving(true);
						setError(null);
						void store.voice
							.pin(providerId(), modelId(), selectedProvider()?.name)
							.then(() => setFeedback(productUi.settings.modelSaved))
							.catch((cause) => setError(messageOf(cause)))
							.finally(() => setSaving(false));
					}}
				>
					{productUi.settings.useModel}
				</button>
				<h3 class="model-section-title fallback-section-title">
					{productUi.settings.fallbackModelSection}
				</h3>
				<div class="fallback-route">
					<div class="switch-field">
						<span class="field-label">{productUi.settings.textFallbackLabel}</span>
						<button
							type="button"
							class="switch-control"
							role="switch"
							aria-label={productUi.settings.textFallbackEnable}
							aria-checked={settings().textFallback !== undefined}
							data-checked={settings().textFallback ? "" : undefined}
							onClick={() =>
								settings().textFallback
									? void save({ textFallback: null }, productUi.settings.modelSaved)
									: enableFallback("textFallback", false)
							}
						>
							<span class="switch-thumb" />
						</button>
					</div>
					<Show when={settings().textFallback}>
						{(route) => (
							<div class="fallback-route-fields">
								<label class="field">
									<span class="field-label">{productUi.settings.textFallbackProvider}</span>
									<select
										aria-label={productUi.settings.textFallbackProvider}
										value={route().providerId}
										onChange={(event) =>
											changeFallbackProvider("textFallback", event.currentTarget.value, false)
										}
									>
										<For each={providers()}>
											{(provider) => <option value={provider.id}>{provider.name}</option>}
										</For>
									</select>
								</label>
								<label class="field">
									<span class="field-label">{productUi.settings.textFallbackApiKey}</span>
									<input
										aria-label={productUi.settings.textFallbackApiKey}
										type="password"
										autocomplete="off"
										placeholder={apiKeyPlaceholder(route().providerId)}
										value={textFallbackApiKey()}
										onInput={(event) => setTextFallbackApiKey(event.currentTarget.value)}
									/>
									<button
										type="button"
										aria-label={`${productUi.settings.saveKey} ${productUi.settings.textFallbackApiKey}`}
										disabled={!textFallbackApiKey()}
										onClick={() =>
											void saveFallbackKey(route().providerId, textFallbackApiKey(), () =>
												setTextFallbackApiKey(""),
											)
										}
									>
										{productUi.settings.saveKey}
									</button>
								</label>
								<label class="field">
									<span class="field-label">{productUi.settings.textFallbackLabel}</span>
									<select
										value={routeValue(route())}
										onChange={(event) =>
											void setFallback("textFallback", event.currentTarget.value)
										}
									>
										<For
											each={modelRoutes().filter(
												(candidate) => candidate.provider.id === route().providerId,
											)}
										>
											{(candidate) => (
												<option value={candidate.value}>{candidate.model.name}</option>
											)}
										</For>
									</select>
								</label>
								<button
									class="inline-disclosure"
									type="button"
									aria-expanded={fallbackCustomKind() === "text"}
									onClick={() =>
										setFallbackCustomKind((current) => (current === "text" ? null : "text"))
									}
								>
									{productUi.settings.textFallbackCustomToggle}
								</button>
								<Show when={fallbackCustomKind() === "text"}>
									<div class="inline-custom-provider">
										<label class="field">
											<span class="field-label">{productUi.settings.textFallbackCustomUrl}</span>
											<input
												aria-label={productUi.settings.textFallbackCustomUrl}
												placeholder={productUi.settings.customBaseUrlPlaceholder}
												value={fallbackCustomUrl()}
												onInput={(event) => setFallbackCustomUrl(event.currentTarget.value)}
											/>
										</label>
										<button
											class="secondary-action"
											type="button"
											disabled={saving() || !fallbackCustomUrl()}
											onClick={() =>
												void saveProviderOverride(route().providerId, fallbackCustomUrl(), () => {
													setFallbackCustomKind(null);
												})
											}
										>
											{productUi.settings.customSave}
										</button>
									</div>
								</Show>
							</div>
						)}
					</Show>
				</div>
				<div class="fallback-route">
					<div class="switch-field">
						<span class="field-label">{productUi.settings.multimodalFallbackLabel}</span>
						<button
							type="button"
							class="switch-control"
							role="switch"
							aria-label={productUi.settings.multimodalFallbackEnable}
							aria-checked={settings().multimodalFallback !== undefined}
							data-checked={settings().multimodalFallback ? "" : undefined}
							onClick={() =>
								settings().multimodalFallback
									? void save({ multimodalFallback: null }, productUi.settings.modelSaved)
									: enableFallback("multimodalFallback", true)
							}
						>
							<span class="switch-thumb" />
						</button>
					</div>
					<Show when={settings().multimodalFallback}>
						{(route) => (
							<div class="fallback-route-fields">
								<label class="field">
									<span class="field-label">{productUi.settings.multimodalFallbackProvider}</span>
									<select
										aria-label={productUi.settings.multimodalFallbackProvider}
										value={route().providerId}
										onChange={(event) =>
											changeFallbackProvider("multimodalFallback", event.currentTarget.value, true)
										}
									>
										<For
											each={providers().filter((provider) =>
												provider.availableModels.some((model) => model.supportsImages),
											)}
										>
											{(provider) => <option value={provider.id}>{provider.name}</option>}
										</For>
									</select>
								</label>
								<label class="field">
									<span class="field-label">{productUi.settings.multimodalFallbackApiKey}</span>
									<input
										aria-label={productUi.settings.multimodalFallbackApiKey}
										type="password"
										autocomplete="off"
										placeholder={apiKeyPlaceholder(route().providerId)}
										value={multimodalFallbackApiKey()}
										onInput={(event) => setMultimodalFallbackApiKey(event.currentTarget.value)}
									/>
									<button
										type="button"
										aria-label={`${productUi.settings.saveKey} ${productUi.settings.multimodalFallbackApiKey}`}
										disabled={!multimodalFallbackApiKey()}
										onClick={() =>
											void saveFallbackKey(route().providerId, multimodalFallbackApiKey(), () =>
												setMultimodalFallbackApiKey(""),
											)
										}
									>
										{productUi.settings.saveKey}
									</button>
								</label>
								<label class="field">
									<span class="field-label">{productUi.settings.multimodalFallbackLabel}</span>
									<select
										value={routeValue(route())}
										onChange={(event) =>
											void setFallback("multimodalFallback", event.currentTarget.value)
										}
									>
										<For
											each={modelRoutes().filter(
												(candidate) =>
													candidate.provider.id === route().providerId &&
													candidate.model.supportsImages,
											)}
										>
											{(candidate) => (
												<option value={candidate.value}>{candidate.model.name}</option>
											)}
										</For>
									</select>
								</label>
								<button
									class="inline-disclosure"
									type="button"
									aria-expanded={fallbackCustomKind() === "multimodal"}
									onClick={() =>
										setFallbackCustomKind((current) =>
											current === "multimodal" ? null : "multimodal",
										)
									}
								>
									{productUi.settings.multimodalFallbackCustomToggle}
								</button>
								<Show when={fallbackCustomKind() === "multimodal"}>
									<div class="inline-custom-provider">
										<label class="field">
											<span class="field-label">
												{productUi.settings.multimodalFallbackCustomUrl}
											</span>
											<input
												aria-label={productUi.settings.multimodalFallbackCustomUrl}
												placeholder={productUi.settings.customBaseUrlPlaceholder}
												value={fallbackCustomUrl()}
												onInput={(event) => setFallbackCustomUrl(event.currentTarget.value)}
											/>
										</label>
										<button
											class="secondary-action"
											type="button"
											disabled={saving() || !fallbackCustomUrl()}
											onClick={() =>
												void saveProviderOverride(route().providerId, fallbackCustomUrl(), () => {
													setFallbackCustomKind(null);
												})
											}
										>
											{productUi.settings.customSave}
										</button>
									</div>
								</Show>
							</div>
						)}
					</Show>
				</div>
				<button
					class="advanced-toggle"
					type="button"
					aria-expanded={advancedOpen()}
					onClick={() => setAdvancedOpen((open) => !open)}
				>
					{productUi.settings.advancedToggle}
				</button>
				<Show when={advancedOpen()}>
					<div class="advanced-model-settings">
						<label class="field">
							<span class="field-label">{productUi.settings.customBaseUrl}</span>
							<input
								placeholder={productUi.settings.customBaseUrlPlaceholder}
								value={customBaseUrl()}
								onInput={(event) => setCustomBaseUrl(event.currentTarget.value)}
							/>
						</label>
						<button
							class="primary-action use-model-button"
							type="button"
							disabled={saving() || !providerId() || !customBaseUrl()}
							onClick={() => {
								void saveProviderOverride(providerId(), customBaseUrl(), () => undefined);
							}}
						>
							{productUi.settings.customSave}
						</button>
					</div>
				</Show>
			</section>
		</div>
	);
}
