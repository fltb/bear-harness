/**
 * Character package loader — reads YAML role packages from
 * `config/characters/<id>/character.yaml`.
 *
 * This is the SINGLE source of truth for all character-specific content:
 * Canon, Identity Core, Self Canon, theme tokens, scene titles, first
 * meeting text, visual states, asset manifests — every string that belongs
 * to the character lives here, never in product code.
 *
 * Package-declared constants, asset paths/content, and Pi resources are
 * Host-owned role-package storage (the package storage bucket). They are not
 * relationship memory and must never be emitted as automatic memory capture,
 * user memory-panel records, or long-term memory-backend inputs. The package
 * snapshot below is therefore a package-storage type, distinct from Host
 * memory records.
 *
 * At boot the loader parses the active character's YAML, seeds the canonical
 * DB, and makes the package available to the rest of the Host.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { CharacterTheme } from "@bear-harness/protocol/schema";
import { z } from "@bear-harness/schema";
import { eq, sql } from "drizzle-orm";
import { parse } from "yaml";
import {
	CanonPackageManifestSchema,
	type LoadedCanonPackage,
	validateCanonManifest,
} from "../canon/package-schema.js";
import type { AppDatabase } from "../storage/database.js";
import {
	type DurableFileRecoveryResult,
	recoverDurableFileTransactionSync,
	replaceDurableFileSync,
} from "../storage/durable-file-transaction.js";
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
import {
	type RoleplayDefinition,
	RoleplaySchema,
	roleplayAssetExtensions,
} from "./roleplay-schema.js";
import { type CharacterStateDefinition, CharacterStateSchema } from "./state-schema.js";
import { CharacterThemeOverridesSchema, resolveCharacterTheme } from "./theme.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemeTokens = CharacterTheme;

export interface CharacterWorkPresentationLabels {
	proposal: string;
	running: string;
	needs_user: string;
	interrupted: string;
	completed: string;
	failed: string;
	steer_placeholder: string;
	interrupt: string;
	resume: string;
	approve: string;
	reject: string;
	artifact_open: string;
	artifact_reveal: string;
}

export interface CharacterWorkPresentation {
	labels: CharacterWorkPresentationLabels;
}

export interface CharacterStrings {
	subtitle: string;
	scene_title: string;
	greeting: string;
	composer_placeholder: string;
	correction: {
		trigger_label: string;
		reason_group_label: string;
		presets: Array<{ id: string; label: string; prompt: string }>;
		custom_label: string;
		custom_placeholder: string;
		custom_prompt_template: string;
	};
	work_presentation?: CharacterWorkPresentation;
	first_meeting: CharacterOnboardingFlow;
}
export interface ScenePreset {
	id: string;
	label: string;
	background: string | null;
	description: string;
	use_when: string;
}

export interface CharacterExpression {
	id: string;
	label: string;
	asset: string;
	use_when: string;
}

export interface CharacterVisuals {
	default_scene: string;
	default_expression: string;
	avatar: string;
	expressions: CharacterExpression[];
}

export interface HostEventReaction {
	event: string;
	visual_state: string;
}

export interface CharacterHostBehavior {
	event_reactions: HostEventReaction[];
}

export interface VoiceMode {
	id: string;
	label: string;
	description: string;
	style_instruction: string;
	use_when: string;
}
export interface CharacterPrompt {
	description: string;
	personality: string;
	scenario: string;
	system_prompt: string;
	mes_example: string;
}

/**
 * Host-owned role-package storage snapshot (the package storage bucket).
 *
 * The declared constants (`theme`, `character`, identity/canon text, scene and
 * roleplay definitions), asset references, and package resources remain
 * package data even when Host projects selected values into UI or prompt
 * context. They are never relationship-memory entries or memory-backend
 * input records.
 */
export interface CharacterPackage {
	id: string;
	name: string;
	version: string;
	language: string;
	theme: ThemeTokens;
	character: CharacterStrings;
	prompt: CharacterPrompt;
	self_canon: string;
	voice_modes?: VoiceMode[];
	scenes: ScenePreset[];
	visual: CharacterVisuals;
	host: CharacterHostBehavior;
	state: CharacterStateDefinition;
	roleplay: RoleplayDefinition;
	canon: LoadedCanonPackage;
}

type CharacterDisplayMediaBase = Pick<
	RoleplayDefinition["media"][number],
	"id" | "label" | "loop"
> & {
	url: string;
};
type CharacterDisplayMedia =
	| (CharacterDisplayMediaBase & {
			kind: "image";
			presentation: "dialog" | "inline";
			posterUrl?: string;
	  })
	| (CharacterDisplayMediaBase & {
			kind: "animation";
			presentation: "dialog" | "inline";
			posterUrl: string;
	  })
	| (CharacterDisplayMediaBase & {
			kind: "audio";
			presentation: "dialog" | "inline" | "ambient";
			posterUrl?: string;
			captionsUrl: string;
	  })
	| (CharacterDisplayMediaBase & {
			kind: "video";
			presentation: "dialog" | "inline";
			posterUrl?: string;
			captionsUrl: string;
	  });

