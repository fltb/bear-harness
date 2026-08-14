/**
 * Character package loader — reads YAML role packages from
 * `config/characters/<id>/character.yaml`.
 *
 * This is the SINGLE source of truth for all character-specific content:
 * Canon, Identity Core, Self Canon, theme tokens, scene titles, first
 * meeting text, visual states, asset manifests — every string that belongs
 * to the character lives here, never in product code.
 *
 * At boot the loader parses the active character's YAML, seeds the canonical
 * DB, and makes the package available to the rest of the Host.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThemeTokens {
	radius: { sm: number; md: number; lg: number };
	color: Record<string, string>;
	font: Record<string, string>;
}

export interface CharacterStrings {
	subtitle: string;
	scene_title: string;
	greeting: string;
	composer_placeholder: string;
	correction: { trigger_label: string; reason_group_label: string };
	first_meeting: {
		step_label: string;
		door_closed: { heading: string; body: string; button: string };
		introduced: { heading: string; body: string; quote: string; button: string };
		naming: { heading: string; body: string; input_placeholder: string; button: string };
		relation: {
			heading: string;
			body: string;
			choices: Array<{ id: string; label: string; description: string }>;
		};
		memory_decision: { heading: string; body: string; accept: string; decline: string; note: string };
		voice_ready: { heading: string; body: string };
		complete: { heading: string; body: string };
	};
}

export interface ScenePreset {
	id: string;
	label: string;
	background: string | null;
	description: string;
}

export interface VisualStateEntry {
	id: string;
	label: string;
}

export interface VisualState {
	required: VisualStateEntry[];
	optional: VisualStateEntry[];
}

export interface CharacterVisuals {
	default_scene: string;
	avatar: string;
	presence: Record<string, string>;
}

export interface CharacterPackage {
	id: string;
	name: string;
	version: string;
	theme: ThemeTokens;
	character: CharacterStrings;
	identity_core: string;
	self_canon: string;
	scenes: ScenePreset[];
	visual_states: VisualState;
	visual: CharacterVisuals;
	manifest: Array<{ path: string; type: string; description: string }>;
}

export interface CharacterDisplay {
	id: string;
	name: string;
	character: CharacterStrings;
	theme: ThemeTokens;
	scenes: Array<{
		id: string;
		label: string;
		description: string;
		backgroundUrl?: string;
	}>;
	visual: {
		defaultSceneId: string;
		avatarUrl: string;
		presence: Record<string, string>;
		stateLabels: Record<string, string>;
	};
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_CONFIG_ROOT = join(__dirname, "..", "..", "..", "..", "..", "config", "characters");
const PRESENCE_ASSET_KEYS = [
	"presence",
	"listening",
	"thinking",
	"needs_user",
	"result_ready",
	"problem",
] as const;
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	".avif": "image/avif",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
};

/** Resolve config from an explicit override, shipped resource, or source tree. */
function configRoot(): string {
	if (process.env.BEAR_CONFIG_DIR) return process.env.BEAR_CONFIG_DIR;
	const runtime = process as NodeJS.Process & { resourcesPath?: string };
	const shippedRoot = runtime.resourcesPath
		? join(runtime.resourcesPath, "config", "characters")
		: undefined;
	return shippedRoot && existsSync(shippedRoot) ? shippedRoot : SOURCE_CONFIG_ROOT;
}

/**
 * Resolve a declared package asset without allowing it to leave that
 * package's directory. This is the filesystem boundary for package assets.
 */
function characterAssetPath(characterId: string, assetPath: string): string {
	const packageDir = resolve(configRoot(), characterId);
	const resolvedAsset = resolve(packageDir, assetPath);
	const packageRelativePath = relative(packageDir, resolvedAsset);
	if (
		!assetPath ||
		packageRelativePath.length === 0 ||
		packageRelativePath === ".." ||
		packageRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(packageRelativePath)
	) {
		throw new Error(`character package ${characterId}: asset path escapes package: ${assetPath}`);
	}
	if (!existsSync(resolvedAsset)) {
		throw new Error(`character package ${characterId}: manifest asset missing: ${assetPath}`);
	}
	return resolvedAsset;
}

/**
 * Convert a validated package image to a data URL. This is the only
 * filesystem-to-renderer asset boundary: callers receive no file path.
 */
function characterAssetDataUrl(characterId: string, assetPath: string): string {
	const mime = IMAGE_MIME_BY_EXTENSION[extname(assetPath).toLowerCase()];
	if (!mime) {
		throw new Error(`character package ${characterId}: unsupported image asset: ${assetPath}`);
	}
	return `data:${mime};base64,${readFileSync(characterAssetPath(characterId, assetPath)).toString("base64")}`;
}

/**
 * Load and validate a character package. There is deliberately no default or
 * compatibility path: a missing field/asset is a package error.
 */
