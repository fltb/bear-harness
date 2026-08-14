// @vitest-environment node

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { characterDisplay, characterPiResources, loadCharacter } from "../src/main/companion/character-loader.js";

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

describe("character package Pi resources", () => {
	it("discovers only role-owned Skills and plugins by package convention", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-package-"));
		const source = resolve(process.cwd(), "../../config/characters/jizhou");
		const packageDir = join(configRoot, "jizhou");
		cpSync(source, packageDir, { recursive: true });
		mkdirSync(join(packageDir, "skills", "station-log"), { recursive: true });
		mkdirSync(join(packageDir, "plugins", "station-log"), { recursive: true });
		writeFileSync(
			join(packageDir, "skills", "station-log", "SKILL.md"),
			"---\\nname: station-log\\ndescription: Read the station log.\\n---\\nUse the station log.\\n",
		);
		writeFileSync(
			join(packageDir, "plugins", "station-log", "extension.ts"),
			"export default function stationLog() {}\\n",
		);
		const previousConfigRoot = process.env.BEAR_CONFIG_DIR;
		process.env.BEAR_CONFIG_DIR = configRoot;
		try {
			const character = loadCharacter("jizhou");
			expect(character).not.toBeNull();
			if (!character) throw new Error("test package failed to load");
			const resources = characterPiResources(character);
			expect(resources.skillPaths).toEqual([realpathSync(join(packageDir, "skills"))]);
			expect(resources.pluginPaths).toEqual([
				realpathSync(join(packageDir, "plugins", "station-log", "extension.ts")),
			]);
		} finally {
			if (previousConfigRoot === undefined) delete process.env.BEAR_CONFIG_DIR;
			else process.env.BEAR_CONFIG_DIR = previousConfigRoot;
			rmSync(configRoot, { recursive: true, force: true });
		}
	});
});