export interface CharacterDisplay {
	id: string;
	name: string;
	language: string;
	character: CharacterStrings;
	prompt: CharacterPrompt;
	theme: ThemeTokens;
	scenes: Array<{
		id: string;
		label: string;
		description: string;
		backgroundUrl?: string;
	}>;
	visual: {
		defaultSceneId: string;
		defaultExpressionId: string;
		avatarUrl: string;
		expressions: Record<string, string>;
		expressionLabels: Record<string, string>;
	};
	roleplay: {
		variables: RoleplayDefinition["variables"];
		media: CharacterDisplayMedia[];
		unlockables: RoleplayDefinition["unlockables"];
		choice_sets: RoleplayDefinition["choice_sets"];
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

export type CharacterPackageOrigin = "official" | "local" | "imported";

export interface CharacterPluginTrust {
	characterId: string;
	origin: CharacterPackageOrigin;
	pluginHash: string;
	pluginsPresent: boolean;
	trusted: boolean;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	".avif": "image/avif",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
};
const MEDIA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	...IMAGE_MIME_BY_EXTENSION,
	".apng": "image/apng",
	".flac": "audio/flac",
	".m4a": "audio/mp4",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".ogv": "video/ogg",
	".webm": "video/webm",
	".vtt": "text/vtt",
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

const WorkPresentationLabelSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => value.trim().length > 0, "must not be blank");
const WorkPresentationSchema = z.strictObject({
	labels: z.strictObject({
		proposal: WorkPresentationLabelSchema,
		running: WorkPresentationLabelSchema,
		needs_user: WorkPresentationLabelSchema,
		interrupted: WorkPresentationLabelSchema,
		completed: WorkPresentationLabelSchema,
		failed: WorkPresentationLabelSchema,
		steer_placeholder: WorkPresentationLabelSchema,
		interrupt: WorkPresentationLabelSchema,
		resume: WorkPresentationLabelSchema,
		approve: WorkPresentationLabelSchema,
		reject: WorkPresentationLabelSchema,
		artifact_open: WorkPresentationLabelSchema,
		artifact_reveal: WorkPresentationLabelSchema,
	}),
});

const PromptStringSchema = z.string().max(65536);
const CharacterPromptSchema = z.strictObject({
	description: PromptStringSchema,
	personality: PromptStringSchema,
	scenario: PromptStringSchema,
	system_prompt: PromptStringSchema,
	mes_example: PromptStringSchema,
});

const ThemeTokensSchema = CharacterThemeOverridesSchema;

function validateWorkPresentation(
	value: unknown,
	characterId: string,
): asserts value is CharacterWorkPresentation | undefined {
	if (value === undefined) return;
	if (!WorkPresentationSchema.safeParse(value).success) {
		throw new Error(`character package ${characterId}: work presentation labels are invalid`);
	}
}

function resolveTheme(value: unknown, characterId: string): ThemeTokens {
	const result = ThemeTokensSchema.safeParse(value);
	if (!result.success)
		throw new Error(`character package ${characterId}: theme tokens are invalid`);
	try {
		return resolveCharacterTheme(result.data);
	} catch (error) {
		throw new Error(
			`character package ${characterId}: ${error instanceof Error ? error.message : "theme tokens are invalid"}`,
		);
	}
}
function validateCharacterCard(
	value: unknown,
	characterId: string,
): asserts value is CharacterStrings {
	const schema = z.strictObject({
		subtitle: z.string(),
		scene_title: z.string(),
		greeting: z.string(),
		composer_placeholder: z.string(),
		correction: z.strictObject({
			trigger_label: z.string(),
			reason_group_label: z.string(),
			presets: z
				.array(
					z.strictObject({ id: z.string().min(1), label: z.string(), prompt: z.string().min(1) }),
				)
				.min(1),
			custom_label: z.string(),
			custom_placeholder: z.string(),
			custom_prompt_template: z.string().min(1),
		}),
		work_presentation: WorkPresentationSchema.optional(),
		first_meeting: z.unknown(),
	});
	if (!schema.safeParse(value).success)
		throw new Error(`character package ${characterId}: character card is invalid`);
}

/**
 * Character packages are loaded exclusively from the user-owned library.
 * The seed root is read only during bootstrap, before any package is loaded.
 */
export class CharacterLoader {
	constructor(
		private readonly seedRoot: string,
		private readonly libraryRoot: string = seedRoot,
		private readonly packageOverride?: Readonly<{ id: string; directory: string }>,
	) {
		mkdirSync(libraryRoot, { recursive: true });
		if (!packageOverride) this.recoverPackageTransactions();
	}

