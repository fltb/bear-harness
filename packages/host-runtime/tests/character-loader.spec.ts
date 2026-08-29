// @vitest-environment node

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CharacterDisplay } from "@bear-harness/protocol/schema";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import {
	DURABLE_FILE_TRANSACTION_VERSION,
	type DurableFileTransactionMarker,
	durableFileTransactionMarkerPath,
} from "../src/storage/durable-file-transaction.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const characterTransactionId = "20000000-0000-4000-8000-000000000001";

function characterTransaction(
	libraryRoot: string,
	characterId: string,
	state: DurableFileTransactionMarker["state"],
): DurableFileTransactionMarker {
	return {
		version: DURABLE_FILE_TRANSACTION_VERSION,
		transactionId: characterTransactionId,
		target: join(libraryRoot, characterId),
		staging: join(libraryRoot, `.${characterId}.staging-${characterTransactionId}`),
		backup: join(libraryRoot, `.${characterId}.backup-${characterTransactionId}`),
		state,
	};
}

function persistCharacterTransaction(
	libraryRoot: string,
	marker: DurableFileTransactionMarker,
): void {
	writeFileSync(
		durableFileTransactionMarkerPath(libraryRoot, marker.target),
		`${JSON.stringify(marker)}\n`,
	);
}

function copyCharacterPackage(destination: string, characterId: string, label: string): void {
	cpSync(join(characterRoot, "jizhou"), destination, { recursive: true });
	const manifestPath = join(destination, "character.yaml");
	const manifest = readFileSync(manifestPath, "utf8").replace("id: jizhou", `id: ${characterId}`);
	writeFileSync(manifestPath, `${manifest}\n# transaction-copy: ${label}\n`, "utf8");
}

describe("character package visual projection", () => {
	it("projects declared SVG assets as renderer-safe data URLs", () => {
		const loader = new CharacterLoader(characterRoot);
		const character = loader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("jizhou package is required for the official build");

		const display = loader.display(character);
		expect(CharacterDisplay.safeParse(display).success).toBe(true);
		expect(display.language).toBe("zh-CN");
		expect(display.character.work_presentation).toEqual({
			labels: {
				proposal: "值守台上的方案",
				running: "正在处理",
				needs_user: "交给你确认",
				interrupted: "交接停在这里",
				completed: "交回的结果",
				failed: "这一步需要重做",
				steer_placeholder: "补充处理方式",
				interrupt: "暂停",
				resume: "继续",
				approve: "开始处理",
				reject: "保留原样",
				artifact_open: "打开",
				artifact_reveal: "在 Finder 中显示",
			},
		});
		expect(character.canon.manifest).toEqual(
			expect.objectContaining({
				version: 1,
				language: "zh-CN",
				sources: expect.arrayContaining([
					expect.objectContaining({ id: "jizhou_story", path: "jizhou-story.md" }),
					expect.objectContaining({
						id: "undelivered_report",
						path: "undelivered-report.md",
					}),
				]),
			}),
		);
		expect(character.canon.manifest.modules).toContainEqual(
			expect.objectContaining({
				id: "station_identity",
				kind: "root",
				access: { mode: "always" },
				bindings: [expect.objectContaining({ source: "jizhou_story" })],
			}),
		);
		expect(character.behavior.identity.invariants).toContainEqual(
			expect.stringContaining("不冒充岑岚"),
		);
		expect(character.voice_modes.default).toBe("default");
		expect(character.skills.map((skill) => skill.name).sort()).toEqual([
			"continuity-reveal",
			"undelivered-report",
		]);
		expect(display.theme.tokens).toEqual(
			expect.objectContaining({
				canvas: "#07171c",
				surface: "#102a31",
				surface_raised: "#183a40",
				accent: "#8bd0bb",
				text_on_accent: "#07171c",
			}),
		);
		expect(display.visual.avatarUrl).toMatch(/^data:image\/(?:png|svg\+xml);base64,/);
		for (const assetUrl of Object.values(display.visual.expressions)) {
			expect(assetUrl).toMatch(/^data:image\/(?:png|svg\+xml);base64,/);
		}
		expect(display.visual.defaultExpressionId).toBe("calm");
		expect(Object.keys(display.visual.expressions)).toHaveLength(12);
		expect(new Set(character.visual.expressions.map((expression) => expression.asset)).size).toBe(
			12,
		);
		expect(display.roleplay.media).toContainEqual(
			expect.objectContaining({
				id: "continuity_light",
				kind: "image",
				url: expect.stringMatching(/^data:image\/webp;base64,/),
			}),
		);
		expect(display.scenes).toContainEqual(
			expect.objectContaining({
				id: "study",
				backgroundUrl: expect.stringMatching(/^data:image\/png;base64,/),
			}),
		);
		expect(display.scenes).toContainEqual(
			expect.objectContaining({
				id: "snowfield",
				backgroundUrl: expect.stringMatching(/^data:image\/png;base64,/),
			}),
		);
		const quietDesktop = display.scenes.find((scene) => scene.id === "quiet_terminal");
		expect(quietDesktop).toBeDefined();
		expect(quietDesktop?.backgroundUrl).toMatch(/^data:image\/webp;base64,/);
	});
});

