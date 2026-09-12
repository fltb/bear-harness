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
import { parse, stringify } from "yaml";
import { CharacterLoader } from "../src/companion/character-loader.js";
import {
	type DurableFileTransactionMarker,
	durableFileTransactionMarkerPath,
} from "../src/storage/durable-file-transaction.js";

const characterRoot = fileURLToPath(new URL("./fixtures/characters", import.meta.url));
const officialCharacterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
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
		schemaVersion: 1,
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
	it("reuses one validated package until its manifest bytes change", () => {
		const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-load-cache-"));
		temporaryDirectories.push(libraryRoot);
		copyCharacterPackage(join(libraryRoot, "jizhou"), "jizhou", "cached");
		const loader = new CharacterLoader(characterRoot, libraryRoot);
		const first = loader.load("jizhou");
		expect(loader.load("jizhou")).toBe(first);

		const manifestPath = join(libraryRoot, "jizhou", "character.yaml");
		writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}\n# externally-updated\n`);
		const updated = loader.load("jizhou");
		expect(updated).not.toBe(first);
		expect(loader.load("jizhou")).toBe(updated);
	});

	it("loads the shipped package and projects its declared assets safely", () => {
		const loader = new CharacterLoader(officialCharacterRoot);
		const character = loader.load("jizhou");
		if (!character) throw new Error("jizhou package is required for the official build");
		const display = loader.display(character);
		expect(CharacterDisplay.safeParse(display).success).toBe(true);
		expect(display.visual.avatarUrl).toMatch(/^data:image\/(?:png|svg\+xml);base64,/);
		for (const assetUrl of Object.values(display.visual.expressions)) {
			expect(assetUrl).toMatch(/^data:image\/(?:png|svg\+xml);base64,/);
		}
		expect(display.visual.expressions).toHaveProperty(character.visual.default_expression);
		for (const media of display.media) {
			expect(media.url).toMatch(/^data:[^;]+;base64,/);
		}
		for (const scene of display.scenes) {
			if (scene.backgroundUrl) expect(scene.backgroundUrl).toMatch(/^data:image\/[^;]+;base64,/);
		}
	});
});

describe("character package display validation", () => {
	it("allows original Canon text to use a different language from the character UI", () => {
		const installedRoot = mkdtempSync(join(tmpdir(), "bear-character-canon-language-"));
		temporaryDirectories.push(installedRoot);
		const packageDir = join(installedRoot, "translated-role");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = parse(readFileSync(manifestPath, "utf8"));
		manifest.id = "translated-role";
		writeFileSync(manifestPath, stringify(manifest));
		const canonPath = join(packageDir, "canon", "manifest.yaml");
		const canon = parse(readFileSync(canonPath, "utf8"));
		canon.language = "en-US";
		writeFileSync(canonPath, stringify(canon));
		const loader = new CharacterLoader(characterRoot, installedRoot);
		const character = loader.load("translated-role");
		if (!character) throw new Error("Imported character must load");
		expect(loader.display(character).language).toBe("zh-CN");
		expect(character.canon.manifest.language).toBe("en-US");
	});

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
		expect(display.media.map((media) => media.id)).toEqual(
			character.media.map((media) => media.id),
		);
	});

	it("supplies the Host theme when an imported package declares no theme", () => {
		const installedRoot = mkdtempSync(join(tmpdir(), "bear-character-theme-default-"));
		temporaryDirectories.push(installedRoot);
		const packageDir = join(installedRoot, "default-theme-role");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = parse(readFileSync(manifestPath, "utf8"));
		manifest.id = "default-theme-role";
		delete manifest.theme;
		writeFileSync(manifestPath, stringify(manifest));

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

describe("character package media", () => {
	it("projects audio and video metadata without presentation state", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-package-media-"));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		writeFileSync(join(packageDir, "assets", "ambient-signal.mp3"), "audio");
		writeFileSync(join(packageDir, "assets", "ambient-signal.vtt"), "WEBVTT\n");
		writeFileSync(join(packageDir, "assets", "chapter-video.mp4"), "video");
		writeFileSync(join(packageDir, "assets", "chapter-video.vtt"), "WEBVTT\n");
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = parse(readFileSync(manifestPath, "utf8"));
		manifest.media.push(
			{
				id: "ambient_signal",
				kind: "audio",
				label: "Ambient signal",
				description: "A damaged ambient signal.",
				use_when: "When requested.",
				asset: "assets/ambient-signal.mp3",
				captions: "assets/ambient-signal.vtt",
			},
			{
				id: "chapter_video",
				kind: "video",
				label: "Chapter video",
				description: "A chapter recording.",
				use_when: "When requested.",
				asset: "assets/chapter-video.mp4",
				captions: "assets/chapter-video.vtt",
			},
		);
		writeFileSync(manifestPath, stringify(manifest));

		const loader = new CharacterLoader(configRoot);
		const character = loader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("test package failed to load");
		const display = loader.display(character);
		expect(CharacterDisplay.parse(display)).toEqual(display);
		const media = display.media;
		expect(media.find((entry) => entry.id === "ambient_signal")).toEqual(
			expect.objectContaining({ kind: "audio", description: "A damaged ambient signal." }),
		);
		expect(media.find((entry) => entry.id === "chapter_video")).toEqual(
			expect.objectContaining({ kind: "video", use_when: expect.any(String) }),
		);
	});

	it("rejects the deleted presentation field", () => {
		const configRoot = mkdtempSync(
			join(tmpdir(), "bear-character-package-deleted-media-presentation-"),
		);
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = parse(readFileSync(manifestPath, "utf8"));
		manifest.media[0].presentation = "inline";
		writeFileSync(manifestPath, stringify(manifest));

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
		const manifest = parse(readFileSync(manifestPath, "utf8"));
		delete manifest.character.work_presentation;
		writeFileSync(manifestPath, stringify(manifest));

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
				(manifest: { character: { work_presentation: { labels: Record<string, string> } } }) => {
					manifest.character.work_presentation.labels.proposal = " ";
				},
			],
			[
				"unknown",
				(manifest: { character: { work_presentation: { labels: Record<string, string> } } }) => {
					manifest.character.work_presentation.labels.unknown = "未知";
				},
			],
		] as const) {
			const configRoot = mkdtempSync(join(tmpdir(), `bear-character-package-${name}-`));
			temporaryDirectories.push(configRoot);
			const packageDir = join(configRoot, "jizhou");
			cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
			const manifestPath = join(packageDir, "character.yaml");
			const manifest = parse(readFileSync(manifestPath, "utf8"));
			mutate(manifest);
			writeFileSync(manifestPath, stringify(manifest));

			const loader = new CharacterLoader(configRoot);
			expect(() => loader.load("jizhou")).toThrow(
				/character package jizhou: manifest character\.work_presentation\.labels/,
			);
		}
	});
});