	bootstrapLibrary(defaultCharacterId: string): void {
		this.recoverPackageTransactions();
		const libraryHasPackage = readdirSync(this.libraryRoot, { withFileTypes: true }).some(
			(entry) =>
				entry.isDirectory() &&
				!entry.name.startsWith(".") &&
				existsSync(join(this.libraryRoot, entry.name, "character.yaml")),
		);
		if (libraryHasPackage) return;
		const source = join(this.seedRoot, defaultCharacterId);
		if (!existsSync(join(source, "character.yaml"))) {
			throw new Error(`default character seed missing: ${defaultCharacterId}`);
		}
		replaceDurableFileSync({
			root: this.libraryRoot,
			target: join(this.libraryRoot, defaultCharacterId),
			stage: (staging) => cpSync(source, staging, { recursive: true, errorOnExist: true }),
			verify: (candidate) => this.verifyPackageDirectory(defaultCharacterId, candidate),
		});
	}

	private recoverPackageTransactions(): void {
		const markerPattern = /^\.([a-z0-9][a-z0-9-]{0,63})\.durable-transaction\.json$/;
		const markers = readdirSync(this.libraryRoot, { withFileTypes: true })
			.filter((entry) => markerPattern.test(entry.name))
			.map((entry) => {
				const match = markerPattern.exec(entry.name);
				if (!match?.[1]) throw new Error(`invalid character transaction marker: ${entry.name}`);
				return { characterId: match[1], name: entry.name };
			})
			.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		for (const { characterId } of markers) {
			let result: DurableFileRecoveryResult;
			try {
				result = recoverDurableFileTransactionSync({
					root: this.libraryRoot,
					target: join(this.libraryRoot, characterId),
					verify: (candidate) => this.verifyPackageDirectory(characterId, candidate),
				});
			} catch (error) {
				throw {
					kind: "conflict",
					reason: "recovery_required",
					details: {
						characterId,
						transaction: {
							status: "recovery-required",
							reason:
								error instanceof Error
									? error.message
									: "character package transaction cannot be recovered",
						},
					},
				};
			}
			if (result.status === "recovery-required") {
				throw {
					kind: "conflict",
					reason: "recovery_required",
					details: { characterId, transaction: result },
				};
			}
		}
	}

	private verifyPackageDirectory(characterId: string, directory: string): boolean {
		try {
			const verifier = new CharacterLoader(dirname(directory), dirname(directory), {
				id: characterId,
				directory,
			});
			return verifier.load(characterId) !== null;
		} catch {
			return false;
		}
	}

	private packageDirectory(characterId: string): string {
		return this.packageOverride?.id === characterId
			? this.packageOverride.directory
			: join(this.libraryRoot, characterId);
	}

	private packageOrigin(_character: CharacterPackage): CharacterPackageOrigin {
		return "local";
	}

	/**
	 * Resolve Host-owned role-package content without allowing it to leave that
	 * package's directory. This guards assets, Pi skill directories, and Pi
	 * plugin paths. Package content resolved here remains role-package storage;
	 * it is never a relationship-memory or memory-backend input.
	 */
	private characterPackagePath(characterId: string, packagePath: string): string {
		const charactersRoot = realpathSync(resolve(this.libraryRoot));
		const declaredPackageDir = resolve(this.packageDirectory(characterId));
		if (!characterId) {
			throw new Error(`character package path escapes config root: ${characterId}`);
		}
		if (lstatSync(declaredPackageDir).isSymbolicLink()) {
			throw new Error(`character package ${characterId}: package symlinks are not allowed`);
		}
		const packageDir = realpathSync(declaredPackageDir);
		const packageRelativePath = relative(charactersRoot, packageDir);
		if (
			packageRelativePath.length === 0 ||
			packageRelativePath === ".." ||
			packageRelativePath.startsWith(`..${sep}`) ||
			isAbsolute(packageRelativePath)
		) {
			throw new Error(`character package path escapes config root: ${characterId}`);
		}
		const declaredPath = resolve(packageDir, packagePath);
		const declaredRelativePath = relative(packageDir, declaredPath);
		if (
			!packagePath ||
			declaredRelativePath.length === 0 ||
			declaredRelativePath === ".." ||
			declaredRelativePath.startsWith(`..${sep}`) ||
			isAbsolute(declaredRelativePath)
		) {
			throw new Error(`character package ${characterId}: path escapes package: ${packagePath}`);
		}
		if (!existsSync(declaredPath)) {
			throw new Error(`character package ${characterId}: package content missing: ${packagePath}`);
		}
		let currentPath = packageDir;
		for (const part of declaredRelativePath.split(sep)) {
			currentPath = join(currentPath, part);
			if (lstatSync(currentPath).isSymbolicLink()) {
				throw new Error(
					`character package ${characterId}: package content symlinks are not allowed`,
				);
			}
		}
		const resolvedPath = realpathSync(declaredPath);
		const resolvedRelativePath = relative(packageDir, resolvedPath);
		if (
			resolvedRelativePath === ".." ||
			resolvedRelativePath.startsWith(`..${sep}`) ||
			isAbsolute(resolvedRelativePath)
		) {
			throw new Error(
				`character package ${characterId}: path resolves outside package: ${packagePath}`,
			);
		}
		return resolvedPath;
	}

