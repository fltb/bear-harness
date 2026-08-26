import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Root as Link } from "@kobalte/core/link";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useCompanionStore } from "../stores/companion.js";
import type { ProviderInfo, ProviderLoginResult } from "../stores/ipc.js";

type PresentationProps = {
	class?: string;
	/** Outer selection (onboarding Pattern 04 tiles) drives this shared surface. */
	focusedProviderId?: string;
	/** Notify the outer stage about internal selection changes so its tiles stay in sync. */
	onProviderFocus?: (providerId: string) => void;
	/** "stack" = single-column onboarding surface; "manager" = Pattern 01 two-column settings. */
	layout?: "stack" | "manager";
};

function credentialed(provider: ProviderInfo): boolean {
	return ["stored", "session_only", "weak_storage", "refreshing"].includes(
		provider.credentialStatus,
	);
}

function supportsAuth(provider: ProviderInfo, type: "api_key" | "oauth"): boolean {
	return provider.authMethods.some((method) => method.type === type);
}

function oauthMethod(provider: ProviderInfo) {
	return provider.authMethods.find((method) => method.type === "oauth");
}

function safeHttpsUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One provider setup flow shared by first-run and system settings.
 * Provider catalogs, credentials, and configured models all come from Host;
 * only form drafts and the currently expanded card live here.
 */
