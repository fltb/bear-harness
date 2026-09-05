/**
 * Wire schemas — the single source of truth for every channel contract.
 *
 * All schemas are strict Zod 4 objects with explicit length, array, enum and
 * safe-integer bounds. The same schemas validate IPC and HTTP requests and
 * generate Draft 2020-12 JSON Schema for package tooling.
 *
 * Wire errors are limited to the `RpcErrorKind` enum plus a localizable
 * `reason` string — never raw paths,
 * SQL, secrets, or provider error text.
 *
 * This module is transport- and runtime-neutral (no Electron, DOM, or Node
 * APIs); it depends only on the shared Zod schema package. Runtime consumers import it via
 * `@bear-harness/protocol/schema`; type-only consumers use the inferred
 * types from the package entry (`@bear-harness/protocol`).
 */

import { type Schema, z } from "@bear-harness/schema";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 4096;
const MAX_PATH_LENGTH = 1024;
const MAX_ARRAY_LENGTH = 100;
const MAX_RECORD_ENTRIES = MAX_ARRAY_LENGTH;
export const MAX_EVENT_PAYLOAD_DEPTH = 32;
export const MAX_EVENT_PAYLOAD_NODES = 1024;
const MAX_SAFE_INT = 9007199254740991;
const WireTimestamp = z
	.string()
	.min(1)
	.max(64)
	.refine((value) => Number.isFinite(Date.parse(value)), "must be a valid timestamp");
export const MAX_MESSAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_MESSAGE_ATTACHMENT_BYTES / 3) * 4;
const boundedRecord = <K extends z.ZodString, V extends Schema>(
	key: K,
	value: V,
	maxEntries = MAX_RECORD_ENTRIES,
) =>
	z.record(key, value).superRefine((record, context) => {
		if (Object.keys(record).length > maxEntries) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `record must contain at most ${maxEntries} entries`,
			});
		}
	});

/** Localizable reason codes for wire errors. */
export const RpcErrorKind = z.union([
	z.literal("invalid_request"),
	z.literal("not_found"),
	z.literal("conflict"),
	z.literal("unavailable"),
	z.literal("internal"),
]);
export type RpcErrorKind = z.infer<typeof RpcErrorKind>;

/** Every IPC response body is either data or an error with this shape. */
export const RpcResponse = <T extends Schema>(data: T) =>
	z.union([
		z.strictObject({
			ok: z.literal(true),
			data,
		}),
		z.strictObject({
			ok: z.literal(false),
			error: z.strictObject({
				kind: RpcErrorKind,
				reason: z.string().max(MAX_STRING_LENGTH),
			}),
		}),
	]);
export const EmptyResponse = z.strictObject({});

/** JSON values accepted by bounded Character and Display documents. */
type BoundedJsonValue =
	| string
	| number
	| boolean
	| null
	| BoundedJsonValue[]
	| { [key: string]: BoundedJsonValue };

/**
 * Validate JSON-like values iteratively. A recursive Zod schema would
 * recurse once per container and can overflow before its own bounds reject an
 * adversarial payload, so depth and node limits are checked in the same pass
 * as the scalar, breadth, and key bounds.
 */
function isBoundedJsonValue(value: unknown): value is BoundedJsonValue {
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	const seen = new Set<object>();
	let nodes = 0;

	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) return false;
		nodes += 1;
		if (nodes > MAX_EVENT_PAYLOAD_NODES || current.depth > MAX_EVENT_PAYLOAD_DEPTH) return false;

		if (current.value === null || typeof current.value === "boolean") continue;
		if (typeof current.value === "string") {
			if (current.value.length > MAX_STRING_LENGTH) return false;
			continue;
		}
		if (typeof current.value === "number") {
			if (!Number.isFinite(current.value)) return false;
			continue;
		}
		if (typeof current.value !== "object") return false;
		if (seen.has(current.value)) return false;
		seen.add(current.value);

		if (Array.isArray(current.value)) {
			if (current.value.length > MAX_ARRAY_LENGTH) return false;
			for (const child of current.value) {
				pending.push({ value: child, depth: current.depth + 1 });
			}
			continue;
		}

		const record = current.value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length > MAX_ARRAY_LENGTH) return false;
		for (const key of keys) {
			if (key.length < 1 || key.length > 128) return false;
			pending.push({ value: record[key], depth: current.depth + 1 });
		}
	}

	return true;
}

const BoundedJsonValue = z.custom<BoundedJsonValue>(
	(value) => isBoundedJsonValue(value),
	"JSON value exceeds its complexity bounds",
);

/** Transient cache invalidation; it has no cursor or replay contract. */
export const CacheKey = Object.freeze({
	snapshot: () => ["snapshot"] as const,
	conversations: () => ["conversations"] as const,
	conversation: (conversationId: string) => ["conversation", conversationId] as const,
	companionState: (conversationId: string) => ["companionState", conversationId] as const,
	settings: () => ["settings"] as const,
	settingsCapabilities: () => ["settings", "capabilities"] as const,
	characters: () => ["characters"] as const,
	characterPackage: (characterId: string) => ["character", "package", characterId] as const,
	characterDeletionStatus: (characterId: string) =>
		["character", "deletionStatus", characterId] as const,
	canonSources: (characterId: string) => ["canon", "sources", characterId] as const,
	canonModules: (characterId: string) => ["canon", "modules", characterId] as const,
	providers: () => ["providers"] as const,
	providerLogin: (providerId: string) => ["providerLogin", providerId] as const,
	providerLoginSessions: () => ["providerLoginSessions"] as const,
	modelPool: () => ["models", "pool"] as const,
	modelDefaults: () => ["models", "defaults"] as const,
	embeddingInventory: () => ["embedding", "inventory"] as const,
	embeddingAcquisition: () => ["embedding", "acquisition"] as const,
	systemModelDefaults: () => ["models", "systemDefaults"] as const,
	modelRoute: (conversationId: string) => ["models", "route", conversationId] as const,
	runs: () => ["runs"] as const,
	audit: () => ["audit"] as const,
});
const CacheIdentity = z.string().min(1).max(128);
export const CacheKeySchema = z.union([
	z.tuple([z.literal("snapshot")]),
	z.tuple([z.literal("conversations")]),
	z.tuple([z.literal("conversation"), CacheIdentity]),
	z.tuple([z.literal("companionState"), CacheIdentity]),
	z.tuple([z.literal("settings")]),
	z.tuple([z.literal("settings"), z.literal("capabilities")]),
	z.tuple([z.literal("characters")]),
	z.tuple([z.literal("character"), z.literal("package"), CacheIdentity]),
	z.tuple([z.literal("character"), z.literal("deletionStatus"), CacheIdentity]),
	z.tuple([z.literal("canon"), z.literal("sources"), CacheIdentity]),
	z.tuple([z.literal("canon"), z.literal("modules"), CacheIdentity]),
	z.tuple([z.literal("providers")]),
	z.tuple([z.literal("providerLogin"), CacheIdentity]),
	z.tuple([z.literal("models"), z.literal("pool")]),
	z.tuple([z.literal("models"), z.literal("defaults")]),
	z.tuple([z.literal("models"), z.literal("systemDefaults")]),
	z.tuple([z.literal("models"), z.literal("route"), CacheIdentity]),
	z.tuple([z.literal("runs")]),
	z.tuple([z.literal("embedding"), z.literal("inventory")]),
	z.tuple([z.literal("embedding"), z.literal("acquisition")]),
	z.tuple([z.literal("audit")]),
]);
export type CacheKey = z.infer<typeof CacheKeySchema>;

export const InvalidationNotice = z.strictObject({
	keys: z.array(CacheKeySchema).min(1).max(256),
});
export const InvalidationBatch = z.strictObject({
	notices: z.array(InvalidationNotice).max(MAX_ARRAY_LENGTH),
});

export const OnboardingStatus = z.union([z.literal("active"), z.literal("complete")]);
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;
export const OnboardingGetRequest = z.strictObject({});
export const OnboardingSubmitRequest = z.strictObject({
	stepId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z][a-z0-9_]*$/),
	answer: z.string().max(MAX_STRING_LENGTH).optional(),
});
export const OnboardingStateData = z.strictObject({
	answers: boundedRecord(
		z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][a-z0-9_]*$/),
		z.string().max(MAX_STRING_LENGTH),
	),
});
export const CharacterGetRequest = z.strictObject({});
const CharacterMediaUrl = z.string().min(1).max(20_000_000);
export const CharacterSummary = z.strictObject({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(MAX_STRING_LENGTH),
	subtitle: z.string().max(MAX_STRING_LENGTH),
	avatarUrl: CharacterMediaUrl,
	active: z.boolean(),
});
export const CharacterListRequest = z.strictObject({});
export const CharacterListResponse = z.strictObject({
	characters: z.array(CharacterSummary).max(100),
});

