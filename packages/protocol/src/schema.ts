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

import { type Infer, type Schema, z } from "@bear-harness/schema";

type Static<T extends Schema> = Infer<T>;
type TSchema = Schema;

type StringOptions = { minLength?: number; maxLength?: number; pattern?: string };
type NumberOptions = { minimum?: number; maximum?: number };
type ArrayOptions = { maxItems?: number };

const S = {
	String(options: StringOptions = {}) {
		let schema = z.string();
		if (options.minLength !== undefined) schema = schema.min(options.minLength);
		if (options.maxLength !== undefined) schema = schema.max(options.maxLength);
		if (options.pattern !== undefined) schema = schema.regex(new RegExp(options.pattern));
		return schema;
	},
	Integer(options: NumberOptions = {}) {
		let schema = z.number().int().safe();
		if (options.minimum !== undefined) schema = schema.min(options.minimum);
		if (options.maximum !== undefined) schema = schema.max(options.maximum);
		return schema;
	},
	Boolean: () => z.boolean(),
	Null: () => z.null(),
	Literal: <T extends string | number | boolean>(value: T) => z.literal(value),
	Optional: <T extends Schema>(schema: T) => schema.optional(),
	Array<T extends Schema>(schema: T, options: ArrayOptions = {}) {
		let array = z.array(schema);
		if (options.maxItems !== undefined) array = array.max(options.maxItems);
		return array;
	},
	Object: <T extends z.ZodRawShape>(shape: T, _options?: { additionalProperties?: false }) =>
		z.strictObject(shape),
	Union: <T extends readonly [Schema, Schema, ...Schema[]]>(schemas: T, _options?: unknown) =>
		z.union(schemas),
	Record: <K extends z.core.$ZodRecordKey, V extends Schema>(key: K, value: V) =>
		z.record(key, value),
	Unknown: () => z.unknown(),
};

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 4096;
const MAX_PATH_LENGTH = 1024;
const MAX_ARRAY_LENGTH = 100;
const MAX_SAFE_INT = 9007199254740991;
const UINT32_MAX = 4294967295;

/** Localizable reason codes for wire errors. */
export const IpcErrorKind = S.Union(
	[
		S.Literal("invalid_request"),
		S.Literal("not_found"),
		S.Literal("conflict"),
		S.Literal("unavailable"),
		S.Literal("internal"),
	],
	{ additionalProperties: false },
);
export type IpcErrorKind = Static<typeof IpcErrorKind>;

