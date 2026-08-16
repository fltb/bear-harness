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
const MAX_SAFE_INT = 9007199254740991;
const UINT32_MAX = 4294967295;
export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_MESSAGE_ATTACHMENT_BYTES / 3) * 4;

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

/** A single domain event published after the Host commits the state change. */
export const DomainEvent = z.strictObject({
	seq: EventSeq,
	kind: z.string().max(128),
	payload: z.unknown(),
});
export const EventSubscribeRequest = z.strictObject({
	afterSeq: EventSeq.optional(),
});
export const EventSubscribeResponse = z.strictObject({
	events: z.array(DomainEvent).max(MAX_ARRAY_LENGTH),
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const SnapshotGetRequest = z.strictObject({});

// ---------------------------------------------------------------------------
// Onboarding (first-meeting FSM)
// ---------------------------------------------------------------------------

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
	answers: z.record(
		z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][a-z0-9_]*$/),
		z.string().max(MAX_STRING_LENGTH),
	),
	decisions: z.strictObject({
		relationship_kind: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z][a-z0-9_]*$/)
			.optional(),
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
	z.strictObject({ type: z.literal("relationship.kind") }),
	z.strictObject({ type: z.literal("relationship.memory"), enabled_when: CharacterIdentifier }),
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
export const CharacterDisplay = z.strictObject({
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
		first_meeting: CharacterOnboardingFlow,
	}),
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
		expressions: z.record(z.string().max(64), CharacterMediaUrl),
		expressionLabels: z.record(z.string().max(64), z.string().max(MAX_STRING_LENGTH)),
	}),
	roleplay: z.strictObject({
		variables: z
			.array(
				z.strictObject({
					id: CharacterIdentifier,
					type: z.enum(["number", "boolean", "enum", "string"]),
					scope: z.enum(["conversation", "relationship", "global"]),
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
		media: z
			.array(
				z.strictObject({
					id: CharacterIdentifier,
					kind: z.enum(["image", "animation", "audio", "video"]),
					label: CharacterCopy,
					loop: z.boolean(),
					url: z.string().min(1).max(20_000_000),
					posterUrl: CharacterMediaUrl.optional(),
					captionsUrl: CharacterMediaUrl.optional(),
				}),
			)
			.max(200),
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
});
export const CharacterResponse = z.strictObject({
	character: CharacterDisplay,
});
export const CharacterActivateRequest = z.strictObject({
	characterId: z.string().min(1).max(64),
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
export const BranchId = z.string().min(1).max(64);
export const MessageId = z.string().min(1).max(64);
export const MessageVersionId = z.string().min(1).max(64);
export const ConversationSummary = z.strictObject({
	id: ConversationId,
	title: z.string().max(MAX_STRING_LENGTH),
	sceneTitle: z.string().max(MAX_STRING_LENGTH),
	unread: z.boolean(),
	updatedAt: z.string().max(64),
});
export const ConversationListRequest = z.strictObject({});
export const ConversationListResponse = z.strictObject({
	conversations: z.array(ConversationSummary).max(MAX_ARRAY_LENGTH),
});
export const ConversationCreateRequest = z.strictObject({
	title: z.string().max(MAX_STRING_LENGTH).optional(),
});
export const ConversationCreateResponse = z.strictObject({
	id: ConversationId,
});
export const ConversationSelectRequest = z.strictObject({
	id: ConversationId,
	branchId: BranchId.optional(),
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

export const MessageRole = z.union([
	z.literal("user"),
	z.literal("assistant"),
	z.literal("system"),
]);
export const MessageVersion = z.strictObject({
	id: MessageVersionId,
	role: MessageRole,
	content: z.string().max(65536),
	editedByUser: z.boolean(),
	createdAt: z.string().max(64),
	adopted: z.boolean(),
});
export const Message = z.strictObject({
	id: MessageId,
	role: MessageRole,
	adoptedVersionId: MessageVersionId.optional(),
	versions: z.array(MessageVersion).max(20),
	createdAt: z.string().max(64),
});
export const ConversationSelectResponse = z.strictObject({
	activeConversationId: ConversationId,
	activeBranchId: BranchId.optional(),
	id: ConversationId,
	title: z.string().max(MAX_STRING_LENGTH),
	sceneTitle: z.string().max(MAX_STRING_LENGTH),
	messages: z.array(Message).max(MAX_ARRAY_LENGTH),
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
	messageId: MessageId,
	versionId: MessageVersionId,
	status: z.union([z.literal("completed"), z.literal("failed"), z.literal("aborted")]),
});
export const MessageRegenerateRequest = z.strictObject({
	conversationId: ConversationId,
	messageId: MessageId,
});
export const MessageSwitchVersionRequest = z.strictObject({
	conversationId: ConversationId,
	messageId: MessageId,
	versionId: MessageVersionId,
});
export const MessageEditRequest = z.strictObject({
	conversationId: ConversationId,
	messageId: MessageId,
	text: z.string().min(1).max(65536),
	isUserMessage: z.boolean(),
});
export const MessageContinueRequest = z.strictObject({
	conversationId: ConversationId,
});
export const MessageCorrectRequest = z.strictObject({
	conversationId: ConversationId,
	reason: z.string().max(MAX_STRING_LENGTH),
	applyScope: z.union([z.literal("once"), z.literal("session"), z.literal("always")]),
});
export const MessageBranchRequest = z.strictObject({
	conversationId: ConversationId,
	messageId: MessageId,
});
export const MessageBranchResponse = z.strictObject({
	branchId: BranchId,
});
export const MessageAbortRequest = z.strictObject({
	conversationId: ConversationId,
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryScope = z.union([
	z.literal("self"),
	z.literal("relationship"),
	z.literal("scene"),
]);
export const MemoryCandidate = z.strictObject({
	id: z.string().max(64),
	kind: z.union([
		z.literal("fact"),
		z.literal("preference"),
		z.literal("event"),
		z.literal("self_canon_summary"),
	]),
	scope: MemoryScope,
	text: z.string().max(MAX_STRING_LENGTH),
	why: z.string().max(MAX_STRING_LENGTH),
	status: z.union([
		z.literal("pending"),
		z.literal("approved"),
		z.literal("rejected"),
		z.literal("expired"),
	]),
	createdAt: z.string().max(64),
});
export const MemoryEntry = z.strictObject({
	id: z.string().max(64),
	kind: z.string().max(64),
	scope: MemoryScope,
	text: z.string().max(MAX_STRING_LENGTH),
	normalizedText: z.string().max(MAX_STRING_LENGTH),
	sourceConversationTitle: z.string().max(MAX_STRING_LENGTH),
	pinned: z.boolean(),
	createdAt: z.string().max(64),
});
export const MemoryListCandidatesRequest = z.strictObject({});
export const MemoryListCandidatesResponse = z.strictObject({
	candidates: z.array(MemoryCandidate).max(MAX_ARRAY_LENGTH),
});
export const MemoryApprovalDecision = z.union([
	z.literal("approve"),
	z.literal("approve_edited"),
	z.literal("reject"),
]);
export const MemoryDecideCandidateRequest = z.strictObject({
	candidateId: z.string().max(64),
	decision: MemoryApprovalDecision,
	editedText: z.string().max(MAX_STRING_LENGTH).optional(),
	scope: MemoryScope.optional(),
});
export const MemorySearchRequest = z.strictObject({
	query: z.string().max(MAX_STRING_LENGTH),
	scope: MemoryScope.optional(),
});
export const MemorySearchResponse = z.strictObject({
	entries: z.array(MemoryEntry).max(MAX_ARRAY_LENGTH),
});
export const MemoryListResponse = MemorySearchResponse;
export const MemoryListRequest = z.strictObject({
	scope: MemoryScope.optional(),
	enabled: z.boolean().optional(),
	limit: z.number().int().safe().min(1).max(100).optional(),
});
export const MemoryPinRequest = z.strictObject({
	entryId: z.string().max(64),
	pinned: z.boolean(),
});
export const MemoryForgetRequest = z.strictObject({
	entryId: z.string().max(64),
});
export const MemoryExcludeRequest = z.strictObject({
	entryId: z.string().max(64),
	excluded: z.boolean(),
});
export const MemoryEditRequest = z.strictObject({
	entryId: z.string().max(64),
	newText: z.string().min(1).max(MAX_STRING_LENGTH),
});

// ---------------------------------------------------------------------------
// Story archive (natural-language changes over read-only source canon)
// ---------------------------------------------------------------------------

export const StoryChangeScope = z.union([z.literal("global"), z.literal("branch")]);
export const StoryChangeSource = z.union([
	z.literal("user_explicit"),
	z.literal("story_event"),
	z.literal("user_confirmed"),
]);
export const StoryChange = z.strictObject({
	id: z.string().min(1).max(64),
	text: z.string().min(1).max(MAX_STRING_LENGTH),
	scope: StoryChangeScope,
	source: StoryChangeSource,
	conversationId: ConversationId.optional(),
	branchId: BranchId.optional(),
	createdAt: z.string().max(64),
});
export const StoryListChangesRequest = z.strictObject({
	branchId: BranchId.optional(),
});
export const StoryListChangesResponse = z.strictObject({
	changes: z.array(StoryChange).max(MAX_ARRAY_LENGTH),
});
export const StoryApplyChangeRequest = z.strictObject({
	conversationId: ConversationId.optional(),
	branchId: BranchId.optional(),
	text: z.string().min(1).max(MAX_STRING_LENGTH),
	scope: StoryChangeScope,
});
export const StoryApplyChangeResponse = z.strictObject({
	change: StoryChange,
});
export const StoryRevertChangeRequest = z.strictObject({
	changeId: z.string().min(1).max(64),
	conversationId: ConversationId.optional(),
});
export const StoryResetRequest = z.strictObject({
	conversationId: ConversationId.optional(),
	branchId: BranchId.optional(),
});
export const StoryResetResponse = z.strictObject({
	count: z.number().int().safe().min(0).max(MAX_SAFE_INT),
});
export const StoryChangeProposal = z.strictObject({
	id: z.string().min(1).max(64),
	conversationId: ConversationId,
	branchId: BranchId,
	text: z.string().min(1).max(MAX_STRING_LENGTH),
	createdAt: z.string().max(64),
});
export const StoryListProposalsRequest = z.strictObject({
	conversationId: ConversationId.optional(),
});
export const StoryListProposalsResponse = z.strictObject({
	proposals: z.array(StoryChangeProposal).max(MAX_ARRAY_LENGTH),
});
export const StoryResolveProposalRequest = z.strictObject({
	proposalId: z.string().min(1).max(64),
	accept: z.boolean(),
});
export const StoryResolveProposalResponse = z.strictObject({
	change: StoryChange.optional(),
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
	createdAt: z.string().max(64),
	origin: z.enum(["user", "package"]),
	language: z.string().max(35).nullable(),
	sourceKind: z.string().max(64).nullable(),
});
export const CanonChunk = z.strictObject({
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
	createdAt: z.string().max(64),
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
	id: z.string().max(64),
	name: z.string().max(MAX_STRING_LENGTH),
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
	availableModels: z
		.array(
			z.strictObject({
				id: z.string().max(128),
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
	providerId: z.string().max(64),
	apiKey: z.string().min(1).max(2048),
	sessionOnly: z.boolean().optional(),
});
export const ProviderSetApiKeyResponse = z.strictObject({
	status: ProviderInfo.shape.credentialStatus,
});
export const ProviderLoginRequest = z.strictObject({
	providerId: z.string().max(64),
	authType: z.literal("oauth"),
});
export const ProviderLoginResponse = z.strictObject({
	providerId: z.string().max(64),
	status: z.union([
		z.literal("running"),
		z.literal("waiting_input"),
		z.literal("completed"),
		z.literal("failed"),
	]),
	authUrl: z.string().max(2048).optional(),
	deviceCode: z.string().max(128).optional(),
	verificationUri: z.string().max(2048).optional(),
	message: z.string().max(MAX_STRING_LENGTH).optional(),
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
export const ProviderLoginStatusRequest = z.strictObject({
	providerId: z.string().max(64),
});
export const ProviderLoginAnswerRequest = z.strictObject({
	providerId: z.string().max(64),
	answer: z.string().max(4096),
});
export const ProviderLogoutRequest = z.strictObject({
	providerId: z.string().max(64),
});

// ---------------------------------------------------------------------------
// Configured models
// ---------------------------------------------------------------------------

export const ModelRoute = z.strictObject({
	providerId: z.string().max(64),
	modelId: z.string().max(128),
});
export const ConfiguredModel = z.strictObject({
	...ModelRoute.shape,
	label: z.string().max(MAX_STRING_LENGTH),
	providerName: z.string().max(MAX_STRING_LENGTH).optional(),
	supportsImages: z.boolean(),
	createdAt: z.string().max(64),
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
	id: z.string().max(64),
	title: z.string().max(MAX_STRING_LENGTH),
	description: z.string().max(MAX_STRING_LENGTH),
	reads: z.array(z.string().max(MAX_PATH_LENGTH)).max(20),
	writes: z.array(z.string().max(MAX_PATH_LENGTH)).max(20),
	networkAllowed: z.boolean(),
	toolNames: z.array(z.string().max(64)).max(20),
	hash: z.string().max(128),
});
export const Commission = z.strictObject({
	id: z.string().max(64),
	conversationId: ConversationId.optional(),
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
	createdAt: z.string().max(64),
});
export const CommissionListRequest = z.strictObject({});
export const CommissionListResponse = z.strictObject({
	commissions: z.array(Commission).max(MAX_ARRAY_LENGTH),
});
export const CommissionDraftRequest = z.strictObject({
	conversationId: z.string().min(1).max(64),
	title: z.string().min(1).max(MAX_STRING_LENGTH),
	description: z.string().min(1).max(MAX_STRING_LENGTH),
	reads: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(20).optional(),
	writes: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(20).optional(),
	networkAllowed: z.boolean().optional(),
	toolNames: z.array(z.string().min(1).max(64)).max(20).optional(),
});
export const CommissionDraftResponse = z.strictObject({
	commissionId: z.string().max(64),
	draftHash: z.string().max(128),
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
	runId: z.string().max(64),
	commissionId: z.string().max(64),
	executorProfile: z.string().max(64),
	status: z.string().max(64),
});
export const RunSteerRequest = z.strictObject({
	runId: z.string().min(1).max(64),
	instruction: z.string().min(1).max(MAX_STRING_LENGTH),
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
export const Run = z.strictObject({
	id: z.string().max(64),
	commissionId: z.string().max(64),
	executorProfile: z.string().max(64),
	status: RunStatus,
	startedAt: z.string().max(64).optional(),
	completedAt: z.string().max(64).optional(),
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
	id: z.string().max(64),
	logicalName: z.string().max(MAX_STRING_LENGTH),
	mime: z.string().max(128),
	bytes: z.number().int().safe().min(0).max(UINT32_MAX),
	sha256: z.string().max(128),
	status: z.union([
		z.literal("created"),
		z.literal("verified"),
		z.literal("verification_failed"),
		z.literal("adopted"),
		z.literal("saved"),
	]),
	producerRunId: z.string().max(64).optional(),
	createdAt: z.string().max(64),
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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SettingsData = z.strictObject({
	relationshipMemoryEnabled: z.boolean(),
});
export const SettingsGetRequest = z.strictObject({});
export const SettingsResponse = z.strictObject({
	settings: SettingsData,
});
export const SettingsPatch = z.strictObject({
	relationshipMemoryEnabled: z.boolean().optional(),
});
export const SettingsSetRequest = z.strictObject({
	settings: SettingsPatch,
});
export const ProviderCustomUpsertRequest = z.strictObject({
	providerId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9._-]*$/),
	name: z.string().min(1).max(100),
	baseUrl: z.string().min(8).max(2048),
	modelId: z.string().min(1).max(200),
	apiKey: z.string().min(1).max(8192).optional(),
	supportsImages: z.boolean().optional(),
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
	activeBranchId: BranchId.optional(),
	id: ConversationId.optional(),
	title: z.string().max(MAX_STRING_LENGTH).optional(),
	sceneTitle: z.string().max(MAX_STRING_LENGTH).optional(),
	messages: z.array(Message).max(MAX_ARRAY_LENGTH).optional(),
});
export const MemorySnapshot = z.strictObject({
	candidates: z.array(MemoryCandidate).max(MAX_ARRAY_LENGTH).optional(),
	entries: z.array(MemoryEntry).max(MAX_ARRAY_LENGTH).optional(),
});
export const CharacterRuntimeState = z.strictObject({
	sceneId: z.string().min(1).max(64),
	visualState: z.string().min(1).max(64),
});
export const CharacterRuntimeSnapshot = z.strictObject({
	byConversation: z.record(ConversationId, CharacterRuntimeState),
});
export const RoleplayValue = z.union([
	z.string().max(MAX_STRING_LENGTH),
	z.number().finite(),
	z.boolean(),
]);
export const RoleplayState = z.strictObject({
	values: z.record(z.string().min(1).max(64), RoleplayValue),
	unlocked: z.array(z.string().min(1).max(64)).max(200),
});
export const RoleplayGetRequest = z.strictObject({ conversationId: ConversationId.optional() });
export const RoleplayTriggerRequest = z.strictObject({
	conversationId: ConversationId,
	eventId: z.string().min(1).max(64),
	dedupeKey: z.string().min(1).max(128),
});
export const RoleplayResetUnlocksRequest = z.strictObject({});
export const RoleplayResponse = z.strictObject({ state: RoleplayState });
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
	story: StoryListChangesResponse.optional(),
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
		import: endpoint("character.import:v1", CharacterImportRequest, CharacterResponse),
	},
	roleplay: {
		get: endpoint("roleplay.get:v1", RoleplayGetRequest, RoleplayResponse),
		trigger: endpoint("roleplay.trigger:v1", RoleplayTriggerRequest, RoleplayResponse),
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
		rename: endpoint("conversation.rename:v1", ConversationRenameRequest, EmptyResponse),
		archive: endpoint("conversation.archive:v1", ConversationArchiveRequest, EmptyResponse),
		delete: endpoint("conversation.delete:v1", ConversationDeleteRequest, EmptyResponse),
	},
	message: {
		send: endpoint("message.send:v1", MessageSendRequest, MessageSendResponse),
		regenerate: endpoint("message.regenerate:v1", MessageRegenerateRequest, MessageSendResponse),
		switchVersion: endpoint("message.switchVersion:v1", MessageSwitchVersionRequest, EmptyResponse),
		edit: endpoint("message.edit:v1", MessageEditRequest, EmptyResponse),
		continue: endpoint("message.continue:v1", MessageContinueRequest, EmptyResponse),
		correct: endpoint("message.correct:v1", MessageCorrectRequest, EmptyResponse),
		branch: endpoint("message.branch:v1", MessageBranchRequest, MessageBranchResponse),
		abort: endpoint("message.abort:v1", MessageAbortRequest, EmptyResponse),
	},
	memory: {
		listCandidates: endpoint(
			"memory.listCandidates:v1",
			MemoryListCandidatesRequest,
			MemoryListCandidatesResponse,
		),
		decideCandidate: endpoint(
			"memory.decideCandidate:v1",
			MemoryDecideCandidateRequest,
			EmptyResponse,
		),
		search: endpoint("memory.search:v1", MemorySearchRequest, MemorySearchResponse),
		list: endpoint("memory.list:v1", MemoryListRequest, MemoryListResponse),
		pin: endpoint("memory.pin:v1", MemoryPinRequest, EmptyResponse),
		forget: endpoint("memory.forget:v1", MemoryForgetRequest, EmptyResponse),
		exclude: endpoint("memory.exclude:v1", MemoryExcludeRequest, EmptyResponse),
		edit: endpoint("memory.edit:v1", MemoryEditRequest, EmptyResponse),
	},
	story: {
		listChanges: endpoint(
			"story.listChanges:v1",
			StoryListChangesRequest,
			StoryListChangesResponse,
		),
		applyChange: endpoint(
			"story.applyChange:v1",
			StoryApplyChangeRequest,
			StoryApplyChangeResponse,
		),
		revertChange: endpoint("story.revertChange:v1", StoryRevertChangeRequest, EmptyResponse),
		reset: endpoint("story.reset:v1", StoryResetRequest, StoryResetResponse),
		listProposals: endpoint(
			"story.listProposals:v1",
			StoryListProposalsRequest,
			StoryListProposalsResponse,
		),
		resolveProposal: endpoint(
			"story.resolveProposal:v1",
			StoryResolveProposalRequest,
			StoryResolveProposalResponse,
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
		loginAnswer: endpoint(
			"provider.loginAnswer:v1",
			ProviderLoginAnswerRequest,
			ProviderLoginResponse,
		),
		logout: endpoint("provider.logout:v1", ProviderLogoutRequest, EmptyResponse),
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
	},
	settings: {
		get: endpoint("settings.get:v1", SettingsGetRequest, SettingsResponse),
		set: endpoint("settings.set:v1", SettingsSetRequest, SettingsResponse),
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

/** Compatibility view for channel enumeration at transport boundaries. */
export const REQUEST_SCHEMAS = Object.freeze(
	Object.fromEntries(
		Object.entries(CHANNEL_CONTRACTS).map(([channel, value]) => [channel, value.request]),
	),
);
