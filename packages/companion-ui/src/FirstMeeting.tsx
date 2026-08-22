import { i18n, useTranslation } from "@bear-harness/i18n";
import { Button } from "@kobalte/core/button";
import { Collapsible } from "@kobalte/core/collapsible";
import { Dialog } from "@kobalte/core/dialog";
import { Root as Link } from "@kobalte/core/link";
import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { For, Show } from "solid-js";
import { EmbeddingSettings } from "./features/EmbeddingSettings.js";
import { ModelPresetField, ProviderSelectionField } from "./ModelSelectionFields.js";
import type { CharacterOnboardingStep } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";
import { createFirstMeetingWorkflow } from "./stores/setup-workflows.js";

/**
 * Renders the active role package's validated onboarding definition. The UI
 * owns no step labels, prose, answer options or transition rules; it submits
 * only the selected role-defined step and answer to the Host.
 */
export function FirstMeeting() {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const workflow = createFirstMeetingWorkflow(store, t);
	const {
		textAnswer,
		setTextAnswer,
		submitting,
		flow,
		providers,
		providerId,
		modelId,
		apiKey,
		setApiKey,
		customBaseUrl,
		setCustomBaseUrl,
		advancedOpen,
		setAdvancedOpen,
		piConfigJson,
		setPiConfigJson,
		importedModels,
		setupError,
		setupBusy,
		modelRequired,
		memorySetupRequired,
		selectedProvider,
		providerConnected,
		currentStep,
		currentStepIndex,
		currentStepLabel,
		visible,
		conversationVisible,
		onboardingError,
		oauth,
		oauthAnswer,
		setOauthAnswer,
		selectProvider,
		setModelId,
		pinModel,
		saveProviderKey,
		saveProviderBaseUrl,
		importPiConfig,
		beginOauth,
		answerOauth,
		submit,
	} = workflow;

	const renderControl = (step: CharacterOnboardingStep) => {
		if (step.kind === "acknowledge") {
			return (
				<div class="intro-actions">
					<Button
						type="button"
						class="primary"
						data-variant="primary"
						disabled={submitting()}
						onClick={() => void submit(step.id)}
					>
						{step.submit_label}
					</Button>
				</div>
			);
		}
		if (step.kind === "text") {
			return (
				<>
					<TextField class="intro-form">
						<TextField.Label>{step.input_label}</TextField.Label>
						<TextField.Input
							id={`onboarding-${step.id}`}
							type="text"
							placeholder={step.input_placeholder}
							value={textAnswer()}
							onInput={(event) => setTextAnswer(event.currentTarget.value)}
						/>
					</TextField>
					<div class="intro-actions">
						<Button
							type="button"
							class="primary"
							data-variant="primary"
							disabled={
								submitting() ||
								textAnswer().trim().length < step.min_length ||
								textAnswer().trim().length > step.max_length
							}
							onClick={() => void submit(step.id, textAnswer().trim())}
						>
							{step.submit_label}
						</Button>
					</div>
				</>
			);
		}
		return (
			<div class="intro-choices">
				<For each={step.choices}>
					{(choice) => (
						<Button
							type="button"
							class="intro-choice"
							disabled={submitting()}
							onClick={() => void submit(step.id, choice.value)}
						>
							<strong>{choice.label}</strong>
							<span>{choice.description}</span>
						</Button>
					)}
				</For>
			</div>
		);
	};

	return (
		<>
			<Show when={modelRequired()}>
				<Dialog open={modelRequired()}>
					<Dialog.Content class="intro model-setup" aria-label={t("modelSetup.dialogLabel")}>
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
								<div class="model-setup-pickers">
									<ProviderSelectionField
										providers={providers()}
										providerId={providerId()}
										class="intro-picker"
										onProviderChange={selectProvider}
									/>
									<ModelPresetField
										provider={selectedProvider()}
										modelId={modelId()}
										class="intro-picker"
										modelLabel={t("modelSetup.modelLabel")}
										disabled={!selectedProvider()}
										onModelChange={setModelId}
									/>
								</div>
								<Collapsible open={advancedOpen()} onOpenChange={setAdvancedOpen}>
									<Collapsible.Trigger class="advanced-toggle">
										{t("settings.advancedToggle")}
										<span class="advanced-chevron" aria-hidden="true">
											⌄
										</span>
									</Collapsible.Trigger>
									<Collapsible.Content class="advanced-model-settings model-setup-advanced">
										<TextField class="intro-form">
											<TextField.Label>{t("settings.customBaseUrl")}</TextField.Label>
											<TextField.Input
												placeholder={t("settings.customBaseUrlPlaceholder")}
												value={customBaseUrl()}
												onInput={(event) => setCustomBaseUrl(event.currentTarget.value)}
											/>
											<Button
												type="button"
												data-variant="secondary"
												disabled={setupBusy() || !providerId() || !customBaseUrl().trim()}
												onClick={() => void saveProviderBaseUrl()}
											>
												{t("settings.customSave")}
											</Button>
										</TextField>
										<TextField class="intro-form">
											<TextField.Label>{t("settings.piConfigLabel")}</TextField.Label>
											<span class="field-hint">{t("settings.piConfigHint")}</span>
											<TextField.TextArea
												rows={7}
												aria-label={t("settings.piConfigLabel")}
												placeholder={t("settings.piConfigPlaceholder")}
												value={piConfigJson()}
												onInput={(event) => setPiConfigJson(event.currentTarget.value)}
											/>
											<Button
												type="button"
												data-variant="secondary"
												disabled={setupBusy() || !piConfigJson().trim()}
												onClick={() => void importPiConfig()}
											>
												{t("settings.piConfigImport")}
											</Button>
										</TextField>
										<Show when={importedModels().length > 0}>
											<div class="model-pool-list" aria-label={t("settings.modelPool")}>
												<For each={importedModels()}>
													{(model) => (
														<div class="model-pool-item">
															<span>
																{model.label} ({model.providerId}/{model.modelId})
															</span>
														</div>
													)}
												</For>
											</div>
										</Show>
									</Collapsible.Content>
								</Collapsible>
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
															<Button
																type="button"
																class="primary"
																data-variant="primary"
																disabled={setupBusy() || !providerId()}
																onClick={() => void beginOauth()}
															>
																{t("settings.loginWithBrowser")}
															</Button>
															<Show when={oauth()}>
																{(state) => (
																	<div class="oauth-login">
																		<Show when={state().authUrl ?? state().verificationUri}>
																			{(url) => (
																				<Link href={url()} target="_blank" rel="noreferrer">
																					{t("settings.oauthOpen")}
																				</Link>
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
																				<TextField class="intro-form">
																					<TextField.Label>{prompt().message}</TextField.Label>
																					<Show
																						when={prompt().type === "select"}
																						fallback={
																							<TextField.Input
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
																						<Select
																							options={prompt().options ?? []}
																							value={
																								prompt().options?.find(
																									(option) => option.id === oauthAnswer(),
																								) ?? null
																							}
																							optionValue="id"
																							optionTextValue="label"
																							onChange={(option) =>
																								setOauthAnswer(option?.id ?? "")
																							}
																							itemComponent={(itemProps) => (
																								<Select.Item
																									item={itemProps.item}
																									class="select-item"
																								>
																									<Select.ItemLabel>
																										{itemProps.item.rawValue.label}
																									</Select.ItemLabel>
																								</Select.Item>
																							)}
																						>
																							<Select.Trigger class="select-trigger">
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
																						disabled={setupBusy() || !oauthAnswer()}
																						onClick={() => void answerOauth()}
																					>
																						{t("settings.oauthSubmit")}
																					</Button>
																				</TextField>
																			)}
																		</Show>
																	</div>
																)}
															</Show>
														</div>
													}
												>
													<TextField class="intro-form">
														<TextField.Label>{t("settings.apiKeyLabel")}</TextField.Label>
														<TextField.Input
															id="initial-api-key"
															type="password"
															autocomplete="off"
															value={apiKey()}
															onInput={(event) => setApiKey(event.currentTarget.value)}
														/>
														<Button
															type="button"
															class="primary"
															data-variant="primary"
															disabled={setupBusy() || !apiKey().trim()}
															onClick={() => void saveProviderKey()}
														>
															{t("settings.saveKey")}
														</Button>
													</TextField>
												</Show>
											</Show>
											<Show when={providerConnected()}>
												<div class="intro-actions">
													<Button
														type="button"
														class="primary"
														data-variant="primary"
														disabled={setupBusy() || !modelId()}
														onClick={() => void pinModel()}
													>
														{t("modelSetup.continue")}
													</Button>
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
					</Dialog.Content>
				</Dialog>
			</Show>
			<Show when={memorySetupRequired()}>
				<Dialog open={memorySetupRequired()}>
					<Dialog.Content class="intro model-setup" aria-label={t("settings.memoryVectorSection")}>
						<article class="intro-card">
							<div class="intro-step">{t("settings.memoryVectorSection")}</div>
							<h2>{t("settings.memoryVectorEnabled")}</h2>
							<p>{t("modelSetup.memorySetupNote")}</p>
							<EmbeddingSettings mode="onboarding" />
						</article>
					</Dialog.Content>
				</Dialog>
			</Show>
			<Show when={conversationVisible()}>
				<Dialog open={conversationVisible()}>
					<Dialog.Content
						class="intro"
						aria-label={flow()?.dialog_label ?? ""}
						data-onboarding-step={currentStep()?.id ?? ""}
					>
						<article class="intro-card">
							<Show when={currentStep()} keyed>
								{(activeStep) => (
									<>
										<Show when={currentStepIndex() >= 0}>
											<div class="intro-step">{currentStepLabel()}</div>
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
										<Show when={onboardingError() !== null}>
											<p class="intro-error" role="alert">
												{flow()?.error_prefix}
												{onboardingError()}
											</p>
										</Show>
										{renderControl(activeStep)}
									</>
								)}
							</Show>
						</article>
					</Dialog.Content>
				</Dialog>
			</Show>
		</>
	);
}