/** Every IPC response body is either data or an error with this shape. */
export const IpcResponse = <T extends TSchema>(data: T) =>
	S.Union(
		[
			S.Object(
				{
					ok: S.Literal(true),
					data,
				},
				{ additionalProperties: false },
			),
			S.Object(
				{
					ok: S.Literal(false),
					error: S.Object(
						{
							kind: IpcErrorKind,
							reason: S.String({ maxLength: MAX_STRING_LENGTH }),
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
		],
		{ additionalProperties: false },
	);

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export const EventSeq = S.Integer({ minimum: 0, maximum: MAX_SAFE_INT });

/** A single domain event published after the Host commits the state change. */
export const DomainEvent = S.Object(
	{
		seq: EventSeq,
		kind: S.String({ maxLength: 128 }),
		payload: S.Unknown(),
	},
	{ additionalProperties: false },
);

export const EventSubscribeRequest = S.Object(
	{
		afterSeq: S.Optional(EventSeq),
	},
	{ additionalProperties: false },
);

export const EventSubscribeResponse = S.Object(
	{
		events: S.Array(DomainEvent, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const SnapshotGetRequest = S.Object({}, { additionalProperties: false });

export const SnapshotResponse = S.Object(
	{
		eventSeq: EventSeq,
		onboarding: S.Optional(S.Unknown()),
		character: S.Optional(S.Unknown()),
		conversation: S.Optional(S.Unknown()),
		memory: S.Optional(S.Unknown()),
		provider: S.Optional(S.Unknown()),
		voice: S.Optional(S.Unknown()),
		commission: S.Optional(S.Unknown()),
		run: S.Optional(S.Unknown()),
		artifact: S.Optional(S.Unknown()),
		settings: S.Optional(S.Unknown()),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Onboarding (first-meeting FSM)
// ---------------------------------------------------------------------------

export const OnboardingStatus = S.Union([S.Literal("active"), S.Literal("complete")], {
	additionalProperties: false,
});
export type OnboardingStatus = Static<typeof OnboardingStatus>;

export const OnboardingGetRequest = S.Object({}, { additionalProperties: false });
export const OnboardingSubmitRequest = S.Object(
	{
		stepId: S.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" }),
		answer: S.Optional(S.String({ maxLength: MAX_STRING_LENGTH })),
	},
	{ additionalProperties: false },
);
export const OnboardingStateData = S.Object(
	{
		schema_version: S.Literal(1),
		flow_version: S.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		answers: S.Record(
			S.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" }),
			S.String({ maxLength: MAX_STRING_LENGTH }),
		),
		decisions: S.Object(
			{
				relationship_kind: S.Optional(
					S.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" }),
				),
				relationship_memory_enabled: S.Optional(S.Boolean()),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const CharacterGetRequest = S.Object({}, { additionalProperties: false });
export const CharacterSummary = S.Object(
	{
		id: S.String({ minLength: 1, maxLength: 64 }),
		name: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
		version: S.String({ minLength: 1, maxLength: 64 }),
		subtitle: S.String({ maxLength: MAX_STRING_LENGTH }),
		avatarUrl: S.String({ minLength: 1, maxLength: 2_000_000 }),
		active: S.Boolean(),
	},
	{ additionalProperties: false },
);
export const CharacterListRequest = S.Object({}, { additionalProperties: false });
export const CharacterListResponse = S.Object(
	{ characters: S.Array(CharacterSummary, { maxItems: 100 }) },
	{ additionalProperties: false },
);
export const CharacterActivateRequest = S.Object(
	{ characterId: S.String({ minLength: 1, maxLength: 64 }) },
	{ additionalProperties: false },
);
export const OnboardingResponse = S.Object(
	{
		status: OnboardingStatus,
		currentStepId: S.Optional(
			S.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" }),
		),
		/** Monotonic Host event cursor for ordering concurrent projections. */
		eventSeq: S.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		stateData: OnboardingStateData,
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export const ConversationId = S.String({ minLength: 1, maxLength: 64 });
export const BranchId = S.String({ minLength: 1, maxLength: 64 });
export const MessageId = S.String({ minLength: 1, maxLength: 64 });
export const MessageVersionId = S.String({ minLength: 1, maxLength: 64 });

export const ConversationSummary = S.Object(
	{
		id: ConversationId,
		title: S.String({ maxLength: MAX_STRING_LENGTH }),
		sceneTitle: S.String({ maxLength: MAX_STRING_LENGTH }),
		unread: S.Boolean(),
		updatedAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const ConversationListRequest = S.Object({}, { additionalProperties: false });
export const ConversationListResponse = S.Object(
	{
		conversations: S.Array(ConversationSummary, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

export const ConversationCreateRequest = S.Object(
	{
		title: S.Optional(S.String({ maxLength: MAX_STRING_LENGTH })),
	},
	{ additionalProperties: false },
);
export const ConversationCreateResponse = S.Object(
	{
		id: ConversationId,
	},
	{ additionalProperties: false },
);

export const ConversationSelectRequest = S.Object(
	{
		id: ConversationId,
		branchId: S.Optional(BranchId),
	},
	{ additionalProperties: false },
);
export const ConversationRenameRequest = S.Object(
	{ id: ConversationId, title: S.String({ minLength: 1, maxLength: 200 }) },
	{ additionalProperties: false },
);
export const ConversationArchiveRequest = S.Object(
	{ id: ConversationId, archived: S.Boolean() },
	{ additionalProperties: false },
);
export const ConversationDeleteRequest = S.Object(
	{ id: ConversationId },
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const MessageRole = S.Union(
	[S.Literal("user"), S.Literal("assistant"), S.Literal("system")],
	{ additionalProperties: false },
);

export const MessageVersion = S.Object(
	{
		id: MessageVersionId,
		role: MessageRole,
		content: S.String({ maxLength: 65536 }),
		editedByUser: S.Boolean(),
		createdAt: S.String({ maxLength: 64 }),
		adopted: S.Boolean(),
	},
	{ additionalProperties: false },
);

export const Message = S.Object(
	{
		id: MessageId,
		role: MessageRole,
		adoptedVersionId: S.Optional(MessageVersionId),
		versions: S.Array(MessageVersion, { maxItems: 20 }),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const MessageSendRequest = S.Object(
	{
		conversationId: ConversationId,
		text: S.String({ minLength: 1, maxLength: 65536 }),
	},
	{ additionalProperties: false },
);

export const MessageSendResponse = S.Object(
	{
		messageId: MessageId,
	},
	{ additionalProperties: false },
);

export const MessageRegenerateRequest = S.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
	},
	{ additionalProperties: false },
);

export const MessageSwitchVersionRequest = S.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
		versionId: MessageVersionId,
	},
	{ additionalProperties: false },
);

export const MessageEditRequest = S.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
		text: S.String({ minLength: 1, maxLength: 65536 }),
		isUserMessage: S.Boolean(),
	},
	{ additionalProperties: false },
);

export const MessageContinueRequest = S.Object(
	{
		conversationId: ConversationId,
	},
	{ additionalProperties: false },
);

export const MessageCorrectRequest = S.Object(
	{
		conversationId: ConversationId,
		reason: S.String({ maxLength: MAX_STRING_LENGTH }),
		applyScope: S.Union([S.Literal("once"), S.Literal("session"), S.Literal("always")], {
			additionalProperties: false,
		}),
	},
	{ additionalProperties: false },
);

export const MessageBranchRequest = S.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
	},
	{ additionalProperties: false },
);

export const MessageBranchResponse = S.Object(
	{
		branchId: BranchId,
	},
	{ additionalProperties: false },
);

export const MessageAbortRequest = S.Object(
	{
		conversationId: ConversationId,
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryScope = S.Union(
	[S.Literal("self"), S.Literal("relationship"), S.Literal("scene")],
	{ additionalProperties: false },
);

export const MemoryCandidate = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		kind: S.Union(
			[
				S.Literal("fact"),
				S.Literal("preference"),
				S.Literal("event"),
				S.Literal("self_canon_summary"),
			],
			{ additionalProperties: false },
		),
		scope: MemoryScope,
		text: S.String({ maxLength: MAX_STRING_LENGTH }),
		why: S.String({ maxLength: MAX_STRING_LENGTH }),
		status: S.Union(
			[S.Literal("pending"), S.Literal("approved"), S.Literal("rejected"), S.Literal("expired")],
			{ additionalProperties: false },
		),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const MemoryEntry = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		kind: S.String({ maxLength: 64 }),
		scope: MemoryScope,
		text: S.String({ maxLength: MAX_STRING_LENGTH }),
		normalizedText: S.String({ maxLength: MAX_STRING_LENGTH }),
		sourceConversationTitle: S.String({ maxLength: MAX_STRING_LENGTH }),
		pinned: S.Boolean(),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const MemoryListCandidatesRequest = S.Object({}, { additionalProperties: false });
export const MemoryListCandidatesResponse = S.Object(
	{
		candidates: S.Array(MemoryCandidate, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

export const MemoryApprovalDecision = S.Union(
	[S.Literal("approve"), S.Literal("approve_edited"), S.Literal("reject")],
	{ additionalProperties: false },
);

export const MemoryDecideCandidateRequest = S.Object(
	{
		candidateId: S.String({ maxLength: 64 }),
		decision: MemoryApprovalDecision,
		editedText: S.Optional(S.String({ maxLength: MAX_STRING_LENGTH })),
		scope: S.Optional(MemoryScope),
	},
	{ additionalProperties: false },
);

export const MemorySearchRequest = S.Object(
	{
		query: S.String({ maxLength: MAX_STRING_LENGTH }),
		scope: S.Optional(MemoryScope),
	},
	{ additionalProperties: false },
);

export const MemorySearchResponse = S.Object(
	{
		entries: S.Array(MemoryEntry, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

export const MemoryListRequest = S.Object(
	{
		scope: S.Optional(MemoryScope),
		enabled: S.Optional(S.Boolean()),
		limit: S.Optional(S.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);

export const MemoryPinRequest = S.Object(
	{
		entryId: S.String({ maxLength: 64 }),
		pinned: S.Boolean(),
	},
	{ additionalProperties: false },
);

export const MemoryForgetRequest = S.Object(
	{
		entryId: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const MemoryExcludeRequest = S.Object(
	{
		entryId: S.String({ maxLength: 64 }),
		excluded: S.Boolean(),
	},
	{ additionalProperties: false },
);

export const MemoryEditRequest = S.Object(
	{
		entryId: S.String({ maxLength: 64 }),
		newText: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Story archive (natural-language changes over read-only source canon)
// ---------------------------------------------------------------------------

export const StoryChangeScope = S.Union([S.Literal("global"), S.Literal("branch")], {
	additionalProperties: false,
});
export const StoryChangeSource = S.Union(
	[S.Literal("user_explicit"), S.Literal("story_event"), S.Literal("user_confirmed")],
	{ additionalProperties: false },
);
export const StoryChange = S.Object(
	{
		id: S.String({ minLength: 1, maxLength: 64 }),
		text: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
		scope: StoryChangeScope,
		source: StoryChangeSource,
		conversationId: S.Optional(ConversationId),
		branchId: S.Optional(BranchId),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);
export const StoryListChangesRequest = S.Object(
	{ branchId: S.Optional(BranchId) },
	{ additionalProperties: false },
);
export const StoryListChangesResponse = S.Object(
	{ changes: S.Array(StoryChange, { maxItems: MAX_ARRAY_LENGTH }) },
	{ additionalProperties: false },
);
export const StoryApplyChangeRequest = S.Object(
	{
		conversationId: S.Optional(ConversationId),
		branchId: S.Optional(BranchId),
		text: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
		scope: StoryChangeScope,
	},
	{ additionalProperties: false },
);
export const StoryApplyChangeResponse = S.Object(
	{ change: StoryChange },
	{ additionalProperties: false },
);
export const StoryRevertChangeRequest = S.Object(
	{
		changeId: S.String({ minLength: 1, maxLength: 64 }),
		conversationId: S.Optional(ConversationId),
	},
	{ additionalProperties: false },
);
export const StoryResetRequest = S.Object(
	{ conversationId: S.Optional(ConversationId), branchId: S.Optional(BranchId) },
	{ additionalProperties: false },
);
export const StoryResetResponse = S.Object(
	{ count: S.Integer({ minimum: 0, maximum: MAX_SAFE_INT }) },
	{ additionalProperties: false },
);
export const StoryChangeProposal = S.Object(
	{
		id: S.String({ minLength: 1, maxLength: 64 }),
		conversationId: ConversationId,
		branchId: BranchId,
		text: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);
export const StoryListProposalsRequest = S.Object(
	{ conversationId: S.Optional(ConversationId) },
	{ additionalProperties: false },
);
export const StoryListProposalsResponse = S.Object(
	{ proposals: S.Array(StoryChangeProposal, { maxItems: MAX_ARRAY_LENGTH }) },
	{ additionalProperties: false },
);
export const StoryResolveProposalRequest = S.Object(
	{
		proposalId: S.String({ minLength: 1, maxLength: 64 }),
		accept: S.Boolean(),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Canon Hub (advanced package authoring)
// ---------------------------------------------------------------------------

export const CanonSource = S.Object(
	{
		id: S.String({ minLength: 1, maxLength: 64 }),
		logicalName: S.String({ minLength: 1, maxLength: 255 }),
		mime: S.String({ minLength: 1, maxLength: 128 }),
		sha256: S.String({ minLength: 1, maxLength: 128 }),
		chunkCount: S.Integer({ minimum: 0, maximum: MAX_SAFE_INT }),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);
export const CanonChunk = S.Object(
	{
		id: S.String({ minLength: 1, maxLength: 64 }),
		sourceId: S.String({ minLength: 1, maxLength: 64 }),
		sourceName: S.String({ minLength: 1, maxLength: 255 }),
		ordinal: S.Integer({ minimum: 0, maximum: MAX_SAFE_INT }),
		content: S.String({ maxLength: 4096 }),
	},
	{ additionalProperties: false },
);
export const CanonListSourcesRequest = S.Object({}, { additionalProperties: false });
export const CanonAddSourceRequest = S.Object(
	{
		logicalName: S.String({ minLength: 1, maxLength: 255 }),
		content: S.String({ minLength: 1, maxLength: 1_048_576 }),
	},
	{ additionalProperties: false },
);
export const CanonSearchRequest = S.Object(
	{ query: S.String({ minLength: 1, maxLength: 1000 }) },
	{ additionalProperties: false },
);
export const CanonRemoveSourceRequest = S.Object(
	{ sourceId: S.String({ minLength: 1, maxLength: 64 }) },
	{ additionalProperties: false },
);
export const CanonModuleKind = S.Union([
	S.Literal("root"),
	S.Literal("arc"),
	S.Literal("event"),
	S.Literal("entity"),
	S.Literal("relationship"),
	S.Literal("location"),
	S.Literal("object"),
	S.Literal("behavior"),
]);
export const CanonModule = S.Object(
	{
		id: S.String({ minLength: 1, maxLength: 64 }),
		parentId: S.Optional(S.String({ minLength: 1, maxLength: 64 })),
		kind: CanonModuleKind,
		title: S.String({ minLength: 1, maxLength: 255 }),
		instructions: S.String({ maxLength: 16_384 }),
		sourceChunkIds: S.Array(S.String({ minLength: 1, maxLength: 64 }), { maxItems: 100 }),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);
export const CanonListModulesRequest = S.Object({}, { additionalProperties: false });
export const CanonUpsertModuleRequest = S.Object(
	{
		id: S.Optional(S.String({ minLength: 1, maxLength: 64 })),
		parentId: S.Optional(S.String({ minLength: 1, maxLength: 64 })),
		kind: CanonModuleKind,
		title: S.String({ minLength: 1, maxLength: 255 }),
		instructions: S.String({ maxLength: 16_384 }),
		sourceChunkIds: S.Array(S.String({ minLength: 1, maxLength: 64 }), { maxItems: 100 }),
	},
	{ additionalProperties: false },
);
export const CanonDeleteModuleRequest = S.Object(
	{ id: S.String({ minLength: 1, maxLength: 64 }) },
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const ProviderInfo = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		name: S.String({ maxLength: MAX_STRING_LENGTH }),
		authType: S.Union([S.Literal("api_key"), S.Literal("oauth")], {
			additionalProperties: false,
		}),
		credentialStatus: S.Union(
			[
				S.Literal("missing"),
				S.Literal("session_only"),
				S.Literal("stored"),
				S.Literal("weak_storage"),
				S.Literal("refreshing"),
				S.Literal("invalid"),
				S.Literal("unavailable"),
			],
			{ additionalProperties: false },
		),
		availableModels: S.Array(
			S.Object(
				{
					id: S.String({ maxLength: 128 }),
					name: S.String({ maxLength: MAX_STRING_LENGTH }),
					supportsImages: S.Boolean(),
				},
				{ additionalProperties: false },
			),
			{ maxItems: MAX_ARRAY_LENGTH },
		),
	},
	{ additionalProperties: false },
);

export const ProviderListRequest = S.Object({}, { additionalProperties: false });
export const ProviderListResponse = S.Object(
	{
		providers: S.Array(ProviderInfo, { maxItems: 30 }),
	},
	{ additionalProperties: false },
);

export const ProviderSetApiKeyRequest = S.Object(
	{
		providerId: S.String({ maxLength: 64 }),
		apiKey: S.String({ minLength: 1, maxLength: 2048 }),
		sessionOnly: S.Optional(S.Boolean()),
	},
	{ additionalProperties: false },
);

export const ProviderLoginRequest = S.Object(
	{
		providerId: S.String({ maxLength: 64 }),
		authType: S.Literal("oauth"),
	},
	{ additionalProperties: false },
);

export const ProviderLoginResponse = S.Object(
	{
		providerId: S.String({ maxLength: 64 }),
		status: S.Union([
			S.Literal("running"),
			S.Literal("waiting_input"),
			S.Literal("completed"),
			S.Literal("failed"),
		]),
		authUrl: S.Optional(S.String({ maxLength: 2048 })),
		deviceCode: S.Optional(S.String({ maxLength: 128 })),
		verificationUri: S.Optional(S.String({ maxLength: 2048 })),
		message: S.Optional(S.String({ maxLength: MAX_STRING_LENGTH })),
		prompt: S.Optional(
			S.Object(
				{
					type: S.Union([
						S.Literal("text"),
						S.Literal("secret"),
						S.Literal("select"),
						S.Literal("manual_code"),
					]),
					message: S.String({ maxLength: MAX_STRING_LENGTH }),
					placeholder: S.Optional(S.String({ maxLength: MAX_STRING_LENGTH })),
					options: S.Optional(
						S.Array(
							S.Object(
								{
									id: S.String(),
									label: S.String(),
									description: S.Optional(S.String()),
								},
								{ additionalProperties: false },
							),
							{ maxItems: 30 },
						),
					),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export const ProviderLoginStatusRequest = S.Object(
	{ providerId: S.String({ maxLength: 64 }) },
	{ additionalProperties: false },
);
export const ProviderLoginAnswerRequest = S.Object(
	{ providerId: S.String({ maxLength: 64 }), answer: S.String({ maxLength: 4096 }) },
	{ additionalProperties: false },
);

export const ProviderLogoutRequest = S.Object(
	{
		providerId: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Voice Stack
// ---------------------------------------------------------------------------

export const VoiceStack = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		providerId: S.String({ maxLength: 64 }),
		modelId: S.String({ maxLength: 128 }),
		revision: S.Integer({ minimum: 0, maximum: MAX_SAFE_INT }),
		label: S.String({ maxLength: MAX_STRING_LENGTH }),
		active: S.Boolean(),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const VoiceStackListRequest = S.Object({}, { additionalProperties: false });
export const VoiceStackListResponse = S.Object(
	{
		stacks: S.Array(VoiceStack, { maxItems: 20 }),
	},
	{ additionalProperties: false },
);

export const VoiceStackSwitchRequest = S.Object(
	{
		stackId: S.String({ maxLength: 64 }),
		scope: S.Union([S.Literal("next_scene"), S.Literal("branch_only")], {
			additionalProperties: false,
		}),
		rollbackAvailable: S.Boolean(),
	},
	{ additionalProperties: false },
);
export const VoiceStackPinRequest = S.Object(
	{
		providerId: S.String({ minLength: 1, maxLength: 64 }),
		modelId: S.String({ minLength: 1, maxLength: 128 }),
		label: S.Optional(S.String({ maxLength: MAX_STRING_LENGTH })),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

export const ActionDraft = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		title: S.String({ maxLength: MAX_STRING_LENGTH }),
		description: S.String({ maxLength: MAX_STRING_LENGTH }),
		reads: S.Array(S.String({ maxLength: MAX_PATH_LENGTH }), { maxItems: 20 }),
		writes: S.Array(S.String({ maxLength: MAX_PATH_LENGTH }), { maxItems: 20 }),
		networkAllowed: S.Boolean(),
		toolNames: S.Array(S.String({ maxLength: 64 }), { maxItems: 20 }),
		hash: S.String({ maxLength: 128 }),
	},
	{ additionalProperties: false },
);

export const Commission = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		conversationId: S.Optional(ConversationId),
		draft: ActionDraft,
		status: S.Union(
			[
				S.Literal("draft"),
				S.Literal("awaiting_approval"),
				S.Literal("approved"),
				S.Literal("queued"),
				S.Literal("running"),
				S.Literal("needs_user"),
				S.Literal("completed"),
				S.Literal("failed"),
				S.Literal("cancelled"),
			],
			{ additionalProperties: false },
		),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const CommissionListRequest = S.Object({}, { additionalProperties: false });
export const CommissionListResponse = S.Object(
	{
		commissions: S.Array(Commission, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

export const CommissionDraftRequest = S.Object(
	{
		conversationId: S.String({ minLength: 1, maxLength: 64 }),
		title: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
		description: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
		reads: S.Optional(
			S.Array(S.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }), { maxItems: 20 }),
		),
		writes: S.Optional(
			S.Array(S.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }), { maxItems: 20 }),
		),
		networkAllowed: S.Optional(S.Boolean()),
		toolNames: S.Optional(S.Array(S.String({ minLength: 1, maxLength: 64 }), { maxItems: 20 })),
	},
	{ additionalProperties: false },
);

export const CommissionDraftResponse = S.Object(
	{
		commissionId: S.String({ maxLength: 64 }),
		draftHash: S.String({ maxLength: 128 }),
	},
	{ additionalProperties: false },
);

export const CommissionApproveRequest = S.Object(
	{
		commissionId: S.String({ minLength: 1, maxLength: 64 }),
		approvedHash: S.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
export const CommissionRejectRequest = S.Object(
	{ commissionId: S.String({ minLength: 1, maxLength: 64 }) },
	{ additionalProperties: false },
);

export const CommissionLaunchRequest = S.Object(
	{
		commissionId: S.String({ minLength: 1, maxLength: 64 }),
		executorProfile: S.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const RunSteerRequest = S.Object(
	{
		runId: S.String({ minLength: 1, maxLength: 64 }),
		instruction: S.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
	},
	{ additionalProperties: false },
);

export const RunCancelRequest = S.Object(
	{
		runId: S.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const RunRespondPermissionRequest = S.Object(
	{
		runId: S.String({ minLength: 1, maxLength: 64 }),
		requestId: S.String({ minLength: 1, maxLength: 128 }),
		optionId: S.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunStatus = S.Union(
	[
		S.Literal("enqueued"),
		S.Literal("running"),
		S.Literal("needs_user"),
		S.Literal("completed"),
		S.Literal("failed"),
		S.Literal("cancelled"),
		S.Literal("interrupted"),
		S.Literal("forced_termination"),
	],
	{ additionalProperties: false },
);

export const Run = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		commissionId: S.String({ maxLength: 64 }),
		executorProfile: S.String({ maxLength: 64 }),
		status: RunStatus,
		startedAt: S.Optional(S.String({ maxLength: 64 })),
		completedAt: S.Optional(S.String({ maxLength: 64 })),
	},
	{ additionalProperties: false },
);

export const RunListRequest = S.Object({}, { additionalProperties: false });
export const RunListResponse = S.Object(
	{
		runs: S.Array(Run, { maxItems: 10 }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const Artifact = S.Object(
	{
		id: S.String({ maxLength: 64 }),
		logicalName: S.String({ maxLength: MAX_STRING_LENGTH }),
		mime: S.String({ maxLength: 128 }),
		bytes: S.Integer({ minimum: 0, maximum: UINT32_MAX }),
		sha256: S.String({ maxLength: 128 }),
		status: S.Union(
			[
				S.Literal("created"),
				S.Literal("verified"),
				S.Literal("verification_failed"),
				S.Literal("adopted"),
				S.Literal("saved"),
			],
			{ additionalProperties: false },
		),
		producerRunId: S.Optional(S.String({ maxLength: 64 })),
		createdAt: S.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const ArtifactListRequest = S.Object({}, { additionalProperties: false });
export const ArtifactReadRequest = S.Object(
	{ artifactId: S.String({ minLength: 1, maxLength: 64 }) },
	{ additionalProperties: false },
);
export const ArtifactListResponse = S.Object(
	{
		artifacts: S.Array(Artifact, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SettingsData = S.Object(
	{
		relationshipMemoryEnabled: S.Boolean(),
		textFallback: S.Optional(
			S.Object(
				{
					providerId: S.String({ minLength: 1, maxLength: 64 }),
					modelId: S.String({ minLength: 1, maxLength: 200 }),
				},
				{ additionalProperties: false },
			),
		),
		multimodalFallback: S.Optional(
			S.Object(
				{
					providerId: S.String({ minLength: 1, maxLength: 64 }),
					modelId: S.String({ minLength: 1, maxLength: 200 }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const SettingsGetRequest = S.Object({}, { additionalProperties: false });
export const SettingsResponse = S.Object(
	{
		settings: SettingsData,
	},
	{ additionalProperties: false },
);

export const SettingsPatch = S.Object(
	{
		relationshipMemoryEnabled: S.Optional(S.Boolean()),
		textFallback: S.Optional(S.Union([SettingsData.shape.textFallback, S.Null()])),
		multimodalFallback: S.Optional(S.Union([SettingsData.shape.multimodalFallback, S.Null()])),
	},
	{ additionalProperties: false },
);
export const SettingsSetRequest = S.Object(
	{
		settings: SettingsPatch,
	},
	{ additionalProperties: false },
);

export const ProviderCustomUpsertRequest = S.Object(
	{
		providerId: S.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9._-]*$" }),
		name: S.String({ minLength: 1, maxLength: 100 }),
		baseUrl: S.String({ minLength: 8, maxLength: 2048 }),
		modelId: S.String({ minLength: 1, maxLength: 200 }),
		apiKey: S.Optional(S.String({ minLength: 1, maxLength: 8192 })),
		supportsImages: S.Optional(S.Boolean()),
	},
	{ additionalProperties: false },
);
export const ProviderOverrideBaseUrlRequest = S.Object(
	{
		providerId: S.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9._-]*$" }),
		baseUrl: S.String({ minLength: 8, maxLength: 2048 }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Channel registry (for main-side validation)
// ---------------------------------------------------------------------------

/** Map of IPC channel name → request schema for the main-side router. */
export const REQUEST_SCHEMAS: Record<string, TSchema> = {
	"snapshot.get:v1": SnapshotGetRequest,
	"character.get:v1": CharacterGetRequest,
	"character.list:v1": CharacterListRequest,
	"character.activate:v1": CharacterActivateRequest,
	"events.subscribe:v1": EventSubscribeRequest,
	"onboarding.get:v1": OnboardingGetRequest,
	"onboarding.submit:v1": OnboardingSubmitRequest,
	"conversation.list:v1": ConversationListRequest,
	"conversation.create:v1": ConversationCreateRequest,
	"conversation.select:v1": ConversationSelectRequest,
	"conversation.rename:v1": ConversationRenameRequest,
	"conversation.archive:v1": ConversationArchiveRequest,
	"conversation.delete:v1": ConversationDeleteRequest,
	"message.send:v1": MessageSendRequest,
	"message.regenerate:v1": MessageRegenerateRequest,
	"message.switchVersion:v1": MessageSwitchVersionRequest,
	"message.edit:v1": MessageEditRequest,
	"message.continue:v1": MessageContinueRequest,
	"message.correct:v1": MessageCorrectRequest,
	"message.branch:v1": MessageBranchRequest,
	"message.abort:v1": MessageAbortRequest,
	"memory.listCandidates:v1": MemoryListCandidatesRequest,
	"memory.decideCandidate:v1": MemoryDecideCandidateRequest,
	"memory.search:v1": MemorySearchRequest,
	"memory.list:v1": MemoryListRequest,
	"memory.pin:v1": MemoryPinRequest,
	"memory.forget:v1": MemoryForgetRequest,
	"memory.exclude:v1": MemoryExcludeRequest,
	"memory.edit:v1": MemoryEditRequest,
	"story.listChanges:v1": StoryListChangesRequest,
	"story.applyChange:v1": StoryApplyChangeRequest,
	"story.revertChange:v1": StoryRevertChangeRequest,
	"story.reset:v1": StoryResetRequest,
	"story.listProposals:v1": StoryListProposalsRequest,
	"story.resolveProposal:v1": StoryResolveProposalRequest,
	"canon.listSources:v1": CanonListSourcesRequest,
	"canon.addSource:v1": CanonAddSourceRequest,
	"canon.search:v1": CanonSearchRequest,
	"canon.removeSource:v1": CanonRemoveSourceRequest,
	"canon.listModules:v1": CanonListModulesRequest,
	"canon.upsertModule:v1": CanonUpsertModuleRequest,
	"canon.deleteModule:v1": CanonDeleteModuleRequest,
	"provider.list:v1": ProviderListRequest,
	"provider.customUpsert:v1": ProviderCustomUpsertRequest,
	"provider.overrideBaseUrl:v1": ProviderOverrideBaseUrlRequest,
	"provider.setApiKey:v1": ProviderSetApiKeyRequest,
	"provider.login:v1": ProviderLoginRequest,
	"provider.loginStatus:v1": ProviderLoginStatusRequest,
	"provider.loginAnswer:v1": ProviderLoginAnswerRequest,
	"provider.logout:v1": ProviderLogoutRequest,
	"voice.list:v1": VoiceStackListRequest,
	"voice.switch:v1": VoiceStackSwitchRequest,
	"voice.pin:v1": VoiceStackPinRequest,
	"commission.list:v1": CommissionListRequest,
	"commission.draft:v1": CommissionDraftRequest,
	"commission.approve:v1": CommissionApproveRequest,
	"commission.reject:v1": CommissionRejectRequest,
	"commission.launch:v1": CommissionLaunchRequest,
	"run.list:v1": RunListRequest,
	"run.steer:v1": RunSteerRequest,
	"run.cancel:v1": RunCancelRequest,
	"run.respondPermission:v1": RunRespondPermissionRequest,
	"artifact.list:v1": ArtifactListRequest,
	"artifact.read:v1": ArtifactReadRequest,
	"settings.get:v1": SettingsGetRequest,
	"settings.set:v1": SettingsSetRequest,
};
