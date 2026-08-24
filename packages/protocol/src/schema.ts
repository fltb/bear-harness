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
const UINT32_MAX = 4294967295;
const WireTimestamp = z
	.string()
	.min(1)
	.max(64)
	.refine((value) => Number.isFinite(Date.parse(value)), "must be a valid timestamp");
export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_MESSAGE_ATTACHMENT_BYTES / 3) * 4;
export const MessageStatus = z.union([
	z.literal("completed"),
	z.literal("failed"),
	z.literal("aborted"),
]);

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

/** Every IPC response body is either data or an error with this shape. */
export const IpcResponse = <T extends Schema>(data: T) =>
	z.union([
		z.strictObject({
			ok: z.literal(true),
			data,
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

/**
 * Event payloads are deliberately JSON-only and bounded.  This keeps replay
 * rows safe even when an event is produced by a plugin, while still allowing
 * the opaque branch below to carry a forward-compatible event kind.
 */
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
export const OpaqueEventPayload = BoundedEventValue;

const EventId = z.string().min(1).max(1024);
const EventText = z.string().max(MAX_STRING_LENGTH);
const EventPayload = <const Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
	z
		.object(shape)
		.catchall(BoundedEventValue)
		.superRefine((value, context) => {
			if (Object.keys(value).length > MAX_ARRAY_LENGTH) {
				context.addIssue({ code: "custom", message: "too many event payload fields" });
			}
		});
const EventStringList = z.array(EventText).max(MAX_ARRAY_LENGTH);

/**
 * Payload contracts for every event currently emitted by Host or consumed by
 * the renderer.  Unknown kinds intentionally use the bounded opaque payload
 * branch in `DomainEvent`; known kinds always validate the fields consumers
 * read before they are persisted or projected.
 */
export const EventPayloadSchemas = {
	"character.imported": EventPayload({ characterId: EventId, trust: BoundedEventValue }),
	"character.pluginsTrusted": EventPayload({ characterId: EventId, pluginHash: EventText }),
	"character.activated": EventPayload({ characterId: EventId }),
	"character.seeded": EventPayload({ id: EventId, name: EventText }),
	"character.scene_changed": EventPayload({
		conversationId: EventId,
		characterId: EventId,
		sceneId: EventId,
		visualState: EventText,
	}),
	"character.visual_state_changed": EventPayload({
		conversationId: EventId,
		characterId: EventId,
		sceneId: EventId,
		visualState: EventText,
	}),
	"roleplay.unlocks_reset": EventPayload({}),
	"roleplay.state_changed": EventPayload({
		conversationId: EventId,
		eventId: EventId.optional(),
		state: BoundedEventValue,
	}),
	"roleplay.media_presented": EventPayload({ conversationId: EventId, mediaId: EventId }),
	"roleplay.media_dismissed": EventPayload({ conversationId: EventId, mediaId: EventId }),
	"roleplay.choices_presented": EventPayload({ conversationId: EventId, choiceSetId: EventId }),
	"conversation.created": EventPayload({
		conversationId: EventId,
		sceneTitle: EventText.optional(),
		title: EventText.optional(),
	}),
	"conversation.selected": EventPayload({ id: EventId }),
	"conversation.renamed": EventPayload({ conversationId: EventId, title: EventText }),
	"conversation.archived": EventPayload({ conversationId: EventId, archived: z.boolean() }),
	"conversation.deleted": EventPayload({ conversationId: EventId }),
	"conversation.branched": EventPayload({
		conversationId: EventId,
		messageId: EventId,
		branchId: EventId,
	}),
	"settings.changed": EventPayload({
		settings: BoundedEventValue,
		changed: EventStringList,
	}),
	"diagnostics.memory_capture_failed": EventPayload({ message: EventText }),
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
	"canon.source_removed": EventPayload({ companionId: EventId, sourceId: EventId }),
	"canon.module_saved": EventPayload({ companionId: EventId, moduleId: EventId }),
	"canon.module_removed": EventPayload({ companionId: EventId, moduleId: EventId }),
	"evidence.collected": EventPayload({ runId: EventId, evidenceId: EventId, kind: EventText }),
	"artifact.created": EventPayload({ artifactId: EventId, runId: EventId }),
	"commission.drafted": EventPayload({ commissionId: EventId, draftHash: EventText }),
	"commission.approved": EventPayload({ commissionId: EventId, draftHash: EventText }),
	"commission.rejected": EventPayload({ commissionId: EventId }),
	"commission.status_changed": EventPayload({ commissionId: EventId, status: EventText }),
	"run.enqueued": EventPayload({
		runId: EventId,
		commissionId: EventId,
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
	"run.cancelled": EventPayload({ runId: EventId }),
	"run.result_adopted": EventPayload({
		commissionId: EventId,
		artifactId: EventId,
		runId: EventId,
	}),
	"companion.tool_started": EventPayload({
		conversationId: EventId,
		toolCallId: EventId,
		tool: EventText,
		label: EventText,
	}),
	"companion.tool_finished": EventPayload({
		conversationId: EventId,
		toolCallId: EventId,
		tool: EventText.optional(),
		ok: z.boolean(),
		message: EventText.optional(),
	}),
	"companion.state_changed": EventPayload({
		state: z.enum(["running", "crashed", "unavailable", "stopped"]),
		error: EventText.optional(),
	}),
	"companion.runtime_error": EventPayload({
		conversationId: EventId.optional(),
		code: EventText,
		message: EventText.optional(),
		command: EventText.optional(),
	}),
	"companion.runtime_ready": EventPayload({
		conversationId: EventId,
		skills: EventStringList,
		tools: EventStringList,
	}),
	"pi.session.changed": EventPayload({
		conversationId: EventId,
		sessionId: z.string().min(1).max(128),
		reason: z.enum(["message", "turn", "agent", "tool", "compaction", "queue"]),
	}),
	message_start: EventPayload({ conversationId: EventId }),
	message_update: EventPayload({ conversationId: EventId, text: EventText }),
	message_end: EventPayload({
		conversationId: EventId,
		failed: z.boolean().optional(),
		status: MessageStatus.optional(),
		reason: z.string().max(256).optional(),
		text: EventText.optional(),
		// Host-produced Pi assistant message. Not consumed by the renderer and
		// structurally arbitrary JSON (streaming deltas, tool use, usage
		// blocks), so it is deliberately opaque here; the bus JSON-roundtrips
		// every payload before persistence, so storage stays JSON-safe.
		message: z.unknown().optional(),
	}),
	"message.user_sent": EventPayload({
		conversationId: EventId,
		messageId: EventId.optional(),
		versionId: EventId.optional(),
		text: EventText.optional(),
	}),
	"message.aborted": EventPayload({ conversationId: EventId }),
	"message.regenerated": EventPayload({
		conversationId: EventId,
		messageId: EventId,
		versionId: EventId,
	}),
	"message.version_switched": EventPayload({
		conversationId: EventId,
		messageId: EventId,
		versionId: EventId,
	}),
	"message.edited": EventPayload({
		conversationId: EventId,
		messageId: EventId,
		versionId: EventId,
	}),
	"message.continued": EventPayload({ conversationId: EventId }),
	"message.corrected": EventPayload({
		conversationId: EventId,
		reason: EventText,
		applyScope: z.enum(["once", "session", "always"]),
	}),
	"message.assistant_committed": EventPayload({
		conversationId: EventId,
		messageId: EventId.optional(),
		versionId: EventId,
		failed: z.boolean().optional(),
		status: MessageStatus.optional(),
		reason: z.string().max(256).optional(),
	}),
	"codex.consented": EventPayload({
		profileId: EventId,
		canonicalPath: EventText,
		version: EventText,
		sha256: EventText,
		codexHome: EventText,
		consentedAt: EventText,
	}),
	"codex.launched": EventPayload({
		executor: EventText,
		profileId: EventId,
		runId: EventId,
		commissionId: EventId,
		version: EventText,
		sha256: EventText,
		canonicalPath: EventText,
		codexHome: EventText,
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
	"model.defaults_changed": EventPayload({ kind: z.enum(["reply", "vision"]) }),
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
/** Forward-compatible event variant for kinds unknown to this protocol version. */
export const OpaqueDomainEvent = z
	.strictObject({
		seq: EventSeq,
		kind: EventKind,
		payload: OpaqueEventPayload,
	})
	.superRefine((event, context) => {
		if (isKnownEventKind(event.kind)) {
			context.addIssue({ code: "custom", path: ["kind"], message: "known kinds are not opaque" });
		}
	});

/**
 * The shared event contract. Known kinds are checked against their matching
 * payload schema (declared fields bounded, unknown extra fields bounded);
 * unknown kinds are accepted only as bounded opaque events. Payloads are
 * JSON-roundtripped by the Host before persistence.
 */
export const DomainEvent = z
	.strictObject({
		seq: EventSeq,
		kind: EventKind,
		payload: z.unknown(),
	})
	.superRefine((event, context) => {
		const payloadSchema = isKnownEventKind(event.kind)
			? EventPayloadSchemas[event.kind]
			: OpaqueEventPayload;
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
		conversation_history_read_enabled: z.boolean().optional(),
		roleplay_initial_values: boundedRecord(
			z
				.string()
				.min(1)
				.max(64)
				.regex(/^[a-z][a-z0-9_]*$/),
			z.union([z.string().max(MAX_STRING_LENGTH), z.number().finite(), z.boolean()]),
		).optional(),
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
		setting: z.enum(["relationship_memory_enabled", "conversation_history_read_enabled"]),
		values: boundedRecord(CharacterIdentifier, z.boolean()),
	}),
	z.strictObject({
		type: z.literal("roleplay.initial"),
		variable: CharacterIdentifier,
		values: boundedRecord(
			CharacterIdentifier,
			z.union([z.string().max(MAX_STRING_LENGTH), z.number().finite(), z.boolean()]),
		),
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
export const CharacterTheme = z.strictObject({
	radius: z.strictObject({ sm: z.number(), md: z.number(), lg: z.number() }),
	color: z.strictObject({
		surface: z.string(),
		surface_alt: z.string(),
		text: z.string(),
		text_muted: z.string(),
		accent: z.string(),
		line: z.string(),
		danger: z.string(),
		amber: z.string(),
	}),
	font: z.strictObject({ body: z.string(), heading: z.string() }),
});
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
const CharacterRoleplayMedia = z.discriminatedUnion("kind", [
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("image"),
		label: CharacterCopy,
		loop: z.boolean(),
		presentation: z.enum(["dialog", "inline"]),
		url: z.string().min(1).max(20_000_000),
		posterUrl: CharacterMediaUrl.optional(),
	}),
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("animation"),
		label: CharacterCopy,
		loop: z.boolean(),
		presentation: z.enum(["dialog", "inline"]),
		url: z.string().min(1).max(20_000_000),
		posterUrl: CharacterMediaUrl,
	}),
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("audio"),
		label: CharacterCopy,
		loop: z.boolean(),
		presentation: z.enum(["dialog", "inline", "ambient"]),
		url: z.string().min(1).max(20_000_000),
		posterUrl: CharacterMediaUrl.optional(),
		captionsUrl: CharacterMediaUrl,
	}),
	z.strictObject({
		id: CharacterIdentifier,
		kind: z.literal("video"),
		label: CharacterCopy,
		loop: z.boolean(),
		presentation: z.enum(["dialog", "inline"]),
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
			scene_title: z.string().max(MAX_STRING_LENGTH),
			greeting: z.string().max(MAX_STRING_LENGTH),
			composer_placeholder: z.string().max(MAX_STRING_LENGTH),
			correction: z.strictObject({
				trigger_label: z.string().max(MAX_STRING_LENGTH),
				reason_group_label: z.string().max(MAX_STRING_LENGTH),
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
		roleplay: z.strictObject({
			variables: z
				.array(
					z.strictObject({
						id: CharacterIdentifier,
						type: z.enum(["number", "boolean", "enum", "string"]),
						scope: z.enum(["conversation", "relationship", "character"]),
						initial: z.union([z.string(), z.number(), z.boolean()]),
						display: z.union([
							z.strictObject({ kind: z.literal("hidden") }),
							z.strictObject({ kind: z.literal("exact"), label: CharacterCopy }),
							z.strictObject({
								kind: z.literal("level"),
								label: CharacterCopy,
								levels: z
									.array(z.strictObject({ min: z.number(), label: CharacterCopy }))
									.min(1)
									.max(20),
							}),
						]),
						values: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
					}),
				)
				.max(100),
			media: z.array(CharacterRoleplayMedia).max(200),
			unlockables: z
				.array(
					z.strictObject({
						id: CharacterIdentifier,
						kind: z.enum(["cg", "memory", "music", "video", "achievement"]),
						label: CharacterCopy,
						description: z.string().max(MAX_STRING_LENGTH),
						media: CharacterIdentifier.optional(),
					}),
				)
				.max(200),
			choice_sets: z
				.array(
					z.strictObject({
						id: CharacterIdentifier,
						prompt: CharacterCopy,
						choices: z
							.array(
								z.strictObject({
									id: CharacterIdentifier,
									label: CharacterCopy,
									description: z.string().max(MAX_STRING_LENGTH).optional(),
									event: CharacterIdentifier,
								}),
							)
							.min(2)
							.max(12),
					}),
				)
				.max(100),
		}),
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
		const mediaIds = new Set(character.roleplay.media.map((media) => media.id));
		for (const [index, unlockable] of character.roleplay.unlockables.entries()) {
			if (unlockable.media && !mediaIds.has(unlockable.media)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["roleplay", "unlockables", index, "media"],
					message: "unlockable media must reference listed media",
				});
			}
		}
		for (const [index, variable] of character.roleplay.variables.entries()) {
			const initialType =
				variable.type === "number"
					? typeof variable.initial === "number"
					: variable.type === "boolean"
						? typeof variable.initial === "boolean"
						: typeof variable.initial === "string";
			if (!initialType) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["roleplay", "variables", index, "initial"],
					message: "variable initial value must match its type",
				});
			}
			if (
				variable.type === "enum" &&
				(!variable.values || !variable.values.includes(variable.initial as string))
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["roleplay", "variables", index, "initial"],
					message: "enum initial value must be one of values",
				});
			}
			const display = variable.display;
			if (display.kind === "level") {
				for (let levelIndex = 1; levelIndex < display.levels.length; levelIndex += 1) {
					if (display.levels[levelIndex - 1]!.min >= display.levels[levelIndex]!.min) {
						context.addIssue({
							code: z.ZodIssueCode.custom,
							path: ["roleplay", "variables", index, "display", "levels"],
							message: "level minimums must be strictly increasing",
						});
						break;
					}
				}
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
export const CharacterPackageResponse = z.strictObject({ package: CharacterPackageDocument });

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
	pluginHash: z.string().min(1).max(128),
	pluginsPresent: z.boolean(),
	trusted: z.boolean(),
});
export const CharacterPluginTrustGetRequest = z.strictObject({
	characterId: z.string().min(1).max(64),
});
export const CharacterPluginTrustResponse = z.strictObject({ trust: CharacterPluginTrust });
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
export const CharacterDraftGetRequest = z.strictObject({ id: z.string().min(1).max(64) });
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
	sceneTitle: z.string().max(MAX_STRING_LENGTH),
	unread: z.boolean(),
	updatedAt: WireTimestamp,
});
export const ConversationListRequest = z.strictObject({});
export const ConversationListResponse = z.strictObject({
	conversations: z.array(ConversationSummary).max(MAX_ARRAY_LENGTH),
});
export const ConversationCreateRequest = z.strictObject({
	title: z.string().max(MAX_STRING_LENGTH).optional(),
});
export const ConversationSelectRequest = z.strictObject({
	id: ConversationId,
});
export const ConversationActiveGetRequest = z.strictObject({});

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
export const ConversationSearchRequest = z.strictObject({
	query: z.string().min(1).max(1000),
	includeArchived: z.boolean().optional(),
	limit: z.number().int().min(1).max(8).optional(),
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
});
const PiTimelineToolResult = z.strictObject({
	...PiTimelineBase,
	kind: z.literal("message"),
	role: z.literal("tool"),
	toolName: z.string().min(1).max(200),
	toolCallId: z.string().min(1).max(256),
	status: z.union([z.literal("succeeded"), z.literal("failed")]),
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
export const ConversationSearchHit = z.strictObject({
	conversationId: ConversationId,
	title: z.string().max(MAX_STRING_LENGTH),
	updatedAt: WireTimestamp,
	entryId: PiSessionEntryId,
	role: z.union([z.literal("user"), z.literal("assistant")]),
	excerpt: z.string().max(1000),
});
export const ConversationSearchResponse = z.strictObject({
	hits: z.array(ConversationSearchHit).max(8),
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
	errorMessage: z.string().max(4096).optional(),
});
export type PiLiveAssistantMessage = z.infer<typeof PiLiveAssistantMessage>;
export type PiLiveState = z.infer<typeof PiLiveState>;
export type PiTimeline = z.infer<typeof PiTimeline>;
export const ConversationSelectResponse = z.strictObject({
	activeConversationId: ConversationId,
	id: ConversationId,
	title: z.string().max(MAX_STRING_LENGTH),
	sceneTitle: z.string().max(MAX_STRING_LENGTH),
	piTimeline: PiTimeline,
	piSessionId: PiSessionId,
	piLiveState: PiLiveState,
});
export const ConversationCreateResponse = ConversationSelectResponse;
export const ConversationActiveResponse = z.strictObject({
	conversation: ConversationSelectResponse.optional(),
});
export const MessageSendRequest = z.strictObject({
	conversationId: ConversationId,
	text: z.string().min(1).max(65536),
	attachments: z
		.array(
			z.strictObject({
				name: z.string().min(1).max(255),
				mime: z.string().min(1).max(128),
				base64: z.string().min(1).max(MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH),
			}),
		)
		.max(MAX_MESSAGE_ATTACHMENTS)
		.optional(),
});
export const MessageSendResponse = z.strictObject({
	accepted: z.literal(true),
	sessionId: PiSessionId,
});
export const MessageRegenerateRequest = z.strictObject({
	conversationId: ConversationId,
	entryId: PiSessionEntryId,
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
export const MessageContinueRequest = z.strictObject({ conversationId: ConversationId });
export const MessageCorrectRequest = z.strictObject({
	conversationId: ConversationId,
	reason: z.string().max(MAX_STRING_LENGTH),
	applyScope: z.union([z.literal("once"), z.literal("session"), z.literal("always")]),
});
export const MessageBranchRequest = z.strictObject({
	conversationId: ConversationId,
	entryId: PiSessionEntryId,
});
export const MessageBranchResponse = z.strictObject({ leafId: PiSessionEntryId });
export const MessageAbortRequest = z.strictObject({ conversationId: ConversationId });

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryScope = z.union([
	z.literal("self"),
	z.literal("relationship"),
	z.literal("scene"),
]);
export const MemoryEntry = z
	.strictObject({
		id: z.string().min(1).max(128),
		sourceEntryId: z.string().min(1).max(128).optional(),
		kind: z.string().min(1).max(64),
		scope: MemoryScope,
		text: z.string().max(MAX_STRING_LENGTH),
		createdAt: WireTimestamp,
		updatedAt: WireTimestamp,
		importance: z.number().finite(),
	})
	.superRefine((entry, context) => {
		if (Date.parse(entry.updatedAt) < Date.parse(entry.createdAt)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["updatedAt"],
				message: "updatedAt must not precede createdAt",
			});
		}
	});
export const MemoryCaptureCreatedBy = z.union([
	z.literal("user_capture"),
	z.literal("assistant_tool"),
]);
export type MemoryCaptureCreatedBy = z.infer<typeof MemoryCaptureCreatedBy>;
const MemoryBackendId = z.string().min(1).max(128);
export const MemoryCaptureRequest = z.strictObject({
	conversationId: ConversationId,
	entryId: PiSessionEntryId,
});
export type MemoryCaptureRequest = z.infer<typeof MemoryCaptureRequest>;
export const MemoryCaptureResponse = z.strictObject({
	memoryId: MemoryBackendId,
	sourceEntryId: PiSessionEntryId,
	createdBy: MemoryCaptureCreatedBy,
});
export type MemoryCaptureResponse = z.infer<typeof MemoryCaptureResponse>;
export const MemorySearchRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	query: z.string().max(MAX_STRING_LENGTH),
	scope: MemoryScope.optional(),
});
export const MemorySearchResponse = z.strictObject({
	entries: z.array(MemoryEntry).max(MAX_ARRAY_LENGTH),
});
export const MemoryListResponse = MemorySearchResponse;
export const MemoryListRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	scope: MemoryScope.optional(),
	enabled: z.boolean().optional(),
	limit: z.number().int().safe().min(1).max(100).optional(),
});
export const MemoryForgetRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	entryId: z.string().min(1).max(128),
});

