import { i18n, useTranslation } from "@bear-harness/i18n";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { markSelectPortalTopLayer } from "../lib/select-portal.js";
import { createStableSnapshot } from "../lib/stable-snapshot.js";
import { useCompanionStore } from "../stores/companion.js";
import type { ProviderInfo, ProviderLoginResult } from "../stores/ipc.js";
import { Button, Link, Select, TextField } from "../ui/primitives.js";

type PresentationProps = {
	class?: string;

	/** "stack" = single-column onboarding surface; "manager" = Pattern 01 two-column settings. */
	layout?: "stack" | "manager";
	surface?: "all" | "list" | "add";
	onAdded?: () => void;
};

export function ProviderList() {
	return <ProviderSetup surface="list" class="system-provider-list" />;
}

export function AddProviderForm(props: { onAdded?: () => void }) {
	return <ProviderSetup surface="add" class="system-provider-add" onAdded={props.onAdded} />;
}

type OAuthEvent = ProviderLoginResult["events"][number];

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
		return url.protocol === "https:" ? value : undefined;
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
	const [oauthProviderId, setOauthProviderId] = createSignal("");
	const oauth = () =>
		oauthProviderId() ? (store.provider.loginState(oauthProviderId()) ?? null) : null;
	const oauthEvents = () => oauth()?.events ?? [];
	const latestOAuthEvent = <T extends OAuthEvent["type"]>(type: T) => {
		const events = oauthEvents();
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index];
			if (event?.type === type) return event as Extract<OAuthEvent, { type: T }>;
		}
	};
	const authUrlEvent = () => latestOAuthEvent("auth_url");
	const deviceCodeEvent = () => latestOAuthEvent("device_code");
	const oauthInfoEvent = () => latestOAuthEvent("info");
	const oauthMessageEvent = () => {
		const events = oauthEvents();
		for (let index = events.length - 1; index >= 0; index--) {
			const event = events[index];
			if (event?.type === "info" || event?.type === "progress") return event;
		}
	};
	const oauthPrompt = createStableSnapshot(() => oauth()?.prompt);
	const [answerDraft, setAnswerDraft] = createSignal<{ prompt: unknown; value: string }>();
	const [copiedDeviceCode, setCopiedDeviceCode] = createSignal("");
	const oauthAnswer = () => {
		const prompt = oauthPrompt();
		const draft = answerDraft();
		return draft && draft.prompt === prompt
			? draft.value
			: prompt?.type === "select"
				? (prompt.options?.[0]?.id ?? "")
				: "";
	};
	const setOauthAnswer = (value: string) => setAnswerDraft({ prompt: oauthPrompt(), value });

	const [busy, setBusy] = createSignal(false);
	const [actionError, setError] = createSignal<string | null>(null);
	const error = () =>
		actionError() ??
		(oauth()?.status === "failed" ? (oauth()?.error ?? t("settings.oauthFailed")) : null);
	const [customName, setCustomName] = createSignal("");
	const [customId, setCustomId] = createSignal("");
	const [customUrl, setCustomUrl] = createSignal("");
	const [customModels, setCustomModels] = createSignal("");
	const [customKey, setCustomKey] = createSignal("");
	const [customBusy, setCustomBusy] = createSignal(false);
	const [customError, setCustomError] = createSignal<string | null>(null);
	let disposed = false;
	let oauthGeneration = 0;
	let oauthCleanup = Promise.resolve();
	let pendingAuthWindow: Window | null = null;
	let openedAuthTarget = "";

	const prepareAuthWindow = (): void => {
		pendingAuthWindow?.close();
		pendingAuthWindow = window.open("about:blank", "_blank");
		if (pendingAuthWindow) pendingAuthWindow.opener = null;
	};

	createEffect(() => {
		const target = safeHttpsUrl(authUrlEvent()?.url ?? deviceCodeEvent()?.verificationUri);
		if (target && target !== openedAuthTarget) {
			openedAuthTarget = target;
			const targetWindow = pendingAuthWindow ?? window.open("about:blank", "_blank");
			pendingAuthWindow = null;
			if (targetWindow) {
				targetWindow.opener = null;
				targetWindow.location.href = target;
			}
		}
		if (oauthPrompt()?.type === "select" && pendingAuthWindow) {
			pendingAuthWindow.close();
			pendingAuthWindow = null;
		}
	});

	const abandonOauth = (): void => {
		oauthGeneration++;
		const state = oauth();
		const id = oauthProviderId();
		if (id && (!state || state.status === "running" || state.status === "waiting_input")) {
			oauthCleanup = oauthCleanup
				.then(() => store.provider.loginCancel(id))
				.then(() => undefined)
				.catch(() => undefined);
		}
	};

	onCleanup(() => {
		disposed = true;
		pendingAuthWindow?.close();
		abandonOauth();
	});

	const providerItems = createStableSnapshot(() => store.provider.providers());
	const candidates = createMemo(() =>
		providerItems().filter((provider) => provider.source === "builtin" && !provider.added),
	);
	const added = createMemo(() => providerItems().filter((provider) => provider.added));
	const selected = createMemo(() =>
		providerItems().find((provider) => provider.id === providerId()),
	);

	const refresh = async (): Promise<void> => {
		await Promise.all([store.provider.list(), store.model?.list?.() ?? Promise.resolve()]);
	};
	onMount(() => {
		void refresh().catch((cause) => {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		});
	});

	const selectProvider = (id: string): void => {
		abandonOauth();
		const provider = providerItems().find((item) => item.id === id);
		setProviderId(id);
		setCustomBaseUrl(provider?.baseUrl ?? "");
		setOauthProviderId("");
		setOauthAnswer("");
		setError(null);
		if (managerLayout) setExpandedProvider("");
	};

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
			props.onAdded?.();
		});
	};

	const removeProvider = async (provider: ProviderInfo): Promise<void> => {
		await run(async () => {
			await store.provider.remove(provider.id);
			if (providerId() === provider.id) {
				setProviderId("");
				setOauthProviderId("");
				setOauthAnswer("");
			}
			await refresh();
		});
	};

	let statusRequest = 0;

	const beginOauth = async (flowProviderId: string): Promise<void> => {
		if (!flowProviderId || busy() || disposed) return;
		const generation = ++oauthGeneration;
		prepareAuthWindow();
		openedAuthTarget = "";
		setOauthAnswer("");
		setCopiedDeviceCode("");
		setOauthProviderId(flowProviderId);
		await oauthCleanup;
		if (disposed || generation !== oauthGeneration) return;
		const request = ++statusRequest;
		const initial = await runOauthRequest(() => store.provider.login(flowProviderId));
		if (initial && !disposed && generation === oauthGeneration && request === statusRequest) {
			if (initial.status === "completed") {
				await refresh();
				props.onAdded?.();
			}
		}
	};

	const answerOauth = async (): Promise<void> => {
		const generation = oauthGeneration;
		const answer = oauthAnswer();
		const flowProviderId = oauthProviderId() || providerId();
		if (!flowProviderId || !answer) return;
		prepareAuthWindow();
		setOauthAnswer("");
		const request = ++statusRequest;
		const state = await runOauthRequest(() => store.provider.loginAnswer(flowProviderId, answer));
		if (state && !disposed && generation === oauthGeneration && request === statusRequest)
			if (state.status === "completed") {
				await refresh();
				props.onAdded?.();
			}
	};

	const cancelOauth = async (): Promise<void> => {
		const flowProviderId = oauthProviderId() || providerId();
		if (!flowProviderId || disposed) return;
		const generation = ++oauthGeneration;
		try {
			await store.provider.loginCancel(flowProviderId);
		} catch (cause) {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		}
		if (disposed || generation !== oauthGeneration) return;
		pendingAuthWindow?.close();
		pendingAuthWindow = null;
		setOauthProviderId("");
		setOauthAnswer("");
		setCopiedDeviceCode("");
	};

	const importPiConfig = async (): Promise<void> => {
		if (!piConfigJson().trim()) return;
		await run(async () => {
			await store.provider.importPiConfig(piConfigJson().trim());
			setPiConfigJson("");
			await refresh();
			props.onAdded?.();
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
			props.onAdded?.();
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
						when={oauthProviderId() === provider.id ? oauth() : null}
						fallback={
							<Button
								type="button"
								data-variant="secondary"
								disabled={busy()}
								onClick={() => void beginOauth(provider.id)}
							>
								{oauthMethod(provider)?.loginLabel ?? t("settings.loginWithBrowser")}
							</Button>
						}
					>
						{(state) => (
							<div class="oauth-login" aria-live="polite">
								<Show
									when={
										!deviceCodeEvent() &&
										(state().status === "running" || state().status === "waiting_input") &&
										safeHttpsUrl(authUrlEvent()?.url)
									}
								>
									{(url) => (
										<Link href={url()} target="_blank" rel="noreferrer">
											{t("settings.oauthOpen")}
										</Link>
									)}
								</Show>
								<Show when={state().status === "running" && !oauthMessageEvent()}>
									<p>{t("settings.oauthWaiting")}</p>
								</Show>
								<Show when={state().status === "completed"}>
									<p>{t("settings.oauthConnected")}</p>
								</Show>
								<Show when={state().status === "failed"}>
									<Button
										type="button"
										disabled={busy()}
										onClick={() => void beginOauth(provider.id)}
									>
										{t("settings.reauthProvider")}
									</Button>
								</Show>
								<Show when={deviceCodeEvent()}>
									{(event) => (
										<div class="oauth-device-code">
											<span>{t("settings.oauthCode")}</span>
											<strong>{event().userCode}</strong>
											<Button
												type="button"
												data-variant="secondary"
												onClick={() => {
													void navigator.clipboard?.writeText(event().userCode);
													setCopiedDeviceCode(event().userCode);
												}}
											>
												{copiedDeviceCode() === event().userCode
													? t("settings.oauthCodeCopied")
													: t("settings.oauthCopyCode")}
											</Button>
										</div>
									)}
								</Show>
								<Show when={safeHttpsUrl(deviceCodeEvent()?.verificationUri)}>
									{(url) => (
										<Link href={url()} target="_blank" rel="noreferrer">
											{t("settings.oauthOpenVerification")}
										</Link>
									)}
								</Show>
								<Show when={authUrlEvent()?.instructions}>
									<p class="field-hint">{authUrlEvent()?.instructions}</p>
								</Show>
								<Show when={oauthMessageEvent()}>{(event) => <p>{event().message}</p>}</Show>
								<Show when={oauthInfoEvent()?.links?.length}>
									<ul class="oauth-info-links">
										<For each={oauthInfoEvent()?.links}>
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
								<Show when={oauthPrompt()}>
									{(prompt) => (
										<Show
											when={prompt().type === "manual_code" && Boolean(authUrlEvent())}
											fallback={
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
															disallowEmptySelection
															options={prompt().options ?? []}
															value={
																prompt().options?.find((option) => option.id === oauthAnswer()) ??
																null
															}
															optionValue="id"
															optionTextValue="label"
															onChange={(option) => {
																if (option) setOauthAnswer(option.id);
															}}
															itemComponent={(itemProps) => (
																<Select.Item item={itemProps.item} class="select-item">
																	<Select.ItemLabel>
																		{itemProps.item.rawValue.label}
																	</Select.ItemLabel>
																</Select.Item>
															)}
														>
															<Select.Trigger class="select-trigger" aria-label={prompt().message}>
																<Select.Value class="select-value">
																	{
																		prompt().options?.find((option) => option.id === oauthAnswer())
																			?.label
																	}
																</Select.Value>
															</Select.Trigger>
															<Select.Portal ref={markSelectPortalTopLayer}>
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
											}
										>
											<details class="oauth-manual-fallback">
												<summary>{t("settings.oauthManualFallback")}</summary>
												<TextField class="field">
													<TextField.Label class="field-label">
														{t("settings.oauthCallbackLabel")}
													</TextField.Label>
													<p class="field-hint">{t("settings.oauthManualHint")}</p>
													<TextField.Input
														type="text"
														placeholder={prompt().placeholder}
														value={oauthAnswer()}
														onInput={(event) => setOauthAnswer(event.currentTarget.value)}
													/>
													<Button
														type="button"
														data-variant="secondary"
														disabled={busy() || !oauthAnswer().trim()}
														onClick={() => void answerOauth()}
													>
														{t("settings.oauthManualSubmit")}
													</Button>
												</TextField>
											</details>
										</Show>
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
									<Select.Value<ProviderInfo> class="select-value">
										{(state) => state.selectedOption()?.name ?? ""}
									</Select.Value>
									<Select.Icon class="select-icon" aria-hidden="true">
										v
									</Select.Icon>
								</Select.Trigger>
								<Select.Portal ref={markSelectPortalTopLayer}>
									<Select.Content class="select-content">
										<Select.Listbox class="select-listbox" />
									</Select.Content>
								</Select.Portal>
							</Select>
						</div>
					}
				>
					<div class="provider-selector onboarding-provider-selector">
						<Select<ProviderInfo>
							options={candidates()}
							value={selected() ?? null}
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
						>
							<Select.Label class="field-label">{t("settings.providerLabel")}</Select.Label>
							<Select.Trigger class="select-trigger" aria-label={t("settings.providerLabel")}>
								<Select.Value<ProviderInfo> class="select-value">
									{(state) => state.selectedOption()?.name ?? ""}
								</Select.Value>
								<Select.Icon class="select-icon" aria-hidden="true">
									v
								</Select.Icon>
							</Select.Trigger>
							<Select.Portal ref={markSelectPortalTopLayer}>
								<Select.Content class="select-content">
									<Select.Listbox class="select-listbox" />
								</Select.Content>
							</Select.Portal>
						</Select>
					</div>
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
		<details class="provider-import provider-import-advanced">
			<summary>{t("settings.advancedToggle")}</summary>
			<section class="provider-import-section provider-import-pi">
				<h5>{t("settings.piConfigLabel")}</h5>
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
			</section>
			<section class="provider-import-section provider-import-custom">
				<h5>{t("settings.customProvider")}</h5>
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
			</section>
		</details>
	);

	if (props.surface === "list")
		return (
			<section class={`provider-setup ${props.class ?? ""}`} aria-label={t("settings.addedProviders")}>
				<Show when={error()}>
					{(message) => (
						<p class="status-line err" role="alert">
							{message()}
						</p>
					)}
				</Show>
				<div class="provider-card-list">
					{renderProviderCards(true)}
				</div>
			</section>
		);
	if (props.surface === "add")
		return (
			<section class={`provider-setup ${props.class ?? ""}`} aria-label={t("settings.addProvider")}>
				{renderCandidateSection(true)}
				{renderImports()}
			</section>
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
