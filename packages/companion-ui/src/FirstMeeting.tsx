import { createSignal, For, Show } from "solid-js";
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
						onClick={() => void store.submitOnboarding(step.id)}
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
								textAnswer().trim().length < step.min_length ||
								textAnswer().trim().length > step.max_length
							}
							onClick={() => void store.submitOnboarding(step.id, textAnswer().trim())}
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
							onClick={() => void store.submitOnboarding(step.id, choice.value)}
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
		<Show when={visible()}>
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
							const index = definition?.steps.findIndex((item) => item.id === activeStep.id) ?? -1;
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
	);
}
