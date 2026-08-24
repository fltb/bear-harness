// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	ARCTIC_CONSOLE_THEME,
	CharacterThemeOverridesSchema,
	resolveCharacterTheme,
} from "../src/companion/theme.js";

describe("character theme resolution", () => {
	it("inherits Host defaults for a partial role-package override", () => {
		const theme = resolveCharacterTheme({
			tokens: { canvas: "#07171c", accent: "#8bd0bb" },
		});

		expect(theme.tokens).toEqual({
			...ARCTIC_CONSOLE_THEME.tokens,
			canvas: "#07171c",
			accent: "#8bd0bb",
		});
		expect(theme.radius).toEqual(ARCTIC_CONSOLE_THEME.radius);
		expect(theme.font).toEqual(ARCTIC_CONSOLE_THEME.font);
	});

	it("rejects color syntax that cannot receive deterministic contrast validation", () => {
		expect(
			CharacterThemeOverridesSchema.safeParse({ tokens: { accent: "oklch(0.7 0.15 190)" } })
				.success,
		).toBe(false);
	});

	it("rejects an inaccessible resolved text pair", () => {
		expect(() => resolveCharacterTheme({ tokens: { text: "#111113" } })).toThrow(
			"text/canvas contrast",
		);
	});
});