describe("character package display validation", () => {
	it("projects and parses an imported package display", () => {
		const installedRoot = mkdtempSync(join(tmpdir(), "bear-character-display-imported-"));
		temporaryDirectories.push(installedRoot);
		const packageDir = join(installedRoot, "imported-role");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		writeFileSync(manifestPath, manifest.replace("id: jizhou", "id: imported-role"));

		const loader = new CharacterLoader(characterRoot, installedRoot);
		const character = loader.load("imported-role");
		expect(character).not.toBeNull();
		if (!character) throw new Error("imported test package failed to load");
		const display = loader.display(character);
		expect(CharacterDisplay.parse(display)).toEqual(display);
		expect(display.roleplay.unlockables).toEqual(character.roleplay.unlockables);
		expect(display.roleplay.choice_sets).toEqual(
			character.roleplay.choice_sets.map(({ when: _when, ...choiceSet }) => choiceSet),
		);
	});

	it("supplies the Host theme when an imported package declares no theme", () => {
		const installedRoot = mkdtempSync(join(tmpdir(), "bear-character-theme-default-"));
		temporaryDirectories.push(installedRoot);
		const packageDir = join(installedRoot, "default-theme-role");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		writeFileSync(
			manifestPath,
			manifest
				.replace("id: jizhou", "id: default-theme-role")
				.replace(/^theme:\n(?: {2}.*\n)+\n/m, ""),
		);

		const character = new CharacterLoader(characterRoot, installedRoot).load("default-theme-role");
		expect(character?.theme.tokens).toEqual({
			canvas: "#111113",
			surface: "#18191b",
			surface_raised: "#212225",
			surface_interactive: "#272a2d",
			surface_selected: "#0b3a48",
			text: "#ecedee",
			text_muted: "#9ba1a6",
			text_on_accent: "#07171c",
			accent: "#00a2c7",
			accent_hover: "#4ccce6",
			border: "#43484e",
			border_focus: "#4ccce6",
			success: "#86ead4",
			warning: "#ffc53d",
			danger: "#ff9592",
		});
	});
});