export function loadCharacter(id: string): CharacterPackage | null {
	const path = join(configRoot(), id, "character.yaml");
	if (!existsSync(path)) return null;
	const parsed = parse(readFileSync(path, "utf8")) as CharacterPackage;
	if (parsed.id !== id) {
		throw new Error(`character package ${id}: yaml id must equal directory id`);
	}
	if (!Array.isArray(parsed.manifest) || !Array.isArray(parsed.scenes)) {
		throw new Error(`character package ${id}: manifest and scenes are required arrays`);
	}
	const manifestPaths = new Set<string>();
	for (const asset of parsed.manifest) {
		if (!asset || typeof asset.path !== "string" || typeof asset.type !== "string") {
			throw new Error(`character package ${id}: invalid manifest entry`);
		}
		characterAssetPath(id, asset.path);
		manifestPaths.add(asset.path);
	}
	if (
		!parsed.visual ||
		typeof parsed.visual.default_scene !== "string" ||
		typeof parsed.visual.avatar !== "string" ||
		!parsed.visual.presence ||
		typeof parsed.visual.presence !== "object"
	) {
		throw new Error(
			`character package ${id}: visual.default_scene, visual.avatar and visual.presence are required`,
		);
	}
	if (!parsed.scenes.some((scene) => scene.id === parsed.visual.default_scene)) {
		throw new Error(`character package ${id}: visual.default_scene is not a declared scene`);
	}
	if (!manifestPaths.has(parsed.visual.avatar)) {
		throw new Error(`character package ${id}: visual.avatar must reference a manifest asset`);
	}
	for (const state of PRESENCE_ASSET_KEYS) {
		const assetPath = parsed.visual.presence[state];
		if (typeof assetPath !== "string" || !manifestPaths.has(assetPath)) {
			throw new Error(`character package ${id}: visual.presence.${state} must reference a manifest asset`);
		}
	}
	for (const scene of parsed.scenes) {
		if (!scene || typeof scene.id !== "string" || typeof scene.label !== "string") {
			throw new Error(`character package ${id}: invalid scene`);
		}
		if (scene.background !== null && (!manifestPaths.has(scene.background) || typeof scene.background !== "string")) {
			throw new Error(`character package ${id}: scene ${scene.id} background must reference a manifest asset`);
		}
	}
	return parsed;
}

/** Project package presentation data into renderer-safe strings and data URLs. */
export function characterDisplay(character: CharacterPackage): CharacterDisplay {
	const stateLabels = Object.fromEntries(
		[...character.visual_states.required, ...character.visual_states.optional].map((state) => [
			state.id,
			state.label.replaceAll("{name}", character.name),
		]),
	);
	return {
		id: character.id,
		name: character.name,
		character: character.character,
		theme: character.theme,
		scenes: character.scenes.map((scene) => ({
			id: scene.id,
			label: scene.label,
			description: scene.description,
			...(scene.background ? { backgroundUrl: characterAssetDataUrl(character.id, scene.background) } : {}),
		})),
		visual: {
			defaultSceneId: character.visual.default_scene,
			avatarUrl: characterAssetDataUrl(character.id, character.visual.avatar),
			presence: Object.fromEntries(
				PRESENCE_ASSET_KEYS.map((state) => {
					const assetPath = character.visual.presence[state];
					if (typeof assetPath !== "string") {
						throw new Error(`character package ${character.id}: missing presence asset for ${state}`);
					}
					return [state, characterAssetDataUrl(character.id, assetPath)];
				}),
			),
			stateLabels,
		},
	};
}

export function getActiveCharacterId(db: DatabaseSync, defaultCharacterId: string): string {
	const row = db
		.prepare("SELECT id FROM companion_identity LIMIT 1")
		.get() as { id: string } | undefined;
	return row?.id ?? defaultCharacterId;
}

/** Seed the database from a character package. Idempotent (checks companion_identity). */
export function seedCharacterPackage(
	db: DatabaseSync,
	eventBus: EventBus,
	character: CharacterPackage,
): void {
	const existing = db
		.prepare("SELECT id FROM companion_identity WHERE id = ?")
		.get(character.id) as { id: string } | undefined;
	if (existing) return; // already seeded

	db.exec("BEGIN IMMEDIATE");
	try {
		const packageHash = createHash("sha256")
			.update(character.id)
			.update("\0")
			.update(character.version)
			.update("\0")
			.update(character.name)
			.update("\0")
			.update(character.identity_core)
			.update("\0")
			.update(character.self_canon)
			.digest("hex");
		db.prepare(
			`INSERT INTO companion_packages (id, name, version, hash)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, hash = excluded.hash`,
		).run(character.id, character.name, character.version, packageHash);
		// Insert the companion identity
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
		).run(character.id, character.id, character.name, character.self_canon);

		// Insert the first Self Canon version
		db.prepare(
			"INSERT INTO self_canon_versions (companion_id, canon, version, hash) VALUES (?, ?, 1, ?)",
		).run(character.id, character.self_canon, createHash("sha256").update(character.self_canon).digest("hex"));

		// The first meeting FSM creates the initial conversation, so we don't seed one here.

		db.exec("COMMIT");
		eventBus.publish("character.seeded", { id: character.id, name: character.name });
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}