	/**
	 * Refuse symlinks anywhere in role-package resources passed from the Host
	 * to Pi. These resources remain package-owned storage and are not memory
	 * records or automatic memory-capture input.
	 */
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
	 * The resulting renderer asset is still Host-owned role-package storage,
	 * never relationship memory or a memory-panel/backend input.
	 */
	private characterAssetDataUrl(characterId: string, assetPath: string): string {
		const mime = MEDIA_MIME_BY_EXTENSION[extname(assetPath).toLowerCase()];
		if (!mime) {
			throw new Error(`character package ${characterId}: unsupported image asset: ${assetPath}`);
		}
		return `data:${mime};base64,${readFileSync(this.characterPackagePath(characterId, assetPath)).toString("base64")}`;
	}

	/**
	 * Load and validate a character package. There is deliberately no default or
	 * compatibility path: a missing field/asset is a package error. The returned
	 * `CharacterPackage` is package storage, not a memory record.
	 */
	load(id: string): CharacterPackage | null {
		const path = join(this.packageDirectory(id), "character.yaml");
		if (!existsSync(path)) return null;
		const parsed = parse(readFileSync(path, "utf8")) as CharacterPackage;
		if (parsed.id !== id) {
			throw new Error(`character package ${id}: yaml id must equal directory id`);
		}
		if (!LanguageTagSchema.safeParse(parsed.language).success) {
			throw new Error(`character package ${id}: language must be a BCP-47 language tag`);
		}
		parsed.theme = resolveTheme(parsed.theme, id);
		if (!Array.isArray(parsed.scenes)) {
			throw new Error(`character package ${id}: scenes is required array`);
		}
		if (
			!parsed.visual ||
			typeof parsed.visual.default_scene !== "string" ||
			typeof parsed.visual.default_expression !== "string" ||
			typeof parsed.visual.avatar !== "string" ||
			!Array.isArray(parsed.visual.expressions) ||
			parsed.visual.expressions.length === 0
		) {
			throw new Error(
				`character package ${id}: visual.default_scene, visual.default_expression, visual.avatar and visual.expressions are required`,
			);
		}
		if (!parsed.scenes.some((scene) => scene.id === parsed.visual.default_scene)) {
			throw new Error(`character package ${id}: visual.default_scene is not a declared scene`);
		}
		this.ensureImageAsset(id, parsed.visual.avatar);
		const expressionIds = new Set<string>();
		for (const expression of parsed.visual.expressions) {
			if (
				!expression ||
				typeof expression.id !== "string" ||
				!/^[a-z][a-z0-9_]*$/.test(expression.id) ||
				typeof expression.label !== "string" ||
				typeof expression.asset !== "string" ||
				typeof expression.use_when !== "string" ||
				!expression.use_when.trim() ||
				expressionIds.has(expression.id)
			) {
				throw new Error(`character package ${id}: invalid or duplicate visual expression`);
			}
			expressionIds.add(expression.id);
			this.ensureImageAsset(id, expression.asset);
		}
		if (!expressionIds.has(parsed.visual.default_expression))
			throw new Error(`character package ${id}: visual.default_expression is not declared`);
		for (const scene of parsed.scenes) {
			if (
				!scene ||
				typeof scene.id !== "string" ||
				typeof scene.label !== "string" ||
				typeof scene.description !== "string" ||
				typeof scene.use_when !== "string" ||
				!scene.use_when.trim()
			) {
				throw new Error(`character package ${id}: invalid scene`);
			}
			if (scene.background !== null) {
				if (typeof scene.background !== "string") {
					throw new Error(`character package ${id}: scene ${scene.id} background is invalid`);
				}
				this.ensureImageAsset(id, scene.background);
			}
		}
		if (!parsed.host || !Array.isArray(parsed.host.event_reactions)) {
			throw new Error(`character package ${id}: host reactions are required`);
		}
		const promptResult = CharacterPromptSchema.safeParse(parsed.prompt);
		if (!promptResult.success) {
			throw new Error(`character package ${id}: prompt is invalid`);
		}
		validateCharacterCard(parsed.character, id);
		const state = CharacterStateSchema.parse(
			(parsed as CharacterPackage & { state_schema?: unknown }).state_schema ?? {},
		);
		const roleplay = RoleplaySchema.parse(parsed.roleplay);
		validateCharacterOnboardingFlow(parsed.character?.first_meeting, id, roleplay);
		validateWorkPresentation(parsed.character?.work_presentation, id);
		const canonManifestPath = this.characterPackagePath(id, "canon/manifest.yaml");
		const canonManifest = CanonPackageManifestSchema.parse(
			parse(readFileSync(canonManifestPath, "utf8")),
		);
		validateCanonManifest(canonManifest, id);
		if (canonManifest.language !== parsed.language)
			throw new Error(`character package ${id}: canon language must match character language`);
		const canonSources = canonManifest.sources.map((source) => ({
			...source,
			content: readFileSync(this.characterPackagePath(id, `canon/${source.path}`), "utf8"),
		}));
		const variableIds = new Set(roleplay.variables.map((entry) => entry.id));
		const mediaIds = new Set(roleplay.media.map((entry) => entry.id));
		const unlockableIds = new Set(roleplay.unlockables.map((entry) => entry.id));
		const eventIds = new Set(roleplay.events.map((entry) => entry.id));
		const reactions = parsed.host.event_reactions;
		const invalidReaction = () => {
			throw new Error(`character package ${id}: invalid host event reaction`);
		};
		const reactionEvents = new Set<string>();
		for (const reaction of reactions) {
			if (
				!reaction ||
				typeof reaction !== "object" ||
				Array.isArray(reaction) ||
				Object.keys(reaction).length !== 2 ||
				!("event" in reaction) ||
				!("visual_state" in reaction)
			)
				invalidReaction();
			const event = reaction.event;
			const visualState = reaction.visual_state;
			if (
				typeof event !== "string" ||
				!event.trim() ||
				typeof visualState !== "string" ||
				!visualState.trim() ||
				!expressionIds.has(visualState) ||
				reactionEvents.has(event)
			)
				invalidReaction();
			reactionEvents.add(event);
		}
		for (const variable of roleplay.variables) {
			const actualType = typeof variable.initial;
			if (
				(variable.type === "number" && actualType !== "number") ||
				(variable.type === "boolean" && actualType !== "boolean") ||
				((variable.type === "string" || variable.type === "enum") && actualType !== "string")
			)
				throw new Error(
					`character package ${id}: variable ${variable.id} initial value has the wrong type`,
				);
			if (
				variable.type === "enum" &&
				(!variable.values || !variable.values.includes(String(variable.initial)))
			)
				throw new Error(
					`character package ${id}: enum variable ${variable.id} must declare and use an allowed initial value`,
				);
		}
		for (const collection of [
			roleplay.variables,
			roleplay.media,
			roleplay.unlockables,
			roleplay.events,
			roleplay.choice_sets,
		]) {
			if (new Set(collection.map((entry) => entry.id)).size !== collection.length) {
				throw new Error(`character package ${id}: duplicate roleplay id`);
			}
		}
		for (const media of roleplay.media) {
			if (media.kind === "animation" && !media.poster)
				throw new Error(`character package ${id}: animation ${media.id} requires poster`);
			if ((media.kind === "audio" || media.kind === "video") && !media.captions)
				throw new Error(`character package ${id}: ${media.kind} ${media.id} requires captions`);
			const extension = extname(media.asset).toLowerCase();
			if (!roleplayAssetExtensions(media.kind).has(extension)) {
				throw new Error(
					`character package ${id}: media ${media.id} has an invalid ${media.kind} extension`,
				);
			}
			this.characterPackagePath(id, media.asset);
			if (media.poster) this.ensureImageAsset(id, media.poster);
			if (media.captions) {
				if (extname(media.captions).toLowerCase() !== ".vtt")
					throw new Error(`character package ${id}: media ${media.id} captions must be WebVTT`);
				this.characterPackagePath(id, media.captions);
			}
		}
		for (const unlockable of roleplay.unlockables) {
			if (unlockable.media && !mediaIds.has(unlockable.media))
				throw new Error(
					`character package ${id}: unlockable ${unlockable.id} references missing media`,
				);
		}
		for (const event of roleplay.events) {
			if (event.when)
				validateRoleplayConditionReferences(event.when, variableIds, unlockableIds, id, event.id);
			for (const effect of event.effects) {
				if (
					(effect.type === "set" || effect.type === "increment") &&
					!variableIds.has(effect.variable)
				)
					throw new Error(`character package ${id}: event ${event.id} references missing variable`);
				if (effect.type === "unlock" && !unlockableIds.has(effect.unlockable))
					throw new Error(
						`character package ${id}: event ${event.id} references missing unlockable`,
					);
				if (effect.type === "media" && !mediaIds.has(effect.media))
					throw new Error(`character package ${id}: event ${event.id} references missing media`);
				if (effect.type === "scene" && !parsed.scenes.some((scene) => scene.id === effect.scene))
					throw new Error(`character package ${id}: event ${event.id} references missing scene`);
				if (effect.type === "expression" && !expressionIds.has(effect.expression))
					throw new Error(
						`character package ${id}: event ${event.id} references missing expression`,
					);
			}
		}
		for (const set of roleplay.choice_sets) {
			if (new Set(set.choices.map((choice) => choice.id)).size !== set.choices.length)
				throw new Error(`character package ${id}: duplicate choice id in ${set.id}`);
			for (const choice of set.choices)
				if ("event" in choice && !eventIds.has(choice.event))
					throw new Error(`character package ${id}: choice ${choice.id} references missing event`);
		}
		parsed.state = state;
		parsed.roleplay = roleplay;
		parsed.canon = { manifest: canonManifest, sources: canonSources };
		return parsed;
	}