const CharacterCopy = z.string().min(1).max(MAX_STRING_LENGTH);
const CharacterIdentifier = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);
const CharacterOnboardingEffect = z.strictObject({
	type: z.literal("identity.nickname"),
});
const CharacterStepPresentation = {
	id: CharacterIdentifier,
	heading: CharacterCopy,
	body: CharacterCopy,
	quote: CharacterCopy.optional(),
	note: CharacterCopy.optional(),
	effects: z.array(CharacterOnboardingEffect).max(3).optional(),
};
export const CharacterOnboardingFlow = z.strictObject({
	step_label: CharacterCopy,
	dialog_label: CharacterCopy,
	error_prefix: CharacterCopy,
	steps: z
		.array(
			z.discriminatedUnion("kind", [
				z.strictObject({
					...CharacterStepPresentation,
					kind: z.literal("acknowledge"),
					submit_label: CharacterCopy,
				}),
				z.strictObject({
					...CharacterStepPresentation,
					kind: z.literal("text"),
					answer_key: CharacterIdentifier,
					input_label: CharacterCopy,
					input_placeholder: CharacterCopy,
					min_length: z.number().int().safe().min(1).max(MAX_STRING_LENGTH),
					max_length: z.number().int().safe().min(1).max(MAX_STRING_LENGTH),
					submit_label: CharacterCopy,
				}),
				z.strictObject({
					...CharacterStepPresentation,
					kind: z.literal("choice"),
					answer_key: CharacterIdentifier,
					choices: z
						.array(
							z.strictObject({
								value: CharacterIdentifier,
								label: CharacterCopy,
								description: CharacterCopy,
							}),
						)
						.min(2)
						.max(12),
				}),
			]),
		)
		.min(1)
		.max(12),
});
export const SystemThemeTokens = z.strictObject({
	canvas: z.string(),
	surface: z.string(),
	surface_raised: z.string(),
	surface_interactive: z.string(),
	surface_selected: z.string(),
	text: z.string(),
	text_muted: z.string(),
	text_on_accent: z.string(),
	accent: z.string(),
	accent_hover: z.string(),
	border: z.string(),
	border_focus: z.string(),
	success: z.string(),
	warning: z.string(),
	danger: z.string(),
});
export type SystemThemeTokens = z.infer<typeof SystemThemeTokens>;
export const CharacterTheme = z.strictObject({
	radius: z.strictObject({ sm: z.number(), md: z.number(), lg: z.number() }),
	tokens: SystemThemeTokens,
	font: z.strictObject({ body: z.string(), heading: z.string() }),
});
export type CharacterTheme = z.infer<typeof CharacterTheme>;
export const CharacterWorkPresentationLabels = z.strictObject({
	proposal: CharacterCopy.refine((value) => value.trim().length > 0),
	running: CharacterCopy.refine((value) => value.trim().length > 0),
	needs_user: CharacterCopy.refine((value) => value.trim().length > 0),
	interrupted: CharacterCopy.refine((value) => value.trim().length > 0),
	completed: CharacterCopy.refine((value) => value.trim().length > 0),
	failed: CharacterCopy.refine((value) => value.trim().length > 0),
	steer_placeholder: CharacterCopy.refine((value) => value.trim().length > 0),
	interrupt: CharacterCopy.refine((value) => value.trim().length > 0),
	resume: CharacterCopy.refine((value) => value.trim().length > 0),
	approve: CharacterCopy.refine((value) => value.trim().length > 0),
	reject: CharacterCopy.refine((value) => value.trim().length > 0),
	artifact_open: CharacterCopy.refine((value) => value.trim().length > 0),
	artifact_reveal: CharacterCopy.refine((value) => value.trim().length > 0),
});
export const CharacterWorkPresentation = z.strictObject({
	labels: CharacterWorkPresentationLabels,
});
export const CharacterMedia = z.discriminatedUnion("kind", [
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("image"),
		label: CharacterCopy,
		description: CharacterCopy,
		use_when: CharacterCopy,
		loop: z.boolean(),
		url: z.string().min(1).max(20_000_000),
		posterUrl: CharacterMediaUrl.optional(),
	}),
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("animation"),
		label: CharacterCopy,
		description: CharacterCopy,
		use_when: CharacterCopy,
		loop: z.boolean(),
		url: z.string().min(1).max(20_000_000),
		posterUrl: CharacterMediaUrl,
	}),
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("audio"),
		label: CharacterCopy,
		description: CharacterCopy,
		use_when: CharacterCopy,
		loop: z.boolean(),
		url: z.string().min(1).max(20_000_000),
		posterUrl: CharacterMediaUrl.optional(),
		captionsUrl: CharacterMediaUrl,
	}),
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("video"),
		label: CharacterCopy,
		description: CharacterCopy,
		use_when: CharacterCopy,
		loop: z.boolean(),
		url: z.string().min(1).max(20_000_000),
		posterUrl: CharacterMediaUrl.optional(),
		captionsUrl: CharacterMediaUrl,
	}),
]);

export const CharacterPrompt = z.strictObject({
	description: z.string().max(65_536),
	personality: z.string().max(65_536),
	scenario: z.string().max(65_536),
	system_prompt: z.string().max(65_536),
});
export type CharacterPrompt = z.infer<typeof CharacterPrompt>;

export const CharacterDisplay = z
	.strictObject({
		id: z.string().min(1).max(64),
		name: CharacterCopy,
		language: z.string().min(1).max(64),
		character: z.strictObject({
			subtitle: z.string().max(MAX_STRING_LENGTH),
			greeting: z.string().max(MAX_STRING_LENGTH),
			composer_placeholder: z.string().max(MAX_STRING_LENGTH),
			correction: z.strictObject({
				trigger_label: z.string().max(MAX_STRING_LENGTH),
				reason_group_label: z.string().max(MAX_STRING_LENGTH),
				presets: z
					.array(
						z.strictObject({
							id: z.string().min(1).max(64),
							label: z.string().max(MAX_STRING_LENGTH),
						}),
					)
					.min(1)
					.max(20),
				custom_label: z.string().max(MAX_STRING_LENGTH),
				custom_placeholder: z.string().max(MAX_STRING_LENGTH),
			}),
			work_presentation: CharacterWorkPresentation.optional(),
			first_meeting: CharacterOnboardingFlow,
		}),
		prompt: CharacterPrompt,
		theme: CharacterTheme,
		scenes: z
			.array(
				z.strictObject({
					id: z.string().min(1).max(64),
					label: z.string().max(MAX_STRING_LENGTH),
					description: z.string().max(MAX_STRING_LENGTH),
					backgroundUrl: CharacterMediaUrl.optional(),
				}),
			)
			.max(MAX_ARRAY_LENGTH),
		visual: z.strictObject({
			defaultSceneId: z.string().min(1).max(64),
			defaultExpressionId: z.string().min(1).max(64),
			avatarUrl: CharacterMediaUrl,
			expressions: boundedRecord(z.string().min(1).max(64), CharacterMediaUrl),
			expressionLabels: boundedRecord(z.string().min(1).max(64), z.string().max(MAX_STRING_LENGTH)),
		}),
		media: z.array(CharacterMedia).max(200),
	})
	.superRefine((character, context) => {
		const sceneIds = new Set(character.scenes.map((scene) => scene.id));
		if (!sceneIds.has(character.visual.defaultSceneId)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["visual", "defaultSceneId"],
				message: "defaultSceneId must reference a listed scene",
			});
		}
		const expressionIds = new Set(Object.keys(character.visual.expressions));
		if (!expressionIds.has(character.visual.defaultExpressionId)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["visual", "defaultExpressionId"],
				message: "defaultExpressionId must reference a listed expression",
			});
		}
		for (const expressionId of Object.keys(character.visual.expressionLabels)) {
			if (!expressionIds.has(expressionId)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["visual", "expressionLabels", expressionId],
					message: "expressionLabels keys must reference listed expressions",
				});
			}
		}
		for (const [index, step] of character.character.first_meeting.steps.entries()) {
			if (step.kind === "text" && step.min_length > step.max_length) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["character", "first_meeting", "steps", index, "max_length"],
					message: "min_length must not exceed max_length",
				});
			}
		}
	});
export const CharacterResponse = z.strictObject({
	character: CharacterDisplay,
});
const CharacterPackageId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const CharacterActivateRequest = z.strictObject({
	characterId: CharacterPackageId,
});
export const CharacterPackageGetRequest = z.strictObject({
	characterId: CharacterPackageId,
});
export const CharacterPackageUpdateRequest = z.strictObject({
	characterId: CharacterPackageId,
	yaml: z.string().max(1_048_576),
	expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const CharacterPackageDocument = z.strictObject({
	characterId: CharacterPackageId,
	origin: z.enum(["official", "local", "imported"]),
	writable: z.boolean(),
	yaml: z.string().max(1_048_576),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	character: CharacterDisplay,
	manifest: BoundedJsonValue,
	manifestSchema: BoundedJsonValue,
});
export const CharacterPackageResponse = z.strictObject({
	package: CharacterPackageDocument,
});
export const CharacterPackageRevealRequest = CharacterPackageGetRequest;
export const CharacterPackageRevealResponse = z.strictObject({ revealed: z.literal(true) });

const CharacterDeletionId = CharacterPackageId;
export const CharacterDeletionStatusGetRequest = z.strictObject({
	characterId: CharacterDeletionId,
});
export const CharacterDeletionStatus = z.strictObject({
	characterId: CharacterDeletionId,
	active: z.boolean(),
	default: z.boolean(),
	runtimePresent: z.boolean(),
	packagePresent: z.boolean(),
});
export const CharacterDeletionStatusResponse = z.strictObject({
	status: CharacterDeletionStatus,
});
export const CharacterDeleteRequest = z.strictObject({
	characterId: CharacterDeletionId,
});
export const CharacterRuntimeDeleteResponse = z.strictObject({
	characterId: CharacterDeletionId,
	target: z.literal("runtime"),
	deleted: z.boolean(),
});
export const CharacterPackageDeleteResponse = z.strictObject({
	characterId: CharacterDeletionId,
	target: z.literal("package"),
	deleted: z.boolean(),
});

export const CharacterImportRequest = z.strictObject({
	files: z
		.array(
			z.strictObject({
				path: z.string().min(1).max(512),
				base64: z.string().max(8_000_000),
			}),
		)
		.min(1)
		.max(500),
});
export const CharacterPluginTrust = z.strictObject({
	characterId: CharacterPackageId,
	origin: z.enum(["official", "local", "imported"]),
	pluginHash: z.string().max(128),
	pluginsPresent: z.boolean(),
	trusted: z.boolean(),
});
export const CharacterPluginTrustGetRequest = z.strictObject({
	characterId: CharacterPackageId,
});
export const CharacterPluginTrustResponse = z.strictObject({
	trust: CharacterPluginTrust,
});
export const CharacterPluginTrustConfirmRequest = z.strictObject({
	characterId: CharacterPackageId,
});
const CharacterDraftFile = z.strictObject({
	encoding: z.enum(["utf8", "base64"]),
	content: z.string().max(8_000_000),
});
const CharacterDraftFiles = boundedRecord(z.string().min(1).max(512), CharacterDraftFile);
export const CharacterDraft = z.strictObject({
	id: z.string().min(1).max(64),
	basePackageId: z.string().min(1).max(64).optional(),
	status: z.enum(["draft", "validating", "ready_to_publish", "published"]),
	locale: z.string().min(2).max(35),
	currentRevision: z.number().int().min(1),
	files: CharacterDraftFiles,
});
export const CharacterDraftCreateRequest = z.strictObject({
	basePackageId: z.string().min(1).max(64).optional(),
	locale: z.string().min(2).max(35).optional(),
});
export const CharacterDraftGetRequest = z.strictObject({
	id: z.string().min(1).max(64),
});
export const CharacterDraftListRevisionsRequest = CharacterDraftGetRequest;
export const CharacterDraftPatchRequest = z
	.strictObject({
		id: z.string().min(1).max(64),
		expectedRevision: z.number().int().min(1),
		files: CharacterDraftFiles,
	})
	.superRefine(({ files }, context) => {
		const count = Object.keys(files).length;
		if (count < 1 || count > 100)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "files must contain 1 to 100 entries",
				path: ["files"],
			});
	});