export function ProviderSetup(props: PresentationProps) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const managerLayout =
		props.layout === "manager" ||
		props.class?.split(/\s+/u).includes("system-provider-setup") === true;
	const onboardingLayout =
		props.class?.split(/\s+/u).includes("first-meeting-provider-setup") === true;
	const [expandedProvider, setExpandedProvider] = createSignal("");
	const [providerId, setProviderId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const [customBaseUrl, setCustomBaseUrl] = createSignal("");
	const [piConfigJson, setPiConfigJson] = createSignal("");
	const [oauth, setOauth] = createSignal<ProviderLoginResult | null>(null);
	const [oauthProviderId, setOauthProviderId] = createSignal("");
	const [oauthAnswer, setOauthAnswer] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [customName, setCustomName] = createSignal("");
	const [customId, setCustomId] = createSignal("");
	const [customUrl, setCustomUrl] = createSignal("");
	const [customModels, setCustomModels] = createSignal("");
	const [customKey, setCustomKey] = createSignal("");
	const [customBusy, setCustomBusy] = createSignal(false);
	const [customError, setCustomError] = createSignal<string | null>(null);
	const [piOpen, setPiOpen] = createSignal(false);
	let disposed = false;
	let lastFocusedProvider = "";

	onCleanup(() => {
		disposed = true;
	});

	let openedOauthUrl = "";
	createEffect(() => {
		const url = safeHttpsUrl(oauth()?.authUrl);
		if (
			!url ||
			openedOauthUrl === url ||
			!("bearDesktop" in (window as Window & { bearDesktop?: unknown }))
		)
			return;
		openedOauthUrl = url;
		const popup = window.open(url, "_blank", "noopener,noreferrer");
		if (popup) popup.opener = null;
	});

	const providerItems = createMemo(() => store.provider.providers());
	const candidates = createMemo(() =>
		providerItems().filter((provider) => provider.source === "builtin" && !provider.added),
	);
	const added = createMemo(() => providerItems().filter((provider) => provider.added));
	const selected = createMemo(() =>
		providerItems().find((provider) => provider.id === providerId()),
	);

	const refresh = async (): Promise<void> => {
		await Promise.all([store.provider.list(), store.model.list()]);
	};
	onMount(() => {
		void refresh().catch((cause) => {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		});
	});

	const selectProvider = (id: string): void => {
		const provider = providerItems().find((item) => item.id === id);
		setProviderId(id);
		setCustomBaseUrl(provider?.baseUrl ?? "");
		setOauth(null);
		setOauthProviderId("");
		setOauthAnswer("");
		setError(null);
		if (managerLayout) setExpandedProvider("");
		props.onProviderFocus?.(id);
	};

	// Outer tile stage drives the shared editor; only react when the focused id actually changes
	// so manual dropdown picks are never clobbered by a re-run.
	createEffect(() => {
		const focused = props.focusedProviderId;
		if (focused && focused !== lastFocusedProvider) {
			lastFocusedProvider = focused;
			selectProvider(focused);
		}
	});

	const run = async (action: () => Promise<void>): Promise<void> => {
		if (busy() || disposed) return;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!disposed) setBusy(false);
		}
	};

	const runOauthRequest = async (
		action: () => Promise<ProviderLoginResult>,
	): Promise<ProviderLoginResult | null> => {
		if (busy() || disposed) return null;
		setBusy(true);
		setError(null);
		try {
			return await action();
		} catch (cause) {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
			return null;
		} finally {
			if (!disposed) setBusy(false);
		}
	};

	const saveApiKey = async (): Promise<void> => {
		if (!providerId() || !apiKey().trim()) return;
		await run(async () => {
			await store.provider.setApiKey(providerId(), apiKey().trim());
			setApiKey("");
			await refresh();
		});
	};

	const saveBaseUrl = async (): Promise<void> => {
		if (!providerId() || !customBaseUrl().trim()) return;
		await run(async () => {
			const baseUrl = customBaseUrl().trim();
			await store.provider.overrideBaseUrl({ providerId: providerId(), baseUrl });
			setCustomBaseUrl(baseUrl);
			await store.provider.list();
		});
	};

	const addProvider = async (): Promise<void> => {
		if (!providerId() || !apiKey().trim()) return;
		await run(async () => {
			await store.provider.setApiKey(providerId(), apiKey().trim());
			setApiKey("");
			if (customBaseUrl().trim()) {
				await store.provider.overrideBaseUrl({
					providerId: providerId(),
					baseUrl: customBaseUrl().trim(),
				});
			}
			await refresh();
		});
	};

	const removeProvider = async (provider: ProviderInfo): Promise<void> => {
		await run(async () => {
			await store.provider.remove(provider.id);
			if (providerId() === provider.id) {
				setProviderId("");
				setOauth(null);
				setOauthProviderId("");
				setOauthAnswer("");
			}
			await refresh();
		});
	};

	let oauthCancelled = false;
	const pollOauth = async (flowProviderId: string, initial: ProviderLoginResult): Promise<void> => {
		oauthCancelled = false;
		let state = initial;
		if (disposed) return;
		setOauth(state);
		while (
			!disposed &&
			!oauthCancelled &&
			(state.status === "running" || state.status === "waiting_input")
		) {
			await new Promise<void>((resolve) => setTimeout(resolve, 750));
			if (disposed || oauthCancelled) return;
			try {
				state = await store.provider.loginStatus(flowProviderId);
			} catch (cause) {
				// Cancellation deletes the host session; a racing poll is not an error.
				if (disposed || oauthCancelled) return;
				if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
				return;
			}
			if (disposed || oauthCancelled) return;
			setOauth(state);
		}
		if (disposed || oauthCancelled) return;
		if (state.status === "completed") await refresh();
		if (state.status === "failed") setError(state.message ?? t("settings.oauthFailed"));
	};

	const beginOauth = async (flowProviderId: string): Promise<void> => {
		if (!flowProviderId) return;
		setOauthProviderId(flowProviderId);
		const initial = await runOauthRequest(() => store.provider.login(flowProviderId));
		if (initial) await pollOauth(flowProviderId, initial);
	};

	const answerOauth = async (): Promise<void> => {
		const answer = oauthAnswer();
		const flowProviderId = oauthProviderId() || providerId();
		if (!flowProviderId || !answer) return;
		setOauthAnswer("");
		const state = await runOauthRequest(() => store.provider.loginAnswer(flowProviderId, answer));
		if (state && !disposed && !oauthCancelled) setOauth(state);
	};

	const cancelOauth = async (): Promise<void> => {
		const flowProviderId = oauthProviderId() || providerId();
		if (!flowProviderId || disposed) return;
		oauthCancelled = true;
		try {
			await store.provider.loginCancel(flowProviderId);
		} catch (cause) {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		}
		if (disposed) return;
		setOauth(null);
		setOauthProviderId("");
		setOauthAnswer("");
	};

	const importPiConfig = async (): Promise<void> => {
		if (!piConfigJson().trim()) return;
		await run(async () => {
			await store.provider.importPiConfig(piConfigJson().trim());
			setPiConfigJson("");
			await refresh();
		});
	};

	const submitCustom = async (): Promise<void> => {
		const modelRows = customModels()
			.split(/[\n,]+/u)
			.map((id) => id.trim())
			.filter(Boolean)
			.map((id) => ({ id }));
		if (!customId().trim() || !customName().trim() || !customUrl().trim() || modelRows.length === 0)
			return;
		setCustomBusy(true);
		setCustomError(null);
		try {
			await store.provider.customUpsert({
				providerId: customId().trim(),
				name: customName().trim(),
				baseUrl: customUrl().trim(),
				models: modelRows,
				...(customKey().trim() ? { apiKey: customKey().trim() } : {}),
			});
			setCustomName("");
			setCustomId("");
			setCustomUrl("");
			setCustomModels("");
			setCustomKey("");
			await refresh();
		} catch (cause) {
			if (!disposed) setCustomError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!disposed) setCustomBusy(false);
		}
	};

	const renderProviderEditor = (provider: ProviderInfo, isNew: boolean) => (
		<div class="provider-setup-editor" data-provider-editor={provider.id}>
			<Show when={supportsAuth(provider, "oauth")}>
				<div class="oauth-login">
					<Show
						when={oauth()}
						fallback={
							<Button
								type="button"
								data-variant="secondary"
								disabled={busy()}
								onClick={() => void beginOauth(provider.id)}
							>
								{t("settings.loginWithBrowser")}
							</Button>
						}
					>
						{(state) => (
							<div class="oauth-login" aria-live="polite">
								<Show when={safeHttpsUrl(state().authUrl ?? state().verificationUri)}>
									{(url) => (
										<Link href={url()} target="_blank" rel="noreferrer">
											{t("settings.oauthOpen")}
										</Link>
									)}
								</Show>
								<Show when={state().deviceCode}>
									<p>
										{t("settings.oauthCode")}: <strong>{state().deviceCode}</strong>
									</p>
								</Show>
								<Show when={state().instructions}>
									<p class="field-hint">{state().instructions}</p>
								</Show>
								<Show when={state().message && state().status !== "failed"}>
									<p>{state().message}</p>
								</Show>
								<Show when={state().infoLinks?.length}>
									<ul class="oauth-info-links">
										<For each={state().infoLinks}>
											{(link) => (
												<li>
													<Link href={link.url} target="_blank" rel="noreferrer">
														{link.label ?? link.url}
													</Link>
												</li>
											)}
										</For>
									</ul>
								</Show>
								<Show when={state().prompt}>
									{(prompt) => (
										<TextField class="field">
											<TextField.Label class="field-label">{prompt().message}</TextField.Label>
											<Show
												when={prompt().type === "select"}
												fallback={
													<TextField.Input
														type={prompt().type === "secret" ? "password" : "text"}
														placeholder={prompt().placeholder}
														value={oauthAnswer()}
														onInput={(event) => setOauthAnswer(event.currentTarget.value)}
													/>
												}
											>
												<Select
													options={prompt().options ?? []}
													value={
														prompt().options?.find((option) => option.id === oauthAnswer()) ?? null
													}
													optionValue="id"
													optionTextValue="label"
													onChange={(option) => setOauthAnswer(option?.id ?? "")}
													itemComponent={(itemProps) => (
														<Select.Item item={itemProps.item} class="select-item">
															<Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
														</Select.Item>
													)}
												>
													<Select.Trigger class="select-trigger" aria-label={prompt().message}>
														<Select.Value class="select-value" />
													</Select.Trigger>
													<Select.Portal>
														<Select.Content class="select-content">
															<Select.Listbox class="select-listbox" />
														</Select.Content>
													</Select.Portal>
												</Select>
											</Show>
											<Button
												type="button"
												data-variant="secondary"
												disabled={busy() || !oauthAnswer()}
												onClick={() => void answerOauth()}
											>
												{t("settings.oauthSubmit")}
											</Button>
										</TextField>
									)}
								</Show>
								<Show when={state().status === "running" || state().status === "waiting_input"}>
									<Button type="button" data-variant="secondary" onClick={() => void cancelOauth()}>
										{t("settings.oauthCancel")}
									</Button>
								</Show>
							</div>
						)}
					</Show>
				</div>
			</Show>
			<Show when={supportsAuth(provider, "api_key")}>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.apiKeyLabel")}</TextField.Label>
					<TextField.Input
						type="password"
						autocomplete="off"
						placeholder={credentialed(provider) ? t("settings.apiKeyStoredPlaceholder") : undefined}
						value={apiKey()}
						onInput={(event) => setApiKey(event.currentTarget.value)}
					/>
					<Button
						type="button"
						data-variant={isNew ? "primary" : "secondary"}
						disabled={busy() || !apiKey().trim()}
						onClick={() => void (isNew ? addProvider() : saveApiKey())}
					>
						{isNew ? t("settings.addProvider") : t("settings.saveKey")}
					</Button>
				</TextField>
			</Show>
			<Show when={supportsAuth(provider, "api_key")}>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.customBaseUrl")}</TextField.Label>
					<TextField.Input
						value={customBaseUrl()}
						placeholder={t("settings.customBaseUrlPlaceholder")}
						onInput={(event) => setCustomBaseUrl(event.currentTarget.value)}
					/>
					<Show when={!isNew}>
						<Button
							type="button"
							data-variant="secondary"
							disabled={busy() || !customBaseUrl().trim()}
							onClick={() => void saveBaseUrl()}
						>
							{t("settings.customSave")}
						</Button>
					</Show>
				</TextField>
			</Show>
			<Show when={credentialed(provider)}>
				<p class="provider-status" data-connected="true">
					{t("settings.connected")}
				</p>
			</Show>
		</div>
	);
	const renderCandidateSection = (embeddedEditor: boolean) => (
		<div class="provider-candidate-section">
			<div class="settings-group-heading">
				<h4>{t("settings.addProvider")}</h4>
				<p class="field-hint">{t("settings.addProviderHint")}</p>
			</div>
			<Show when={error()}>
				{(message) => (
					<p class="status-line err" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<Show
				when={candidates().length > 0}
				fallback={<p class="field-hint">{t("settings.noProviderCandidates")}</p>}
			>
				<Show
					when={onboardingLayout}
					fallback={
						<div class="provider-selector">
							<Select<ProviderInfo>
								options={candidates()}
								value={
									selected() && candidates().some((item) => item.id === selected()?.id)
										? selected()
										: null
								}
								optionValue="id"
								optionTextValue="name"
								placeholder={t("settings.chooseProvider")}
								onChange={(provider) => selectProvider(provider?.id ?? "")}
								disabled={busy()}
								itemComponent={(itemProps) => (
									<Select.Item item={itemProps.item} class="select-item">
										<Select.ItemLabel>{itemProps.item.rawValue.name}</Select.ItemLabel>
									</Select.Item>
								)}
								class="field"
							>
								<Select.Label class="field-label">{t("settings.providerLabel")}</Select.Label>
								<Select.Trigger class="select-trigger" aria-label={t("settings.providerLabel")}>
									<Select.Value<ProviderInfo> class="select-value" />
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
						</div>
					}
				>
					<section class="intro-provider-tiles" aria-label={t("settings.providerLabel")}>
						<For each={candidates()}>
							{(provider) => (
								<Button
									type="button"
									class="intro-provider-tile"
									data-provider-tile={provider.id}
									data-selected={providerId() === provider.id ? "" : undefined}
									aria-pressed={providerId() === provider.id}
									disabled={busy()}
									onClick={() => selectProvider(provider.id)}
								>
									<strong>{provider.name}</strong>
									<span>{provider.id}</span>
								</Button>
							)}
						</For>
					</section>
				</Show>
			</Show>
			<Show when={embeddedEditor && selected() && !selected()!.added}>
				{renderProviderEditor(selected()!, true)}
			</Show>
		</div>
	);

	const renderProviderCards = (inlineEditors: boolean) => (
		<For each={added()}>
			{(provider) => (
				<article
					class="provider-card"
					data-selected={!inlineEditors && expandedProvider() === provider.id ? "" : undefined}
				>
					<div class="provider-card-heading">
						<strong>{provider.name}</strong>
						<span class="field-hint">
							{provider.source === "custom"
								? t("settings.customProvider")
								: t("settings.builtinProvider")}
						</span>
					</div>
					<Show when={credentialed(provider)}>
						<span class="provider-status" data-connected="true">
							{t("settings.connected")}
						</span>
					</Show>
					<div class="provider-card-actions">
						<Show when={supportsAuth(provider, "api_key")}>
							<Button
								type="button"
								data-variant="secondary"
								disabled={busy()}
								onClick={() => {
									selectProvider(provider.id);
									setExpandedProvider(provider.id);
								}}
							>
								{t("settings.editProviderKey")}
							</Button>
							<Button
								type="button"
								data-variant="secondary"
								disabled={busy()}
								onClick={() => {
									selectProvider(provider.id);
									setExpandedProvider(provider.id);
								}}
							>
								{t("settings.editProviderUrl")}
							</Button>
						</Show>
						<Show when={supportsAuth(provider, "oauth")}>
							<Button
								type="button"
								data-variant="secondary"
								disabled={busy()}
								onClick={() => {
									selectProvider(provider.id);
									setExpandedProvider(provider.id);
									void beginOauth(provider.id);
								}}
							>
								{oauthMethod(provider)?.loginLabel ?? t("settings.reauthProvider")}
							</Button>
						</Show>
						<Button
							type="button"
							data-variant="danger"
							disabled={busy()}
							onClick={() => void removeProvider(provider)}
						>
							{t("settings.deleteProvider")}
						</Button>
					</div>
					<Show when={inlineEditors && expandedProvider() === provider.id}>
						{renderProviderEditor(provider, false)}
					</Show>
				</article>
			)}
		</For>
	);

	const renderImports = () => (
		<>
			<details
				open={piOpen()}
				onToggle={(event) => setPiOpen(event.currentTarget.open)}
				class="provider-import provider-import-pi"
			>
				<summary>{t("settings.piConfigLabel")}</summary>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.piConfigLabel")}</TextField.Label>
					<span class="field-hint">{t("settings.piConfigHint")}</span>
					<TextField.TextArea
						rows={7}
						value={piConfigJson()}
						aria-label={t("settings.piConfigLabel")}
						placeholder={t("settings.piConfigPlaceholder")}
						onInput={(event) => setPiConfigJson(event.currentTarget.value)}
					/>
				</TextField>
				<Button
					type="button"
					data-variant="secondary"
					disabled={busy() || !piConfigJson().trim()}
					onClick={() => void importPiConfig()}
				>
					{t("settings.piConfigImport")}
				</Button>
			</details>
			<details class="provider-import provider-import-custom">
				<summary>{t("settings.customProvider")}</summary>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.customProviderId")}</TextField.Label>
					<TextField.Input
						value={customId()}
						onInput={(event) => setCustomId(event.currentTarget.value)}
					/>
				</TextField>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.customServiceName")}</TextField.Label>
					<TextField.Input
						value={customName()}
						onInput={(event) => setCustomName(event.currentTarget.value)}
					/>
				</TextField>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.customBaseUrl")}</TextField.Label>
					<TextField.Input
						value={customUrl()}
						placeholder={t("settings.customBaseUrlPlaceholder")}
						onInput={(event) => setCustomUrl(event.currentTarget.value)}
					/>
				</TextField>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.customModels")}</TextField.Label>
					<TextField.TextArea
						rows={4}
						value={customModels()}
						placeholder={t("settings.customModelsPlaceholder")}
						onInput={(event) => setCustomModels(event.currentTarget.value)}
					/>
				</TextField>
				<TextField class="field">
					<TextField.Label class="field-label">{t("settings.apiKeyLabel")}</TextField.Label>
					<TextField.Input
						type="password"
						autocomplete="off"
						value={customKey()}
						onInput={(event) => setCustomKey(event.currentTarget.value)}
					/>
				</TextField>
				<Button
					type="button"
					data-variant="secondary"
					disabled={
						customBusy() ||
						!customId().trim() ||
						!customName().trim() ||
						!customUrl().trim() ||
						!customModels().trim()
					}
					onClick={() => void submitCustom()}
				>
					{t("settings.addProvider")}
				</Button>
				<Show when={customError()}>
					{(message) => (
						<p class="status-line err" role="alert">
							{message()}
						</p>
					)}
				</Show>
			</details>
		</>
	);

	return (
		<section
			class={`provider-setup ${managerLayout ? "provider-setup-manager" : ""} ${props.class ?? ""}`}
			aria-label={t("settings.providerSetupLabel")}
		>
			<Show
				when={managerLayout}
				fallback={
					<>
						{renderCandidateSection(true)}
						<section class="provider-card-list" aria-label={t("settings.addedProviders")}>
							{renderProviderCards(true)}
						</section>
						{renderImports()}
					</>
				}
			>
				<div class="provider-connections">
					{renderCandidateSection(false)}
					<div class="settings-group-heading">
						<h4>{t("settings.addedProviders")}</h4>
					</div>
					<section class="provider-card-list" aria-label={t("settings.addedProviders")}>
						{renderProviderCards(false)}
					</section>
				</div>
				<div class="provider-editor-pane">
					<Show when={selected() && !selected()!.added}>
						{renderProviderEditor(selected()!, true)}
					</Show>
					<Show when={added().find((provider) => provider.id === expandedProvider())}>
						{(provider) => renderProviderEditor(provider(), false)}
					</Show>
					{renderImports()}
				</div>
			</Show>
		</section>
	);
}
