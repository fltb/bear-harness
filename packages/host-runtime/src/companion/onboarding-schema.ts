import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const MAX_COPY_LENGTH = 4_096;
const Identifier = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-z][a-z0-9_]*$",
});
const Copy = Type.String({ minLength: 1, maxLength: MAX_COPY_LENGTH });

const OnboardingEffectSchema = Type.Union([
	Type.Object({ type: Type.Literal("identity.nickname") }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("relationship.kind") }, { additionalProperties: false }),
	Type.Object(
		{
			type: Type.Literal("relationship.memory"),
			enabled_when: Identifier,
		},
		{ additionalProperties: false },
	),
]);

const StepPresentationSchema = {
	id: Identifier,
	heading: Copy,
	body: Copy,
	quote: Type.Optional(Copy),
	note: Type.Optional(Copy),
	effects: Type.Optional(Type.Array(OnboardingEffectSchema, { maxItems: 3 })),
};

const AcknowledgeStepSchema = Type.Object(
	{
		...StepPresentationSchema,
		kind: Type.Literal("acknowledge"),
		submit_label: Copy,
	},
	{ additionalProperties: false },
);

const TextStepSchema = Type.Object(
	{
		...StepPresentationSchema,
		kind: Type.Literal("text"),
		answer_key: Identifier,
		input_label: Copy,
		input_placeholder: Copy,
		min_length: Type.Integer({ minimum: 1, maximum: 4_096 }),
		max_length: Type.Integer({ minimum: 1, maximum: 4_096 }),
		submit_label: Copy,
	},
	{ additionalProperties: false },
);

const ChoiceStepSchema = Type.Object(
	{
		...StepPresentationSchema,
		kind: Type.Literal("choice"),
		answer_key: Identifier,
		choices: Type.Array(
			Type.Object(
				{
					value: Identifier,
					label: Copy,
					description: Copy,
				},
				{ additionalProperties: false },
			),
			{ minItems: 2, maxItems: 12 },
		),
	},
	{ additionalProperties: false },
);

/**
 * Role-package DSL for the first meeting. It contains presentation, valid
 * answers and a small, Host-owned effect vocabulary; role packages cannot
 * declare arbitrary code or privileged side effects.
 */
export const CharacterOnboardingFlowSchema = Type.Object(
	{
		version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		step_label: Copy,
		dialog_label: Copy,
		error_prefix: Copy,
		steps: Type.Array(Type.Union([AcknowledgeStepSchema, TextStepSchema, ChoiceStepSchema]), {
			minItems: 1,
			maxItems: 12,
		}),
		completion: Type.Object(
			{
				conversation_title: Copy,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

/** Canonical, versioned persistence shape for role-defined onboarding answers. */
export const OnboardingStateDataSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		flow_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		answers: Type.Record(Identifier, Type.String({ maxLength: MAX_COPY_LENGTH })),
		decisions: Type.Object(
			{
				relationship_kind: Type.Optional(Identifier),
				relationship_memory_enabled: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type OnboardingStateData = Static<typeof OnboardingStateDataSchema>;

export type CharacterOnboardingFlow = Static<typeof CharacterOnboardingFlowSchema>;
export type CharacterOnboardingStep = CharacterOnboardingFlow["steps"][number];
export type CharacterOnboardingEffect = Static<typeof OnboardingEffectSchema>;

export function validateCharacterOnboardingFlow(
	value: unknown,
	characterId: string,
): asserts value is CharacterOnboardingFlow {
	if (!Value.Check(CharacterOnboardingFlowSchema, value)) {
		throw new Error(`character package ${characterId}: invalid first_meeting schema`);
	}

	const stepIds = new Set<string>();
	const answerKeys = new Set<string>();
	const effectKinds = new Set<string>();
	for (const step of value.steps) {
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
