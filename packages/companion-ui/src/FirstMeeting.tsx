import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "./i18n.js";
import { ModelPresetField, ProviderSelectionField } from "./ModelSelectionFields.js";
import type { CharacterOnboardingStep } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";

function stepLabel(template: string, index: number, total: number): string {
	return template.replaceAll("{step}", String(index + 1)).replaceAll("{total}", String(total));
}

/**
 * Renders the active role package's validated onboarding definition. The UI
 * owns no step labels, prose, answer options or transition rules; it submits
 * only the selected role-defined step and answer to the Host.
 */
export function FirstMeeting() {
	const store = useCompanionStore();
	const [textAnswer, setTextAnswer] = createSignal("");
	const flow = () => store.character?.character.first_meeting;
	const [submitting, setSubmitting] = createSignal(false);
	const [onboardingRevision, setOnboardingRevision] = createSignal(0);
	const [providerId, setProviderId] = createSignal("");
	const [modelId, setModelId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const [setupError, setSetupError] = createSignal<string | null>(null);
	const [setupBusy, setSetupBusy] = createSignal(false);
	const [connectedProviderId, setConnectedProviderId] = createSignal("");
	const [oauth, setOauth] = createSignal<Awaited<ReturnType<typeof store.provider.login>> | null>(
		null,
	);
	const [oauthAnswer, setOauthAnswer] = createSignal("");
	let submittedStepId: string | null = null;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	onMount(() => {
		void store.provider.list();
	});

	const providers = () => store.provider.providers();
	const selectedProvider = () => providers().find((provider) => provider.id === providerId());
	const providerConnected = () =>
		selectedProvider()?.credentialStatus === "stored" ||
		selectedProvider()?.credentialStatus === "session_only" ||
		connectedProviderId() === providerId();
	const modelRequired = () => !store.model.loading() && store.model.models().length === 0;
	const selectProvider = (id: string) => {
		setProviderId(id);
		setModelId("");
		setOauth(null);
		setOauthAnswer("");
		setConnectedProviderId("");
		setSetupError(null);
	};
	const pinModel = async (): Promise<void> => {
		if (!providerId() || !modelId()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.model.enable(providerId(), modelId(), selectedProvider()?.name);
		} catch (cause) {
			setSetupError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const saveProviderKey = async (): Promise<void> => {
		if (!apiKey().trim()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.provider.setApiKey(providerId(), apiKey().trim());
			setApiKey("");
			setConnectedProviderId(providerId());
			await store.provider.list();
		} catch (cause) {
			setSetupError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const beginOauth = async (): Promise<void> => {
		setSetupBusy(true);
		setSetupError(null);
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
				setConnectedProviderId(providerId());
				await store.provider.list();
			}
			if (state.status === "failed") setSetupError(state.message ?? t("settings.oauthFailed"));
		} catch (cause) {
			setSetupError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const answerOauth = async (): Promise<void> => {
		if (!oauthAnswer()) return;
		setSetupBusy(true);
		try {
			await store.provider.loginAnswer(providerId(), oauthAnswer());
			setOauthAnswer("");
			await beginOauth();
		} catch (cause) {
			setSetupError(cause instanceof Error ? cause.message : String(cause));
			setSetupBusy(false);
		}
	};
	const submit = async (stepId: string, answer?: string): Promise<void> => {
		if (submitting() || submittedStepId === stepId) return;
		submittedStepId = stepId;
		setSubmitting(true);
		try {
			await store.submitOnboarding(stepId, answer);
			setOnboardingRevision((revision) => revision + 1);
		} catch (cause) {
			submittedStepId = null;
			throw cause;
		} finally {
			setSubmitting(false);
		}
	};
	createEffect(() => {
		const currentStepId = store.onboarding.currentStepId;
		if (submittedStepId !== null && submittedStepId !== currentStepId) submittedStepId = null;
	});
	const currentStep = (): CharacterOnboardingStep | undefined => {
		onboardingRevision();
		const definition = flow();
		const stepId = store.onboarding.currentStepId;
		return definition?.steps.find((step) => step.id === stepId);
	};
	const visible = () =>
		store.onboarding.status === "active" && currentStep() !== undefined && !store.loading;

	const renderControl = (step: CharacterOnboardingStep) => {
		if (step.kind === "acknowledge") {
			return (
				<div class="intro-actions">
					<button
						type="button"
						class="primary"
						disabled={submitting()}
						onClick={() => void submit(step.id)}
					>
						{step.submit_label}
					</button>
				</div>
			);
		}
		if (step.kind === "text") {
			return (
				<>
					<div class="intro-form">
						<label for={`onboarding-${step.id}`}>{step.input_label}</label>
						<input
							id={`onboarding-${step.id}`}
							type="text"
							placeholder={step.input_placeholder}
							value={textAnswer()}
							onInput={(event) => setTextAnswer(event.currentTarget.value)}
						/>
					</div>
					<div class="intro-actions">
						<button
							type="button"
							class="primary"
							disabled={
								submitting() ||
								textAnswer().trim().length < step.min_length ||
								textAnswer().trim().length > step.max_length
							}
							onClick={() => void submit(step.id, textAnswer().trim())}
						>
							{step.submit_label}
						</button>
					</div>
				</>
			);
		}
		return (
			<div class="intro-choices">
				<For each={step.choices}>
					{(choice) => (
						<button
							type="button"
							class="intro-choice"
							disabled={submitting()}
							onClick={() => void submit(step.id, choice.value)}
						>
							<strong>{choice.label}</strong>
							<span>{choice.description}</span>
						</button>
					)}
				</For>
			</div>
		);
	};

	return (
		<>
			<Show when={modelRequired()}>
				<section
					class="intro model-setup"
					role="dialog"
					aria-modal="true"
					aria-label={t("modelSetup.dialogLabel")}
				>
					<article class="intro-card">
						<div class="intro-step">{t("modelSetup.dialogLabel")}</div>
						<h2>{t("modelSetup.title")}</h2>
						<p>{t("modelSetup.description")}</p>
						<Show
							when={providers().length > 0}
							fallback={
								<p class="intro-error" role="alert">
									{t("modelSetup.noProviders")}
								</p>
							}
						>
							<ProviderSelectionField
								providers={providers()}
								providerId={providerId()}
								class="intro-form"
								onProviderChange={selectProvider}
							/>
							<Show when={selectedProvider()}>
								{(provider) => (
									<>
										<Show
											when={
												provider().credentialStatus !== "stored" &&
												provider().credentialStatus !== "session_only"
											}
										>
											<Show
												when={provider().authType === "api_key"}
												fallback={
													<div class="intro-form">
														<button
															type="button"
															class="primary"
															data-variant="primary"
															disabled={setupBusy() || !providerId()}
															onClick={() => void beginOauth()}
														>
															{t("settings.loginWithBrowser")}
														</button>
														<Show when={oauth()}>
															{(state) => (
																<div class="oauth-login">
																	<Show when={state().authUrl ?? state().verificationUri}>
																		{(url) => (
																			<a href={url()} target="_blank" rel="noreferrer">
																				{t("settings.oauthOpen")}
																			</a>
																		)}
																	</Show>
																	<Show when={state().deviceCode}>
																		<p>
																			{t("settings.oauthCode")}:{" "}
																			<strong>{state().deviceCode}</strong>
																		</p>
																	</Show>
																	<Show when={state().message}>
																		<p>{state().message}</p>
																	</Show>
																	<Show when={state().prompt}>
																		{(prompt) => (
																			<label class="intro-form">
																				<span>{prompt().message}</span>
																				<Show
																					when={prompt().type === "select"}
																					fallback={
																						<input
																							type={
																								prompt().type === "secret" ? "password" : "text"
																							}
																							value={oauthAnswer()}
																							onInput={(event) =>
																								setOauthAnswer(event.currentTarget.value)
																							}
																						/>
																					}
																				>
																					<select
																						value={oauthAnswer()}
																						onChange={(event) =>
																							setOauthAnswer(event.currentTarget.value)
																						}
																					>
																						<For each={prompt().options ?? []}>
																							{(option) => (
																								<option value={option.id}>{option.label}</option>
																							)}
																						</For>
																					</select>
																				</Show>
																				<button
																					type="button"
																					data-variant="secondary"
																					disabled={setupBusy() || !oauthAnswer()}
																					onClick={() => void answerOauth()}
																				>
																					{t("settings.oauthSubmit")}
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
												<div class="intro-form">
													<label for="initial-api-key">{t("settings.apiKeyLabel")}</label>
													<input
														id="initial-api-key"
														type="password"
														autocomplete="off"
														value={apiKey()}
														onInput={(event) => setApiKey(event.currentTarget.value)}
													/>
													<button
														type="button"
														class="primary"
														data-variant="primary"
														disabled={setupBusy() || !apiKey().trim()}
														onClick={() => void saveProviderKey()}
													>
														{t("settings.saveKey")}
													</button>
												</div>
											</Show>
										</Show>
										<Show when={providerConnected()}>
											<div class="intro-actions">
												<ModelPresetField
													provider={provider()}
													modelId={modelId()}
													class="intro-form"
													modelLabel={t("modelSetup.modelLabel")}
													onModelChange={setModelId}
												/>
												<button
													type="button"
													class="primary"
													data-variant="primary"
													disabled={setupBusy() || !modelId()}
													onClick={() => void pinModel()}
												>
													{t("modelSetup.continue")}
												</button>
											</div>
										</Show>
									</>
								)}
							</Show>
							<Show when={setupBusy()}>
								<p class="memory-note">{t("modelSetup.connecting")}</p>
							</Show>
							<Show when={setupError()}>
								<p class="intro-error" role="alert">
									{setupError()}
								</p>
							</Show>
						</Show>
					</article>
				</section>
			</Show>
			<Show when={!modelRequired() && visible()}>
				<section
					class="intro"
					role="dialog"
					aria-modal="true"
					aria-label={flow()?.dialog_label ?? ""}
					data-onboarding-step={currentStep()?.id ?? ""}
				>
					<article class="intro-card">
						<Show when={currentStep()} keyed>
							{(step) => {
								const activeStep = step;
								const definition = flow();
								const index =
									definition?.steps.findIndex((item) => item.id === activeStep.id) ?? -1;
								return (
									<>
										<Show when={definition && index >= 0}>
											<div class="intro-step">
												{stepLabel(definition!.step_label, index, definition!.steps.length)}
											</div>
										</Show>
										<h2>{activeStep.heading}</h2>
										<p>{activeStep.body}</p>
										<Show when={activeStep.quote}>
											<p class="intro-quote">
												<em>{activeStep.quote}</em>
											</p>
										</Show>
										<Show when={activeStep.note}>
											<p class="memory-note">{activeStep.note}</p>
										</Show>
										<Show when={store.error !== null}>
											<p class="intro-error" role="alert">
												{definition?.error_prefix}
												{store.error}
											</p>
										</Show>

										{renderControl(activeStep)}
									</>
								);
							}}
						</Show>
					</article>
				</section>
			</Show>
		</>
	);
}
