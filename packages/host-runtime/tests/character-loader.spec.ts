// @vitest-environment node

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("character package visual projection", () => {
	it("projects declared SVG assets as renderer-safe data URLs", () => {
		const loader = new CharacterLoader(characterRoot);
		const character = loader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("jizhou package is required for the official build");

		const display = loader.display(character);
		expect(display.language).toBe("zh-CN");
		expect(character.canon.manifest).toEqual(
			expect.objectContaining({ version: 1, language: "zh-CN", sources: [] }),
		);
		expect(character.canon.manifest.modules).toContainEqual(
			expect.objectContaining({ id: "original_root", kind: "root", bindings: [] }),
		);
		expect(display.theme.color.accent).toBe("#8bd0bb");
		expect(display.visual.avatarUrl).toMatch(/^data:image\/(?:png|svg\+xml);base64,/);
		for (const state of [
			"presence",
			"listening",
			"thinking",
			"needs_user",
			"result_ready",
			"problem",
		]) {
			expect(display.visual.expressions[state]).toMatch(/^data:image\/(?:png|svg\+xml);base64,/);
		}
		expect(display.visual.defaultExpressionId).toBe("presence");
		expect(Object.keys(display.visual.expressions)).toHaveLength(12);
		expect(new Set(character.visual.expressions.map((expression) => expression.asset)).size).toBe(
			12,
		);
		expect(display.roleplay.media).toContainEqual(
			expect.objectContaining({
				id: "damaged_signal_live",
				kind: "animation",
				url: expect.stringMatching(/^data:image\/webp;base64,/),
			}),
		);
		expect(display.scenes).toContainEqual(
			expect.objectContaining({
				id: "aurora_study",
				backgroundUrl: expect.stringMatching(/^data:image\/png;base64,/),
			}),
		);
		expect(display.scenes).toContainEqual(
			expect.objectContaining({
				id: "snow_plains",
				backgroundUrl: expect.stringMatching(/^data:image\/png;base64,/),
			}),
		);
		const quietDesktop = display.scenes.find((scene) => scene.id === "quiet_desktop");
		expect(quietDesktop).toBeDefined();
		expect(quietDesktop?.backgroundUrl).toBeUndefined();
	});
});

describe("character package Pi resources", () => {
	it("discovers every official Jizhou Skill and executable plugin", () => {
		const loader = new CharacterLoader(characterRoot);
		const character = loader.load("jizhou");
		if (!character) throw new Error("jizhou package is required for the official build");
		const resources = loader.piResources(character);
		expect(resources.skillPaths).toEqual([
			realpathSync(resolve(characterRoot, "jizhou", "skills")),
		]);
		expect(resources.pluginPaths).toEqual([
			realpathSync(resolve(characterRoot, "jizhou", "plugins", "jizhou-roleplay.mjs")),
		]);
		expect(loader.piResources(character, false).pluginPaths).toEqual([]);
		expect(resources.hostTools).toEqual(
			expect.arrayContaining([
				"host_set_scene",
				"host_set_expression",
				"host_trigger_roleplay_event",
				"host_play_media",
				"host_present_choices",
			]),
		);
	});

	it("discovers only role-owned Skills and plugins by package convention", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-package-"));
		temporaryDirectories.push(configRoot);
		const source = resolve(characterRoot, "jizhou");
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
		const loader = new CharacterLoader(configRoot);
		const character = loader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("test package failed to load");
		const resources = loader.piResources(character);
		expect(resources.skillPaths).toEqual([realpathSync(join(packageDir, "skills"))]);
		expect(resources.pluginPaths).toContain(
			realpathSync(join(packageDir, "plugins", "station-log", "extension.ts")),
		);
	});
});
