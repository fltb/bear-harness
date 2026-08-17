import { z } from "@bear-harness/schema";

const MAX_COPY_LENGTH = 4_096;
const Identifier = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);
const Copy = z.string().min(1).max(MAX_COPY_LENGTH);

const OnboardingEffectSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("identity.nickname") }),
	z.strictObject({ type: z.literal("relationship.kind") }),
	z.strictObject({ type: z.literal("relationship.memory"), enabled_when: Identifier }),
]);

const StepPresentationSchema = {
	id: Identifier,
	heading: Copy,
	body: Copy,
	quote: Copy.optional(),
	note: Copy.optional(),
	effects: z.array(OnboardingEffectSchema).max(3).optional(),
};

const AcknowledgeStepSchema = z.strictObject({
	...StepPresentationSchema,
	kind: z.literal("acknowledge"),
	submit_label: Copy,
});

const TextStepSchema = z.strictObject({
	...StepPresentationSchema,
	kind: z.literal("text"),
	answer_key: Identifier,
	input_label: Copy,
	input_placeholder: Copy,
	min_length: z.number().int().min(1).max(4_096),
	max_length: z.number().int().min(1).max(4_096),
	submit_label: Copy,
});

const ChoiceStepSchema = z.strictObject({
	...StepPresentationSchema,
	kind: z.literal("choice"),
	answer_key: Identifier,
	choices: z
		.array(
			z.strictObject({
				value: Identifier,
				label: Copy,
				description: Copy,
			}),
		)
		.min(2)
		.max(12),
});

/**
 * Role-package DSL for the first meeting. It contains presentation, valid
 * answers and a small, Host-owned effect vocabulary; role packages cannot
 * declare arbitrary code or privileged side effects.
 */
export const CharacterOnboardingFlowSchema = z.strictObject({
	version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	step_label: Copy,
	dialog_label: Copy,
	error_prefix: Copy,
	steps: z
		.array(z.discriminatedUnion("kind", [AcknowledgeStepSchema, TextStepSchema, ChoiceStepSchema]))
		.min(1)
		.max(12),
	completion: z.strictObject({ conversation_title: Copy }),
});

/** Canonical, versioned persistence shape for role-defined onboarding answers. */
export const OnboardingStateDataSchema = z.strictObject({
	schema_version: z.literal(1),
	flow_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	answers: z.record(Identifier, z.string().max(MAX_COPY_LENGTH)),
	decisions: z.strictObject({
		relationship_kind: Identifier.optional(),
		relationship_memory_enabled: z.boolean().optional(),
		conversation_history_read_enabled: z.boolean().optional(),
	}),
});

export type OnboardingStateData = z.infer<typeof OnboardingStateDataSchema>;

export type CharacterOnboardingFlow = z.infer<typeof CharacterOnboardingFlowSchema>;
export type CharacterOnboardingStep = CharacterOnboardingFlow["steps"][number];
export type CharacterOnboardingEffect = z.infer<typeof OnboardingEffectSchema>;

export function validateCharacterOnboardingFlow(
	value: unknown,
	characterId: string,
): asserts value is CharacterOnboardingFlow {
	const parsed = CharacterOnboardingFlowSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`character package ${characterId}: invalid first_meeting schema`);
	}
	const flow = parsed.data;

	const stepIds = new Set<string>();
	const answerKeys = new Set<string>();
	const effectKinds = new Set<string>();
	for (const step of flow.steps) {
		if (step.id === "complete" || stepIds.has(step.id)) {
			throw new Error(`character package ${characterId}: first_meeting step ids must be unique`);
		}
		stepIds.add(step.id);

		if (step.kind === "text" && step.min_length > step.max_length) {
			throw new Error(
				`character package ${characterId}: first_meeting text length range is invalid`,
			);
		}
		if (step.kind === "text" || step.kind === "choice") {
			if (answerKeys.has(step.answer_key)) {
				throw new Error(
					`character package ${characterId}: first_meeting answer keys must be unique`,
				);
			}
			answerKeys.add(step.answer_key);
		}
		if (step.kind === "choice") {
			const values = new Set<string>();
			for (const choice of step.choices) {
				if (values.has(choice.value)) {
					throw new Error(
						`character package ${characterId}: first_meeting choice values must be unique`,
					);
				}
				values.add(choice.value);
			}
			for (const effect of step.effects ?? []) {
				if (effect.type === "relationship.memory" && !values.has(effect.enabled_when)) {
					throw new Error(
						`character package ${characterId}: first_meeting memory effect must name a choice value`,
					);
				}
			}
		}
		for (const effect of step.effects ?? []) {
			if (effectKinds.has(effect.type)) {
				throw new Error(`character package ${characterId}: first_meeting effects must be unique`);
			}
			if (effect.type === "identity.nickname" && step.kind !== "text") {
				throw new Error(`character package ${characterId}: nickname effect requires a text step`);
			}
			if (effect.type !== "identity.nickname" && step.kind !== "choice") {
				throw new Error(
					`character package ${characterId}: relationship effects require a choice step`,
				);
			}
			effectKinds.add(effect.type);
		}
	}
}