export const CharacterDraftResponse = z.strictObject({ draft: CharacterDraft });
export const CharacterDraftRevision = z.strictObject({
	revision: z.number().int().min(1),
	createdAt: WireTimestamp,
});
export const CharacterDraftListRevisionsResponse = z.strictObject({
	revisions: z.array(CharacterDraftRevision).max(10_000),
});
export const CharacterDraftRestoreRevisionRequest = z.strictObject({
	id: z.string().min(1).max(64),
	expectedRevision: z.number().int().min(1),
	sourceRevision: z.number().int().min(1),
});
export const CharacterDraftUploadAssetsRequest = z.strictObject({
	id: z.string().min(1).max(64),
	expectedRevision: z.number().int().min(1),
	assets: z
		.array(
			z.strictObject({
				path: z.string().min(1).max(512),
				mime: z.string().min(3).max(128),
				base64: z.string().min(1).max(8_000_000),
			}),
		)
		.min(1)
		.max(100),
});
export const CharacterDraftValidateRequest = z.strictObject({
	id: z.string().min(1).max(64),
	expectedRevision: z.number().int().min(1),
});
export const CharacterDraftPublishRequest = CharacterDraftValidateRequest;
export const CharacterDraftPublishResponse = z.strictObject({
	draft: CharacterDraft,
	character: CharacterDisplay,
});
export const OnboardingResponse = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("active"),
		currentStepId: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][a-z0-9_]*$/),
		stateData: OnboardingStateData,
	}),
	z.strictObject({
		status: z.literal("complete"),
		stateData: OnboardingStateData,
	}),
]);

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export const ConversationId = z.string().min(1).max(128);
export const ConversationSummary = z.strictObject({
	conversationId: ConversationId,
	name: z.string().max(MAX_STRING_LENGTH).optional(),
	created: WireTimestamp,
	modified: WireTimestamp,
	messageCount: z.number().int().nonnegative(),
	firstMessage: z.string().max(MAX_STRING_LENGTH),
	isStreaming: z.boolean(),
});
export const ConversationListRequest = z.strictObject({
	archived: z.boolean().optional(),
	title: z.string().max(1000).optional(),
	cursor: z.string().min(1).max(512).optional(),
	limit: z.number().int().min(1).max(100).default(50),
});
export const ConversationListResponse = z.strictObject({
	conversations: z.array(ConversationSummary).max(MAX_ARRAY_LENGTH),
	nextCursor: z.string().min(1).max(512).optional(),
});
export const ConversationCreateRequest = z.strictObject({
	title: z.string().max(MAX_STRING_LENGTH).optional(),
});
export const ConversationActiveGetRequest = z.strictObject({});
export const ConversationSelectRequest = z.strictObject({
	conversationId: ConversationId,
});
export const ConversationOpenRequest = z.strictObject({
	conversationId: ConversationId,
});
export const ConversationRenameRequest = z.strictObject({
	conversationId: ConversationId,
	title: z.string().min(1).max(200),
});
export const ConversationArchiveRequest = z.strictObject({
	conversationId: ConversationId,
	archived: z.boolean(),
});
export const ConversationDeleteRequest = z.strictObject({
	conversationId: ConversationId,
});
// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const PiSessionEntryId = z.string().min(1).max(128);
export const PiMessageChoices = z.strictObject({
	prompt: CharacterCopy,
	items: z
		.array(
			z.strictObject({
				label: CharacterCopy,
				message: CharacterCopy,
			}),
		)
		.min(2)
		.max(8),
});
function isPiWireValue(value: unknown): boolean {
	try {
		const encoded = JSON.stringify(value);
		return encoded !== undefined && encoded.length <= 8 * 1024 * 1024;
	} catch {
		return false;
	}
}

/** Pi owns these shapes; Bear validates only that they can cross the wire. */
export const PiSessionEntry = z.custom<SessionEntry>(isPiWireValue, "Pi entry is not serializable");
export const PiAgentMessage = z.custom<AgentMessage>(
	isPiWireValue,
	"Pi message is not serializable",
);
export const PiAgentSessionEvent = z.custom<AgentSessionEvent>(
	isPiWireValue,
	"Pi event is not serializable",
);
export const PiLiveSnapshot = z.strictObject({
	isStreaming: z.boolean(),
	streamingMessage: PiAgentMessage.optional(),
	pendingToolCallIds: z.array(z.string().min(1).max(256)).max(100),
	steering: z.array(z.string().max(65536)).max(100),
	followUp: z.array(z.string().max(65536)).max(100),
	errorMessage: z.string().max(4096).optional(),
});
export const ConversationDetail = z.strictObject({
	conversationId: ConversationId,
	name: z.string().max(MAX_STRING_LENGTH).optional(),
	selectedModel: z
		.strictObject({
			providerId: z.string().min(1).max(64),
			modelId: z.string().min(1).max(128),
		})
		.optional(),
	branch: z.strictObject({
		activeLeafId: PiSessionEntryId.optional(),
		latestLeafIds: z.array(PiSessionEntryId).max(MAX_ARRAY_LENGTH),
		entries: z.array(PiSessionEntry).max(MAX_ARRAY_LENGTH),
		hasMoreBefore: z.boolean(),
	}),
	live: PiLiveSnapshot,
});
export const ConversationActiveResponse = z.strictObject({
	activeConversation: ConversationDetail.nullable(),
});
export const ConversationOpenResponse = ConversationDetail;
export const ConversationCreateResponse = ConversationDetail;
export const ConversationHistoryRequest = z.strictObject({
	conversationId: ConversationId,
	beforeEntryId: PiSessionEntryId.optional(),
	limit: z.number().int().min(1).max(100).default(50),
});
export const ConversationHistoryResponse = z.strictObject({
	entries: z.array(PiSessionEntry).max(MAX_ARRAY_LENGTH),
	nextCursor: PiSessionEntryId.optional(),
});
export const MessageSendRequest = z.strictObject({
	conversationId: ConversationId,
	text: z.string().min(1).max(65536),
	clientMessageId: z.string().uuid(),
});
export const MessageSendResponse = EmptyResponse;

