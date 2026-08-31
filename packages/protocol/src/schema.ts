/**
 * Wire schemas — the single source of truth for every channel contract.
 *
 * All schemas are strict Zod 4 objects with explicit length, array, enum and
 * safe-integer bounds. The same schemas validate IPC and HTTP requests and
 * generate Draft 2020-12 JSON Schema for package tooling.
 *
 * Every channel name ends with `:v1`. Wire errors are limited to the
 * `IpcErrorKind` enum plus a localizable `reason` string — never raw paths,
 * SQL, secrets, or provider error text.
 *
 * This module is transport- and runtime-neutral (no Electron, DOM, or Node
 * APIs); it depends only on the shared Zod schema package. Runtime consumers import it via
 * `@bear-harness/protocol/schema`; type-only consumers use the inferred
 * types from the package entry (`@bear-harness/protocol`).
 */

import { type Schema, z } from "@bear-harness/schema";

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
export const IpcErrorKind = z.union([
	z.literal("invalid_request"),
	z.literal("not_found"),
	z.literal("conflict"),
	z.literal("unavailable"),
	z.literal("internal"),
]);
export type IpcErrorKind = z.infer<typeof IpcErrorKind>;

export const SyncRevision = z.strictObject({
	epoch: z.string().min(1).max(128),
	revision: z.number().int().safe().nonnegative(),
});
export type SyncRevision = z.infer<typeof SyncRevision>;

/** Every IPC response body is either data or an error with this shape. */
export const IpcResponse = <T extends Schema>(data: T) =>
	z.union([
		z.strictObject({
			ok: z.literal(true),
			data,
			sync: SyncRevision.optional(),
		}),
		z.strictObject({
			ok: z.literal(false),
			error: z.strictObject({
				kind: IpcErrorKind,
				reason: z.string().max(MAX_STRING_LENGTH),
			}),
		}),
	]);
export const EmptyResponse = z.strictObject({});

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export const EventSeq = z.number().int().safe().min(0).max(MAX_SAFE_INT);

/** Event payload values that intentionally carry bounded JSON data. */
type BoundedEventValue =
	| string
	| number
	| boolean
	| null
	| BoundedEventValue[]
	| { [key: string]: BoundedEventValue };

/**
 * Validate JSON-like event values iteratively. A recursive Zod schema would
 * recurse once per container and can overflow before its own bounds reject an
 * adversarial payload, so depth and node limits are checked in the same pass
 * as the scalar, breadth, and key bounds.
 */