export const MemoryCandidate = z.strictObject({
	id: z.string().min(1).max(64),
	kind: z.union([
		z.literal("fact"),
		z.literal("preference"),
		z.literal("event"),
		z.literal("self_canon_summary"),
	]),
	sourceKind: z.union([
		z.literal("user_button"),
		z.literal("user_request"),
		z.literal("companion_suggestion"),
		z.literal("extractor"),
	]),
	normalizedText: z.string().max(MAX_STRING_LENGTH),
	why: z.string().max(MAX_STRING_LENGTH),
	suggestedScope: MemoryScope,
	status: z.union([
		z.literal("pending"),
		z.literal("approved"),
		z.literal("rejected"),
		z.literal("expired"),
	]),
	createdAt: WireTimestamp,
});
export const MemoryCandidatesListRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	status: z
		.union([
			z.literal("pending"),
			z.literal("approved"),
			z.literal("rejected"),
			z.literal("expired"),
		])
		.optional(),
});
export const MemoryCandidatesListResponse = z.strictObject({
	candidates: z.array(MemoryCandidate).max(MAX_ARRAY_LENGTH),
});
export const MemoryCandidateApproveRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	candidateId: z.string().min(1).max(64),
	editedText: z.string().max(MAX_STRING_LENGTH).optional(),
	decidedScope: MemoryScope.optional(),
});
export const MemoryCandidateRejectRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	candidateId: z.string().min(1).max(64),
});
export const MemoryExcludeRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	memoryId: z.string().min(1).max(128),
	excluded: z.boolean(),
});
export const MemoryEditRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
	entryId: z.string().min(1).max(128),
	newText: z.string().min(1).max(MAX_STRING_LENGTH),
});
export const LocalEmbeddingCandidate = z.strictObject({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(MAX_STRING_LENGTH),
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
	})
	.superRefine((value, context) => {
		if (value.provider === "local" && !value.candidateId) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["candidateId"],
				message: "candidateId is required for local embedding",
			});
		}
		if (value.provider === "none" && value.candidateId !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["candidateId"],
				message: "candidateId is not valid for disabled embedding",
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
export const ProviderInfo = z.strictObject({
	id: z.string().min(1).max(64),
	name: z.string().max(MAX_STRING_LENGTH),
	source: z.union([z.literal("builtin"), z.literal("custom")]),
	added: z.boolean(),
	authType: z.union([z.literal("api_key"), z.literal("oauth")]),
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
});
export const ModelDefaultsSetReplyRequest = z.strictObject({ reply: ModelRoute.nullable() });
export const ModelDefaultsSetReplyResponse = ModelDefaultsGetResponse;
export const ModelDefaultsSetVisionRequest = VisionModelDefault;
export const ModelDefaultsSetVisionResponse = ModelDefaultsGetResponse;
export const ModelRouteGetRequest = z.strictObject({ conversationId: ConversationId });
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
// Commission
// ---------------------------------------------------------------------------

export const ActionDraft = z.strictObject({
	id: z.string().min(1).max(64),
	title: z.string().max(MAX_STRING_LENGTH),
	description: z.string().max(MAX_STRING_LENGTH),
	reads: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(20),
	writes: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(20),
	networkAllowed: z.boolean(),
	toolNames: z.array(z.string().min(1).max(64)).max(20),
	hash: z.string().min(1).max(128),
});
export const Commission = z.strictObject({
	id: z.string().min(1).max(64),
	conversationId: ConversationId.optional(),
	triggerEntryId: PiSessionEntryId,
	draft: ActionDraft,
	status: z.union([
		z.literal("draft"),
		z.literal("awaiting_approval"),
		z.literal("approved"),
		z.literal("queued"),
		z.literal("running"),
		z.literal("needs_user"),
		z.literal("completed"),
		z.literal("failed"),
		z.literal("cancelled"),
	]),
	createdAt: WireTimestamp,
});
export const CommissionListRequest = z.strictObject({});
export const CommissionListResponse = z.strictObject({
	commissions: z.array(Commission).max(MAX_ARRAY_LENGTH),
});
export const CommissionDraftRequest = z.strictObject({
	conversationId: z.string().min(1).max(64),
	triggerEntryId: PiSessionEntryId,
	title: z.string().min(1).max(MAX_STRING_LENGTH),
	description: z.string().min(1).max(MAX_STRING_LENGTH),
	reads: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(20).optional(),
	writes: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(20).optional(),
	networkAllowed: z.boolean().optional(),
	toolNames: z.array(z.string().min(1).max(64)).max(20).optional(),
});
export const CommissionDraftResponse = z.strictObject({
	commissionId: z.string().min(1).max(64),
	draftHash: z.string().min(1).max(128),
});
export const CommissionApproveRequest = z.strictObject({
	commissionId: z.string().min(1).max(64),
	approvedHash: z.string().min(1).max(128),
});
export const CommissionRejectRequest = z.strictObject({
	commissionId: z.string().min(1).max(64),
});
export const CommissionLaunchRequest = z.strictObject({
	commissionId: z.string().min(1).max(64),
	executorProfile: z.string().min(1).max(64),
});
export const CommissionLaunchResponse = z.strictObject({
	runId: z.string().min(1).max(64),
	commissionId: z.string().min(1).max(64),
	executorProfile: z.string().min(1).max(64),
	status: z.string().min(1).max(64),
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
export const Run = z
	.strictObject({
		id: z.string().min(1).max(64),
		commissionId: z.string().min(1).max(64),
		executorProfile: z.string().min(1).max(64),
		status: RunStatus,
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
// Artifact
// ---------------------------------------------------------------------------

export const Artifact = z.strictObject({
	id: z.string().min(1).max(64),
	logicalName: z.string().min(1).max(MAX_STRING_LENGTH),
	mime: z.string().min(1).max(128),
	bytes: z.number().int().safe().min(0).max(UINT32_MAX),
	sha256: z.string().min(1).max(128),
	status: z.union([
		z.literal("created"),
		z.literal("verified"),
		z.literal("verification_failed"),
		z.literal("adopted"),
		z.literal("saved"),
	]),
	producerRunId: z.string().min(1).max(64).optional(),
	createdAt: WireTimestamp,
});
export const ArtifactListRequest = z.strictObject({});
export const ArtifactReadRequest = z.strictObject({
	artifactId: z.string().min(1).max(64),
});
export const ArtifactListResponse = z.strictObject({
	artifacts: z.array(Artifact).max(MAX_ARRAY_LENGTH),
});
export const ArtifactReadResponse = z.strictObject({
	logicalName: z.string().max(MAX_STRING_LENGTH),
	mime: z.string().max(128),
	base64: z.string().max(64_000_000),
});
export const ArtifactUrlRequest = z.strictObject({
	artifactId: z.string().min(1).max(64),
});
export const ArtifactUrlResponse = z.strictObject({
	/** Custom-scheme URL (bear-artifact://...) when the desktop protocol handler is registered; empty string otherwise. */
	url: z.string().max(2048),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SettingsData = z.strictObject({
	relationshipMemoryEnabled: z.boolean(),
	conversationHistoryReadEnabled: z.boolean(),
	networkProxy: z.strictObject({
		mode: z.union([z.literal("direct"), z.literal("auto"), z.literal("manual")]),
		url: z.string().min(1).max(2048).optional(),
		bypass: z.array(z.string().min(1).max(512)).max(50).optional(),
	}),
	memoryVectorService: z.strictObject({
		enabled: z.boolean(),
		provider: z.union([z.literal("none"), z.literal("remote"), z.literal("local")]),
		baseUrl: z.string().min(1).max(2048).optional(),
		apiKey: z.string().min(1).max(8192).optional(),
		model: z.string().min(1).max(200).optional(),
		dimensions: z.number().int().safe().min(0).max(65536).optional(),
		localModel: z.string().min(1).max(200).optional(),
		customPath: z.string().min(1).max(4096).optional(),
	}),
	modelDownloadMirror: z.strictObject({
		endpoint: z.string().min(1).max(2048).optional(),
	}),
});
export const SettingsGetRequest = z.strictObject({
	characterId: z.string().min(1).max(64).optional(),
});
export const SettingsResponse = z.strictObject({
	settings: SettingsData,
});
export const SettingsPatch = z.strictObject({
	relationshipMemoryEnabled: z.boolean().optional(),
	conversationHistoryReadEnabled: z.boolean().optional(),
	networkProxy: SettingsData.shape.networkProxy.optional(),
	memoryVectorService: SettingsData.shape.memoryVectorService.optional(),
	modelDownloadMirror: SettingsData.shape.modelDownloadMirror.optional(),
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
	z.literal("commission"),
	z.literal("run"),
	z.literal("permission"),
	z.literal("fsop"),
	z.literal("memory"),
	z.literal("config"),
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

export const ConversationSnapshot = z.strictObject({
	conversations: z.array(ConversationSummary).max(MAX_ARRAY_LENGTH).optional(),
	activeConversationId: ConversationId.optional(),
	id: ConversationId.optional(),
	title: z.string().max(MAX_STRING_LENGTH).optional(),
	sceneTitle: z.string().max(MAX_STRING_LENGTH).optional(),
	piTimeline: PiTimeline.optional(),
});
export const MemorySnapshot = z.strictObject({
	entries: z.array(MemoryEntry).max(MAX_ARRAY_LENGTH).optional(),
});
export const CharacterRuntimeState = z.strictObject({
	sceneId: z.string().min(1).max(64),
	visualState: z.string().min(1).max(64),
});
export const CharacterRuntimeSnapshot = z.strictObject({
	byConversation: boundedRecord(ConversationId, CharacterRuntimeState),
});
export const RoleplayValue = z.union([
	z.string().max(MAX_STRING_LENGTH),
	z.number().finite(),
	z.boolean(),
]);
export const RoleplayState = z.strictObject({
	values: boundedRecord(z.string().min(1).max(64), RoleplayValue),
	unlocked: z.array(z.string().min(1).max(64)).max(200),
});
export const RoleplayGetRequest = z.strictObject({ conversationId: ConversationId.optional() });
export const RoleplayTriggerRequest = z.strictObject({
	conversationId: ConversationId,
	eventId: z.string().min(1).max(64),
	dedupeKey: z.string().min(1).max(128),
});
export const RoleplayDismissMediaRequest = z.strictObject({
	conversationId: ConversationId,
	mediaId: z.string().min(1).max(64),
});
export const RoleplayResetUnlocksRequest = z.strictObject({});
export const RoleplayResponse = z.strictObject({ state: RoleplayState });
export const SnapshotGetRequest = z.strictObject({});
export const SnapshotResponse = z.strictObject({
	eventSeq: EventSeq,
	onboarding: OnboardingResponse.optional(),
	character: CharacterDisplay.optional(),
	conversation: ConversationSnapshot.optional(),
	memory: MemorySnapshot.optional(),
	provider: ProviderListResponse.optional(),
	model: ModelSnapshot.optional(),
	commission: CommissionListResponse.optional(),
	run: RunListResponse.optional(),
	artifact: ArtifactListResponse.optional(),
	characterRuntime: CharacterRuntimeSnapshot.optional(),
	roleplay: RoleplayState.optional(),
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
): RpcEndpoint<ChannelName, Request, Response> => ({
	kind: "rpc",
	channel,
	request,
	response,
});

/** The sole runtime and type-level source of truth for every Host RPC channel. */
export const RPC = {
	snapshot: {
		get: endpoint("snapshot.get:v1", SnapshotGetRequest, SnapshotResponse),
	},
	character: {
		get: endpoint("character.get:v1", CharacterGetRequest, CharacterResponse),
		list: endpoint("character.list:v1", CharacterListRequest, CharacterListResponse),
		activate: endpoint("character.activate:v1", CharacterActivateRequest, CharacterResponse),
		packageGet: endpoint(
			"character.packageGet:v1",
			CharacterPackageGetRequest,
			CharacterPackageResponse,
		),
		packageUpdate: endpoint(
			"character.packageUpdate:v1",
			CharacterPackageUpdateRequest,
			CharacterPackageResponse,
		),
		import: endpoint("character.import:v1", CharacterImportRequest, CharacterResponse),
		pluginTrustGet: endpoint(
			"character.pluginTrustGet:v1",
			CharacterPluginTrustGetRequest,
			CharacterPluginTrustResponse,
		),
		pluginTrustConfirm: endpoint(
			"character.pluginTrustConfirm:v1",
			CharacterPluginTrustConfirmRequest,
			CharacterPluginTrustResponse,
		),
		draftCreate: endpoint(
			"character.draftCreate:v1",
			CharacterDraftCreateRequest,
			CharacterDraftResponse,
		),
		draftGet: endpoint("character.draftGet:v1", CharacterDraftGetRequest, CharacterDraftResponse),
		draftPatch: endpoint(
			"character.draftPatch:v1",
			CharacterDraftPatchRequest,
			CharacterDraftResponse,
		),
		draftUploadAssets: endpoint(
			"character.draftUploadAssets:v1",
			CharacterDraftUploadAssetsRequest,
			CharacterDraftResponse,
		),
		draftListRevisions: endpoint(
			"character.draftListRevisions:v1",
			CharacterDraftListRevisionsRequest,
			CharacterDraftListRevisionsResponse,
		),
		draftRestoreRevision: endpoint(
			"character.draftRestoreRevision:v1",
			CharacterDraftRestoreRevisionRequest,
			CharacterDraftResponse,
		),
		draftValidate: endpoint(
			"character.draftValidate:v1",
			CharacterDraftValidateRequest,
			CharacterDraftResponse,
		),
		draftPublish: endpoint(
			"character.draftPublish:v1",
			CharacterDraftPublishRequest,
			CharacterDraftPublishResponse,
		),
	},
	roleplay: {
		get: endpoint("roleplay.get:v1", RoleplayGetRequest, RoleplayResponse),
		trigger: endpoint("roleplay.trigger:v1", RoleplayTriggerRequest, RoleplayResponse),
		dismissMedia: endpoint("roleplay.dismissMedia:v1", RoleplayDismissMediaRequest, EmptyResponse),
		resetUnlocks: endpoint("roleplay.reset-unlocks:v1", RoleplayResetUnlocksRequest, EmptyResponse),
	},
	events: {
		subscribe: endpoint("events.subscribe:v1", EventSubscribeRequest, EventSubscribeResponse),
	},
	onboarding: {
		get: endpoint("onboarding.get:v1", OnboardingGetRequest, OnboardingResponse),
		submit: endpoint("onboarding.submit:v1", OnboardingSubmitRequest, OnboardingResponse),
	},
	conversation: {
		list: endpoint("conversation.list:v1", ConversationListRequest, ConversationListResponse),
		create: endpoint(
			"conversation.create:v1",
			ConversationCreateRequest,
			ConversationCreateResponse,
		),
		select: endpoint(
			"conversation.select:v1",
			ConversationSelectRequest,
			ConversationSelectResponse,
		),
		activeGet: endpoint(
			"conversation.activeGet:v1",
			ConversationActiveGetRequest,
			ConversationActiveResponse,
		),
		rename: endpoint("conversation.rename:v1", ConversationRenameRequest, EmptyResponse),
		archive: endpoint(
			"conversation.archive:v1",
			ConversationArchiveRequest,
			ConversationActiveResponse,
		),
		delete: endpoint(
			"conversation.delete:v1",
			ConversationDeleteRequest,
			ConversationActiveResponse,
		),
		search: endpoint(
			"conversation.search:v1",
			ConversationSearchRequest,
			ConversationSearchResponse,
		),
	},
	message: {
		send: endpoint("message.send:v1", MessageSendRequest, MessageSendResponse),
		regenerate: endpoint("message.regenerate:v1", MessageRegenerateRequest, EmptyResponse),
		switchVersion: endpoint("message.switchVersion:v1", MessageSwitchVersionRequest, EmptyResponse),
		edit: endpoint("message.edit:v1", MessageEditRequest, EmptyResponse),
		continue: endpoint("message.continue:v1", MessageContinueRequest, EmptyResponse),
		correct: endpoint("message.correct:v1", MessageCorrectRequest, EmptyResponse),
		branch: endpoint("message.branch:v1", MessageBranchRequest, MessageBranchResponse),
		abort: endpoint("message.abort:v1", MessageAbortRequest, EmptyResponse),
	},
	memory: {
		search: endpoint("memory.search:v1", MemorySearchRequest, MemorySearchResponse),
		list: endpoint("memory.list:v1", MemoryListRequest, MemoryListResponse),
		capture: endpoint("memory.capture:v1", MemoryCaptureRequest, MemoryCaptureResponse),
		forget: endpoint("memory.forget:v1", MemoryForgetRequest, EmptyResponse),
		edit: endpoint("memory.edit:v1", MemoryEditRequest, EmptyResponse),
		exclude: endpoint("memory.exclude:v1", MemoryExcludeRequest, EmptyResponse),
		configureLocalEmbedding: endpoint(
			"memory.configureLocalEmbedding:v1",
			MemoryConfigureLocalEmbeddingRequest,
			MemoryConfigureLocalEmbeddingResponse,
		),
		candidatesList: endpoint(
			"memory.candidates.list:v1",
			MemoryCandidatesListRequest,
			MemoryCandidatesListResponse,
		),
		candidateApprove: endpoint(
			"memory.candidate.approve:v1",
			MemoryCandidateApproveRequest,
			EmptyResponse,
		),
		candidateReject: endpoint(
			"memory.candidate.reject:v1",
			MemoryCandidateRejectRequest,
			EmptyResponse,
		),
	},
	canon: {
		listSources: endpoint(
			"canon.listSources:v1",
			CanonListSourcesRequest,
			CanonListSourcesResponse,
		),
		addSource: endpoint("canon.addSource:v1", CanonAddSourceRequest, CanonAddSourceResponse),
		search: endpoint("canon.search:v1", CanonSearchRequest, CanonSearchResponse),
		removeSource: endpoint("canon.removeSource:v1", CanonRemoveSourceRequest, EmptyResponse),
		listModules: endpoint(
			"canon.listModules:v1",
			CanonListModulesRequest,
			CanonListModulesResponse,
		),
		upsertModule: endpoint(
			"canon.upsertModule:v1",
			CanonUpsertModuleRequest,
			CanonUpsertModuleResponse,
		),
		deleteModule: endpoint("canon.deleteModule:v1", CanonDeleteModuleRequest, EmptyResponse),
	},
	provider: {
		list: endpoint("provider.list:v1", ProviderListRequest, ProviderListResponse),
		customUpsert: endpoint("provider.customUpsert:v1", ProviderCustomUpsertRequest, EmptyResponse),
		importPiConfig: endpoint(
			"provider.importPiConfig:v1",
			ProviderImportPiConfigRequest,
			ProviderImportPiConfigResponse,
		),
		overrideBaseUrl: endpoint(
			"provider.overrideBaseUrl:v1",
			ProviderOverrideBaseUrlRequest,
			EmptyResponse,
		),
		setApiKey: endpoint("provider.setApiKey:v1", ProviderSetApiKeyRequest, EmptyResponse),
		login: endpoint("provider.login:v1", ProviderLoginRequest, ProviderLoginResponse),
		loginStatus: endpoint(
			"provider.loginStatus:v1",
			ProviderLoginStatusRequest,
			ProviderLoginResponse,
		),
		loginCancel: endpoint(
			"provider.loginCancel:v1",
			ProviderLoginCancelRequest,
			ProviderLoginCancelResponse,
		),
		loginAnswer: endpoint(
			"provider.loginAnswer:v1",
			ProviderLoginAnswerRequest,
			ProviderLoginResponse,
		),
		logout: endpoint("provider.logout:v1", ProviderLogoutRequest, EmptyResponse),
		remove: endpoint("provider.remove:v1", ProviderRemoveRequest, EmptyResponse),
	},
	model: {
		poolGet: endpoint("model.pool.get:v1", ModelPoolGetRequest, ModelPoolGetResponse),
		enable: endpoint("model.enable:v1", ModelEnableRequest, ModelEnableResponse),
		disable: endpoint("model.disable:v1", ModelDisableRequest, EmptyResponse),
		defaultsGet: endpoint(
			"model.defaults.get:v1",
			ModelDefaultsGetRequest,
			ModelDefaultsGetResponse,
		),
		defaultsSetReply: endpoint(
			"model.defaults.setReply:v1",
			ModelDefaultsSetReplyRequest,
			ModelDefaultsSetReplyResponse,
		),
		defaultsSetVision: endpoint(
			"model.defaults.setVision:v1",
			ModelDefaultsSetVisionRequest,
			ModelDefaultsSetVisionResponse,
		),
		routeGet: endpoint("model.route.get:v1", ModelRouteGetRequest, ModelRouteGetResponse),
		routeSet: endpoint("model.route.set:v1", ModelRouteSetRequest, ModelRouteSetResponse),
	},
	commission: {
		list: endpoint("commission.list:v1", CommissionListRequest, CommissionListResponse),
		draft: endpoint("commission.draft:v1", CommissionDraftRequest, CommissionDraftResponse),
		approve: endpoint("commission.approve:v1", CommissionApproveRequest, EmptyResponse),
		reject: endpoint("commission.reject:v1", CommissionRejectRequest, EmptyResponse),
		launch: endpoint("commission.launch:v1", CommissionLaunchRequest, CommissionLaunchResponse),
	},
	run: {
		list: endpoint("run.list:v1", RunListRequest, RunListResponse),
		steer: endpoint("run.steer:v1", RunSteerRequest, EmptyResponse),
		interrupt: endpoint("run.interrupt:v1", RunInterruptRequest, RunResponse),
		resume: endpoint("run.resume:v1", RunResumeRequest, RunResponse),
		cancel: endpoint("run.cancel:v1", RunCancelRequest, RunResponse),
		respondPermission: endpoint(
			"run.respondPermission:v1",
			RunRespondPermissionRequest,
			RunResponse,
		),
	},
	artifact: {
		list: endpoint("artifact.list:v1", ArtifactListRequest, ArtifactListResponse),
		read: endpoint("artifact.read:v1", ArtifactReadRequest, ArtifactReadResponse),
		url: endpoint("artifact.url:v1", ArtifactUrlRequest, ArtifactUrlResponse),
	},
	settings: {
		get: endpoint("settings.get:v1", SettingsGetRequest, SettingsResponse),
		set: endpoint("settings.set:v1", SettingsSetRequest, SettingsResponse),
		capabilitiesGet: endpoint(
			"settings.capabilitiesGet:v1",
			SettingsCapabilitiesGetRequest,
			SettingsCapabilitiesGetResponse,
		),
	},
	update: {
		check: endpoint("update.check:v1", UpdateCheckRequest, UpdateCheckResponse),
		discard: endpoint("update.discard:v1", UpdateDiscardRequest, UpdateDiscardResponse),
		apply: endpoint("update.apply:v1", UpdateApplyRequest, UpdateApplyResponse),
	},
	audit: {
		list: endpoint("audit.list:v1", AuditListRequest, AuditListResponse),
		export: endpoint("audit.export:v1", AuditExportRequest, AuditExportResponse),
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

/**
 * Compatibility view for transport code that only enumerates request schemas.
 * This map intentionally omits each endpoint's response schema and metadata;
 * use `RPC` or `CHANNEL_CONTRACTS` for a complete endpoint contract.
 */
export const REQUEST_SCHEMAS = Object.freeze(
	Object.fromEntries(
		Object.entries(CHANNEL_CONTRACTS).map(([channel, value]) => [channel, value.request]),
	),
);