	pluginHash(character: CharacterPackage): string {
		const pluginsDir = join(resolve(this.packageDirectory(character.id)), "plugins");
		if (!existsSync(pluginsDir)) return "";
		const pluginRoot = this.characterPackagePath(character.id, "plugins");
		const hash = createHash("sha256");
		for (const path of this.collectPluginFiles(character.id, pluginRoot)) {
			hash.update(relative(pluginRoot, path));
			hash.update("\0");
			hash.update(readFileSync(path));
			hash.update("\0");
		}
		return hash.digest("hex");
	}

	pluginTrust(db: AppDatabase, character: CharacterPackage): CharacterPluginTrust {
		const pluginHash = this.pluginHash(character);
		const stored = db
			.select({
				origin: companionPackages.origin,
				pluginHash: companionPackages.pluginHash,
				pluginTrustedHash: companionPackages.pluginTrustedHash,
			})
			.from(companionPackages)
			.where(eq(companionPackages.id, character.id))
			.get();
		const origin = stored?.origin ?? this.packageOrigin(character);
		const trusted =
			pluginHash.length === 0 || origin === "official" || stored?.pluginTrustedHash === pluginHash;
		return {
			characterId: character.id,
			origin,
			pluginHash,
			pluginsPresent: pluginHash.length > 0,
			trusted,
		};
	}

