import type { CharacterPackage } from "../../src/companion/character-loader.js";
import { RoleplaySchema } from "../../src/companion/roleplay-schema.js";

const legacyRoleplay = RoleplaySchema.parse({
	variables: [
		{
			id: "continuity_stage",
			type: "number",
			scope: "character",
			initial: 0,
			display: { kind: "hidden" },
		},
		{
			id: "continuity_response",
			type: "enum",
			scope: "character",
			initial: "unopened",
			values: ["unopened", "received", "set_down"],
			display: { kind: "hidden" },
		},
	],
	media: [
		{
			id: "continuity_light",
			kind: "animation",
			label: "Legacy continuity",
			asset: "assets/cg-damaged-signal-animated.webp",
			poster: "assets/cg-damaged-signal.png",
			loop: true,
		},
	],
	unlockables: [
		{
			id: "continuity_record",
			kind: "cg",
			label: "Legacy continuity",
			description: "Compatibility fixture for packages that still declare event state.",
			media: "continuity_light",
		},
	],
	choice_sets: [
		{
			id: "continuity_response",
			prompt: "Legacy response?",
			choices: [
				{
					id: "receive",
					label: "Receive",
					message: "I receive this continuity record.",
				},
				{
					id: "set_down",
					label: "Set down",
					message: "Set this continuity record down for now.",
				},
			],
		},
	],
});

export function withLegacyRoleplay(character: CharacterPackage): CharacterPackage {
	return { ...character, roleplay: structuredClone(legacyRoleplay) };
}