export const MessageRegenerateRequest = z.strictObject({
	conversationId: ConversationId,
	entryId: PiSessionEntryId,
	feedback: z.string().min(1).max(65536).optional(),
});
export const MessageSwitchVersionRequest = z.strictObject({
	conversationId: ConversationId,
	leafId: PiSessionEntryId,
});
export const MessageEditRequest = z.strictObject({
	conversationId: ConversationId,
	entryId: PiSessionEntryId,
	text: z.string().min(1).max(65536),
});
export const MessageContinueRequest = z.strictObject({
	conversationId: ConversationId,
});
export const MessageBranchRequest = z.strictObject({
	conversationId: ConversationId,
	entryId: PiSessionEntryId,
});
export const MessageBranchResponse = ConversationDetail;
export const MessageAbortRequest = z.strictObject({
	conversationId: ConversationId,
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const LocalEmbeddingCandidate = z.strictObject({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(MAX_STRING_LENGTH),
	dimensions: z.number().int().safe().positive().max(65536),
	isDefault: z.boolean(),
});
export const LocalEmbeddingTarget = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("candidate"),
		candidateId: z.string().min(1).max(200),
	}),
	z.strictObject({
		kind: z.literal("custom"),
		customPath: z.string().min(1).max(4096),
		dimensions: z.number().int().safe().positive().max(65536),
	}),
]);
export const ModelDownloadSource = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("official") }),
	z.strictObject({ type: z.literal("hf-mirror") }),
	z.strictObject({
		type: z.literal("custom"),
		endpoint: z
			.string()
			.url()
			.max(2048)
			.refine((value) => {
				const url = new URL(value);
				return url.protocol === "https:" && !url.username && !url.password;
			}, "custom model endpoint must be HTTPS and cannot contain credentials"),
	}),
]);
export const LocalEmbeddingInventoryItem = z.strictObject({
	...LocalEmbeddingCandidate.shape,
	target: LocalEmbeddingTarget,
	installed: z.boolean(),
});
export const LocalEmbeddingInventoryResponse = z.strictObject({
	candidates: z.array(LocalEmbeddingInventoryItem).min(1).max(20),
	activeTarget: LocalEmbeddingTarget.optional(),
});
export const LocalEmbeddingAcquisitionErrorCode = z.enum([
	"local_embedding_download_failed",
	"local_embedding_validation_failed",
	"local_embedding_target_invalid",
	"local_embedding_io_failed",
	"local_embedding_interrupted",
]);
const LocalEmbeddingAcquisitionBase = {
	revision: z.number().int().safe().nonnegative(),
	downloadedBytes: z.number().int().safe().nonnegative(),
	totalBytes: z.number().int().safe().nonnegative().optional(),
};
const LocalEmbeddingOperationBase = {
	...LocalEmbeddingAcquisitionBase,
	operationId: z.string().min(1).max(64),
	target: LocalEmbeddingTarget,
	sourceFingerprint: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
};
export const LocalEmbeddingAcquisitionState = z.discriminatedUnion("phase", [
	z.strictObject({
		revision: LocalEmbeddingAcquisitionBase.revision,
		phase: z.literal("idle"),
		downloadedBytes: LocalEmbeddingAcquisitionBase.downloadedBytes,
	}),
	z.strictObject({
		...LocalEmbeddingOperationBase,
		phase: z.enum(["preparing", "downloading", "validating"]),
	}),
	z.strictObject({
		...LocalEmbeddingOperationBase,
		phase: z.enum(["completed", "cancelled"]),
	}),
	z.strictObject({
		...LocalEmbeddingOperationBase,
		phase: z.literal("failed"),
		errorCode: LocalEmbeddingAcquisitionErrorCode.exclude(["local_embedding_interrupted"]),
	}),
	z.strictObject({
		...LocalEmbeddingOperationBase,
		phase: z.literal("interrupted"),
		errorCode: z.literal("local_embedding_interrupted"),
	}),
]);
export type LocalEmbeddingAcquisitionState = z.infer<typeof LocalEmbeddingAcquisitionState>;
export const LocalEmbeddingAcquisitionStartRequest = z.strictObject({
	target: LocalEmbeddingTarget,
	source: ModelDownloadSource,
});
export const LocalEmbeddingAcquisitionCancelRequest = z.strictObject({
	operationId: z.string().min(1).max(64),
});
export const MemoryActivateLocalEmbeddingRequest = z.strictObject({
	target: LocalEmbeddingTarget,
});
export const NetworkProxyModeCapability = z.strictObject({
	id: z.union([z.literal("direct"), z.literal("auto"), z.literal("manual")]),
});
export const MemoryVectorProviderCapability = z.strictObject({
	id: z.union([z.literal("none"), z.literal("remote"), z.literal("local")]),
	onboarding: z.boolean(),
});
export const MemoryVectorPresetCapability = z.strictObject({
	id: z.string().min(1).max(200),
	model: z.string().min(1).max(200),
	dimensions: z.number().int().safe().min(1).max(65536),
});
export const SettingsCapabilitiesGetResponse = z.strictObject({
	networkProxyModes: z.array(NetworkProxyModeCapability).min(1).max(10),
	memoryVectorProviders: z.array(MemoryVectorProviderCapability).min(1).max(10),
	memoryVectorPresets: z.array(MemoryVectorPresetCapability).max(100),
	localEmbeddingCandidates: z.array(LocalEmbeddingCandidate).min(1).max(20),
});
export const SettingsCapabilitiesGetRequest = z.strictObject({});
export type SettingsCapabilities = z.infer<typeof SettingsCapabilitiesGetResponse>;
export type NetworkProxyModeCapability = z.infer<typeof NetworkProxyModeCapability>;
export type MemoryVectorProviderCapability = z.infer<typeof MemoryVectorProviderCapability>;
export type MemoryVectorPresetCapability = z.infer<typeof MemoryVectorPresetCapability>;
export type LocalEmbeddingCandidate = z.infer<typeof LocalEmbeddingCandidate>;
// ---------------------------------------------------------------------------
// Canon Hub (advanced package authoring)
// ---------------------------------------------------------------------------

export const CanonSource = z.strictObject({
	id: z.string().min(1).max(64),
	logicalName: z.string().min(1).max(255),
	mime: z.string().min(1).max(128),
	sha256: z.string().min(1).max(128),
	chunkCount: z.number().int().safe().min(0).max(MAX_SAFE_INT),
	createdAt: WireTimestamp,
	origin: z.enum(["user", "package"]),
	language: z.string().max(35).nullable(),
	sourceKind: z.string().max(64).nullable(),
});
export const CanonChunk = z
	.strictObject({
		id: z.string().min(1).max(64),
		sourceId: z.string().min(1).max(64),
		sourceName: z.string().min(1).max(255),
		ordinal: z.number().int().safe().min(0).max(MAX_SAFE_INT),
		content: z.string().max(4096),
		heading: z.string().max(300).optional(),
		startOffset: z.number().int().nonnegative(),
		endOffset: z.number().int().nonnegative(),
		score: z.number().finite().optional(),
		adjacent: z.boolean().optional(),
		language: z.string().max(35).optional(),
		origin: z.enum(["user", "package"]),
	})
	.superRefine((chunk, context) => {
		if (chunk.endOffset < chunk.startOffset) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["endOffset"],
				message: "endOffset must not precede startOffset",
			});
		}
	});
export const CanonListSourcesRequest = z.strictObject({});
export const CanonAddSourceRequest = z.strictObject({
	logicalName: z.string().min(1).max(255),
	content: z.string().min(1).max(1_048_576),
});
export const CanonSearchRequest = z.strictObject({
	query: z.string().min(1).max(1000),
});
export const CanonRemoveSourceRequest = z.strictObject({
	sourceId: z.string().min(1).max(64),
});
export const CanonModuleKind = z.union([
	z.literal("root"),
	z.literal("arc"),
	z.literal("event"),
	z.literal("entity"),
	z.literal("relationship"),
	z.literal("location"),
	z.literal("object"),
	z.literal("behavior"),
]);
export const CanonModule = z.strictObject({
	id: z.string().min(1).max(64),
	parentId: z.string().min(1).max(64).optional(),
	kind: CanonModuleKind,
	title: z.string().min(1).max(255),
	instructions: z.string().max(16_384),
	sourceChunkIds: z.array(z.string().min(1).max(64)).max(100),
	createdAt: WireTimestamp,
	origin: z.enum(["user", "package"]),
	stableKey: z.string().max(64).optional(),
	triggers: z.array(z.string().max(200)).max(40),
});
export const CanonListModulesRequest = z.strictObject({});
export const CanonUpsertModuleRequest = z.strictObject({
	id: z.string().min(1).max(64).optional(),
	parentId: z.string().min(1).max(64).optional(),
	kind: CanonModuleKind,
	title: z.string().min(1).max(255),
	instructions: z.string().max(16_384),
	sourceChunkIds: z.array(z.string().min(1).max(64)).max(100),
});
export const CanonDeleteModuleRequest = z.strictObject({
	id: z.string().min(1).max(64),
});
export const CanonListSourcesResponse = z.strictObject({
	sources: z.array(CanonSource).max(MAX_ARRAY_LENGTH),
});
export const CanonAddSourceResponse = z.strictObject({
	source: CanonSource,
});
export const CanonSearchResponse = z.strictObject({
	chunks: z.array(CanonChunk).max(MAX_ARRAY_LENGTH),
});
export const CanonListModulesResponse = z.strictObject({
	modules: z.array(CanonModule).max(MAX_ARRAY_LENGTH),
});
export const CanonUpsertModuleResponse = z.strictObject({
	module: CanonModule,
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const ProviderModelCost: z.ZodType<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		inputTokensAbove: number;
	}>;
}> = z.lazy(() =>
	z.strictObject({
		input: z.number().finite(),
		output: z.number().finite(),
		cacheRead: z.number().finite(),
		cacheWrite: z.number().finite(),
		tiers: z
			.array(
				z.strictObject({
					input: z.number().finite(),
					output: z.number().finite(),
					cacheRead: z.number().finite(),
					cacheWrite: z.number().finite(),
					inputTokensAbove: z.number().int().safe().nonnegative(),
				}),
			)
			.max(20)
			.optional(),
	}),
);
const ProviderAuthMethod = z.strictObject({
	type: z.union([z.literal("api_key"), z.literal("oauth")]),
	name: z.string().min(1).max(MAX_STRING_LENGTH),
	loginLabel: z.string().min(1).max(MAX_STRING_LENGTH).optional(),
	isSubscription: z.boolean().optional(),
});