	confirmPluginTrust(db: AppDatabase, character: CharacterPackage): CharacterPluginTrust {
		const trust = this.pluginTrust(db, character);
		db.update(companionPackages)
			.set({ pluginHash: trust.pluginHash, pluginTrustedHash: trust.pluginHash })
			.where(eq(companionPackages.id, character.id))
			.run();
		return { ...trust, trusted: true };
	}

	/**
	 * Resolve role-owned Skills and only explicitly trusted executable plugins.
	 * These are Host-owned role-package resources supplied to Pi; they are not
	 * relationship memory, automatic capture, user memory-panel records, or
	 * long-term memory-backend inputs.
	 */
	piResources(
		character: CharacterPackage,
		pluginsEnabled = true,
	): {
		skillPaths: string[];
		pluginPaths: string[];
		appendSystemPrompt: string;
		hostTools: string[];
	} {
		const packageDir = resolve(this.packageDirectory(character.id));
		const skillsDir = join(packageDir, "skills");
		const pluginsDir = join(packageDir, "plugins");
		const skillPaths = existsSync(skillsDir)
			? [this.characterPackagePath(character.id, "skills")]
			: [];
		const pluginRoot = existsSync(pluginsDir)
			? this.characterPackagePath(character.id, "plugins")
			: undefined;
		const pluginPaths =
			pluginsEnabled && pluginRoot ? this.collectPluginFiles(character.id, pluginRoot) : [];
		const mesExample = character.prompt.mes_example.trim();
		const exampleBlocks = mesExample
			.split(/^<START>\s*$/m)
			.map((block) =>
				block.trim().replaceAll("{{char}}", character.name).replaceAll("{{user}}", "用户"),
			)
			.filter(Boolean);
		const roleExamples = mesExample
			? `<role_examples>\n${(exampleBlocks.length > 0 ? exampleBlocks : [mesExample]).join("\n\n")}\n</role_examples>`
			: "";
		const appendSystemPrompt = [character.prompt.system_prompt.trim(), roleExamples]
			.filter(Boolean)
			.join("\n\n");
		return {
			skillPaths,
			pluginPaths,
			appendSystemPrompt,
			hostTools: [
				...(Object.keys(character.state.fields).length ? ["host_state"] : []),
				"host_visual",
				...(character.roleplay.media.length || character.roleplay.choice_sets.length
					? ["host_present"]
					: []),
				"host_history",
				...(character.canon.sources.length ? ["host_canon"] : []),
				"host_memory",
				"host_attachment",
				"host_delegate",
			],
		};
	}

