// @vitest-environment node

import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
		expect(display.character.work_presentation).toEqual({
			labels: {
				proposal: "要交给下级程序的事",
				running: "下级程序正在处理",
				needs_user: "这一步得你决定",
				interrupted: "工作先停在这里",
				completed: "带回来的东西",
				failed: "没有办成",
				steer_placeholder: "补充一句要怎么做",
				interrupt: "叫停",
				resume: "继续处理",
				approve: "交给它们",
				reject: "这次算了",
				artifact_open: "打开",
				artifact_reveal: "在 Finder 中显示",
			},
		});
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

describe("character package Host lifecycle reactions", () => {
	const expectedReactions = [
		{ event: "message.user_sent", visual_state: "listening" },
		{ event: "message_end", visual_state: "result_ready" },
		{ event: "message.aborted", visual_state: "presence" },
	];

	function packageWithManifest(
		prefix: string,
		mutate: (manifest: string) => string,
	): { configRoot: string; manifest: string } {
		const configRoot = mkdtempSync(join(tmpdir(), prefix));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		const mutated = mutate(manifest);
		expect(mutated).not.toBe(manifest);
		writeFileSync(manifestPath, mutated);
		return { configRoot, manifest: mutated };
	}

	it("loads the official package with exactly the fixed lifecycle bindings", () => {
		const character = new CharacterLoader(characterRoot).load("jizhou");
		expect(character).not.toBeNull();
		expect(character?.host.event_reactions).toEqual(expectedReactions);
	});

	it.each([
		[
			"missing",
			(manifest: string) =>
				manifest.replace("    - event: message.aborted\n      visual_state: presence\n", ""),
		],
		[
			"extra",
			(manifest: string) =>
				manifest.replace(
					"    - event: message.aborted\n      visual_state: presence\n",
					"    - event: message.aborted\n      visual_state: presence\n    - event: message.custom\n      visual_state: presence\n",
				),
		],
		[
			"wrong state",
			(manifest: string) =>
				manifest.replace(
					"    - event: message.user_sent\n      visual_state: listening\n",
					"    - event: message.user_sent\n      visual_state: presence\n",
				),
		],
		[
			"forbidden scene effect",
			(manifest: string) =>
				manifest.replace(
					"    - event: message.user_sent\n      visual_state: listening\n",
					"    - event: message.user_sent\n      visual_state: listening\n      scene: aurora_study\n",
				),
		],
		[
			"forbidden media effect",
			(manifest: string) =>
				manifest.replace(
					"    - event: message.user_sent\n      visual_state: listening\n",
					"    - event: message.user_sent\n      visual_state: listening\n      media: first_night\n",
				),
		],
		[
			"forbidden choice effect",
			(manifest: string) =>
				manifest.replace(
					"    - event: message.user_sent\n      visual_state: listening\n",
					"    - event: message.user_sent\n      visual_state: listening\n      choice_set: damaged_log_response\n",
				),
		],
	] as const)("rejects %s lifecycle reaction mutation", (_name, mutate) => {
		const { configRoot } = packageWithManifest(
			`bear-character-package-host-reaction-${_name.replace(/\s+/g, "-")}-`,
			mutate,
		);
		expect(() => new CharacterLoader(configRoot).load("jizhou")).toThrow(
			/invalid host event reaction/,
		);
	});

	it("accepts the fixed bindings in any declaration order", () => {
		const bindings = [
			"    - event: message.user_sent\n      visual_state: listening\n",
			"    - event: message_end\n      visual_state: result_ready\n",
			"    - event: message.aborted\n      visual_state: presence\n",
		];
		const { configRoot } = packageWithManifest(
			"bear-character-package-host-reaction-reordered-",
			(manifest) =>
				manifest.replace(bindings.join(""), [bindings[2], bindings[0], bindings[1]].join("")),
		);
		const character = new CharacterLoader(configRoot).load("jizhou");
		expect(character).not.toBeNull();
		expect(character?.host.event_reactions).toEqual([
			expectedReactions[2],
			expectedReactions[0],
			expectedReactions[1],
		]);
	});
});