describe("character package Host lifecycle reactions", () => {
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

	it("does not overwrite semantic expression state at lifecycle boundaries", () => {
		const character = new CharacterLoader(characterRoot).load("jizhou");
		expect(character).not.toBeNull();
		expect(character?.host.event_reactions).toEqual([]);
	});

	it("accepts arbitrary Host events bound to declared visual states", () => {
		const { configRoot } = packageWithManifest(
			"bear-character-package-host-reaction-generic-",
			(manifest) =>
				manifest.replace(
					"  event_reactions: []",
					"  event_reactions:\n    - event: workflow.review_requested\n      visual_state: reflective",
				),
		);
		const character = new CharacterLoader(configRoot).load("jizhou");
		expect(character?.host.event_reactions).toEqual([
			{ event: "workflow.review_requested", visual_state: "reflective" },
		]);
	});

	it.each([
		[
			"duplicate event",
			(manifest: string) =>
				manifest.replace(
					"  event_reactions: []",
					"  event_reactions:\n    - event: duplicate\n      visual_state: attentive\n    - event: duplicate\n      visual_state: calm",
				),
		],
		[
			"blank event",
			(manifest: string) =>
				manifest.replace(
					"  event_reactions: []",
					'  event_reactions:\n    - event: "   "\n      visual_state: attentive',
				),
		],
		[
			"unknown visual state",
			(manifest: string) =>
				manifest.replace(
					"  event_reactions: []",
					"  event_reactions:\n    - event: message.user_sent\n      visual_state: unknown_state",
				),
		],
		[
			"extra key",
			(manifest: string) =>
				manifest.replace(
					"  event_reactions: []",
					"  event_reactions:\n    - event: message.user_sent\n      visual_state: attentive\n      scene: study",
				),
		],
		[
			"media key",
			(manifest: string) =>
				manifest.replace(
					"  event_reactions: []",
					"  event_reactions:\n    - event: message.user_sent\n      visual_state: attentive\n      media: continuity_light",
				),
		],
		[
			"choice key",
			(manifest: string) =>
				manifest.replace(
					"  event_reactions: []",
					"  event_reactions:\n    - event: message.user_sent\n      visual_state: attentive\n      choice_set: continuity_response",
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
});

describe("character package roleplay media presentation", () => {
	it("projects explicit presentations and defaults omitted presentation to dialog", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-package-media-presentation-"));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		writeFileSync(join(packageDir, "assets", "ambient-signal.mp3"), "audio");
		writeFileSync(join(packageDir, "assets", "ambient-signal.vtt"), "WEBVTT\n");
		writeFileSync(join(packageDir, "assets", "chapter-video.mp4"), "video");
		writeFileSync(join(packageDir, "assets", "chapter-video.vtt"), "WEBVTT\n");
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		const withPresentations = manifest.replace(
			"  unlockables:",
			[
				"    - id: ambient_signal",
				"      kind: audio",
				"      label: Ambient signal",
				"      asset: assets/ambient-signal.mp3",
				"      captions: assets/ambient-signal.vtt",
				"      presentation: ambient",
				"    - id: chapter_video",
				"      kind: video",
				"      label: Chapter video",
				"      asset: assets/chapter-video.mp4",
				"      captions: assets/chapter-video.vtt",
				"      presentation: inline",
				"  unlockables:",
			].join("\n"),
		);
		expect(withPresentations).not.toBe(manifest);
		writeFileSync(manifestPath, withPresentations);

		const loader = new CharacterLoader(configRoot);
		const character = loader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("test package failed to load");
		const display = loader.display(character);
		expect(CharacterDisplay.parse(display)).toEqual(display);
		const media = display.roleplay.media;
		expect(media.find((entry) => entry.id === "continuity_light")).toEqual(
			expect.objectContaining({ presentation: "inline" }),
		);
		expect(media.find((entry) => entry.id === "ambient_signal")).toEqual(
			expect.objectContaining({ kind: "audio", presentation: "ambient" }),
		);
		expect(media.find((entry) => entry.id === "chapter_video")).toEqual(
			expect.objectContaining({ kind: "video", presentation: "inline" }),
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
			"      asset: assets/cg-damaged-signal-animated.webp",
			"      asset: assets/cg-damaged-signal-animated.webp\n      presentation: ambient",
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
			/ {2}work_presentation:\n {4}labels:\n(?: {6}[^\n]+\n){13}/,
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
				(manifest: string) => manifest.replace('proposal: "值守台上的方案"', 'proposal: " "'),
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
				/character package jizhou: (work presentation labels|character card) is invalid/,
			);
		}
	});
});

describe("character package Pi resources", () => {
	it("discovers Jizhou Skills without requiring a role plugin", () => {
		const loader = new CharacterLoader(characterRoot);
		const character = loader.load("jizhou");
		if (!character) throw new Error("jizhou package is required for the official build");
		const resources = loader.piResources(character);
		expect(resources.skillPaths).toEqual([
			realpathSync(resolve(characterRoot, "jizhou", "skills")),
		]);
		expect(resources.pluginPaths).toEqual([]);
		expect(loader.piResources(character, false).pluginPaths).toEqual([]);
		expect(resources.hostTools).toEqual([
			"host_state",
			"host_visual",
			"host_present",
			"host_history",
			"host_canon",
			"host_memory",
			"host_attachment",
			"host_delegate",
		]);
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
			`---
name: station-log
description: Read the station log.
triggers:
  include: [用户明确要求查看值守日志]
  exclude: [用户只提到日志一词]
requires:
  state: {}
allowed-tools: [host_canon]
completion:
  state: {}
priority: 10
---
Use the station log.
`,
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

describe("character package durable replacement", () => {
	it("upgrades the installed default package when the bundled seed version is newer", () => {
		const bundledVersion = new CharacterLoader(characterRoot).load("jizhou")?.version;
		if (!bundledVersion) throw new Error("missing bundled Jizhou package");
		const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-seed-upgrade-"));
		temporaryDirectories.push(libraryRoot);
		copyCharacterPackage(join(libraryRoot, "jizhou"), "jizhou", "installed-old");
		const installedManifest = join(libraryRoot, "jizhou", "character.yaml");
		writeFileSync(
			installedManifest,
			readFileSync(installedManifest, "utf8").replace(/^version: .+$/m, "version: 3.0.0"),
			"utf8",
		);

		const loader = new CharacterLoader(characterRoot, libraryRoot);
		loader.bootstrapLibrary("jizhou");

		expect(loader.load("jizhou")?.version).toBe(bundledVersion);
		expect(readFileSync(installedManifest, "utf8")).not.toContain("installed-old");
	});

	it("preserves an installed package when its version matches the bundled seed", () => {
		const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-seed-preserve-"));
		temporaryDirectories.push(libraryRoot);
		copyCharacterPackage(join(libraryRoot, "jizhou"), "jizhou", "same-version-edit");

		const loader = new CharacterLoader(characterRoot, libraryRoot);
		loader.bootstrapLibrary("jizhou");

		expect(readFileSync(join(libraryRoot, "jizhou", "character.yaml"), "utf8")).toContain(
			"same-version-edit",
		);
	});

	it("rejects an invalid staged edit without disturbing the old package", () => {
		const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-transaction-reject-"));
		temporaryDirectories.push(libraryRoot);
		copyCharacterPackage(join(libraryRoot, "jizhou"), "jizhou", "old");
		const loader = new CharacterLoader(characterRoot, libraryRoot);
		const initial = loader.readPackageDocument("jizhou");
		const invalidYaml = initial.yaml.replace("language: zh-CN", "language: not_a_language");

		expect(() =>
			loader.writePackageDocument({
				characterId: "jizhou",
				yaml: invalidYaml,
				expectedSha256: initial.sha256,
			}),
		).toThrow();

		expect(loader.readPackageDocument("jizhou").yaml).toBe(initial.yaml);
		expect(readdirSync(libraryRoot).filter((name) => name.startsWith(".jizhou"))).toEqual([]);
	});

	it.each([
		{ label: "edit after moving the target", characterId: "jizhou", state: "old-target-moved" },
		{ label: "edit after activation", characterId: "jizhou", state: "activated" },
		{
			label: "import after moving the target",
			characterId: "imported-recovery",
			state: "old-target-moved",
		},
		{ label: "import after activation", characterId: "imported-recovery", state: "activated" },
	] as const)(
		"recovers a valid $label crash as the complete new package",
		({ characterId, state }) => {
			const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-transaction-recover-"));
			temporaryDirectories.push(libraryRoot);
			const marker = characterTransaction(libraryRoot, characterId, state);
			if (characterId === "jizhou") {
				copyCharacterPackage(marker.target, characterId, "old");
			}
			if (state === "old-target-moved") {
				if (characterId === "jizhou") renameSync(marker.target, marker.backup);
				copyCharacterPackage(marker.staging, characterId, "new");
			} else {
				if (characterId === "jizhou") renameSync(marker.target, marker.backup);
				copyCharacterPackage(marker.target, characterId, "new");
			}
			persistCharacterTransaction(libraryRoot, marker);

			const loader = new CharacterLoader(characterRoot, libraryRoot);
			loader.bootstrapLibrary("jizhou");

			expect(loader.load(characterId)?.id).toBe(characterId);
			expect(readFileSync(join(marker.target, "character.yaml"), "utf8")).toContain(
				"# transaction-copy: new",
			);
			expect(existsSync(marker.staging)).toBe(false);
			expect(existsSync(marker.backup)).toBe(false);
			expect(existsSync(durableFileTransactionMarkerPath(libraryRoot, marker.target))).toBe(false);
		},
	);

	it("surfaces ambiguous recovery and preserves every package copy", () => {
		const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-transaction-ambiguous-"));
		temporaryDirectories.push(libraryRoot);
		const marker = characterTransaction(libraryRoot, "jizhou", "old-target-moved");
		copyCharacterPackage(marker.target, "jizhou", "target");
		copyCharacterPackage(marker.staging, "jizhou", "staging");
		copyCharacterPackage(marker.backup, "jizhou", "backup");
		persistCharacterTransaction(libraryRoot, marker);

		expect(() =>
			new CharacterLoader(characterRoot, libraryRoot).bootstrapLibrary("jizhou"),
		).toThrow(
			expect.objectContaining({
				kind: "conflict",
				reason: "recovery_required",
				details: expect.objectContaining({ characterId: "jizhou" }),
			}),
		);

		for (const [path, label] of [
			[marker.target, "target"],
			[marker.staging, "staging"],
			[marker.backup, "backup"],
		] as const) {
			expect(readFileSync(join(path, "character.yaml"), "utf8")).toContain(
				`# transaction-copy: ${label}`,
			);
		}
		expect(existsSync(durableFileTransactionMarkerPath(libraryRoot, marker.target))).toBe(true);
	});
});