describe("character package Pi resources", () => {
	it("discovers Jizhou Skills without requiring a role plugin", () => {
		const loader = new CharacterLoader(officialCharacterRoot);
		const character = loader.load("jizhou");
		if (!character) throw new Error("jizhou package is required for the official build");
		expect(character.skills.map((skill) => skill.name)).toEqual(["undelivered-report"]);
		const resources = loader.piResources(character);
		expect(resources.skillPaths).toEqual([
			realpathSync(resolve(officialCharacterRoot, "jizhou", "skills")),
		]);
		expect(resources.pluginPaths).toEqual([]);
		expect(loader.piResources(character, false).pluginPaths).toEqual([]);
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
	it("preserves the staged package validation cause", () => {
		const seedRoot = mkdtempSync(join(tmpdir(), "bear-character-invalid-seed-"));
		const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-invalid-library-"));
		temporaryDirectories.push(seedRoot, libraryRoot);
		copyCharacterPackage(join(seedRoot, "jizhou"), "jizhou", "invalid-seed");
		rmSync(join(seedRoot, "jizhou", "canon", "manifest.yaml"));
		const loader = new CharacterLoader(seedRoot, libraryRoot);

		try {
			loader.bootstrapLibrary("jizhou");
			throw new Error("expected invalid staged package to be rejected");
		} catch (error) {
			expect(error).toMatchObject({
				code: "verification-failed",
				message: expect.stringContaining("package content missing: canon/manifest.yaml"),
				cause: expect.objectContaining({
					message: expect.stringContaining("package content missing: canon/manifest.yaml"),
				}),
			});
		}
	});

	it("preserves an installed package", () => {
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

		const loader = new CharacterLoader(characterRoot, libraryRoot);
		loader.bootstrapLibrary("jizhou");
		expect(() => loader.load("jizhou")).toThrow(
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

	it("does not let an inactive package recovery failure block the default package", () => {
		const libraryRoot = mkdtempSync(join(tmpdir(), "bear-character-inactive-recovery-"));
		temporaryDirectories.push(libraryRoot);
		copyCharacterPackage(join(libraryRoot, "jizhou"), "jizhou", "default");
		const marker = characterTransaction(libraryRoot, "inactive-role", "old-target-moved");
		copyCharacterPackage(marker.target, "inactive-role", "target");
		copyCharacterPackage(marker.staging, "inactive-role", "staging");
		copyCharacterPackage(marker.backup, "inactive-role", "backup");
		persistCharacterTransaction(libraryRoot, marker);

		const loader = new CharacterLoader(characterRoot, libraryRoot);
		loader.bootstrapLibrary("jizhou");
		expect(loader.load("jizhou")?.id).toBe("jizhou");
		expect(() => loader.load("inactive-role")).toThrow(
			expect.objectContaining({ reason: "recovery_required" }),
		);
	});
});
