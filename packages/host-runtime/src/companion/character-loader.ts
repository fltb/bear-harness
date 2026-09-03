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
import { toJsonSchema, z } from "@bear-harness/schema";
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
import { removeOwnedDirectorySync, requireCompanionId } from "../storage/layout.js";
import { activeCharacter, companionIdentity, companionPackages } from "../storage/schema.js";
import { type CharacterBehaviorContract, CharacterBehaviorSchema } from "./behavior-schema.js";
import {
	type CharacterMediaDefinition,
	CharacterMediaSchema,
	mediaAssetExtensions,
} from "./media-schema.js";
import {
	type CharacterOnboardingFlow,
	CharacterOnboardingFlowSchema,
	validateCharacterOnboardingFlow,
} from "./onboarding-schema.js";
import { loadRoleSkills, type RoleSkill, roleSkillPrompt } from "./role-resources.js";
import {
	type CharacterStateDefinition,
	CharacterStateSchema,
	characterStatePrompt,
} from "./state-schema.js";
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
	greeting: string;
	composer_placeholder: string;
	correction: {
		trigger_label: string;
		reason_group_label: string;
		presets: Array<{ id: string; label: string }>;
		custom_label: string;
		custom_placeholder: string;
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

export interface CharacterPrompt {
	description: string;
	personality: string;
	scenario: string;
	system_prompt: string;
}

/**
 * Host-owned role-package storage snapshot (the package storage bucket).
 *
 * The declared constants (`theme`, `character`, identity/canon text, scene and
 * media definitions), asset references, and package resources remain
 * package data even when Host projects selected values into UI or prompt
 * context. They are never relationship-memory entries or memory-backend
 * input records.
 */
export interface CharacterPackage {
	id: string;
	name: string;
	language: string;
	theme: ThemeTokens;
	character: CharacterStrings;
	behavior: CharacterBehaviorContract;
	prompt: CharacterPrompt;
	self_canon: string;
	scenes: ScenePreset[];
	visual: CharacterVisuals;
	state: CharacterStateDefinition;
	media: CharacterMediaDefinition;
	skills: RoleSkill[];
	canon: LoadedCanonPackage;
}

type CharacterDisplayMediaBase = Pick<
	CharacterMediaDefinition[number],
	"id" | "label" | "description" | "use_when" | "loop"
> & {
	url: string;
};
type CharacterDisplayMedia =
	| (CharacterDisplayMediaBase & {
			kind: "image";
			posterUrl?: string;
	  })
	| (CharacterDisplayMediaBase & {
			kind: "animation";
			posterUrl: string;
	  })
	| (CharacterDisplayMediaBase & {
			kind: "audio";
			posterUrl?: string;
			captionsUrl: string;
	  })
	| (CharacterDisplayMediaBase & {
			kind: "video";
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
	media: CharacterDisplayMedia[];
}

export interface CharacterSummary {
	id: string;
	name: string;
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
});

const ThemeTokensSchema = CharacterThemeOverridesSchema;

const CharacterIdentifierSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);
const CharacterPackageIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const CharacterCardSchema = z.strictObject({
	subtitle: z.string().max(4096),
	greeting: z.string().max(16_384),
	composer_placeholder: z.string().max(4096),
	correction: z.strictObject({
		trigger_label: z.string().min(1).max(4096),
		reason_group_label: z.string().min(1).max(4096),
		presets: z
			.array(z.strictObject({ id: CharacterIdentifierSchema, label: z.string().min(1).max(4096) }))
			.min(1)
			.max(20),
		custom_label: z.string().min(1).max(4096),
		custom_placeholder: z.string().min(1).max(4096),
	}),
	work_presentation: WorkPresentationSchema.optional(),
	first_meeting: CharacterOnboardingFlowSchema,
});
const ScenePresetSchema = z.strictObject({
	id: CharacterIdentifierSchema,
	label: z.string().min(1).max(4096),
	background: z.string().min(1).max(512).nullable(),
	description: z.string().min(1).max(16_384),
	use_when: z.string().min(1).max(16_384),
});
const CharacterExpressionSchema = z.strictObject({
	id: CharacterIdentifierSchema,
	label: z.string().min(1).max(4096),
	asset: z.string().min(1).max(512),
	use_when: z.string().min(1).max(16_384),
});