function isBoundedEventValue(value: unknown): value is BoundedEventValue {
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

const BoundedEventValue = z.custom<BoundedEventValue>(
	(value) => isBoundedEventValue(value),
	"event payload exceeds its complexity bounds",
);

const EventId = z.string().min(1).max(1024);
const EventText = z.string().max(MAX_STRING_LENGTH);
const EventPayload = <const Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
	z.strictObject(shape);
const EventStringList = z.array(EventText).max(MAX_ARRAY_LENGTH);

/**
 * Payload contracts for every event currently emitted by Host or consumed by
 * the renderer. Every kind and field must be declared before use.
 */
export const EmbeddingDownloadState = z.strictObject({
	status: z.enum([
		"idle",
		"preparing",
		"downloading",
		"validating",
		"activating",
		"completed",
		"cancelled",
		"failed",
	]),
	downloadedBytes: z.number().nonnegative(),
	totalBytes: z.number().nonnegative().optional(),
});
export type EmbeddingDownloadState = z.infer<typeof EmbeddingDownloadState>;

export const EventPayloadSchemas = {
	"sync.invalidated": z.strictObject({
		sync: SyncRevision,
		sources: z.array(z.string().min(1).max(160)).max(256),
	}),
	"provider.login_changed": z.strictObject({ providerId: EventId }),
	"memory.embedding_download_changed": EmbeddingDownloadState,
	"character.imported": EventPayload({
		characterId: EventId,
		trust: BoundedEventValue,
	}),
	"character.pluginsTrusted": EventPayload({
		characterId: EventId,
		pluginHash: EventText,
	}),
	"character.activated": EventPayload({ characterId: EventId }),
	"character.seeded": EventPayload({ id: EventId, name: EventText }),
	"conversation.created": EventPayload({
		conversationId: EventId,
		title: EventText.optional(),
	}),
	"conversation.renamed": EventPayload({
		conversationId: EventId,
		title: EventText,
	}),
	"conversation.archived": EventPayload({
		conversationId: EventId,
		archived: z.boolean(),
	}),
	"conversation.deleted": EventPayload({ conversationId: EventId }),
	"settings.changed": EventPayload({
		settings: BoundedEventValue,
		changed: EventStringList,
	}),
	"diagnostics.protocol_violation": EventPayload({
		channel: EventText,
		issues: z.array(BoundedEventValue).max(MAX_ARRAY_LENGTH),
	}),
	"canon.source_added": EventPayload({
		companionId: EventId,
		sourceId: EventId,
		logicalName: EventText,
	}),
	"canon.package_synced": EventPayload({
		companionId: EventId,
		version: z.number().int().safe().min(1).max(MAX_SAFE_INT),
	}),
	"canon.source_removed": EventPayload({
		companionId: EventId,
		sourceId: EventId,
	}),
	"canon.module_saved": EventPayload({
		companionId: EventId,
		moduleId: EventId,
	}),
	"canon.module_removed": EventPayload({
		companionId: EventId,
		moduleId: EventId,
	}),
	"evidence.collected": EventPayload({
		runId: EventId,
		evidenceId: EventId,
		kind: EventText,
	}),
	"run.enqueued": EventPayload({
		runId: EventId,
		conversationId: EventId,
		triggerEntryId: EventId,
		executorProfile: EventText,
	}),
	"run.started": EventPayload({ runId: EventId }),
	"run.completed": EventPayload({ runId: EventId, status: EventText }),
	"run.needs_user": EventPayload({
		runId: EventId,
		prompt: EventText,
		requestId: EventId,
		options: z
			.array(
				EventPayload({
					optionId: EventId,
					kind: EventText,
					name: EventText,
				}),
			)
			.max(MAX_ARRAY_LENGTH),
	}),
	"run.steered": EventPayload({ runId: EventId, instruction: EventText }),
	"run.interrupted": EventPayload({ runId: EventId }),
	"run.resumed": EventPayload({ runId: EventId }),
	"companion.snapshot_changed": EventPayload({
		conversationId: EventId,
	}),
	"codex.launched": EventPayload({
		executor: EventText,
		profileId: EventId,
		runId: EventId,
		triggerEntryId: EventId,
		version: EventText,
		sha256: EventText,
		launchedAt: EventText,
	}),
	"fsops.plan_created": EventPayload({
		planId: EventId,
		opCount: z.number().int().safe().min(0).max(MAX_SAFE_INT),
	}),
	"fsops.journal_entry": EventPayload({
		entryId: EventId,
		planId: EventId,
		opIndex: z.number().int().safe().min(0).max(MAX_SAFE_INT),
		status: z.enum(["done", "error", "needs_user", "undone"]),
	}),
	"fsops.undo_entry": EventPayload({
		entryId: EventId,
		planId: EventId,
		opIndex: z.number().int().safe().min(0).max(MAX_SAFE_INT),
		status: z.enum(["done", "error", "needs_user", "undone"]),
	}),
	"model.enabled": EventPayload({ providerId: EventId, modelId: EventId }),
	"model.disabled": EventPayload({ providerId: EventId, modelId: EventId }),
	"model.defaults_changed": EventPayload({ kind: z.enum(["reply", "vision", "system"]) }),
	"model.selected": EventPayload({
		conversationId: EventId,
		providerId: EventId,
		modelId: EventId,
	}),
	"onboarding.state_changed": EventPayload({
		status: z.enum(["active", "complete"]),
		currentStepId: EventId.optional(),
		stateData: BoundedEventValue,
	}),
	"onboarding.reset": EventPayload({}),
} as const;

export type KnownEventKind = keyof typeof EventPayloadSchemas;
export const EventKind = z.string().min(1).max(128);
const isKnownEventKind = (kind: string): kind is KnownEventKind =>
	Object.hasOwn(EventPayloadSchemas, kind);
/**
 * The shared event contract. Every event kind and payload must be declared.
 * Payloads are JSON-roundtripped by the Host before persistence.
 */
export const DomainEvent = z
	.strictObject({
		seq: EventSeq,
		kind: EventKind,
		payload: z.unknown(),
	})
	.superRefine((event, context) => {
		if (!isKnownEventKind(event.kind)) {
			context.addIssue({ code: "custom", path: ["kind"], message: "unknown event kind" });
			return;
		}
		const payloadSchema = EventPayloadSchemas[event.kind];
		const result = payloadSchema.safeParse(event.payload);
		if (!result.success) {
			context.addIssue({
				code: "custom",
				path: ["payload"],
				message: "event payload does not match its contract",
			});
		}
	});

export type KnownDomainEvent = {
	[K in KnownEventKind]: {
		seq: number;
		kind: K;
		payload: z.infer<(typeof EventPayloadSchemas)[K]>;
	};
}[KnownEventKind];

/** Parse and narrow a known event for consumers such as the renderer. */
export function parseKnownDomainEvent(value: unknown): KnownDomainEvent | undefined {
	const result = DomainEvent.safeParse(value);
	if (!result.success || !isKnownEventKind(result.data.kind)) return undefined;
	const payloadSchema = EventPayloadSchemas[result.data.kind];
	const payload = payloadSchema.safeParse(result.data.payload);
	if (!payload.success) return undefined;
	return {
		seq: result.data.seq,
		kind: result.data.kind as KnownEventKind,
		payload: payload.data,
	} as KnownDomainEvent;
}

export const EventSubscribeRequest = z.strictObject({
	afterSeq: EventSeq.optional(),
});
export const EventSubscribeResponse = z.strictObject({
	events: z.array(DomainEvent).max(MAX_ARRAY_LENGTH),
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
	schema_version: z.literal(1),
	flow_version: z.number().int().safe().min(1).max(Number.MAX_SAFE_INTEGER),
	answers: boundedRecord(
		z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][a-z0-9_]*$/),
		z.string().max(MAX_STRING_LENGTH),
	),
	decisions: z.strictObject({
		relationship_memory_enabled: z.boolean().optional(),
	}),
});
export const CharacterGetRequest = z.strictObject({});
const CharacterMediaUrl = z.string().min(1).max(20_000_000);
export const CharacterSummary = z.strictObject({
	id: z.string().min(1).max(64),
	name: z.string().min(1).max(MAX_STRING_LENGTH),
	version: z.string().min(1).max(64),
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
const CharacterOnboardingEffect = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("identity.nickname") }),
	z.strictObject({
		type: z.literal("setting.set"),
		setting: z.literal("relationship_memory_enabled"),
		values: boundedRecord(CharacterIdentifier, z.boolean()),
	}),
]);
const CharacterStepPresentation = {
	id: CharacterIdentifier,
	heading: CharacterCopy,
	body: CharacterCopy,
	quote: CharacterCopy.optional(),
	note: CharacterCopy.optional(),
	effects: z.array(CharacterOnboardingEffect).max(3).optional(),
};
export const CharacterOnboardingFlow = z.strictObject({
	version: z.number().int().safe().min(1).max(MAX_SAFE_INT),
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
	completion: z.strictObject({ conversation_title: CharacterCopy }),
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
	mes_example: z.string().max(65_536),
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
export const CharacterActivateRequest = z.strictObject({
	characterId: z.string().min(1).max(64),
});
export const CharacterPackageGetRequest = z.strictObject({
	characterId: z.string().min(1).max(64),
});
export const CharacterPackageUpdateRequest = z.strictObject({
	characterId: z.string().min(1).max(64),
	yaml: z.string().max(1_048_576),
	expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const CharacterPackageDocument = z.strictObject({
	characterId: z.string().min(1).max(64),
	origin: z.enum(["official", "local", "imported"]),
	writable: z.boolean(),
	yaml: z.string().max(1_048_576),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	character: CharacterDisplay,
});
export const CharacterPackageResponse = z.strictObject({
	package: CharacterPackageDocument,
});

const CharacterDeletionId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
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
	characterId: z.string().min(1).max(64),
	origin: z.enum(["official", "local", "imported"]),
	pluginHash: z.string().max(128),
	pluginsPresent: z.boolean(),
	trusted: z.boolean(),
});
export const CharacterPluginTrustGetRequest = z.strictObject({
	characterId: z.string().min(1).max(64),
});
export const CharacterPluginTrustResponse = z.strictObject({
	trust: CharacterPluginTrust,
});
export const CharacterPluginTrustConfirmRequest = z.strictObject({
	characterId: z.string().min(1).max(64),
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
export const OnboardingResponse = z.strictObject({
	status: OnboardingStatus,
	currentStepId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional(),
	/** Monotonic Host event cursor for ordering concurrent projections. */
	eventSeq: z.number().int().safe().min(0).max(Number.MAX_SAFE_INTEGER),
	stateData: OnboardingStateData,
});

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export const ConversationId = z.string().min(1).max(64);
export const ConversationSummary = z.strictObject({
	id: ConversationId,
	title: z.string().max(MAX_STRING_LENGTH),
	created: WireTimestamp,
	modified: WireTimestamp,
	messageCount: z.number().int().nonnegative(),
	firstMessage: z.string().max(MAX_STRING_LENGTH),
});
export const ConversationListRequest = z.strictObject({
	archived: z.boolean().optional(),
	title: z.string().max(1000).optional(),
});
export const ConversationListResponse = z.strictObject({
	sessions: z.array(ConversationSummary).max(MAX_ARRAY_LENGTH),
});
export const ConversationCreateRequest = z.strictObject({
	title: z.string().max(MAX_STRING_LENGTH).optional(),
});
export const ConversationOpenRequest = z.strictObject({
	id: ConversationId,
});
export const ConversationRenameRequest = z.strictObject({
	id: ConversationId,
	title: z.string().min(1).max(200),
});
export const ConversationArchiveRequest = z.strictObject({
	id: ConversationId,
	archived: z.boolean(),
});
export const ConversationDeleteRequest = z.strictObject({
	id: ConversationId,
});
// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const PiSessionId = z.string().min(1).max(128);
export const PiSessionEntryId = z.string().min(1).max(128);
const PiTimelineBase = {
	id: PiSessionEntryId,
	parentId: PiSessionEntryId.nullable(),
	timestamp: WireTimestamp,
} as const;
export const PiTimelineToolCall = z.strictObject({
	toolName: z.string().min(1).max(200),
	toolCallId: z.string().min(1).max(256),
});
const PiTimelineContextEntry = z.strictObject({
	...PiTimelineBase,
	kind: z.union([
		z.literal("thinking_level_change"),
		z.literal("model_change"),
		z.literal("compaction"),
		z.literal("branch_summary"),
		z.literal("custom"),
		z.literal("custom_message"),
		z.literal("label"),
		z.literal("session_info"),
	]),
});
const PiTimelineUserMessage = z.strictObject({
	...PiTimelineBase,
	kind: z.literal("message"),
	role: z.literal("user"),
	text: z.string().max(65536),
});
const PiTimelineAssistantMessage = z.strictObject({
	...PiTimelineBase,
	kind: z.literal("message"),
	role: z.literal("assistant"),
	text: z.string().max(65536).optional(),
	toolCalls: z.array(PiTimelineToolCall).max(100).optional(),
	stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]).optional(),
	errorMessage: z.string().max(4096).optional(),
	version: z
		.strictObject({
			current: z.number().int().nonnegative(),
			leafIds: z.array(PiSessionEntryId).min(2).max(100),
		})
		.optional(),
});
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
const PiTimelineToolResult = z.strictObject({
	...PiTimelineBase,
	kind: z.literal("message"),
	role: z.literal("tool"),
	toolName: z.string().min(1).max(200),
	toolCallId: z.string().min(1).max(256),
	status: z.union([z.literal("succeeded"), z.literal("failed")]),
	mediaId: CharacterIdentifier.optional(),
	choices: PiMessageChoices.optional(),
});
/** Security-safe direct projection of one native Pi SessionManager entry. */
export const PiTimelineEntry = z.union([
	PiTimelineUserMessage,
	PiTimelineAssistantMessage,
	PiTimelineToolResult,
	PiTimelineContextEntry,
]);
export type PiTimelineEntry = z.infer<typeof PiTimelineEntry>;
export const PiTimeline = z.strictObject({
	entries: z.array(PiTimelineEntry).max(MAX_ARRAY_LENGTH),
	activeLeafId: PiSessionEntryId.optional(),
});

export const PiLiveAssistantMessage = z.strictObject({
	text: z.string().max(65536).optional(),
	toolCalls: z.array(PiTimelineToolCall).max(100).optional(),
	stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
	errorMessage: z.string().max(4096).optional(),
});
export const PiLiveState = z.strictObject({
	isStreaming: z.boolean(),
	streamingMessage: PiLiveAssistantMessage.optional(),
	queuedUserMessages: z.array(z.string().max(65536)).max(20),
	errorMessage: z.string().max(4096).optional(),
});
export type PiLiveAssistantMessage = z.infer<typeof PiLiveAssistantMessage>;
export type PiLiveState = z.infer<typeof PiLiveState>;
export type PiTimeline = z.infer<typeof PiTimeline>;

/**
 * Transient Pi event projection. These events are never written to the Host
 * event log: reconnecting consumers replace them with a fresh Pi snapshot.
 */
export const PiSessionEventType = z.enum([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"entry_appended",
	"session_info_changed",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"thinking_level_changed",
	"bash_execution_update",
]);
export const PiToolActivity = z.strictObject({
	toolCallId: z.string().min(1).max(256),
	toolName: z.string().min(1).max(200),
	status: z.enum(["running", "succeeded", "failed"]),
});
export const PiSessionLiveEvent = z.strictObject({
	sessionId: PiSessionId,
	type: PiSessionEventType,
	live: PiLiveState,
	tool: PiToolActivity.optional(),
});
export const PiEventSubscribeResponse = z.strictObject({
	events: z.array(PiSessionLiveEvent).max(MAX_ARRAY_LENGTH),
});
export const ConversationDetail = z.strictObject({
	sessionId: PiSessionId,
	name: z.string().max(MAX_STRING_LENGTH),
	timeline: PiTimeline,
	live: PiLiveState,
});
export const ConversationOpenResponse = ConversationDetail;
export const ConversationCreateResponse = ConversationDetail;
export const MessageSendRequest = z.strictObject({
	conversationId: ConversationId,
	text: z.string().min(1).max(65536),
});
export const MessageSendResponse = z.strictObject({
	accepted: z.literal(true),
});

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
export const MemoryConfigureLocalEmbeddingRequest = z
	.strictObject({
		provider: z.union([z.literal("none"), z.literal("local")]),
		candidateId: z.string().min(1).max(200).optional(),
		customPath: z.string().min(1).max(4096).optional(),
	})
	.superRefine((value, context) => {
		if (value.provider === "local" && Boolean(value.candidateId) === Boolean(value.customPath)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["candidateId"],
				message: "exactly one of candidateId or customPath is required for local embedding",
			});
		}
		if (
			value.provider === "none" &&
			(value.candidateId !== undefined || value.customPath !== undefined)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["candidateId"],
				message: "model selection is not valid for disabled embedding",
			});
		}
	});
