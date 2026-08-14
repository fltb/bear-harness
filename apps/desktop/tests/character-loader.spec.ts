// @vitest-environment node

import { describe, expect, it } from "vitest";
import { characterDisplay, loadCharacter } from "../src/main/companion/character-loader.js";

describe("character package visual projection", () => {
	it("projects declared SVG assets as renderer-safe data URLs", () => {
		const character = loadCharacter("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("jizhou package is required for the official build");

		const display = characterDisplay(character);
		expect(display.visual.avatarUrl).toMatch(/^data:image\/svg\+xml;base64,/);
		for (const state of [
			"presence",
			"listening",
			"thinking",
			"needs_user",
			"result_ready",
			"problem",
		]) {
			expect(display.visual.presence[state]).toMatch(/^data:image\/svg\+xml;base64,/);
		}
		expect(display.scenes).toContainEqual(
			expect.objectContaining({
			id: "aurora_study",
			backgroundUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
		}),
		);
		const quietDesktop = display.scenes.find((scene) => scene.id === "quiet_desktop");
		expect(quietDesktop).toBeDefined();
		expect(quietDesktop?.backgroundUrl).toBeUndefined();
	});
});
