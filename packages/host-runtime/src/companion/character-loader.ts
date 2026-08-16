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

import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { z } from "@bear-harness/schema";
import { eq, sql } from "drizzle-orm";
import { parse } from "yaml";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import {
	activeCharacter,
	companionIdentity,
	companionPackages,
	selfCanonVersions,
} from "../storage/schema.js";
import {
	type CharacterOnboardingFlow,
	validateCharacterOnboardingFlow,
} from "./onboarding-schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThemeTokens {
	radius: { sm: number; md: number; lg: number };
	color: {
		surface: string;
		surface_alt: string;
		text: string;
		text_muted: string;
		accent: string;
		line: string;
		danger: string;
		amber: string;
	};
	font: { body: string; heading: string };
}

export interface CharacterStrings {
	subtitle: string;
	scene_title: string;
	greeting: string;
	composer_placeholder: string;
	correction: { trigger_label: string; reason_group_label: string };
	first_meeting: CharacterOnboardingFlow;
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

export interface HostEventReaction {
	event: string;
	visual_state: string;
}

export interface CharacterHostBehavior {
	event_reactions: HostEventReaction[];
}

export interface CompanionPiConfiguration {
	append_system_prompt: string;
}

export interface CharacterCompanionConfiguration {
	pi: CompanionPiConfiguration;
}

export interface CharacterPackage {
	id: string;
	name: string;
	version: string;
	language: string;
	theme: ThemeTokens;
	character: CharacterStrings;
	identity_core: string;
	self_canon: string;
	scenes: ScenePreset[];
	visual_states: VisualState;
	visual: CharacterVisuals;
	host: CharacterHostBehavior;
	companion: CharacterCompanionConfiguration;
}

export interface CharacterDisplay {
	id: string;
	name: string;
	language: string;
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

export interface CharacterSummary {
	id: string;
	name: string;
	version: string;
	subtitle: string;
	avatarUrl: string;
	active: boolean;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

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

const LanguageTagSchema = z
	.string()
	.max(35)
	.refine((value) => {
		try {
			return Intl.getCanonicalLocales(value).length === 1;
		} catch {
			return false;
		}
	}, "must be a valid BCP-47 language tag");

const SafeCssValueSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !/[;{}<>]/.test(value) && !/url\s*\(/i.test(value), "unsafe CSS value");

const ThemeTokensSchema = z.strictObject({
	radius: z.strictObject({
		sm: z.number().finite().min(0).max(40),
		md: z.number().finite().min(0).max(40),
		lg: z.number().finite().min(0).max(40),
	}),
	color: z.strictObject({
		surface: SafeCssValueSchema,
		surface_alt: SafeCssValueSchema,
		text: SafeCssValueSchema,
		text_muted: SafeCssValueSchema,
		accent: SafeCssValueSchema,
		line: SafeCssValueSchema,
		danger: SafeCssValueSchema,
		amber: SafeCssValueSchema,
	}),
	font: z.strictObject({ body: SafeCssValueSchema, heading: SafeCssValueSchema }),
});

function validateTheme(value: unknown, characterId: string): asserts value is ThemeTokens {
	const result = ThemeTokensSchema.safeParse(value);
	if (!result.success)
		throw new Error(`character package ${characterId}: theme tokens are invalid`);
}

/**
 * Character package loader — resolves role packages from an injected
 * `characterRoot` directory of `<characterId>/character.yaml` packages.
 *
 * The root is owned by the runtime (never derived from the source tree):
 * `createHostRuntime` passes `options.characterRoot` (with the
 * `BEAR_CONFIG_DIR` override applied), and every file read stays inside it.
 */
export class CharacterLoader {
	constructor(
		private readonly characterRoot: string,
		private readonly installedRoot?: string,
	) {
		if (installedRoot) mkdirSync(installedRoot, { recursive: true });
	}

	private packageRoot(characterId: string): string {
		for (const root of [this.installedRoot, this.characterRoot]) {
			if (root && existsSync(join(root, characterId, "character.yaml"))) return root;
		}
		return this.characterRoot;
	}

