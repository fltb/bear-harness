// @vitest-environment node

import { describe, expect, it } from "vitest";
import { RoleplaySchema, roleplayAssetExtensions } from "../src/companion/roleplay-schema.js";

describe("roleplay package schema", () => {
	it("models scoped presentation data and natural-language choices", () => {
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
			choice_sets: [
				{
					id: "signal_reply",
					prompt: "Reply?",
					choices: [
						{
							id: "wait",
							label: "Wait",
							message: "I chose to wait.",
						},
						{
							id: "leave",
							label: "Leave",
							message: "I chose to leave.",
						},
					],
				},
			],
		});
		expect(parsed.media[0]?.loop).toBe(false);
		expect(roleplayAssetExtensions("animation").has(".gif")).toBe(true);
		expect(roleplayAssetExtensions("video").has(".gif")).toBe(false);
	});

	it("rejects the removed global scope", () => {
		expect(() =>
			RoleplaySchema.parse({
				variables: [
					{
						id: "legacy",
						type: "boolean",
						scope: "global",
						initial: false,
						display: { kind: "hidden" },
					},
				],
				media: [],
				unlockables: [],
				choice_sets: [],
			}),
		).toThrow();
	});
});