export const MemoryConfigureLocalEmbeddingResponse = z.strictObject({
	ready: z.literal(true),
});
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
export const CanonListSourcesRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
});
export const CanonAddSourceRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	logicalName: z.string().min(1).max(255),
	content: z.string().min(1).max(1_048_576),
});
export const CanonSearchRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	query: z.string().min(1).max(1000),
});
export const CanonRemoveSourceRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
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
export const CanonListModulesRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
});
export const CanonUpsertModuleRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	id: z.string().min(1).max(64).optional(),
	parentId: z.string().min(1).max(64).optional(),
	kind: CanonModuleKind,
	title: z.string().min(1).max(255),
	instructions: z.string().max(16_384),
	sourceChunkIds: z.array(z.string().min(1).max(64)).max(100),
});
export const CanonDeleteModuleRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
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
export const ProviderLoginResponse = z.strictObject({
	providerId: z.string().min(1).max(64),
	status: z.union([
		z.literal("idle"),
		z.literal("running"),
		z.literal("waiting_input"),
		z.literal("completed"),
		z.literal("failed"),
	]),
	authUrl: z.string().max(2048).optional(),
	instructions: z.string().max(MAX_STRING_LENGTH).optional(),
	deviceCode: z.string().max(128).optional(),
	verificationUri: z.string().max(2048).optional(),
	intervalSeconds: z.number().int().positive().max(3600).optional(),
	expiresInSeconds: z.number().int().positive().max(86400).optional(),
	message: z.string().max(MAX_STRING_LENGTH).optional(),
	infoLinks: z
		.array(
			z.strictObject({
				url: z.string().max(2048),
				label: z.string().max(MAX_STRING_LENGTH).optional(),
			}),
		)
		.max(10)
		.optional(),
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
export const ConfiguredModel = z.strictObject({
	...ModelRoute.shape,
	label: z.string().max(MAX_STRING_LENGTH),
	providerName: z.string().max(MAX_STRING_LENGTH).optional(),
	supportsImages: z.boolean(),
	createdAt: WireTimestamp,
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
	codexHome: z.string().min(1).max(MAX_PATH_LENGTH),
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
		permission: EventPayloadSchemas["run.needs_user"].optional(),
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

export const SettingsData = z.strictObject({
	firstRunStage: z.union([z.literal("model"), z.literal("embedding"), z.literal("role")]),
	relationshipMemoryEnabled: z.boolean(),
	networkProxy: NetworkProxySettings,
	memoryVectorService: MemoryVectorServiceSettings,
	modelDownloadSource: z.discriminatedUnion("type", [
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
	]),
});
export const SettingsGetRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
});
export const SettingsResponse = z.strictObject({
	settings: SettingsData,
});
export const SettingsPatch = z.strictObject({
	firstRunStage: SettingsData.shape.firstRunStage.optional(),
	relationshipMemoryEnabled: z.boolean().optional(),
	networkProxy: NetworkProxySettings.optional(),
	memoryVectorService: MemoryVectorServiceInput.optional(),
	modelDownloadSource: SettingsData.shape.modelDownloadSource.optional(),
});
export const SettingsSetRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	settings: SettingsPatch,
});

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
		document: BoundedEventValue,
		revisions: z.strictObject({
			conversation: z.number().int().safe().nonnegative(),
			global: z.number().int().safe().nonnegative(),
		}),
		schemaHash: z.string().min(64).max(64),
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
	schema: BoundedEventValue,
	state: CompanionConversationState,
});
export const CharacterStateRevisions = z.strictObject({
	conversation: z.number().int().safe().nonnegative(),
	global: z.number().int().safe().nonnegative(),
});
export const CharacterStateDocument = z.strictObject({
	document: BoundedEventValue,
	revisions: CharacterStateRevisions,
	schemaHash: z.string().min(64).max(64),
});
const StatePath = z
	.string()
	.min(1)
	.max(512)
	.regex(/^\/(?:character|display)\//u);
export const CompanionStateChange = z.strictObject({
	path: StatePath,
	value: BoundedEventValue,
});
export const CompanionStateUpdateRequest = z.strictObject({
	conversationId: ConversationId,
	changes: z.array(CompanionStateChange).min(1).max(50),
});
export const SnapshotGetRequest = z.strictObject({});
export const SnapshotResponse = z.strictObject({
	eventSeq: EventSeq,
	onboarding: OnboardingResponse.optional(),
	character: CharacterDisplay.optional(),
	provider: ProviderListResponse.optional(),
	model: ModelSnapshot.optional(),
	settings: SettingsData.optional(),
});

// ---------------------------------------------------------------------------
// Channel registry (for main-side validation)
// ---------------------------------------------------------------------------

export interface RpcEndpoint<
	ChannelName extends `${string}:v1` = `${string}:v1`,
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
	const ChannelName extends `${string}:v1`,
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
		get: endpoint("snapshot.get:v1", SnapshotGetRequest, SnapshotResponse, "query"),
	},
	character: {
		get: endpoint("character.get:v1", CharacterGetRequest, CharacterResponse, "query"),
		list: endpoint("character.list:v1", CharacterListRequest, CharacterListResponse, "query"),
		activate: endpoint(
			"character.activate:v1",
			CharacterActivateRequest,
			CharacterResponse,
			"mutation",
		),
		packageGet: endpoint(
			"character.packageGet:v1",
			CharacterPackageGetRequest,
			CharacterPackageResponse,
			"query",
		),
		packageUpdate: endpoint(
			"character.packageUpdate:v1",
			CharacterPackageUpdateRequest,
			CharacterPackageResponse,
			"mutation",
		),
		deletionStatusGet: endpoint(
			"character.deletionStatusGet:v1",
			CharacterDeletionStatusGetRequest,
			CharacterDeletionStatusResponse,
			"query",
		),
		runtimeDelete: endpoint(
			"character.runtimeDelete:v1",
			CharacterDeleteRequest,
			CharacterRuntimeDeleteResponse,
			"mutation",
		),
		packageDelete: endpoint(
			"character.packageDelete:v1",
			CharacterDeleteRequest,
			CharacterPackageDeleteResponse,
			"mutation",
		),
		import: endpoint("character.import:v1", CharacterImportRequest, CharacterResponse, "mutation"),
		pluginTrustGet: endpoint(
			"character.pluginTrustGet:v1",
			CharacterPluginTrustGetRequest,
			CharacterPluginTrustResponse,
			"query",
		),
		pluginTrustConfirm: endpoint(
			"character.pluginTrustConfirm:v1",
			CharacterPluginTrustConfirmRequest,
			CharacterPluginTrustResponse,
			"mutation",
		),
		draftCreate: endpoint(
			"character.draftCreate:v1",
			CharacterDraftCreateRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftGet: endpoint(
			"character.draftGet:v1",
			CharacterDraftGetRequest,
			CharacterDraftResponse,
			"query",
		),
		draftPatch: endpoint(
			"character.draftPatch:v1",
			CharacterDraftPatchRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftUploadAssets: endpoint(
			"character.draftUploadAssets:v1",
			CharacterDraftUploadAssetsRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftListRevisions: endpoint(
			"character.draftListRevisions:v1",
			CharacterDraftListRevisionsRequest,
			CharacterDraftListRevisionsResponse,
			"query",
		),
		draftRestoreRevision: endpoint(
			"character.draftRestoreRevision:v1",
			CharacterDraftRestoreRevisionRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftValidate: endpoint(
			"character.draftValidate:v1",
			CharacterDraftValidateRequest,
			CharacterDraftResponse,
			"mutation",
		),
		draftPublish: endpoint(
			"character.draftPublish:v1",
			CharacterDraftPublishRequest,
			CharacterDraftPublishResponse,
			"mutation",
		),
	},
	companionState: {
		get: endpoint(
			"companionState.get:v1",
			CompanionStateGetRequest,
			CompanionStateResponse,
			"query",
		),
		update: endpoint(
			"companionState.update:v1",
			CompanionStateUpdateRequest,
			EmptyResponse,
			"mutation",
		),
	},
	events: {
		subscribe: endpoint(
			"events.subscribe:v1",
			EventSubscribeRequest,
			EventSubscribeResponse,
			"query",
		),
	},
	onboarding: {
		get: endpoint("onboarding.get:v1", OnboardingGetRequest, OnboardingResponse, "query"),
		submit: endpoint(
			"onboarding.submit:v1",
			OnboardingSubmitRequest,
			OnboardingResponse,
			"mutation",
		),
	},
	conversation: {
		list: endpoint(
			"conversation.list:v1",
			ConversationListRequest,
			ConversationListResponse,
			"query",
		),
		create: endpoint(
			"conversation.create:v1",
			ConversationCreateRequest,
			ConversationCreateResponse,
			"mutation",
		),
		open: endpoint(
			"conversation.open:v1",
			ConversationOpenRequest,
			ConversationOpenResponse,
			"query",
		),
		rename: endpoint(
			"conversation.rename:v1",
			ConversationRenameRequest,
			EmptyResponse,
			"mutation",
		),
		archive: endpoint(
			"conversation.archive:v1",
			ConversationArchiveRequest,
			EmptyResponse,
			"mutation",
		),
		delete: endpoint(
			"conversation.delete:v1",
			ConversationDeleteRequest,
			EmptyResponse,
			"mutation",
		),
	},
	message: {
		send: endpoint("message.send:v1", MessageSendRequest, MessageSendResponse, "mutation"),
		regenerate: endpoint(
			"message.regenerate:v1",
			MessageRegenerateRequest,
			EmptyResponse,
			"mutation",
		),
		switchVersion: endpoint(
			"message.switchVersion:v1",
			MessageSwitchVersionRequest,
			EmptyResponse,
			"mutation",
		),
		edit: endpoint("message.edit:v1", MessageEditRequest, EmptyResponse, "mutation"),
		continue: endpoint("message.continue:v1", MessageContinueRequest, EmptyResponse, "mutation"),
		branch: endpoint("message.branch:v1", MessageBranchRequest, MessageBranchResponse, "mutation"),
		abort: endpoint("message.abort:v1", MessageAbortRequest, EmptyResponse, "mutation"),
	},
	memory: {
		localEmbeddingDownloadStatus: endpoint(
			"memory.localEmbeddingDownloadStatus:v1",
			z.strictObject({}),
			EmbeddingDownloadState,
			"query",
		),
		cancelLocalEmbeddingDownload: endpoint(
			"memory.cancelLocalEmbeddingDownload:v1",
			z.strictObject({}),
			EmptyResponse,
			"mutation",
		),
		configureLocalEmbedding: endpoint(
			"memory.configureLocalEmbedding:v1",
			MemoryConfigureLocalEmbeddingRequest,
			MemoryConfigureLocalEmbeddingResponse,
			"mutation",
		),
	},
	canon: {
		listSources: endpoint(
			"canon.listSources:v1",
			CanonListSourcesRequest,
			CanonListSourcesResponse,
			"query",
		),
		addSource: endpoint(
			"canon.addSource:v1",
			CanonAddSourceRequest,
			CanonAddSourceResponse,
			"mutation",
		),
		search: endpoint("canon.search:v1", CanonSearchRequest, CanonSearchResponse, "query"),
		removeSource: endpoint(
			"canon.removeSource:v1",
			CanonRemoveSourceRequest,
			EmptyResponse,
			"mutation",
		),
		listModules: endpoint(
			"canon.listModules:v1",
			CanonListModulesRequest,
			CanonListModulesResponse,
			"query",
		),
		upsertModule: endpoint(
			"canon.upsertModule:v1",
			CanonUpsertModuleRequest,
			CanonUpsertModuleResponse,
			"mutation",
		),
		deleteModule: endpoint(
			"canon.deleteModule:v1",
			CanonDeleteModuleRequest,
			EmptyResponse,
			"mutation",
		),
	},
	provider: {
		list: endpoint("provider.list:v1", ProviderListRequest, ProviderListResponse, "query"),
		customUpsert: endpoint(
			"provider.customUpsert:v1",
			ProviderCustomUpsertRequest,
			EmptyResponse,
			"mutation",
		),
		importPiConfig: endpoint(
			"provider.importPiConfig:v1",
			ProviderImportPiConfigRequest,
			ProviderImportPiConfigResponse,
			"mutation",
		),
		overrideBaseUrl: endpoint(
			"provider.overrideBaseUrl:v1",
			ProviderOverrideBaseUrlRequest,
			EmptyResponse,
			"mutation",
		),
		setApiKey: endpoint(
			"provider.setApiKey:v1",
			ProviderSetApiKeyRequest,
			EmptyResponse,
			"mutation",
		),
		login: endpoint("provider.login:v1", ProviderLoginRequest, ProviderLoginResponse, "mutation"),
		loginStatus: endpoint(
			"provider.loginStatus:v1",
			ProviderLoginStatusRequest,
			ProviderLoginResponse,
			"query",
		),
		loginCancel: endpoint(
			"provider.loginCancel:v1",
			ProviderLoginCancelRequest,
			ProviderLoginCancelResponse,
			"mutation",
		),
		loginAnswer: endpoint(
			"provider.loginAnswer:v1",
			ProviderLoginAnswerRequest,
			ProviderLoginResponse,
			"mutation",
		),
		logout: endpoint("provider.logout:v1", ProviderLogoutRequest, EmptyResponse, "mutation"),
		remove: endpoint("provider.remove:v1", ProviderRemoveRequest, EmptyResponse, "mutation"),
	},
	model: {
		poolGet: endpoint("model.pool.get:v1", ModelPoolGetRequest, ModelPoolGetResponse, "query"),
		enable: endpoint("model.enable:v1", ModelEnableRequest, ModelEnableResponse, "mutation"),
		disable: endpoint("model.disable:v1", ModelDisableRequest, EmptyResponse, "mutation"),
		defaultsGet: endpoint(
			"model.defaults.get:v1",
			ModelDefaultsGetRequest,
			ModelDefaultsGetResponse,
			"query",
		),
		defaultsSetReply: endpoint(
			"model.defaults.setReply:v1",
			ModelDefaultsSetReplyRequest,
			ModelDefaultsSetReplyResponse,
			"mutation",
		),
		defaultsSetVision: endpoint(
			"model.defaults.setVision:v1",
			ModelDefaultsSetVisionRequest,
			ModelDefaultsSetVisionResponse,
			"mutation",
		),
		systemDefaultsGet: endpoint(
			"model.systemDefaults.get:v1",
			SystemModelDefaultsGetRequest,
			SystemModelDefaultsGetResponse,
			"query",
		),
		systemDefaultsSet: endpoint(
			"model.systemDefaults.set:v1",
			SystemModelDefaultsSetRequest,
			SystemModelDefaultsSetResponse,
			"mutation",
		),
		defaultsInitialize: endpoint(
			"model.defaults.initialize:v1",
			ModelDefaultsInitializeRequest,
			ModelDefaultsInitializeResponse,
			"mutation",
		),
		defaultsCompleteOnboarding: endpoint(
			"model.defaults.completeOnboarding:v1",
			ModelDefaultsCompleteOnboardingRequest,
			ModelDefaultsCompleteOnboardingResponse,
			"mutation",
		),
		routeGet: endpoint("model.route.get:v1", ModelRouteGetRequest, ModelRouteGetResponse, "query"),
		routeSet: endpoint(
			"model.route.set:v1",
			ModelRouteSetRequest,
			ModelRouteSetResponse,
			"mutation",
		),
	},
	externalAgent: {
		discoverCodex: endpoint(
			"externalAgent.discoverCodex:v1",
			ExternalAgentDiscoverCodexRequest,
			ExternalAgentDiscoverCodexResponse,
			"query",
		),
		connectCodex: endpoint(
			"externalAgent.connectCodex:v1",
			ExternalAgentConnectCodexRequest,
			ExternalAgentConnectCodexResponse,
			"mutation",
		),
		status: endpoint(
			"externalAgent.status:v1",
			ExternalAgentStatusRequest,
			ExternalAgentStatusResponse,
			"query",
		),
	},
	run: {
		list: endpoint("run.list:v1", RunListRequest, RunListResponse, "query"),
		steer: endpoint("run.steer:v1", RunSteerRequest, EmptyResponse, "mutation"),
		interrupt: endpoint("run.interrupt:v1", RunInterruptRequest, RunResponse, "mutation"),
		resume: endpoint("run.resume:v1", RunResumeRequest, RunResponse, "mutation"),
		cancel: endpoint("run.cancel:v1", RunCancelRequest, RunResponse, "mutation"),
		respondPermission: endpoint(
			"run.respondPermission:v1",
			RunRespondPermissionRequest,
			RunResponse,
			"mutation",
		),
	},
	artifact: {
		read: endpoint("artifact.read:v1", ArtifactReadRequest, ArtifactReadResponse, "query"),
		open: endpoint("artifact.open:v1", ArtifactActionRequest, ArtifactActionResponse, "mutation"),
		reveal: endpoint(
			"artifact.reveal:v1",
			ArtifactActionRequest,
			ArtifactActionResponse,
			"mutation",
		),
		saveAs: endpoint(
			"artifact.saveAs:v1",
			ArtifactActionRequest,
			ArtifactActionResponse,
			"mutation",
		),
	},
	settings: {
		get: endpoint("settings.get:v1", SettingsGetRequest, SettingsResponse, "query"),
		set: endpoint("settings.set:v1", SettingsSetRequest, SettingsResponse, "mutation"),
		capabilitiesGet: endpoint(
			"settings.capabilitiesGet:v1",
			SettingsCapabilitiesGetRequest,
			SettingsCapabilitiesGetResponse,
			"query",
		),
	},
	update: {
		check: endpoint("update.check:v1", UpdateCheckRequest, UpdateCheckResponse, "mutation"),
		discard: endpoint("update.discard:v1", UpdateDiscardRequest, UpdateDiscardResponse, "mutation"),
		apply: endpoint("update.apply:v1", UpdateApplyRequest, UpdateApplyResponse, "mutation"),
	},
	audit: {
		list: endpoint("audit.list:v1", AuditListRequest, AuditListResponse, "query"),
		export: endpoint("audit.export:v1", AuditExportRequest, AuditExportResponse, "query"),
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