	/** Project package presentation data into renderer-safe strings and data URLs. */
	display(character: CharacterPackage): CharacterDisplay {
		const expressionLabels = Object.fromEntries(
			character.visual.expressions.map((expression) => [
				expression.id,
				expression.label.replaceAll("{name}", character.name),
			]),
		);
		return {
			id: character.id,
			name: character.name,
			language: character.language,
			character: character.character,
			prompt: character.prompt,
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
				defaultExpressionId: character.visual.default_expression,
				avatarUrl: this.characterAssetDataUrl(character.id, character.visual.avatar),
				expressions: Object.fromEntries(
					character.visual.expressions.map((expression) => {
						return [expression.id, this.characterAssetDataUrl(character.id, expression.asset)];
					}),
				),
				expressionLabels,
			},
			roleplay: {
				variables: character.roleplay.variables,
				media: character.roleplay.media.map((media) => {
					const url = this.characterAssetDataUrl(character.id, media.asset);
					switch (media.kind) {
						case "image": {
							if (media.presentation === "ambient")
								throw new Error(
									`character package ${character.id}: non-audio media cannot be ambient`,
								);
							return {
								id: media.id,
								kind: "image" as const,
								label: media.label,
								loop: media.loop,
								presentation: media.presentation,
								url,
								...(media.poster
									? { posterUrl: this.characterAssetDataUrl(character.id, media.poster) }
									: {}),
							};
						}
						case "animation": {
							if (!media.poster)
								throw new Error(
									`character package ${character.id}: animation ${media.id} requires poster`,
								);
							if (media.presentation === "ambient")
								throw new Error(
									`character package ${character.id}: non-audio media cannot be ambient`,
								);
							return {
								id: media.id,
								kind: "animation" as const,
								label: media.label,
								loop: media.loop,
								presentation: media.presentation,
								url,
								posterUrl: this.characterAssetDataUrl(character.id, media.poster),
							};
						}
						case "audio": {
							if (!media.captions)
								throw new Error(
									`character package ${character.id}: audio ${media.id} requires captions`,
								);
							return {
								id: media.id,
								kind: "audio" as const,
								label: media.label,
								loop: media.loop,
								presentation: media.presentation,
								url,
								...(media.poster
									? { posterUrl: this.characterAssetDataUrl(character.id, media.poster) }
									: {}),
								captionsUrl: this.characterAssetDataUrl(character.id, media.captions),
							};
						}
						case "video": {
							if (!media.captions)
								throw new Error(
									`character package ${character.id}: video ${media.id} requires captions`,
								);
							if (media.presentation === "ambient")
								throw new Error(
									`character package ${character.id}: non-audio media cannot be ambient`,
								);
							return {
								id: media.id,
								kind: "video" as const,
								label: media.label,

								loop: media.loop,
								presentation: media.presentation,
								url,
								...(media.poster
									? { posterUrl: this.characterAssetDataUrl(character.id, media.poster) }
									: {}),
								captionsUrl: this.characterAssetDataUrl(character.id, media.captions),
							};
						}
						default:
							throw new Error(`character package ${character.id}: unsupported media kind`);
					}
				}),
				unlockables: character.roleplay.unlockables,
				choice_sets: character.roleplay.choice_sets,
			},
		};
	}

	readPackageDocument(characterId: string): {
		characterId: string;
		origin: CharacterPackageOrigin;
		writable: boolean;
		yaml: string;
		sha256: string;
		character: CharacterDisplay;
	} {
		const character = this.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		const yaml = readFileSync(join(this.packageDirectory(characterId), "character.yaml"), "utf8");
		return {
			characterId,
			origin: this.packageOrigin(character),
			writable: true,
			yaml,
			sha256: createHash("sha256").update(yaml).digest("hex"),
			character: this.display(character),
		};
	}