export const ProviderInfo = z.strictObject({
	id: z.string().min(1).max(64),
	name: z.string().max(MAX_STRING_LENGTH),
	source: z.union([z.literal("builtin"), z.literal("custom")]),
	added: z.boolean(),
	authMethods: z.array(ProviderAuthMethod).min(1).max(2),
	credentialStatus: z.union([
		z.literal("missing"),
		z.literal("session_only"),
		z.literal("stored"),
		z.literal("weak_storage"),
		z.literal("refreshing"),
		z.literal("invalid"),
		z.literal("unavailable"),
	]),
	/** Effective provider endpoint; never contains credentials. */
	baseUrl: z.string().max(2048).optional(),
	availableModels: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(128),
				name: z.string().max(MAX_STRING_LENGTH),
				supportsImages: z.boolean(),
				cost: ProviderModelCost,
			}),
		)
		.max(1000),
	unavailable: z.array(z.string().min(1).max(64)).max(30),
});
export const ProviderListRequest = z.strictObject({});
export const ProviderListResponse = z.strictObject({
	providers: z.array(ProviderInfo).max(30),
});
export const ProviderSetApiKeyRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
	apiKey: z.string().min(1).max(2048),
	sessionOnly: z.boolean().optional(),
});
export const ProviderSetApiKeyResponse = EmptyResponse;
export const ProviderLoginRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
	authType: z.literal("oauth"),
});
const ProviderAuthEvent = z.union([
	z.strictObject({
		type: z.literal("info"),
		message: z.string().max(MAX_STRING_LENGTH),
		links: z
			.array(
				z.strictObject({
					url: z.string().max(2048),
					label: z.string().max(MAX_STRING_LENGTH).optional(),
				}),
			)
			.max(10)
			.optional(),
	}),
	z.strictObject({
		type: z.literal("auth_url"),
		url: z.string().max(2048),
		instructions: z.string().max(MAX_STRING_LENGTH).optional(),
	}),
	z.strictObject({
		type: z.literal("device_code"),
		userCode: z.string().max(128),
		verificationUri: z.string().max(2048),
		intervalSeconds: z.number().int().positive().max(3600).optional(),
		expiresInSeconds: z.number().int().positive().max(86400).optional(),
	}),
	z.strictObject({
		type: z.literal("progress"),
		message: z.string().max(MAX_STRING_LENGTH),
	}),
]);
export const ProviderLoginResponse = z.strictObject({
	providerId: z.string().min(1).max(64),
	status: z.union([
		z.literal("running"),
		z.literal("waiting_input"),
		z.literal("completed"),
		z.literal("failed"),
	]),
	events: z.array(ProviderAuthEvent).max(100),
	error: z.string().max(MAX_STRING_LENGTH).optional(),
	prompt: z
		.strictObject({
			type: z.union([
				z.literal("text"),
				z.literal("secret"),
				z.literal("select"),
				z.literal("manual_code"),
			]),
			message: z.string().max(MAX_STRING_LENGTH),
			placeholder: z.string().max(MAX_STRING_LENGTH).optional(),
			options: z
				.array(
					z.strictObject({
						id: z.string(),
						label: z.string(),
						description: z.string().optional(),
					}),
				)
				.max(30)
				.optional(),
		})
		.optional(),
});
export const ProviderLoginSessionsRequest = z.strictObject({});
export const ProviderLoginSessionsResponse = z.strictObject({
	sessions: z.array(ProviderLoginResponse).max(30),
});
export const ProviderLoginCancelRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
});
export const ProviderLoginCancelResponse = EmptyResponse;
export const ProviderLoginStatusRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
});
export const ProviderLoginAnswerRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
	answer: z.string().max(4096),
});
export const ProviderLogoutRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
});
export const ProviderRemoveRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// Configured models
// ---------------------------------------------------------------------------

export const ModelRoute = z.strictObject({
	providerId: z.string().min(1).max(64),
	modelId: z.string().min(1).max(128),
});
export const ModelReadiness = z.enum([
	"ready",
	"disabled",
	"catalog_missing",
	"provider_auth_required",
	"provider_removing",
]);
export const ConfiguredModel = z.strictObject({
	...ModelRoute.shape,
	label: z.string().max(MAX_STRING_LENGTH),
	providerName: z.string().max(MAX_STRING_LENGTH).optional(),
	supportsImages: z.boolean(),
	createdAt: WireTimestamp,
	enabled: z.boolean(),
	readiness: ModelReadiness,
});
export const ProviderImportPiConfigResponse = z.strictObject({
	models: z.array(ConfiguredModel).max(100),
});
export const ModelPoolGetRequest = z.strictObject({});
export const ModelPoolGetResponse = z.strictObject({
	models: z.array(ConfiguredModel).max(100),
});
export const VisionModelDefault = z.discriminatedUnion("mode", [
	z.strictObject({ mode: z.literal("auto") }),
	z.strictObject({ mode: z.literal("manual"), route: ModelRoute }),
]);
export const ModelDefaultsGetRequest = z.strictObject({});
export const ModelDefaultsGetResponse = z.strictObject({
	reply: ModelRoute.optional(),
	vision: VisionModelDefault,
	onboardingComplete: z.boolean(),
});
export const ModelDefaultsSetReplyRequest = z.strictObject({
	reply: ModelRoute.nullable(),
});
export const ModelDefaultsSetReplyResponse = ModelDefaultsGetResponse;
export const ModelDefaultsSetVisionRequest = VisionModelDefault;
export const ModelDefaultsSetVisionResponse = ModelDefaultsGetResponse;
export const SystemModelDefaultsGetRequest = z.strictObject({});
export const SystemModelDefaultsGetResponse = z.strictObject({
	reply: ModelRoute.optional(),
	vision: VisionModelDefault,
});
export const SystemModelDefaultsSetRequest = z.strictObject({
	reply: ModelRoute,
	vision: VisionModelDefault,
});
export const SystemModelDefaultsSetResponse = SystemModelDefaultsGetResponse;
export const ModelDefaultsInitializeRequest = z.strictObject({});
export const ModelDefaultsInitializeResponse = ModelDefaultsGetResponse;
export const ModelDefaultsCompleteOnboardingRequest = z.strictObject({});
export const ModelDefaultsCompleteOnboardingResponse = ModelDefaultsGetResponse;
export const ModelRouteGetRequest = z.strictObject({
	conversationId: ConversationId,
});
export const ModelRouteGetResponse = z.strictObject({
	conversationId: ConversationId,
	selected: ModelRoute.optional(),
});
export const ModelRouteSetRequest = z.strictObject({
	conversationId: ConversationId,
	selected: ModelRoute,
});
export const ModelRouteSetResponse = ModelRouteGetResponse;
export const ModelSnapshot = z.strictObject({
	pool: ModelPoolGetResponse,
	defaults: ModelDefaultsGetResponse,
	route: ModelRouteGetResponse.optional(),
});
export const ModelEnableRequest = z.strictObject({
	providerId: z.string().min(1).max(64),
	modelId: z.string().min(1).max(128),
	label: z.string().max(MAX_STRING_LENGTH).optional(),
});
export const ModelEnableResponse = z.strictObject({
	model: ConfiguredModel,
});
export const ModelDisableRequest = ModelRoute;

// ---------------------------------------------------------------------------
// External agents
// ---------------------------------------------------------------------------

export const ExternalAgentCandidate = z.strictObject({
	candidatePath: z.string().min(1).max(MAX_PATH_LENGTH),
	canonicalPath: z.string().min(1).max(MAX_PATH_LENGTH).nullable(),
	version: z.string().min(1).max(64).nullable(),
	sha256: z.string().length(64).nullable(),
	status: z.union([z.literal("usable"), z.literal("not_found"), z.literal("rejected")]),
});
export const ExternalAgentDiscoverCodexRequest = z.strictObject({});
export const ExternalAgentDiscoverCodexResponse = z.strictObject({
	candidates: z.array(ExternalAgentCandidate).max(100),
});
export const ExternalAgentConnectCodexRequest = z.strictObject({
	canonicalPath: z.string().min(1).max(MAX_PATH_LENGTH),
	version: z.string().min(1).max(64),
	sha256: z.string().length(64),
});
export const ExternalAgentConnectCodexResponse = z.strictObject({
	profileId: z.string().min(1).max(64),
	version: z.string().min(1).max(64),
	hash: z.string().length(64),
});
export const ExternalAgentStatusRequest = z.strictObject({});
export const ExternalAgentStatusResponse = z.strictObject({
	pi: z.strictObject({
		available: z.literal(true),
		profileId: z.literal("pi-default"),
	}),
	codex: z.discriminatedUnion("available", [
		z.strictObject({
			available: z.literal(true),
			profileId: z.string().min(1).max(64),
			version: z.string().min(1).max(64),
			hash: z.string().length(64),
		}),
		z.strictObject({
			available: z.literal(false),
			reason: z.union([z.literal("no_codex_found"), z.literal("not_connected")]),
		}),
	]),
});
export const RunSteerRequest = z.strictObject({
	runId: z.string().min(1).max(64),
	instruction: z.string().min(1).max(MAX_STRING_LENGTH),
});
export const RunInterruptRequest = z.strictObject({
	runId: z.string().min(1).max(64),
});
export const RunResumeRequest = z.strictObject({
	runId: z.string().min(1).max(64),
});
export const RunCancelRequest = z.strictObject({
	runId: z.string().min(1).max(64),
});
export const RunRespondPermissionRequest = z.strictObject({
	runId: z.string().min(1).max(64),
	requestId: z.string().min(1).max(128),
	optionId: z.string().min(1).max(128),
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunStatus = z.union([
	z.literal("enqueued"),
	z.literal("running"),
	z.literal("needs_user"),
	z.literal("completed"),
	z.literal("failed"),
	z.literal("cancelled"),
	z.literal("interrupted"),
	z.literal("forced_termination"),
]);
export const ArtifactStatus = z.enum([
	"created",
	"verified",
	"verification_failed",
	"adopted",
	"saved",
]);
export const RunEvidenceSummary = z.strictObject({
	kind: z.string().min(1).max(128),
	summary: z.string().min(1).max(512).optional(),
	createdAt: WireTimestamp,
});
export const ArtifactSummary = z.strictObject({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(1024),
	mime: z.string().min(1).max(255),
	bytes: z.number().int().safe().nonnegative(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	status: ArtifactStatus,
	createdAt: WireTimestamp,
});
export const RunPermission = z.strictObject({
	runId: z.string().min(1).max(1024),
	prompt: z.string().max(MAX_STRING_LENGTH),
	requestId: z.string().min(1).max(1024),
	options: z
		.array(
			z.strictObject({
				optionId: z.string().min(1).max(1024),
				kind: z.string().max(MAX_STRING_LENGTH),
				name: z.string().max(MAX_STRING_LENGTH),
			}),
		)
		.max(MAX_ARRAY_LENGTH),
});
export const Run = z
	.strictObject({
		id: z.string().min(1).max(64),
		conversationId: ConversationId,
		triggerEntryId: PiSessionEntryId,
		executorProfile: z.string().min(1).max(64),
		title: z.string().min(1).max(80),
		status: RunStatus,
		artifacts: z.array(ArtifactSummary).max(1000),
		summary: z.string().max(MAX_STRING_LENGTH).optional(),
		evidence: z.array(RunEvidenceSummary).max(20),
		permission: RunPermission.optional(),
		startedAt: WireTimestamp.optional(),
		completedAt: WireTimestamp.optional(),
	})
	.superRefine((run, context) => {
		if (
			run.startedAt !== undefined &&
			run.completedAt !== undefined &&
			Date.parse(run.completedAt) < Date.parse(run.startedAt)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["completedAt"],
				message: "completedAt must not precede startedAt",
			});
		}
	});
export const RunListRequest = z.strictObject({});
export const RunListResponse = z.strictObject({
	runs: z.array(Run).max(10),
});
export const RunResponse = Run;

// ---------------------------------------------------------------------------
// Run-owned Artifacts
// ---------------------------------------------------------------------------

export const MAX_ARTIFACT_READ_BYTES = 1024 * 1024;
export const ArtifactIdentity = z.strictObject({
	conversationId: ConversationId,
	runId: z.string().min(1).max(64),
	artifactId: z.string().min(1).max(64),
});
export const ArtifactReadRequest = z.strictObject({
	...ArtifactIdentity.shape,
	offset: z.number().int().safe().nonnegative().optional(),
	length: z.number().int().safe().min(1).max(MAX_ARTIFACT_READ_BYTES).optional(),
});
export const ArtifactReadResponse = z.strictObject({
	artifact: ArtifactSummary,
	offset: z.number().int().safe().nonnegative(),
	nextOffset: z.number().int().safe().nonnegative(),
	eof: z.boolean(),
	base64: z.string().max(Math.ceil(MAX_ARTIFACT_READ_BYTES / 3) * 4 + 4),
});
export const ArtifactActionRequest = ArtifactIdentity;
export const ArtifactActionResponse = z.strictObject({
	outcome: z.enum(["completed", "cancelled", "unsupported"]),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const NetworkProxySettings = z
	.strictObject({
		mode: z.union([z.literal("direct"), z.literal("auto"), z.literal("manual")]),
		url: z.string().min(1).max(2048).optional(),
		bypass: z.array(z.string().min(1).max(512)).max(50).optional(),
	})
	.superRefine((value, context) => {
		if (value.mode !== "manual") return;
		if (!value.url) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["url"],
				message: "manual proxy URL is required",
			});
			return;
		}
		try {
			const url = new URL(value.url);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error();
		} catch {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["url"],
				message: "manual proxy URL must be HTTP(S) and cannot contain credentials",
			});
		}
	});