/** The single runtime contract for character.yaml; UI and Host consume this schema. */
export const CharacterManifestSchema = z
	.strictObject({
		id: CharacterPackageIdSchema,
		name: z.string().min(1).max(4096),
		language: LanguageTagSchema,
		theme: ThemeTokensSchema.optional(),
		character: CharacterCardSchema,
		behavior: CharacterBehaviorSchema,
		prompt: CharacterPromptSchema,
		self_canon: z.string().max(65_536),
		scenes: z.array(ScenePresetSchema).min(1).max(100),
		visual: z.strictObject({
			default_scene: CharacterIdentifierSchema,
			default_expression: CharacterIdentifierSchema,
			avatar: z.string().min(1).max(512),
			expressions: z.array(CharacterExpressionSchema).min(1).max(100),
		}),
		state_schema: z.record(z.string(), z.unknown()).default({}),
		media: CharacterMediaSchema,
	})
	.superRefine((manifest, context) => {
		const unique = (values: string[]) => new Set(values).size === values.length;
		if (!unique(manifest.scenes.map((scene) => scene.id)))
			context.addIssue({ code: "custom", path: ["scenes"], message: "scene ids must be unique" });
		if (!unique(manifest.visual.expressions.map((expression) => expression.id)))
			context.addIssue({
				code: "custom",
				path: ["visual", "expressions"],
				message: "expression ids must be unique",
			});
		if (!manifest.scenes.some((scene) => scene.id === manifest.visual.default_scene))
			context.addIssue({
				code: "custom",
				path: ["visual", "default_scene"],
				message: "default scene must reference a declared scene",
			});
		if (
			!manifest.visual.expressions.some(
				(expression) => expression.id === manifest.visual.default_expression,
			)
		)
			context.addIssue({
				code: "custom",
				path: ["visual", "default_expression"],
				message: "default expression must reference a declared expression",
			});
	});
export type CharacterManifest = z.infer<typeof CharacterManifestSchema>;
type CharacterManifestJson = z.infer<ReturnType<typeof z.json>>;

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
/**
 * Character packages are loaded exclusively from the user-owned library.
 * The seed root is read only during bootstrap, before any package is loaded.
 */