	writePackageDocument(params: { characterId: string; yaml: string; expectedSha256: string }): {
		character: CharacterPackage;
	} {
		const current = this.readPackageDocument(params.characterId);
		if (current.sha256 !== params.expectedSha256)
			throw { kind: "conflict", reason: "character_package_revision_mismatch" };
		const parsed = parse(params.yaml);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!("id" in parsed) ||
			parsed.id !== params.characterId
		)
			throw { kind: "invalid_request", reason: "character_id_immutable" };
		const target = join(this.libraryRoot, params.characterId);
		try {
			replaceDurableFileSync({
				root: this.libraryRoot,
				target,
				stage: (staging) => {
					cpSync(this.packageDirectory(params.characterId), staging, {
						recursive: true,
						errorOnExist: true,
					});
					writeFileSync(join(staging, "character.yaml"), params.yaml, "utf8");
				},
				verify: (candidate) => this.verifyPackageDirectory(params.characterId, candidate),
			});
			const updated = this.load(params.characterId);
			if (!updated) throw new Error("character_package_missing_after_write");
			return { character: updated };
		} catch (error) {
			if (error && typeof error === "object" && "kind" in error) throw error;
			throw { kind: "invalid_request", reason: "character_package_invalid" };
		}
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
		const ids = readdirSync(this.libraryRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name);
		return ids
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
		const destination = join(this.libraryRoot, id);
		replaceDurableFileSync({
			root: this.libraryRoot,
			target: destination,
			stage: (stagingPackage) => {
				mkdirSync(stagingPackage, { recursive: true });
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
			},
			verify: (candidate) => this.verifyPackageDirectory(id, candidate),
		});
		const character = this.load(id);
		if (!character) throw { kind: "invalid_request", reason: "character_manifest_missing" };
		return character;
	}

	/** Validate an import-shaped package without retaining it in the installed library. */
	validate(files: Array<{ path: string; base64: string }>): CharacterPackage {
		const validationRoot = join(this.libraryRoot, `.validate-${randomUUID()}`);
		try {
			const validator = new CharacterLoader(
				join(validationRoot, "source"),
				join(validationRoot, "installed"),
			);
			return validator.install(files);
		} finally {
			rmSync(validationRoot, { recursive: true, force: true });
		}
	}

	activate(
		db: AppDatabase,
		eventBus: EventBus,
		character: CharacterPackage,
		origin?: CharacterPackageOrigin,
	): void {
		this.seed(db, eventBus, character, origin);
		db.insert(activeCharacter)
			.values({ singleton: 1, characterId: character.id })
			.onConflictDoUpdate({
				target: activeCharacter.singleton,
				set: { characterId: character.id, updatedAt: sql`datetime('now')` },
			})
			.run();
		eventBus.publish("character.activated", { characterId: character.id });
	}

	/** Seed identity once and refresh package provenance on every package load. */
	seed(
		db: AppDatabase,
		eventBus: EventBus,
		character: CharacterPackage,
		origin: CharacterPackageOrigin = this.packageOrigin(character),
	): void {
		const existing = db
			.select({ id: companionIdentity.id })
			.from(companionIdentity)
			.where(eq(companionIdentity.id, character.id))
			.get();
		const existingPackage = db
			.select({ origin: companionPackages.origin })
			.from(companionPackages)
			.where(eq(companionPackages.id, character.id))
			.get();
		const effectiveOrigin = existingPackage?.origin ?? origin;
		db.transaction((transaction) => {
			const packageHash = createHash("sha256")
				.update(character.id)
				.update("\0")
				.update(character.version)
				.update("\0")
				.update(character.name)
				.update("\0")
				.update(character.prompt.description)
				.update("\0")
				.update(character.prompt.personality)
				.update("\0")
				.update(character.prompt.scenario)
				.update("\0")
				.update(character.prompt.system_prompt)
				.update("\0")
				.update(character.prompt.mes_example)
				.update("\0")
				.update(character.self_canon)
				.digest("hex");
			const pluginHash = this.pluginHash(character);
			transaction
				.insert(companionPackages)
				.values({
					id: character.id,
					name: character.name,
					version: character.version,
					hash: packageHash,
					origin: effectiveOrigin,
					pluginHash,
					pluginTrustedHash: effectiveOrigin === "official" ? pluginHash : null,
				})
				.onConflictDoUpdate({
					target: companionPackages.id,
					set: {
						name: character.name,
						version: character.version,
						hash: packageHash,
						origin: effectiveOrigin,
						pluginHash,
						pluginTrustedHash:
							effectiveOrigin === "official" ? pluginHash : companionPackages.pluginTrustedHash,
					},
				})
				.run();
			if (existing) return;
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

function validateRoleplayConditionReferences(
	condition: import("./roleplay-schema.js").RoleplayCondition,
	variables: ReadonlySet<string>,
	unlockables: ReadonlySet<string>,
	characterId: string,
	eventId: string,
): void {
	if ("all" in condition) {
		condition.all.forEach((part) => {
			validateRoleplayConditionReferences(part, variables, unlockables, characterId, eventId);
		});
		return;
	}
	if ("any" in condition) {
		condition.any.forEach((part) => {
			validateRoleplayConditionReferences(part, variables, unlockables, characterId, eventId);
		});
		return;
	}
	if ("not" in condition) {
		validateRoleplayConditionReferences(
			condition.not,
			variables,
			unlockables,
			characterId,
			eventId,
		);
		return;
	}
	if ("unlocked" in condition) {
		if (!unlockables.has(condition.unlocked))
			throw new Error(
				`character package ${characterId}: event ${eventId} condition references missing unlockable`,
			);
		return;
	}
	if (!variables.has(condition.variable))
		throw new Error(
			`character package ${characterId}: event ${eventId} condition references missing variable`,
		);
}
