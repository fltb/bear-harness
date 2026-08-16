// @vitest-environment node

import { describe, expect, it } from "vitest";
import { RoleplaySchema, roleplayAssetExtensions } from "../src/companion/roleplay-schema.js";

describe("roleplay package schema", () => {
	it("models scoped state, deterministic events, choices and animated media", () => {
		const parsed = RoleplaySchema.parse({
			variables: [
				{
					id: "trust",
					type: "number",
					scope: "relationship",
					initial: 0,
					display: { kind: "exact", label: "Trust" },
				},
			],
			media: [
				{
					id: "signal",
					kind: "animation",
					label: "Signal",
					asset: "assets/signal.webp",
					poster: "assets/signal.png",
				},
			],
			unlockables: [
				{ id: "signal_cg", kind: "cg", label: "Signal", description: "", media: "signal" },
			],
			events: [
				{
					id: "signal_found",
					label: "Signal found",
					effects: [
						{ type: "increment", variable: "trust", by: 1 },
						{ type: "unlock", unlockable: "signal_cg" },
					],
				},
			],
			choice_sets: [
				{
					id: "signal_reply",
					prompt: "Reply?",
					choices: [
						{ id: "wait", label: "Wait", event: "signal_found" },
						{ id: "leave", label: "Leave", event: "signal_found" },
					],
				},
			],
		});
		expect(parsed.media[0]?.loop).toBe(false);
		expect(roleplayAssetExtensions("animation").has(".gif")).toBe(true);
		expect(roleplayAssetExtensions("video").has(".gif")).toBe(false);
	});
});