const MemoryVectorServiceBase = z.strictObject({
	enabled: z.boolean(),
	provider: z.union([z.literal("none"), z.literal("remote"), z.literal("local")]),
	baseUrl: z.string().min(1).max(2048).optional(),
	model: z.string().min(1).max(200).optional(),
	dimensions: z.number().int().safe().positive().max(65536).optional(),
	localModel: z.string().min(1).max(200).optional(),
	customPath: z.string().min(1).max(4096).optional(),
});
function validateMemoryVectorService(
	value: z.infer<typeof MemoryVectorServiceBase>,
	context: z.RefinementCtx<z.infer<typeof MemoryVectorServiceBase>>,
): void {
	if (value.provider === "none" && value.enabled) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["enabled"],
			message: "embedding cannot be enabled without a provider",
		});
	}
	if (value.provider !== "none" && !value.enabled) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["enabled"],
			message: "a selected embedding provider must be enabled",
		});
	}
	if (
		value.provider === "local" &&
		value.enabled &&
		Boolean(value.localModel) === Boolean(value.customPath)
	) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["localModel"],
			message: "exactly one local embedding model source is required",
		});
	}
	if (value.provider !== "remote" || !value.enabled) return;
	for (const key of ["baseUrl", "model"] as const) {
		if (!value[key])
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: [key],
				message: `${key} is required for remote embedding`,
			});
	}
	if (!value.dimensions)
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["dimensions"],
			message: "positive dimensions are required for remote embedding",
		});
	if (value.baseUrl) {
		try {
			const url = new URL(value.baseUrl);
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error();
		} catch {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["baseUrl"],
				message: "remote embedding URL must be HTTP(S) and cannot contain credentials",
			});
		}
	}
}
const MemoryVectorServiceSettings = MemoryVectorServiceBase.extend({
	hasCredential: z.boolean().optional(),
}).superRefine(validateMemoryVectorService);
const MemoryVectorServiceInput = MemoryVectorServiceBase.extend({
	apiKey: z.string().min(1).max(8192).optional(),
}).superRefine(validateMemoryVectorService);

const SettingsDataBase = z.strictObject({
	firstRunStage: z.union([z.literal("model"), z.literal("embedding"), z.literal("role")]),
	relationshipMemoryEnabled: z.boolean(),
	networkProxy: NetworkProxySettings,
	memoryVectorService: MemoryVectorServiceSettings,
	modelDownloadSource: ModelDownloadSource,
});
export const SettingsData = SettingsDataBase.superRefine((settings, context) => {
	if (settings.relationshipMemoryEnabled !== settings.memoryVectorService.enabled) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["relationshipMemoryEnabled"],
			message: "relationship memory state must match the configured embedding service",
		});
	}
});
export const SettingsGetRequest = z.strictObject({});
export const SettingsResponse = z.strictObject({
	settings: SettingsData,
});
export const SettingsPatch = z
	.strictObject({
		networkProxy: NetworkProxySettings.optional(),
		memoryVectorService: MemoryVectorServiceInput.optional(),
		modelDownloadSource: ModelDownloadSource.optional(),
	})
	.superRefine((settings, context) => {
		if (Object.keys(settings).length !== 1) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "settings.set changes exactly one settings domain",
			});
		}
	});
export const SettingsSetRequest = z.strictObject({
	settings: SettingsPatch,
});
export const SystemOnboardingCompleteModelRequest = z.strictObject({
	reply: ModelRoute,
	vision: VisionModelDefault,
});
export const SystemOnboardingCompleteModelResponse = z.strictObject({
	settings: SettingsData,
	defaults: SystemModelDefaultsGetResponse,
});
export const RemoteEmbeddingOnboardingConfiguration = z.strictObject({
	baseUrl: z
		.string()
		.url()
		.max(2048)
		.refine((value) => {
			const url = new URL(value);
			return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
		}, "remote embedding URL must be HTTP(S) and cannot contain credentials"),
	model: z.string().min(1).max(200),
	dimensions: z.number().int().safe().positive().max(65536),
	apiKey: z.string().min(1).max(8192).optional(),
});
export const SystemOnboardingCompleteEmbeddingRequest = z.discriminatedUnion("choice", [
	z.strictObject({ choice: z.literal("none") }),
	z.strictObject({
		choice: z.literal("local"),
		target: LocalEmbeddingTarget,
	}),
	z.strictObject({
		choice: z.literal("remote"),
		configuration: RemoteEmbeddingOnboardingConfiguration,
	}),
]);
export const SystemOnboardingCompleteEmbeddingResponse = SettingsResponse;

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export const UpdateCheckRequest = z.strictObject({});
export const UpdateStateValue = z.union([
	z.literal("disabled"),
	z.literal("idle"),
	z.literal("checking"),
	z.literal("available"),
	z.literal("downloading"),
	z.literal("downloaded"),
	z.literal("verifying"),
	z.literal("ready"),
	z.literal("error"),
]);
export const UpdateCheckResponse = z.strictObject({
	state: UpdateStateValue,
	currentVersion: z.string().max(64).optional(),
	latestVersion: z.string().max(64).optional(),
	feedUrl: z.string().max(2048).optional(),
	error: z.string().max(512).optional(),
});
export const UpdateDiscardRequest = z.strictObject({});
export const UpdateDiscardResponse = z.strictObject({
	state: UpdateStateValue,
	discarded: z.boolean(),
	latestVersion: z.string().max(64).optional(),
	error: z.string().max(512).optional(),
});
export const UpdateApplyRequest = z.strictObject({});
export const UpdateApplyResponse = z.strictObject({
	state: UpdateStateValue,
	applyUnsupported: z.literal(true),
	latestVersion: z.string().max(64).optional(),
	error: z.string().max(512).optional(),
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AuditEntryKind = z.union([
	z.literal("run"),
	z.literal("permission"),
	z.literal("fsop"),
	z.literal("memory"),
	z.literal("config"),
	z.literal("conversation"),
	z.literal("companion_state"),
	z.literal("canon"),
	z.literal("artifact"),
]);
export const AuditEntry = z.strictObject({
	id: z.string().min(1).max(128),
	seq: z.number().int().safe().min(1),
	kind: AuditEntryKind,
	action: z.string().min(1).max(128),
	detail: z.string().max(MAX_STRING_LENGTH),
	hash: z.string().min(1).max(128),
	prevHash: z.string().max(128),
	createdAt: WireTimestamp,
});
export const AuditListRequest = z.strictObject({
	limit: z.number().int().safe().min(1).max(500).optional(),
	afterSeq: z.number().int().safe().min(0).optional(),
});
export const AuditListResponse = z.strictObject({
	entries: z.array(AuditEntry).max(500),
	oldestSeq: z.number().int().safe().min(0),
});
export const AuditExportRequest = z.strictObject({});
export const AuditExportResponse = z.strictObject({
	lines: z.string().max(32_000_000),
	verified: z.boolean(),
});
const CustomProviderModel = z.strictObject({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(200).optional(),
	supportsImages: z.boolean().optional(),
});
export const ProviderCustomUpsertRequest = z.strictObject({
	providerId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9._-]*$/),
	name: z.string().min(1).max(100),
	baseUrl: z.string().min(8).max(2048),
	models: z.array(CustomProviderModel).min(1).max(1000),
	apiKey: z.string().min(1).max(8192).optional(),
});
export const ProviderImportPiConfigRequest = z.strictObject({
	configJson: z.string().min(2).max(262_144),
});
export const ProviderOverrideBaseUrlRequest = z.strictObject({
	providerId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9._-]*$/),
	baseUrl: z.string().min(8).max(2048),
});