describe("character package roleplay media presentation", () => {
	it("projects explicit presentations and defaults omitted presentation to dialog", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-package-media-presentation-"));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		writeFileSync(join(packageDir, "assets", "ambient-signal.mp3"), "audio");
		writeFileSync(join(packageDir, "assets", "ambient-signal.vtt"), "WEBVTT\n");
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		const withPresentations = manifest
			.replace(
				"      asset: assets/scene-aurora-study.png",
				"      asset: assets/scene-aurora-study.png\n      presentation: inline",
			)
			.replace(
				"      loop: true\n  unlockables:",
				[
					"      loop: true",
					"    - id: ambient_signal",
					"      kind: audio",
					"      label: Ambient signal",
					"      asset: assets/ambient-signal.mp3",
					"      captions: assets/ambient-signal.vtt",
					"      presentation: ambient",
					"  unlockables:",
				].join("\n"),
			);
		expect(withPresentations).not.toBe(manifest);
		writeFileSync(manifestPath, withPresentations);

		const loader = new CharacterLoader(configRoot);
		const character = loader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("test package failed to load");
		const media = loader.display(character).roleplay.media;
		expect(media.find((entry) => entry.id === "first_night")).toEqual(
			expect.objectContaining({ presentation: "inline" }),
		);
		expect(media.find((entry) => entry.id === "damaged_signal_live")).toEqual(
			expect.objectContaining({ presentation: "dialog" }),
		);
		expect(media.find((entry) => entry.id === "ambient_signal")).toEqual(
			expect.objectContaining({ kind: "audio", presentation: "ambient" }),
		);
	});

	it("rejects ambient presentation for image media", () => {
		const configRoot = mkdtempSync(
			join(tmpdir(), "bear-character-package-invalid-media-presentation-"),
		);
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		const invalidManifest = manifest.replace(
			"      asset: assets/scene-aurora-study.png",
			"      asset: assets/scene-aurora-study.png\n      presentation: ambient",
		);
		expect(invalidManifest).not.toBe(manifest);
		writeFileSync(manifestPath, invalidManifest);

		const loader = new CharacterLoader(configRoot);
		expect(() => loader.load("jizhou")).toThrow();
	});
});

describe("character package work presentation", () => {
	it("keeps work presentation optional for packages that do not declare it", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-package-no-work-"));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		const withoutWorkPresentation = manifest.replace(
			/  work_presentation:\n    labels:\n(?:      [^\n]+\n){13}/,
			"",
		);
		expect(withoutWorkPresentation).not.toBe(manifest);
		writeFileSync(manifestPath, withoutWorkPresentation);

		const loader = new CharacterLoader(configRoot);
		const character = loader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("test package failed to load");
		expect(loader.display(character).character.work_presentation).toBeUndefined();
	});

	it("rejects blank and unknown work presentation labels", () => {
		for (const [name, mutate] of [
			[
				"blank",
				(manifest: string) => manifest.replace('proposal: "要交给下级程序的事"', 'proposal: " "'),
			],
			[
				"unknown",
				(manifest: string) =>
					manifest.replace(
						'      artifact_reveal: "在 Finder 中显示"',
						'      artifact_reveal: "在 Finder 中显示"\n      unknown: "未知"',
					),
			],
		] as const) {
			const configRoot = mkdtempSync(join(tmpdir(), `bear-character-package-${name}-`));
			temporaryDirectories.push(configRoot);
			const packageDir = join(configRoot, "jizhou");
			cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
			const manifestPath = join(packageDir, "character.yaml");
			const manifest = readFileSync(manifestPath, "utf8");
			writeFileSync(manifestPath, mutate(manifest));

			const loader = new CharacterLoader(configRoot);
			expect(() => loader.load("jizhou")).toThrow(
				/character package jizhou: work presentation labels are invalid/,
			);
		}
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