	/**
	 * Resolve package content without allowing it to leave that package's
	 * directory. This guards assets, Pi skill directories, and Pi plugin paths.
	 */
	private characterPackagePath(characterId: string, packagePath: string): string {
		const charactersRoot = realpathSync(resolve(this.packageRoot(characterId)));
		const declaredPackageDir = resolve(charactersRoot, characterId);
		const packageRelativePath = relative(charactersRoot, declaredPackageDir);
		if (
			!characterId ||
			packageRelativePath.length === 0 ||
			packageRelativePath === ".." ||
			packageRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(packageRelativePath)
		) {
			throw new Error(`character package path escapes config root: ${characterId}`);
		}
		const packageDir = realpathSync(declaredPackageDir);
		const declaredPath = resolve(packageDir, packagePath);
		const declaredRelativePath = relative(packageDir, declaredPath);
		if (
			!packagePath ||
			declaredRelativePath.length === 0 ||
			declaredRelativePath === ".." ||
			declaredRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(declaredRelativePath)
		) {
			throw new Error(`character package ${characterId}: path escapes package: ${packagePath}`);
		}
		if (!existsSync(declaredPath)) {
			throw new Error(`character package ${characterId}: package content missing: ${packagePath}`);
		}
		const resolvedPath = realpathSync(declaredPath);
		const resolvedRelativePath = relative(packageDir, resolvedPath);
		if (
			resolvedRelativePath === ".." ||
			resolvedRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(resolvedRelativePath)
		) {
			throw new Error(
				`character package ${characterId}: path resolves outside package: ${packagePath}`,
			);
		}
		return resolvedPath;
	}

	/** Refuse symlinks anywhere in resources passed from a role package to Pi. */
	private ensureContainedTree(characterId: string, path: string): void {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			throw new Error(`character package ${characterId}: Pi resource symlinks are not allowed`);
		}
		if (!stat.isDirectory()) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			this.ensureContainedTree(characterId, join(path, entry.name));
		}
	}

	private ensureImageAsset(characterId: string, assetPath: string): void {
		if (!IMAGE_MIME_BY_EXTENSION[extname(assetPath).toLowerCase()]) {
			throw new Error(`character package ${characterId}: unsupported image asset: ${assetPath}`);
		}
		this.characterPackagePath(characterId, assetPath);
	}

