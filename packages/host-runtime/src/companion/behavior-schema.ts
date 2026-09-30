import { z } from "@bear-harness/schema";

const Copy = z.string().min(1).max(16_384);

export const CharacterBehaviorSchema = z.strictObject({
	identity: z.strictObject({
		summary: Copy,
		invariants: z.array(Copy).max(40).optional(),
		knowledge_boundaries: z.array(Copy).max(40).optional(),
	}),
	interaction: Copy.optional(),
	examples: z
		.array(
			z.strictObject({
				user: Copy,
				assistant: Copy,
			}),
		)
		.max(40)
		.optional(),
});

export type CharacterBehaviorContract = z.infer<typeof CharacterBehaviorSchema>;
