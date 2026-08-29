import { z } from "@bear-harness/schema";

const Copy = z.string().min(1).max(16_384);
const Identifier = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/u);

const InteractionContract = z.strictObject({
	real_work: Copy,
	companionship: Copy,
	roleplay: Copy,
	technical_meta: Copy,
	task_failure: Copy,
	waiting_for_user: Copy,
});

const RequiredExampleIds = new Set([
	"emotional_support",
	"real_work",
	"disagreement",
	"uncertainty",
	"user_boundary",
	"technical_discussion",
	"story_entry",
	"story_exit",
	"long_task_handoff",
]);

export const CharacterBehaviorSchema = z
	.strictObject({
		identity: z.strictObject({
			summary: Copy,
			invariants: z.array(Copy).min(1).max(40),
			knowledge_boundaries: z.array(Copy).min(1).max(40),
			self_reference: z.strictObject({
				always_known: z.array(Copy).min(1).max(20),
				answer_when_asked: z.array(Copy).max(20),
				gated: z.array(Copy).max(20),
			}),
		}),
		agency: z.strictObject({
			never: z.array(Copy).min(1).max(40),
			when_uncertain: z.array(Copy).min(1).max(20),
		}),
		interaction: InteractionContract,
		examples: z
			.array(
				z.strictObject({
					id: Identifier,
					user: Copy,
					assistant: Copy,
				}),
			)
			.min(1)
			.max(40),
	})
	.superRefine((behavior, context) => {
		const ids = behavior.examples.map((example) => example.id);
		if (new Set(ids).size !== ids.length)
			context.addIssue({ code: "custom", path: ["examples"], message: "duplicate example id" });
		for (const id of RequiredExampleIds)
			if (!ids.includes(id))
				context.addIssue({
					code: "custom",
					path: ["examples"],
					message: `missing required example ${id}`,
				});
	});

export type CharacterBehaviorContract = z.infer<typeof CharacterBehaviorSchema>;

export const VoiceModesSchema = z
	.strictObject({
		default: Identifier,
		modes: z
			.array(
				z.strictObject({
					id: Identifier,
					label: Copy,
					description: Copy,
					style_instruction: Copy,
					use_when: Copy,
				}),
			)
			.min(1)
			.max(20),
	})
	.superRefine((voice, context) => {
		const ids = voice.modes.map((mode) => mode.id);
		if (new Set(ids).size !== ids.length)
			context.addIssue({ code: "custom", path: ["modes"], message: "duplicate voice mode" });
		if (!ids.includes(voice.default))
			context.addIssue({
				code: "custom",
				path: ["default"],
				message: "default voice mode is not declared",
			});
	});

export type VoiceModesContract = z.infer<typeof VoiceModesSchema>;
