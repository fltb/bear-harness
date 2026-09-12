import { i18n, useTranslation } from "@bear-harness/i18n";
import { createMemo, For, Show } from "solid-js";
import { EmbeddingSettings } from "./features/EmbeddingSettings.js";
import { ModelSelector } from "./features/ModelSelector.js";
import { ProviderSetup } from "./features/ProviderSetup.js";
import type { CharacterOnboardingStep } from "./stores/companion.js";
import { useCompanionStore } from "./stores/companion.js";
import { createFirstMeetingWorkflow } from "./stores/setup-workflows.js";
import { useShellWorkflowStore } from "./stores/shell-workflows.js";
import { Button, Checkbox, Dialog, Link, TextField } from "./ui/primitives.js";

/** First-run gates: system model setup → embedding configuration → role onboarding. */
export function FirstMeeting(props: { platform?: string } = {}) {
	const [t] = useTranslation(undefined, { i18n });
	const store = useCompanionStore();
	const shell = useShellWorkflowStore();
	const workflow = createFirstMeetingWorkflow(store, props.platform);
	const hasConfiguredModels = createMemo(() => workflow.configuredModels().length > 0);
	const renderControl = (step: CharacterOnboardingStep) => {
		if (step.kind === "acknowledge")
			return (
				<div class="intro-actions">
					<Button
						type="button"
						class="primary"
						data-variant="primary"
						disabled={workflow.submitting()}
						onClick={() => void workflow.submit(step.id)}
					>
						{step.submit_label}
					</Button>
				</div>
			);
		if (step.kind === "text")
			return (
				<>
					<TextField class="intro-form">
						<TextField.Label>{step.input_label}</TextField.Label>
						<TextField.Input
							id={`onboarding-${step.id}`}
							type="text"
							placeholder={step.input_placeholder}
							value={workflow.textAnswer()}
							onInput={(event) => workflow.setTextAnswer(event.currentTarget.value)}
						/>
					</TextField>
					<div class="intro-actions">
						<Button
							type="button"
							class="primary"
							data-variant="primary"
							disabled={
								workflow.submitting() ||
								workflow.textAnswer().trim().length < step.min_length ||
								workflow.textAnswer().trim().length > step.max_length
							}
							onClick={() => void workflow.submit(step.id, workflow.textAnswer().trim())}
						>
							{step.submit_label}
						</Button>
					</div>
				</>
			);
		return (
			<div class="intro-choices">
				<For each={step.choices}>
					{(choice) => (
						<Button
							type="button"
							class="intro-choice"
							disabled={workflow.submitting()}
							onClick={() => void workflow.submit(step.id, choice.value)}
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
			<Show when={workflow.licenseRequired()}>
				<Dialog open={workflow.licenseRequired()}>
					<Dialog.Content class="intro license-notice" aria-label={t("licenseNotice.dialogLabel")}>
						<article class="intro-card">
							<div class="intro-step">{t("licenseNotice.step")}</div>
							<h2>{t("licenseNotice.title")}</h2>
							<p>{t("licenseNotice.description")}</p>
							<section class="license-notice-item" aria-labelledby="bear-license-title">
								<h3 id="bear-license-title">{t("licenseNotice.bearTitle")}</h3>
								<p>{t("licenseNotice.bearDescription")}</p>
								<Link
									href="https://www.gnu.org/licenses/gpl-3.0.html"
									target="_blank"
									rel="noreferrer"
								>
									{t("licenseNotice.readGpl3")}
								</Link>
							</section>
							<Show when={props.platform === "win32"}>
								<section class="license-notice-item" aria-labelledby="git-license-title">
									<h3 id="git-license-title">{t("licenseNotice.gitTitle")}</h3>
									<p>{t("licenseNotice.gitDescription")}</p>
									<div class="license-notice-links">
										<Link
											href="https://www.gnu.org/licenses/old-licenses/gpl-2.0.html"
											target="_blank"
											rel="noreferrer"
										>
											{t("licenseNotice.readGpl2")}
										</Link>
										<Link
											href="https://github.com/git-for-windows/git"
											target="_blank"
											rel="noreferrer"
										>
											{t("licenseNotice.gitSource")}
										</Link>
									</div>
								</section>
							</Show>
							<Checkbox
								class="license-notice-checkbox"
								checked={workflow.licenseConfirmed()}
								onChange={workflow.setLicenseConfirmed}
							>
								<Checkbox.Input />
								<Checkbox.Control class="license-notice-checkbox-control">
									<Checkbox.Indicator>✓</Checkbox.Indicator>
								</Checkbox.Control>
								<Checkbox.Label>
									{props.platform === "win32"
										? t("licenseNotice.confirmWindows")
										: t("licenseNotice.confirmBear")}
								</Checkbox.Label>
							</Checkbox>
							<div class="intro-actions">
								<Button
									type="button"
									data-variant="primary"
									disabled={!workflow.licenseConfirmed()}
									onClick={workflow.completeLicenseNotice}
								>
									{t("licenseNotice.continue")}
								</Button>
							</div>
						</article>
					</Dialog.Content>
				</Dialog>
			</Show>
			<Show
				when={
					store.setupLoadError &&
					!workflow.modelRequired() &&
					!workflow.roleModelRequired() &&
					!workflow.memorySetupRequired() &&
					!workflow.conversationVisible()
				}
			>
				<p class="intro-error" role="alert">
					{store.setupLoadError}
				</p>
			</Show>
			<Show when={workflow.modelRequired() || workflow.roleModelRequired()}>
				<Dialog open={workflow.modelRequired() || workflow.roleModelRequired()}>
					<Dialog.Content class="intro model-setup" aria-label={t("modelSetup.dialogLabel")}>
						<article class="intro-card">
							<div class="intro-step">{t("modelSetup.dialogLabel")}</div>
							<h2>
								{workflow.roleModelRequired() ? t("modelSetup.roleTitle") : t("modelSetup.title")}
							</h2>
							<p>
								{workflow.roleModelRequired()
									? t("modelSetup.roleDescription")
									: t("modelSetup.description")}
							</p>
							<Show when={workflow.modelRequired() && !hasConfiguredModels()}>
								<ProviderSetup class="first-meeting-provider-setup" />
							</Show>
							<Show when={hasConfiguredModels() || workflow.roleModelRequired()}>
								<Show when={workflow.modelError()}>
									<p class="intro-error" role="alert">
										{String(workflow.modelError())}
									</p>
								</Show>
								<Show when={workflow.setupBusy()}>
									<p class="memory-note">{t("modelSetup.connecting")}</p>
								</Show>
								<Show
									when={
										!workflow.setupBusy() &&
										workflow.configuredModels().length === 0 &&
										!workflow.modelError()
									}
								>
									<p class="field-hint">{t("modelSetup.noModels")}</p>
								</Show>
								<ModelSelector
									models={workflow.configuredModels()}
									value={workflow.selectedReplyModel()}
									class="intro-picker"
									label={t("modelSetup.modelLabel")}
									disabled={workflow.setupBusy()}
									placement="bottom-start"
									onModelChange={(model) => {
										if (model) void workflow.selectReplyModel(model);
									}}
								/>
								<Show
									when={
										workflow.selectedReplyModel() &&
										workflow.selectedReplyModel()?.supportsImages !== true
									}
								>
									<ModelSelector
										models={workflow.configuredModels().filter((model) => model.supportsImages)}
										value={workflow.selectedVisionModel()}
										class="intro-picker"
										label={t("settings.visionModel")}
										autoLabel={t("settings.noFallback")}
										includeAuto
										disabled={workflow.setupBusy()}
										placement="bottom-start"
										onModelChange={(model) => void workflow.selectVisionModel(model)}
									/>
									<p class="field-hint">{t("settings.visionModelHint")}</p>
								</Show>
								<Show when={workflow.selectedReplyModel()?.supportsImages === true}>
									<p class="field-hint">{t("settings.visionModelNative")}</p>
								</Show>
								<div class="intro-actions">
									<Button
										type="button"
										class="primary"
										data-variant="primary"
										disabled={workflow.setupBusy() || !workflow.selectedReplyModel()}
										onClick={workflow.completeModelSetup}
									>
										{workflow.roleModelRequired()
											? t("modelSetup.confirmRole")
											: t("modelSetup.continue")}
									</Button>
								</div>
							</Show>
							<Show when={workflow.setupBusy()}>
								<p class="memory-note">{t("modelSetup.connecting")}</p>
							</Show>
							<Show when={workflow.setupError() ?? store.setupLoadError}>
								<p class="intro-error" role="alert">
									{workflow.setupError() ?? store.setupLoadError}
								</p>
							</Show>
						</article>
					</Dialog.Content>
				</Dialog>
			</Show>
			<Show when={workflow.memorySetupRequired()}>
				<Dialog open={workflow.memorySetupRequired()}>
					<Dialog.Content class="intro model-setup" aria-label={t("settings.memoryVectorSection")}>
						<article class="intro-card">
							<div class="intro-step">{t("settings.memoryVectorSection")}</div>
							<EmbeddingSettings mode="onboarding" />
							<Show when={workflow.setupError() ?? store.setupLoadError}>
								<p class="intro-error" role="alert">
									{workflow.setupError() ?? store.setupLoadError}
								</p>
							</Show>
						</article>
					</Dialog.Content>
				</Dialog>
			</Show>
			<Show when={workflow.conversationVisible() && !shell.backstageOpen()}>
				<Dialog open={workflow.conversationVisible()}>
					<Dialog.Content
						class="intro"
						aria-label={workflow.flow()?.dialog_label ?? ""}
						data-onboarding-step={workflow.currentStep()?.id ?? ""}
					>
						<article class="intro-card">
							<Show when={workflow.currentStep()} keyed>
								{(activeStep) => (
									<>
										<Show when={workflow.currentStepIndex() >= 0}>
											<div class="intro-step">{workflow.currentStepLabel()}</div>
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
										<Show when={workflow.onboardingError() !== null}>
											<p class="intro-error" role="alert">
												{workflow.flow()?.error_prefix}
												{workflow.onboardingError()}
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
