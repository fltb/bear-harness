import { productUi } from "@bear-harness/product-config";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
	const [providerId, setProviderId] = createSignal("");
	const [modelId, setModelId] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const [setupError, setSetupError] = createSignal<string | null>(null);
	const [setupBusy, setSetupBusy] = createSignal(false);
	const [oauth, setOauth] = createSignal<Awaited<ReturnType<typeof store.provider.login>> | null>(
		null,
	);
	const [oauthAnswer, setOauthAnswer] = createSignal("");
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	onMount(() => {
		void store.provider.list().then((data) => {
			const first = data.providers[0];
			if (!first) return;
			setProviderId(first.id);
			setModelId(first.availableModels[0]?.id ?? "");
		});
	});

	const providers = () => store.provider.providers();
	const selectedProvider = () => providers().find((provider) => provider.id === providerId());
	const modelRequired = () => !store.voice.loading() && !store.voice.activeStackId();
	createEffect(() => {
		const provider = selectedProvider();
		if (!providerId() && provider) setProviderId(provider.id);
	});
	const selectProvider = (id: string) => {
		setProviderId(id);
		setModelId(providers().find((provider) => provider.id === id)?.availableModels[0]?.id ?? "");
		setOauth(null);
		setOauthAnswer("");
		setSetupError(null);
	};
	const pinModel = async (): Promise<void> => {
		if (!providerId() || !modelId()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.voice.pin(providerId(), modelId(), selectedProvider()?.name);
		} catch (cause) {
			setSetupError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSetupBusy(false);
		}
	};
	const saveKeyAndPin = async (): Promise<void> => {
		if (!apiKey().trim()) return;
		setSetupBusy(true);
		setSetupError(null);
		try {
			await store.provider.setApiKey(providerId(), apiKey().trim());
			setApiKey("");
			await store.voice.pin(providerId(), modelId(), selectedProvider()?.name);
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
			if (state.status === "completed") await pinModel();
			if (state.status === "failed") setSetupError(state.message ?? productUi.settings.oauthFailed);
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
		if (submitting()) return;
		setSubmitting(true);
		try {
			await store.submitOnboarding(stepId, answer);
		} finally {
			setSubmitting(false);
		}
	};
	const currentStep = (): CharacterOnboardingStep | undefined => {
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
					aria-label={productUi.modelSetup.dialogLabel}
				>
					<article class="intro-card">
						<div class="intro-step">{productUi.modelSetup.dialogLabel}</div>
						<h2>{productUi.modelSetup.title}</h2>
						<p>{productUi.modelSetup.description}</p>
						<Show
							when={providers().length > 0}
							fallback={
								<p class="intro-error" role="alert">
									{productUi.modelSetup.noProviders}
								</p>
							}
						>
							<label class="intro-form">
								<span>{productUi.settings.serviceLabel}</span>
								<select
									aria-label={productUi.settings.serviceLabel}
									value={providerId()}
									onChange={(event) => selectProvider(event.currentTarget.value)}
								>
									<For each={providers()}>
										{(provider) => <option value={provider.id}>{provider.name}</option>}
									</For>
								</select>
							</label>
							<label class="intro-form">
								<span>{productUi.modelSetup.modelLabel}</span>
								<select
									aria-label={productUi.modelSetup.modelLabel}
									value={modelId()}
									onChange={(event) => setModelId(event.currentTarget.value)}
								>
									<For each={selectedProvider()?.availableModels ?? []}>
										{(model) => <option value={model.id}>{model.name}</option>}
									</For>
								</select>
							</label>
							<Show
								when={
									selectedProvider()?.credentialStatus !== "stored" &&
									selectedProvider()?.credentialStatus !== "session_only"
								}
							>
								<Show
									when={selectedProvider()?.authType === "api_key"}
									fallback={
										<div class="intro-form">
											<button
												type="button"
												class="primary"
												disabled={setupBusy() || !providerId()}
												onClick={() => void beginOauth()}
											>
												{productUi.settings.loginWithBrowser}
											</button>
											<Show when={oauth()}>
												{(state) => (
													<div class="oauth-login">
														<Show when={state().authUrl ?? state().verificationUri}>
															{(url) => (
																<a href={url()} target="_blank" rel="noreferrer">
																	{productUi.settings.oauthOpen}
																</a>
															)}
														</Show>
														<Show when={state().deviceCode}>
															<p>
																{productUi.settings.oauthCode}:{" "}
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
																				type={prompt().type === "secret" ? "password" : "text"}
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
																		disabled={setupBusy() || !oauthAnswer()}
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
									<div class="intro-form">
										<label for="initial-api-key">{productUi.settings.apiKeyLabel}</label>
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
											disabled={setupBusy() || !apiKey().trim() || !modelId()}
											onClick={() => void saveKeyAndPin()}
										>
											{productUi.modelSetup.continue}
										</button>
									</div>
								</Show>
							</Show>
							<Show
								when={
									selectedProvider()?.credentialStatus === "stored" ||
									selectedProvider()?.credentialStatus === "session_only"
								}
							>
								<div class="intro-actions">
									<button
										type="button"
										class="primary"
										disabled={setupBusy() || !modelId()}
										onClick={() => void pinModel()}
									>
										{productUi.modelSetup.continue}
									</button>
								</div>
							</Show>
							<Show when={setupBusy()}>
								<p class="memory-note">{productUi.modelSetup.connecting}</p>
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
