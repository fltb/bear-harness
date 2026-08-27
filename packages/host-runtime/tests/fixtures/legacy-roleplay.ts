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
	events: [
		{
			id: "continuity_opened",
			label: "Open continuity",
			effects: [
				{ type: "set", variable: "continuity_stage", value: 1 },
				{ type: "scene", scene: "quiet_terminal" },
				{ type: "expression", expression: "reflective" },
			],
		},
		{
			id: "continuity_revealed",
			label: "Reveal continuity",
			when: { variable: "continuity_stage", equals: 1 },
			effects: [
				{ type: "set", variable: "continuity_stage", value: 2 },
				{ type: "expression", expression: "alert" },
			],
		},
		{
			id: "continuity_received",
			label: "Receive continuity",
			when: { variable: "continuity_stage", equals: 2 },
			effects: [
				{ type: "set", variable: "continuity_stage", value: 3 },
				{ type: "set", variable: "continuity_response", value: "received" },
				{ type: "unlock", unlockable: "continuity_record" },
				{ type: "media", media: "continuity_light" },
			],
		},
		{
			id: "continuity_set_down",
			label: "Set continuity down",
			when: { variable: "continuity_stage", equals: 2 },
			effects: [
				{ type: "set", variable: "continuity_stage", value: 3 },
				{ type: "set", variable: "continuity_response", value: "set_down" },
				{ type: "expression", expression: "calm" },
			],
		},
	],
	choice_sets: [
		{
			id: "continuity_response",
			prompt: "Legacy response?",
			choices: [
				{ id: "receive", label: "Receive", event: "continuity_received" },
				{ id: "set_down", label: "Set down", event: "continuity_set_down" },
			],
		},
	],
});

export function withLegacyRoleplay(character: CharacterPackage): CharacterPackage {
	return { ...character, roleplay: structuredClone(legacyRoleplay) };
}