	private collectPluginFiles(characterId: string, pluginsDir: string): string[] {
		this.ensureContainedTree(characterId, pluginsDir);
		const pluginPaths: string[] = [];
		const visit = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
				left.name.localeCompare(right.name),
			)) {
				const path = join(directory, entry.name);
				const stat = lstatSync(path);
				if (stat.isDirectory()) {
					visit(path);
				} else if (stat.isFile() && [".cjs", ".js", ".mjs", ".ts"].includes(extname(entry.name))) {
					pluginPaths.push(path);
				}
			}
		};
		visit(pluginsDir);
		return pluginPaths;
	}

	/**
	 * Convert a validated package image to a data URL. This is the only
	 * filesystem-to-renderer asset boundary: callers receive no file path.
	 */
	private characterAssetDataUrl(characterId: string, assetPath: string): string {
		const mime = IMAGE_MIME_BY_EXTENSION[extname(assetPath).toLowerCase()];
		if (!mime) {
			throw new Error(`character package ${characterId}: unsupported image asset: ${assetPath}`);
		}
		return `data:${mime};base64,${readFileSync(this.characterPackagePath(characterId, assetPath)).toString("base64")}`;
	}

	/**
	 * Load and validate a character package. There is deliberately no default or
	 * compatibility path: a missing field/asset is a package error.
	 */
	load(id: string): CharacterPackage | null {
		const path = join(this.packageRoot(id), id, "character.yaml");
		if (!existsSync(path)) return null;
		const parsed = parse(readFileSync(path, "utf8")) as CharacterPackage;
		if (parsed.id !== id) {
			throw new Error(`character package ${id}: yaml id must equal directory id`);
		}
		if (!LanguageTagSchema.safeParse(parsed.language).success) {
			throw new Error(`character package ${id}: language must be a BCP-47 language tag`);
		}
		validateTheme(parsed.theme, id);
		if (!Array.isArray(parsed.scenes)) {
			throw new Error(`character package ${id}: scenes is required array`);
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
		this.ensureImageAsset(id, parsed.visual.avatar);
		for (const state of PRESENCE_ASSET_KEYS) {
			const assetPath = parsed.visual.presence[state];
			if (typeof assetPath !== "string") {
				throw new Error(`character package ${id}: visual.presence.${state} is required`);
			}
			this.ensureImageAsset(id, assetPath);
		}
		for (const scene of parsed.scenes) {
			if (!scene || typeof scene.id !== "string" || typeof scene.label !== "string") {
				throw new Error(`character package ${id}: invalid scene`);
			}
			if (scene.background !== null) {
				if (typeof scene.background !== "string") {
					throw new Error(`character package ${id}: scene ${scene.id} background is invalid`);
				}
				this.ensureImageAsset(id, scene.background);
			}
		}
		if (
			!parsed.host ||
			!Array.isArray(parsed.host.event_reactions) ||
			!parsed.companion ||
			!parsed.companion.pi ||
			typeof parsed.companion.pi.append_system_prompt !== "string"
		) {
			throw new Error(
				`character package ${id}: host reactions and companion.pi configuration are required`,
			);
		}
		const validStates = new Set([
			...parsed.visual_states.required.map((state) => state.id),
			...parsed.visual_states.optional.map((state) => state.id),
		]);
		const reactionEvents = new Set<string>();
		for (const reaction of parsed.host.event_reactions) {
			if (
				!reaction ||
				typeof reaction.event !== "string" ||
				typeof reaction.visual_state !== "string" ||
				reactionEvents.has(reaction.event) ||
				!validStates.has(reaction.visual_state) ||
				typeof parsed.visual.presence[reaction.visual_state] !== "string"
			) {
				throw new Error(`character package ${id}: invalid or duplicate host event reaction`);
			}
			reactionEvents.add(reaction.event);
		}
		validateCharacterOnboardingFlow(parsed.character?.first_meeting, id);
		return parsed;
	}

	/**
	 * Resolve role-owned Pi resources by convention, not YAML plumbing:
	 * `skills/…/SKILL.md` and JavaScript or TypeScript files below `plugins/` are optional,
	 * package-private extensions of a role. Missing directories mean no role-
	 * specific dynamic behavior.
	 */
	piResources(character: CharacterPackage): {
		skillPaths: string[];
		pluginPaths: string[];
		appendSystemPrompt: string;
	} {
		const packageDir = resolve(this.packageRoot(character.id), character.id);
		const skillsDir = join(packageDir, "skills");
		const pluginsDir = join(packageDir, "plugins");
		const skillPaths = existsSync(skillsDir)
			? [this.characterPackagePath(character.id, "skills")]
			: [];
		const pluginRoot = existsSync(pluginsDir)
			? this.characterPackagePath(character.id, "plugins")
			: undefined;
		const pluginPaths = pluginRoot ? this.collectPluginFiles(character.id, pluginRoot) : [];
		for (const path of skillPaths) this.ensureContainedTree(character.id, path);
		return {
			skillPaths,
			pluginPaths,
			appendSystemPrompt: `${character.identity_core}\n\n${character.companion.pi.append_system_prompt}`,
		};
	}

	/** Project package presentation data into renderer-safe strings and data URLs. */
	display(character: CharacterPackage): CharacterDisplay {
		const stateLabels = Object.fromEntries(
			[...character.visual_states.required, ...character.visual_states.optional].map((state) => [
				state.id,
				state.label.replaceAll("{name}", character.name),
			]),
		);
		return {
			id: character.id,
			name: character.name,
			language: character.language,
			character: character.character,
			theme: character.theme,
			scenes: character.scenes.map((scene) => ({
				id: scene.id,
				label: scene.label,
				description: scene.description,
				...(scene.background
					? { backgroundUrl: this.characterAssetDataUrl(character.id, scene.background) }
					: {}),
			})),
			visual: {
				defaultSceneId: character.visual.default_scene,
				avatarUrl: this.characterAssetDataUrl(character.id, character.visual.avatar),
				presence: Object.fromEntries(
					PRESENCE_ASSET_KEYS.map((state) => {
						const assetPath = character.visual.presence[state];
						if (typeof assetPath !== "string") {
							throw new Error(
								`character package ${character.id}: missing presence asset for ${state}`,
							);
						}
						return [state, this.characterAssetDataUrl(character.id, assetPath)];
					}),
				),
				stateLabels,
			},
		};
	}

	getActiveCharacterId(db: AppDatabase, defaultCharacterId: string): string {
		const row = db
			.select({ characterId: activeCharacter.characterId })
			.from(activeCharacter)
			.where(eq(activeCharacter.singleton, 1))
			.get();
		return row?.characterId ?? defaultCharacterId;
	}

	list(db: AppDatabase, defaultCharacterId: string): CharacterSummary[] {
		const activeId = this.getActiveCharacterId(db, defaultCharacterId);
		const ids = new Set<string>();
		for (const root of [this.characterRoot, this.installedRoot]) {
			if (!root || !existsSync(root)) continue;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (entry.isDirectory() && !entry.name.startsWith(".")) ids.add(entry.name);
			}
		}
		return [...ids]
			.sort()
			.map((id) => this.load(id))
			.filter((character): character is CharacterPackage => character !== null)
			.map((character) => ({
				id: character.id,
				name: character.name,
				version: character.version,
				subtitle: character.character.subtitle,
				avatarUrl: this.characterAssetDataUrl(character.id, character.visual.avatar),
				active: character.id === activeId,
			}));
	}

	install(files: Array<{ path: string; base64: string }>): CharacterPackage {
		if (!this.installedRoot) throw { kind: "unavailable", reason: "character_import_unavailable" };
		let totalBytes = 0;
		const normalized = files.map((file) => {
			const path = file.path.replaceAll("\\", "/").replace(/^\.\//, "");
			if (!path || posix.isAbsolute(path) || path.split("/").includes("..")) {
				throw { kind: "invalid_request", reason: "character_package_path_invalid" };
			}
			const buffer = Buffer.from(file.base64, "base64");
			totalBytes += buffer.byteLength;
			return { path, buffer };
		});
		if (totalBytes > 25 * 1024 * 1024) {
			throw { kind: "invalid_request", reason: "character_package_too_large" };
		}
		const manifest =
			normalized.find((file) => file.path === "character.yaml") ??
			normalized.find(
				(file) => file.path.split("/").length === 2 && file.path.endsWith("/character.yaml"),
			);
		if (!manifest) throw { kind: "invalid_request", reason: "character_manifest_missing" };
		const prefix =
			manifest.path === "character.yaml" ? "" : manifest.path.slice(0, -"character.yaml".length);
		const document = parse(manifest.buffer.toString("utf8")) as { id?: unknown };
		if (typeof document?.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(document.id)) {
			throw { kind: "invalid_request", reason: "character_id_invalid" };
		}
		const id = document.id;
		if (this.load(id)) throw { kind: "conflict", reason: "character_package_already_exists" };
		const stagingRoot = join(this.installedRoot, `.import-${randomUUID()}`);
		const stagingPackage = join(stagingRoot, id);
		mkdirSync(stagingPackage, { recursive: true });
		try {
			for (const file of normalized) {
				if (prefix && !file.path.startsWith(prefix)) {
					throw { kind: "invalid_request", reason: "character_package_multiple_roots" };
				}
				const localPath = prefix ? file.path.slice(prefix.length) : file.path;
				if (!localPath) continue;
				const target = join(stagingPackage, ...localPath.split("/"));
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, file.buffer, { mode: 0o600 });
			}
			const stagedLoader = new CharacterLoader(stagingRoot);
			const character = stagedLoader.load(id);
			if (!character) throw { kind: "invalid_request", reason: "character_manifest_missing" };
			const destination = join(this.installedRoot, id);
			const backup = `${destination}.backup-${randomUUID()}`;
			if (existsSync(destination)) renameSync(destination, backup);
			try {
				renameSync(stagingPackage, destination);
				rmSync(backup, { recursive: true, force: true });
			} catch (error) {
				if (existsSync(backup)) renameSync(backup, destination);
				throw error;
			}
			return character;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	activate(db: AppDatabase, eventBus: EventBus, character: CharacterPackage): void {
		this.seed(db, eventBus, character);
		db.insert(activeCharacter)
			.values({ singleton: 1, characterId: character.id })
			.onConflictDoUpdate({
				target: activeCharacter.singleton,
				set: { characterId: character.id, updatedAt: sql`datetime('now')` },
			})
			.run();
		eventBus.publish("character.activated", { characterId: character.id });
	}

	/** Seed the database from a character package. Idempotent (checks companion_identity). */
	seed(db: AppDatabase, eventBus: EventBus, character: CharacterPackage): void {
		const existing = db
			.select({ id: companionIdentity.id })
			.from(companionIdentity)
			.where(eq(companionIdentity.id, character.id))
			.get();
		if (existing) return; // already seeded

		db.transaction((transaction) => {
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
			transaction
				.insert(companionPackages)
				.values({
					id: character.id,
					name: character.name,
					version: character.version,
					hash: packageHash,
				})
				.onConflictDoUpdate({
					target: companionPackages.id,
					set: { name: character.name, version: character.version, hash: packageHash },
				})
				.run();
			// Insert the companion identity
			transaction
				.insert(companionIdentity)
				.values({
					id: character.id,
					packageId: character.id,
					name: character.name,
					selfCanon: character.self_canon,
				})
				.run();

			// Insert the first Self Canon version
			transaction
				.insert(selfCanonVersions)
				.values({
					companionId: character.id,
					canon: character.self_canon,
					version: 1,
					hash: createHash("sha256").update(character.self_canon).digest("hex"),
				})
				.run();

			// The first meeting FSM creates the initial conversation, so we don't seed one here.
		});
		eventBus.publish("character.seeded", { id: character.id, name: character.name });
	}
}