// ---------------------------------------------------------------------------
// Composed boot snapshot
// ---------------------------------------------------------------------------

export const CompanionDisplayState = z.strictObject({
	sceneId: z.string().min(1).max(64),
	expressionId: z.string().min(1).max(64),
});
export const CompanionConversationState = z.strictObject({
	character: z.strictObject({
		document: BoundedJsonValue,
		revisions: z.strictObject({
			conversation: z.number().int().safe().nonnegative(),
			global: z.number().int().safe().nonnegative(),
		}),
	}),
	display: CompanionDisplayState,
	revisions: z.strictObject({
		display: z.number().int().safe().nonnegative(),
	}),
});
export const CompanionStateGetRequest = z.strictObject({
	conversationId: ConversationId,
});
export const CompanionStateResponse = z.strictObject({
	schema: BoundedJsonValue,
	state: CompanionConversationState,
});
export const CharacterStateRevisions = z.strictObject({
	conversation: z.number().int().safe().nonnegative(),
	global: z.number().int().safe().nonnegative(),
});
export const CharacterStateDocument = z.strictObject({
	document: BoundedJsonValue,
	revisions: CharacterStateRevisions,
});
const StatePath = z
	.string()
	.min(1)
	.max(512)
	.regex(/^\/(?:character|display)\//u);
export const CompanionStateChange = z.strictObject({
	path: StatePath,
	value: BoundedJsonValue,
});
export const CompanionStateUpdateRequest = z.strictObject({
	conversationId: ConversationId,
	changes: z.array(CompanionStateChange).min(1).max(50),
});
export const SnapshotGetRequest = z.strictObject({});
export const SnapshotResponse = z.strictObject({
	onboarding: OnboardingResponse,
	character: CharacterDisplay,
});

/** Process-local live updates. Nothing in this union is persisted or replayed. */
export const LivePush = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("pi"),
		conversationId: ConversationId,
		event: PiAgentSessionEvent,
	}),
	z.strictObject({
		type: z.literal("companionState"),
		conversationId: ConversationId,
		state: CompanionStateResponse,
	}),
	z.strictObject({ type: z.literal("run"), run: Run }),
	z.strictObject({
		type: z.literal("embeddingAcquisition"),
		state: LocalEmbeddingAcquisitionState,
	}),
	z.strictObject({
		type: z.literal("providerLogin"),
		providerId: z.string().min(1).max(200),
		state: ProviderLoginResponse,
	}),
]);
export const LivePushBatch = z.strictObject({
	events: z.array(LivePush).max(MAX_ARRAY_LENGTH),
});

// ---------------------------------------------------------------------------
// Channel registry (for main-side validation)
// ---------------------------------------------------------------------------

export interface RpcEndpoint<
	ChannelName extends string = string,
	Request extends Schema = Schema,
	Response extends Schema = Schema,
> {
	readonly kind: "rpc";
	readonly operation: "query" | "mutation";
	readonly channel: ChannelName;
	readonly request: Request;
	readonly response: Response;
}
const endpoint = <
	const ChannelName extends string,
	Request extends Schema,
	Response extends Schema,
>(
	channel: ChannelName,
	request: Request,
	response: Response,
	operation: "query" | "mutation",
): RpcEndpoint<ChannelName, Request, Response> => ({
	kind: "rpc",
	operation,
	channel,
	request,
	response,
});

