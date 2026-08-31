import { z } from "@bear-harness/schema";

const Copy = z.string().min(1).max(16_384);

export const CharacterBehaviorSchema = z.strictObject({
	identity: z.strictObject({
		summary: Copy,
		invariants: z.array(Copy).min(1).max(40),
		knowledge_boundaries: z.array(Copy).min(1).max(40),
	}),
	agency: z.strictObject({
		never: z.array(Copy).min(1).max(40),
		when_uncertain: z.array(Copy).min(1).max(20),
	}),
	interaction: Copy,
	examples: z
		.array(
			z.strictObject({
				user: Copy,
				assistant: Copy,
			}),
		)
		.min(1)
		.max(40),
});

export type CharacterBehaviorContract = z.infer<typeof CharacterBehaviorSchema>;