export class CharacterLoader {
	private readonly packageRecoveryFailures = new Map<string, unknown>();
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
		const source = join(this.seedRoot, defaultCharacterId);
		const sourceManifest = join(source, "character.yaml");
		if (!existsSync(sourceManifest)) {
			throw new Error(`default character seed missing: ${defaultCharacterId}`);
		}
		const target = join(this.libraryRoot, defaultCharacterId);
		const targetManifest = join(target, "character.yaml");
		if (existsSync(targetManifest)) return;
		replaceDurableFileSync({
			root: this.libraryRoot,
			target,
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
				this.packageRecoveryFailures.set(characterId, error);
				continue;
			}
			if (result.status === "recovery-required") {
				this.packageRecoveryFailures.set(characterId, result);
				continue;
			}
			this.packageRecoveryFailures.delete(characterId);
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
	 * Load and validate a character package. A missing field or asset is a package error. The returned
	 * `CharacterPackage` is package storage, not a memory record.
	 */
	load(id: string): CharacterPackage | null {
		const recoveryFailure = this.packageRecoveryFailures.get(id);
		if (recoveryFailure) {
			throw {
				kind: "conflict",
				reason: "recovery_required",
				details: { characterId: id, transaction: recoveryFailure },
			};
		}
		const path = join(this.packageDirectory(id), "character.yaml");
		if (!existsSync(path)) return null;
		const manifestResult = CharacterManifestSchema.safeParse(parse(readFileSync(path, "utf8")));
		if (!manifestResult.success) {
			const issue = manifestResult.error.issues[0];
			throw new Error(
				`character package ${id}: manifest ${issue?.path.join(".") || "root"} ${issue?.message ?? "is invalid"}`,
			);
		}
		const parsed = manifestResult.data;
		if (parsed.id !== id) {
			throw new Error(`character package ${id}: yaml id must equal directory id`);
		}
		if (!LanguageTagSchema.safeParse(parsed.language).success) {
			throw new Error(`character package ${id}: language must be a BCP-47 language tag`);
		}
		const theme = resolveTheme(parsed.theme, id);
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
		const behavior = parsed.behavior;
		const state = CharacterStateSchema.parse(parsed.state_schema);
		if ("roleplay" in parsed || "choice_sets" in parsed)
			throw new Error(`character package ${id}: deleted roleplay fields are not supported`);
		const media = parsed.media;
		validateCharacterOnboardingFlow(parsed.character?.first_meeting, id);
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
		const skillsDir = join(resolve(this.packageDirectory(id)), "skills");
		const skills = existsSync(skillsDir)
			? loadRoleSkills([this.characterPackagePath(id, "skills")])
			: [];
		const allowedHostTools = new Set([
			"host_state",
			"host_media",
			"host_choices",
			"host_canon",
			"tdai_memory_search",
			"tdai_conversation_search",
			"explicit_memory",
			"host_delegate",
		]);
		for (const skill of skills) {
			for (const tool of skill.allowedTools)
				if (!allowedHostTools.has(tool))
					throw new Error(
						`character package ${id}: Skill ${skill.name} references unknown tool ${tool}`,
					);
			for (const path of [
				...Object.keys(skill.requires.state),
				...Object.keys(skill.completion.state),
			])
				if (!Object.hasOwn(state.fields, path))
					throw new Error(
						`character package ${id}: Skill ${skill.name} references missing state ${path}`,
					);
		}
		if (new Set(media.map((entry) => entry.id)).size !== media.length)
			throw new Error(`character package ${id}: duplicate media id`);
		for (const item of media) {
			if (item.kind === "animation" && !item.poster)
				throw new Error(`character package ${id}: animation ${item.id} requires poster`);
			if ((item.kind === "audio" || item.kind === "video") && !item.captions)
				throw new Error(`character package ${id}: ${item.kind} ${item.id} requires captions`);
			const extension = extname(item.asset).toLowerCase();
			if (!mediaAssetExtensions(item.kind).has(extension)) {
				throw new Error(
					`character package ${id}: media ${item.id} has an invalid ${item.kind} extension`,
				);
			}
			this.characterPackagePath(id, item.asset);
			if (item.poster) this.ensureImageAsset(id, item.poster);
			if (item.captions) {
				if (extname(item.captions).toLowerCase() !== ".vtt")
					throw new Error(`character package ${id}: media ${item.id} captions must be WebVTT`);
				this.characterPackagePath(id, item.captions);
			}
		}
		return {
			id: parsed.id,
			name: parsed.name,
			language: parsed.language,
			theme,
			character: parsed.character,
			behavior,
			prompt: parsed.prompt,
			self_canon: parsed.self_canon,
			scenes: parsed.scenes,
			visual: parsed.visual,
			state,
			media,
			skills,
			canon: { manifest: canonManifest, sources: canonSources },
		};
	}

	pluginHash(character: CharacterPackage): string {
		const pluginsDir = join(resolve(this.packageDirectory(character.id)), "plugins");
		if (!existsSync(pluginsDir)) return "";
		const pluginRoot = this.characterPackagePath(character.id, "plugins");
		const files = this.collectPluginFiles(character.id, pluginRoot);
		if (files.length === 0) return "";
		const hash = createHash("sha256");
		for (const path of files) {
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
		const behaviorContract = `<character_behavior_contract>\n${JSON.stringify(
			character.behavior,
			null,
			2,
		)}\n</character_behavior_contract>`;
		const hostContract = `<host_product_contract>
Treat every user message the same way, whether it was typed or submitted by a choice button. A choice has no command semantics beyond its natural-language message.
Use host_state for Character or Display changes. Its update action accepts one or more path/value changes under /character or /display. Use only ids declared in the display catalog.
Use host_media with a declared media id when media would materially help the conversation. Use host_choices only for choices created for the current response; every choice is ordinary user input.
Treat external Runs as separate work. Starting a Run does not mean it finished. Treat local file paths as references to files in place; do not claim they were uploaded or copied.
Do not infer conversation, turn, queue, streaming, tool, branch, or lifecycle state from Host data. Use Pi's own values and events for those concerns.
When relationship memory is enabled, completed natural conversation is captured by TDAI and may be selectively distilled; the user does not need to use a fixed command. Use explicit_memory only when the user clearly asks to remember, change, or forget exact information.
Do not claim that missing an explicit request prevents TDAI capture, and do not promise that every natural message becomes durable structured memory. Keep automatic relationship memory and explicit MEMORY.md edits distinct.
</host_product_contract>`;
		const displayCatalog = `<host_display_catalog>\n${JSON.stringify(
			modelDisplayCatalog(character),
			null,
			2,
		)}\n</host_display_catalog>`;
		const appendSystemPrompt = [
			hostContract,
			`<character_identity>\n${[
				character.prompt.description,
				character.prompt.personality,
				character.prompt.scenario,
			]
				.filter(Boolean)
				.join("\n\n")}\n</character_identity>`,
			behaviorContract,
			character.prompt.system_prompt.trim(),
			characterStatePrompt(character.state),
			displayCatalog,
			roleSkillPrompt(character.skills),
			character.self_canon.trim()
				? `<self_canon>\n${character.self_canon.trim()}\n</self_canon>`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
		return {
			skillPaths,
			pluginPaths,
			appendSystemPrompt,
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
			media: character.media.map((media) => {
				const url = this.characterAssetDataUrl(character.id, media.asset);
				switch (media.kind) {
					case "image": {
						return {
							id: media.id,
							kind: "image" as const,
							label: media.label,
							description: media.description,
							use_when: media.use_when,
							loop: media.loop,
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
						return {
							id: media.id,
							kind: "animation" as const,
							label: media.label,
							description: media.description,
							use_when: media.use_when,
							loop: media.loop,
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
							description: media.description,
							use_when: media.use_when,
							loop: media.loop,
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
						return {
							id: media.id,
							kind: "video" as const,
							label: media.label,
							description: media.description,
							use_when: media.use_when,

							loop: media.loop,
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
		};
	}

	readPackageDocument(characterId: string): {
		characterId: string;
		origin: CharacterPackageOrigin;
		writable: boolean;
		yaml: string;
		sha256: string;
		character: CharacterDisplay;
		manifest: CharacterManifestJson;
		manifestSchema: CharacterManifestJson;
	} {
		const character = this.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		const yaml = readFileSync(join(this.packageDirectory(characterId), "character.yaml"), "utf8");
		const manifest = CharacterManifestSchema.parse(parse(yaml));
		return {
			characterId,
			origin: this.packageOrigin(character),
			writable: true,
			yaml,
			sha256: createHash("sha256").update(yaml).digest("hex"),
			character: this.display(character),
			manifest: JSON.parse(JSON.stringify(manifest)) as CharacterManifestJson,
			manifestSchema: toJsonSchema(CharacterManifestSchema) as CharacterManifestJson,
		};
	}

	packageLocation(characterId: string): string {
		if (!this.load(characterId)) throw { kind: "not_found", reason: "character_package_not_found" };
		return this.packageDirectory(characterId);
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

	deletePackage(
		db: AppDatabase,
		characterId: string,
		options: { readonly defaultCharacterId: string; readonly runtimeExists: boolean },
	): boolean {
		const id = requireCompanionId(characterId);
		if (id === options.defaultCharacterId) {
			throw { kind: "conflict", reason: "character_package_default" };
		}
		if (id === this.getActiveCharacterId(db, options.defaultCharacterId)) {
			throw { kind: "conflict", reason: "character_package_active" };
		}
		if (options.runtimeExists) {
			throw { kind: "conflict", reason: "character_runtime_exists" };
		}
		const registered =
			db
				.select({ id: companionPackages.id })
				.from(companionPackages)
				.where(eq(companionPackages.id, id))
				.get() !== undefined;
		let removed = false;
		db.transaction((transaction) => {
			removed = removeOwnedDirectorySync(this.libraryRoot, id, "character package directory");
			transaction.delete(companionIdentity).where(eq(companionIdentity.id, id)).run();
			transaction.delete(companionPackages).where(eq(companionPackages.id, id)).run();
		});
		return removed || registered;
	}

	list(db: AppDatabase, defaultCharacterId: string): CharacterSummary[] {
		const activeId = this.getActiveCharacterId(db, defaultCharacterId);
		const ids = readdirSync(this.libraryRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name);
		return ids
			.map((id) => {
				try {
					return this.load(id);
				} catch {
					return null;
				}
			})
			.filter((character): character is CharacterPackage => character !== null)
			.map((character) => ({
				id: character.id,
				name: character.name,
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
		systemDb: AppDatabase,
		character: CharacterPackage,
		origin?: CharacterPackageOrigin,
	): void {
		this.seed(systemDb, character, origin);
		systemDb
			.insert(activeCharacter)
			.values({ singleton: 1, characterId: character.id })
			.onConflictDoUpdate({
				target: activeCharacter.singleton,
				set: { characterId: character.id, updatedAt: sql`datetime('now')` },
			})
			.run();
	}

	/** Seed identity once and refresh package provenance on every package load. */
	seed(
		systemDb: AppDatabase,
		character: CharacterPackage,
		origin: CharacterPackageOrigin = this.packageOrigin(character),
	): void {
		const existingIdentity = systemDb
			.select({ id: companionIdentity.id })
			.from(companionIdentity)
			.where(eq(companionIdentity.id, character.id))
			.get();
		const existingPackage = systemDb
			.select({ origin: companionPackages.origin })
			.from(companionPackages)
			.where(eq(companionPackages.id, character.id))
			.get();
		const effectiveOrigin = existingPackage?.origin ?? origin;
		systemDb.transaction((transaction) => {
			const pluginHash = this.pluginHash(character);
			transaction
				.insert(companionPackages)
				.values({
					id: character.id,
					name: character.name,
					origin: effectiveOrigin,
					pluginHash,
					pluginTrustedHash: effectiveOrigin === "official" ? pluginHash : null,
				})
				.onConflictDoUpdate({
					target: companionPackages.id,
					set: {
						name: character.name,
						origin: effectiveOrigin,
						pluginHash,
						pluginTrustedHash:
							effectiveOrigin === "official" ? pluginHash : companionPackages.pluginTrustedHash,
					},
				})
				.run();
			if (existingIdentity) return;
			// Insert the companion identity
			transaction
				.insert(companionIdentity)
				.values({
					id: character.id,
					packageId: character.id,
					name: character.name,
				})
				.run();
		});
		// The first meeting FSM creates the initial conversation, so we don't seed one here.
	}
}

/** Static semantic ids exposed to the model; asset paths remain renderer-only. */
export function modelDisplayCatalog(character: CharacterPackage) {
	return {
		scenes: character.scenes.map(({ id, label, use_when }) => ({ id, label, useWhen: use_when })),
		expressions: character.visual.expressions.map(({ id, label, use_when }) => ({
			id,
			label: label.replaceAll("{name}", character.name),
			useWhen: use_when,
		})),
		media: character.media.map(({ id, kind, label, description, use_when }) => ({
			id,
			kind,
			label,
			description,
			useWhen: use_when,
		})),
	};
}