/** The sole runtime and type-level source of truth for every Host RPC channel. */
export const RPC = {
	snapshot: {
		get: endpoint("snapshot.get", SnapshotGetRequest, SnapshotResponse, "query"),
	},
	character: {
		get: endpoint("character.get", CharacterGetRequest, CharacterResponse, "query"),
		list: endpoint("character.list", CharacterListRequest, CharacterListResponse, "query"),
		activate: endpoint(
			"character.activate",
			CharacterActivateRequest,
			CharacterResponse,
			"mutation",
		),
		packageGet: endpoint(
			"character.packageGet",
			CharacterPackageGetRequest,
			CharacterPackageResponse,
			"query",
		),
		packageUpdate: endpoint(
			"character.packageUpdate",
			CharacterPackageUpdateRequest,
			CharacterPackageResponse,
			"mutation",
		),
		packageReveal: endpoint(
			"character.packageReveal",
			CharacterPackageRevealRequest,
			CharacterPackageRevealResponse,
			"mutation",
		),
		deletionStatusGet: endpoint(
			"character.deletionStatusGet",
			CharacterDeletionStatusGetRequest,
			CharacterDeletionStatusResponse,
			"query",
		),
		runtimeDelete: endpoint(
			"character.runtimeDelete",
			CharacterDeleteRequest,
			CharacterRuntimeDeleteResponse,
			"mutation",
		),
		packageDelete: endpoint(
			"character.packageDelete",
			CharacterDeleteRequest,
			CharacterPackageDeleteResponse,
			"mutation",
		),
		import: endpoint("character.import", CharacterImportRequest, CharacterResponse, "mutation"),
		pluginTrustGet: endpoint(
			"character.pluginTrustGet",
			CharacterPluginTrustGetRequest,
			CharacterPluginTrustResponse,
			"query",
		),
		pluginTrustConfirm: endpoint(
			"character.pluginTrustConfirm",
			CharacterPluginTrustConfirmRequest,
			CharacterPluginTrustResponse,
			"mutation",
		),
		draftCreate: endpoint(
			"character.draftCreate",
			CharacterDraftCreateRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftGet: endpoint(
			"character.draftGet",
			CharacterDraftGetRequest,
			CharacterDraftResponse,
			"query",
		),
		draftPatch: endpoint(
			"character.draftPatch",
			CharacterDraftPatchRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftUploadAssets: endpoint(
			"character.draftUploadAssets",
			CharacterDraftUploadAssetsRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftListRevisions: endpoint(
			"character.draftListRevisions",
			CharacterDraftListRevisionsRequest,
			CharacterDraftListRevisionsResponse,
			"query",
		),
		draftRestoreRevision: endpoint(
			"character.draftRestoreRevision",
			CharacterDraftRestoreRevisionRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftValidate: endpoint(
			"character.draftValidate",
			CharacterDraftValidateRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftPublish: endpoint(
			"character.draftPublish",
			CharacterDraftPublishRequest,
			CharacterDraftPublishResponse,
			"mutation",
		),
	},
	companionState: {
		get: endpoint("companionState.get", CompanionStateGetRequest, CompanionStateResponse, "query"),
		update: endpoint(
			"companionState.update",
			CompanionStateUpdateRequest,
			EmptyResponse,
			"mutation",
		),
	},
	onboarding: {
		get: endpoint("onboarding.get", OnboardingGetRequest, OnboardingResponse, "query"),
		submit: endpoint("onboarding.submit", OnboardingSubmitRequest, OnboardingResponse, "mutation"),
	},
	conversation: {
		list: endpoint("conversation.list", ConversationListRequest, ConversationListResponse, "query"),
		activeGet: endpoint(
			"conversation.activeGet",
			ConversationActiveGetRequest,
			ConversationActiveResponse,
			"query",
		),
		select: endpoint(
			"conversation.select",
			ConversationSelectRequest,
			ConversationActiveResponse,
			"mutation",
		),
		create: endpoint(
			"conversation.create",
			ConversationCreateRequest,
			ConversationCreateResponse,
			"mutation",
		),
		open: endpoint("conversation.open", ConversationOpenRequest, ConversationOpenResponse, "query"),
		history: endpoint(
			"conversation.history",
			ConversationHistoryRequest,
			ConversationHistoryResponse,
			"query",
		),
		rename: endpoint("conversation.rename", ConversationRenameRequest, EmptyResponse, "mutation"),
		archive: endpoint(
			"conversation.archive",
			ConversationArchiveRequest,
			ConversationActiveResponse,
			"mutation",
		),
		delete: endpoint(
			"conversation.delete",
			ConversationDeleteRequest,
			ConversationActiveResponse,
			"mutation",
		),
	},
	message: {
		send: endpoint("message.send", MessageSendRequest, MessageSendResponse, "mutation"),
		regenerate: endpoint(
			"message.regenerate",
			MessageRegenerateRequest,
			ConversationDetail,
			"mutation",
		),
		switchVersion: endpoint(
			"message.switchVersion",
			MessageSwitchVersionRequest,
			ConversationDetail,
			"mutation",
		),
		edit: endpoint("message.edit", MessageEditRequest, ConversationDetail, "mutation"),
		continue: endpoint("message.continue", MessageContinueRequest, EmptyResponse, "mutation"),
		branch: endpoint("message.branch", MessageBranchRequest, MessageBranchResponse, "mutation"),
		abort: endpoint("message.abort", MessageAbortRequest, EmptyResponse, "mutation"),
	},
	memory: {
		localEmbeddingInventory: endpoint(
			"memory.localEmbeddingInventory",
			z.strictObject({}),
			LocalEmbeddingInventoryResponse,
			"query",
		),
		localEmbeddingAcquisitionStart: endpoint(
			"memory.localEmbeddingAcquisitionStart",
			LocalEmbeddingAcquisitionStartRequest,
			LocalEmbeddingAcquisitionState,
			"mutation",
		),
		localEmbeddingAcquisitionStatus: endpoint(
			"memory.localEmbeddingAcquisitionStatus",
			z.strictObject({}),
			LocalEmbeddingAcquisitionState,
			"query",
		),
		localEmbeddingAcquisitionCancel: endpoint(
			"memory.localEmbeddingAcquisitionCancel",
			LocalEmbeddingAcquisitionCancelRequest,
			LocalEmbeddingAcquisitionState,
			"mutation",
		),
		activateLocalEmbedding: endpoint(
			"memory.activateLocalEmbedding",
			MemoryActivateLocalEmbeddingRequest,
			SettingsResponse,
			"mutation",
		),
	},
	systemOnboarding: {
		completeModel: endpoint(
			"systemOnboarding.completeModel",
			SystemOnboardingCompleteModelRequest,
			SystemOnboardingCompleteModelResponse,
			"mutation",
		),
		completeEmbedding: endpoint(
			"systemOnboarding.completeEmbedding",
			SystemOnboardingCompleteEmbeddingRequest,
			SystemOnboardingCompleteEmbeddingResponse,
			"mutation",
		),
	},
	canon: {
		listSources: endpoint(
			"canon.listSources",
			CanonListSourcesRequest,
			CanonListSourcesResponse,
			"query",
		),
		addSource: endpoint(
			"canon.addSource",
			CanonAddSourceRequest,
			CanonAddSourceResponse,
			"mutation",
		),
		search: endpoint("canon.search", CanonSearchRequest, CanonSearchResponse, "query"),
		removeSource: endpoint(
			"canon.removeSource",
			CanonRemoveSourceRequest,
			EmptyResponse,
			"mutation",
		),
		listModules: endpoint(
			"canon.listModules",
			CanonListModulesRequest,
			CanonListModulesResponse,
			"query",
		),
		upsertModule: endpoint(
			"canon.upsertModule",
			CanonUpsertModuleRequest,
			CanonUpsertModuleResponse,
			"mutation",
		),
		deleteModule: endpoint(
			"canon.deleteModule",
			CanonDeleteModuleRequest,
			EmptyResponse,
			"mutation",
		),
	},
	provider: {
		list: endpoint("provider.list", ProviderListRequest, ProviderListResponse, "query"),
		customUpsert: endpoint(
			"provider.customUpsert",
			ProviderCustomUpsertRequest,
			EmptyResponse,
			"mutation",
		),
		importPiConfig: endpoint(
			"provider.importPiConfig",
			ProviderImportPiConfigRequest,
			ProviderImportPiConfigResponse,
			"mutation",
		),
		overrideBaseUrl: endpoint(
			"provider.overrideBaseUrl",
			ProviderOverrideBaseUrlRequest,
			EmptyResponse,
			"mutation",
		),
		setApiKey: endpoint("provider.setApiKey", ProviderSetApiKeyRequest, EmptyResponse, "mutation"),
		login: endpoint("provider.login", ProviderLoginRequest, ProviderLoginResponse, "mutation"),
		loginStatus: endpoint(
			"provider.loginStatus",
			ProviderLoginStatusRequest,
			ProviderLoginResponse,
			"query",
		),
		loginCancel: endpoint(
			"provider.loginCancel",
			ProviderLoginCancelRequest,
			ProviderLoginCancelResponse,
			"mutation",
		),
		loginAnswer: endpoint(
			"provider.loginAnswer",
			ProviderLoginAnswerRequest,
			ProviderLoginResponse,
			"mutation",
		),
		loginSessions: endpoint(
			"provider.loginSessions",
			ProviderLoginSessionsRequest,
			ProviderLoginSessionsResponse,
			"query",
		),
		logout: endpoint("provider.logout", ProviderLogoutRequest, EmptyResponse, "mutation"),
		remove: endpoint("provider.remove", ProviderRemoveRequest, EmptyResponse, "mutation"),
	},
	model: {
		poolGet: endpoint("model.pool.get", ModelPoolGetRequest, ModelPoolGetResponse, "query"),
		enable: endpoint("model.enable", ModelEnableRequest, ModelEnableResponse, "mutation"),
		disable: endpoint("model.disable", ModelDisableRequest, EmptyResponse, "mutation"),
		defaultsGet: endpoint(
			"model.defaults.get",
			ModelDefaultsGetRequest,
			ModelDefaultsGetResponse,
			"query",
		),
		defaultsSetReply: endpoint(
			"model.defaults.setReply",
			ModelDefaultsSetReplyRequest,
			ModelDefaultsSetReplyResponse,
			"mutation",
		),
		defaultsSetVision: endpoint(
			"model.defaults.setVision",
			ModelDefaultsSetVisionRequest,
			ModelDefaultsSetVisionResponse,
			"mutation",
		),
		systemDefaultsGet: endpoint(
			"model.systemDefaults.get",
			SystemModelDefaultsGetRequest,
			SystemModelDefaultsGetResponse,
			"query",
		),
		systemDefaultsSet: endpoint(
			"model.systemDefaults.set",
			SystemModelDefaultsSetRequest,
			SystemModelDefaultsSetResponse,
			"mutation",
		),
		defaultsInitialize: endpoint(
			"model.defaults.initialize",
			ModelDefaultsInitializeRequest,
			ModelDefaultsInitializeResponse,
			"mutation",
		),
		defaultsCompleteOnboarding: endpoint(
			"model.defaults.completeOnboarding",
			ModelDefaultsCompleteOnboardingRequest,
			ModelDefaultsCompleteOnboardingResponse,
			"mutation",
		),
		routeGet: endpoint("model.route.get", ModelRouteGetRequest, ModelRouteGetResponse, "query"),
		routeSet: endpoint("model.route.set", ModelRouteSetRequest, ModelRouteSetResponse, "mutation"),
	},
	externalAgent: {
		discoverCodex: endpoint(
			"externalAgent.discoverCodex",
			ExternalAgentDiscoverCodexRequest,
			ExternalAgentDiscoverCodexResponse,
			"query",
		),
		connectCodex: endpoint(
			"externalAgent.connectCodex",
			ExternalAgentConnectCodexRequest,
			ExternalAgentConnectCodexResponse,
			"mutation",
		),
		status: endpoint(
			"externalAgent.status",
			ExternalAgentStatusRequest,
			ExternalAgentStatusResponse,
			"query",
		),
	},
	run: {
		list: endpoint("run.list", RunListRequest, RunListResponse, "query"),
		steer: endpoint("run.steer", RunSteerRequest, EmptyResponse, "mutation"),
		interrupt: endpoint("run.interrupt", RunInterruptRequest, RunResponse, "mutation"),
		resume: endpoint("run.resume", RunResumeRequest, RunResponse, "mutation"),
		cancel: endpoint("run.cancel", RunCancelRequest, RunResponse, "mutation"),
		respondPermission: endpoint(
			"run.respondPermission",
			RunRespondPermissionRequest,
			RunResponse,
			"mutation",
		),
	},
	artifact: {
		read: endpoint("artifact.read", ArtifactReadRequest, ArtifactReadResponse, "query"),
		open: endpoint("artifact.open", ArtifactActionRequest, ArtifactActionResponse, "mutation"),
		reveal: endpoint("artifact.reveal", ArtifactActionRequest, ArtifactActionResponse, "mutation"),
		saveAs: endpoint("artifact.saveAs", ArtifactActionRequest, ArtifactActionResponse, "mutation"),
	},
	settings: {
		get: endpoint("settings.get", SettingsGetRequest, SettingsResponse, "query"),
		set: endpoint("settings.set", SettingsSetRequest, SettingsResponse, "mutation"),
		capabilitiesGet: endpoint(
			"settings.capabilitiesGet",
			SettingsCapabilitiesGetRequest,
			SettingsCapabilitiesGetResponse,
			"query",
		),
	},
	update: {
		check: endpoint("update.check", UpdateCheckRequest, UpdateCheckResponse, "mutation"),
		discard: endpoint("update.discard", UpdateDiscardRequest, UpdateDiscardResponse, "mutation"),
		apply: endpoint("update.apply", UpdateApplyRequest, UpdateApplyResponse, "mutation"),
	},
	audit: {
		list: endpoint("audit.list", AuditListRequest, AuditListResponse, "query"),
		export: endpoint("audit.export", AuditExportRequest, AuditExportResponse, "query"),
	},
} as const;
export type AnyRpcEndpoint = RpcEndpoint;
export type RequestOf<E extends AnyRpcEndpoint> = z.infer<E["request"]>;
export type ResponseOf<E extends AnyRpcEndpoint> = z.infer<E["response"]>;
type EndpointIn<Node> = Node extends AnyRpcEndpoint
	? Node
	: Node extends object
		? { [Key in keyof Node]: EndpointIn<Node[Key]> }[keyof Node]
		: never;
export type DeclaredRpcEndpoint = EndpointIn<typeof RPC>;
function flattenRpc(
	node: object,
	output: Record<string, AnyRpcEndpoint> = {},
): Record<string, AnyRpcEndpoint> {
	for (const value of Object.values(node)) {
		if (typeof value === "object" && value !== null && "kind" in value && value.kind === "rpc") {
			const rpc = value as AnyRpcEndpoint;
			if (output[rpc.channel]) throw new Error(`duplicate RPC channel: ${rpc.channel}`);
			output[rpc.channel] = rpc;
		} else if (typeof value === "object" && value !== null) {
			flattenRpc(value, output);
		}
	}
	return output;
}

/** Dynamic lookup used only at inbound transport boundaries. Business code uses `RPC.*` endpoints. */
export const CHANNEL_CONTRACTS = Object.freeze(flattenRpc(RPC));
export type Channel = DeclaredRpcEndpoint["channel"];
