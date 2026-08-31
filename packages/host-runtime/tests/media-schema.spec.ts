import { describe, expect, it } from "vitest";
import { CharacterMediaSchema, mediaAssetExtensions } from "../src/companion/media-schema.js";

describe("character media package schema", () => {
	it("accepts descriptive top-level media without presentation state", () => {
		expect(
			CharacterMediaSchema.parse([
				{
					id: "signal",
					kind: "image",
					label: "Signal",
					description: "A damaged relay signal.",
					use_when: "When the user opens the relay record.",
					asset: "assets/signal.webp",
				},
			]),
		).toEqual([
			{
				id: "signal",
				kind: "image",
				label: "Signal",
				description: "A damaged relay signal.",
				use_when: "When the user opens the relay record.",
				asset: "assets/signal.webp",
				loop: false,
			},
		]);
	});

	it("rejects the deleted presentation and condition fields", () => {
		for (const field of ["presentation", "when", "choice_sets"])
			expect(() =>
				CharacterMediaSchema.parse([
					{
						id: "signal",
						kind: "image",
						label: "Signal",
						description: "A damaged relay signal.",
						use_when: "When the user opens the relay record.",
						asset: "assets/signal.webp",
						[field]: field === "choice_sets" ? [] : "inline",
					},
				]),
			).toThrow();
	});

	it("keeps media extension validation explicit", () => {
		expect(mediaAssetExtensions("animation").has(".gif")).toBe(true);
		expect(mediaAssetExtensions("video").has(".gif")).toBe(false);
	});
});
