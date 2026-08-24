import { z } from "@bear-harness/schema";
import type { RoleplayDefinition, RoleplayValue } from "./roleplay-schema.js";

const MAX_COPY_LENGTH = 4_096;
const Identifier = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);
const Copy = z.string().min(1).max(MAX_COPY_LENGTH);

const OnboardingEffectSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("identity.nickname") }),
	z.strictObject({
		type: z.literal("setting.set"),
		setting: z.enum(["relationship_memory_enabled", "conversation_history_read_enabled"]),
		values: z.record(Identifier, z.boolean()),
	}),
	z.strictObject({
		type: z.literal("roleplay.initial"),
		variable: Identifier,
		values: z.record(
			Identifier,
			z.union([z.string().max(MAX_COPY_LENGTH), z.number().finite(), z.boolean()]),
		),
	}),
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
		relationship_memory_enabled: z.boolean().optional(),
		conversation_history_read_enabled: z.boolean().optional(),
		roleplay_initial_values: z
			.record(
				Identifier,
				z.union([z.string().max(MAX_COPY_LENGTH), z.number().finite(), z.boolean()]),
			)
			.optional(),
	}),
});

export type OnboardingStateData = z.infer<typeof OnboardingStateDataSchema>;

export type CharacterOnboardingFlow = z.infer<typeof CharacterOnboardingFlowSchema>;
export type CharacterOnboardingStep = CharacterOnboardingFlow["steps"][number];
export type CharacterOnboardingEffect = z.infer<typeof OnboardingEffectSchema>;

export function validateCharacterOnboardingFlow(
	value: unknown,
	characterId: string,
	roleplay?: RoleplayDefinition,
): asserts value is CharacterOnboardingFlow {
	const parsed = CharacterOnboardingFlowSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`character package ${characterId}: invalid first_meeting schema`);
	}
	const flow = parsed.data;

	const stepIds = new Set<string>();
	const answerKeys = new Set<string>();
	const effectTargets = new Set<string>();
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
		for (const effect of step.effects ?? []) {
			const target =
				effect.type === "identity.nickname"
					? effect.type
					: `${effect.type}:${effect.type === "setting.set" ? effect.setting : effect.variable}`;
			if (effectTargets.has(target)) {
				throw new Error(`character package ${characterId}: first_meeting effects must be unique`);
			}
			if (effect.type === "identity.nickname" && step.kind !== "text") {
				throw new Error(`character package ${characterId}: nickname effect requires a text step`);
			}
			if (effect.type !== "identity.nickname") {
				if (step.kind !== "choice") {
					throw new Error(
						`character package ${characterId}: declarative onboarding bindings require a choice step`,
					);
				}
				const values = new Set(step.choices.map((choice) => choice.value));
				for (const value of Object.keys(effect.values)) {
					if (!values.has(value)) {
						throw new Error(
							`character package ${characterId}: onboarding binding references unknown choice ${value}`,
						);
					}
				}
				if (Object.keys(effect.values).length !== values.size) {
					throw new Error(
						`character package ${characterId}: onboarding binding must map every choice`,
					);
				}
			}
			if (effect.type === "roleplay.initial") {
				const variable = roleplay?.variables.find((candidate) => candidate.id === effect.variable);
				if (!variable) {
					throw new Error(
						`character package ${characterId}: onboarding bucket ${effect.variable} is not declared`,
					);
				}
				for (const initial of Object.values(effect.values)) {
					if (!isCompatibleRoleplayValue(variable, initial)) {
						throw new Error(
							`character package ${characterId}: onboarding value is invalid for bucket ${effect.variable}`,
						);
					}
				}
			}
			effectTargets.add(target);
		}
	}
}

function isCompatibleRoleplayValue(
	variable: RoleplayDefinition["variables"][number],
	value: RoleplayValue,
): boolean {
	if (variable.type === "number") return typeof value === "number";
	if (variable.type === "boolean") return typeof value === "boolean";
	if (variable.type === "string") return typeof value === "string";
	return typeof value === "string" && variable.values?.includes(value) === true;
}
