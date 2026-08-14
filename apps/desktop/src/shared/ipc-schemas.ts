/**
 * IPC wire schemas — single source of truth for every cross-process channel.
 *
 * All schemas are TypeBox 1.3.13 objects with `additionalProperties: false`,
 * explicit length/array/enum/safe integer bounds and depth limits. Only
 * `Value.Check / Value.Parse / Value.Errors` from `typebox/value` are used;
 * `typebox/compile` (JIT/eval) is forbidden.
 *
 * Every IPC channel name ends with `:v1`. Wire errors are limited to the
 * `IpcErrorKind` enum plus a localizable `reason` string — never raw paths,
 * SQL, secrets, or provider error text.
 *
 * Channels are grouped by domain. The `companion` prefix on the preload
 * facade (`window.bearDesktop.companion`) maps to these channels.
 */

import { Type, type TSchema, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Shared wire types
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 4096;
const MAX_PATH_LENGTH = 1024;
const MAX_ARRAY_LENGTH = 100;
const MAX_DEPTH = 8;
const MAX_SAFE_INT = 9007199254740991;
const UINT32_MAX = 4294967295;

/** Localizable reason codes for wire errors. */
export const IpcErrorKind = Type.Union(
	[
		Type.Literal("invalid_request"),
		Type.Literal("not_found"),
		Type.Literal("conflict"),
		Type.Literal("unavailable"),
		Type.Literal("internal"),
	],
	{ additionalProperties: false },
);
export type IpcErrorKind = Static<typeof IpcErrorKind>;

/** Every IPC response body is either data or an error with this shape. */
export const IpcResponse = <T extends TSchema>(data: T) =>
	Type.Union(
		[
			Type.Object(
				{
					ok: Type.Literal(true),
					data,
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					ok: Type.Literal(false),
					error: Type.Object(
						{
							kind: IpcErrorKind,
							reason: Type.String({ maxLength: MAX_STRING_LENGTH }),
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

export const EventSeq = Type.Integer({ minimum: 0, maximum: MAX_SAFE_INT });

/** A single domain event published after the Host commits the state change. */
export const DomainEvent = Type.Object(
	{
		seq: EventSeq,
		kind: Type.String({ maxLength: 128 }),
		payload: Type.Unknown(),
	},
	{ additionalProperties: false },
);

export const EventSubscribeRequest = Type.Object(
	{
		afterSeq: Type.Optional(EventSeq),
	},
	{ additionalProperties: false },
);

export const EventSubscribeResponse = Type.Object(
	{
		events: Type.Array(DomainEvent, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const SnapshotGetRequest = Type.Object({}, { additionalProperties: false });

export const SnapshotResponse = Type.Object(
	{
		eventSeq: EventSeq,
		onboarding: Type.Optional(Type.Unknown()),
		conversation: Type.Optional(Type.Unknown()),
		memory: Type.Optional(Type.Unknown()),
		provider: Type.Optional(Type.Unknown()),
		voice: Type.Optional(Type.Unknown()),
		commission: Type.Optional(Type.Unknown()),
		run: Type.Optional(Type.Unknown()),
		artifact: Type.Optional(Type.Unknown()),
		settings: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Onboarding (first-meeting FSM)
// ---------------------------------------------------------------------------

export const OnboardingState = Type.Union(
	[
		Type.Literal("door_closed"),
		Type.Literal("introduced"),
		Type.Literal("naming"),
		Type.Literal("relation"),
		Type.Literal("memory_decision"),
		Type.Literal("voice_ready"),
		Type.Literal("complete"),
	],
	{ additionalProperties: false },
);
export type OnboardingState = Static<typeof OnboardingState>;

export const OnboardingGetRequest = Type.Object({}, { additionalProperties: false });
export const OnboardingResponse = Type.Object(
	{
		state: OnboardingState,
		greeting: Type.Optional(Type.String({ maxLength: MAX_STRING_LENGTH })),
		scene: Type.Optional(Type.String({ maxLength: MAX_STRING_LENGTH })),
	},
	{ additionalProperties: false },
);

export const OnboardingSetNameRequest = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const OnboardingSetRelationRequest = Type.Object(
	{
		kind: Type.Union(
			[
				Type.Literal("shelter"),
				Type.Literal("partner"),
				Type.Literal("ward"),
				Type.Literal("biding"),
			],
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const OnboardingSetMemoryDecisionRequest = Type.Object(
	{
		enabled: Type.Boolean(),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export const ConversationId = Type.String({ minLength: 1, maxLength: 64 });
export const BranchId = Type.String({ minLength: 1, maxLength: 64 });
export const MessageId = Type.String({ minLength: 1, maxLength: 64 });
export const MessageVersionId = Type.String({ minLength: 1, maxLength: 64 });

export const ConversationSummary = Type.Object(
	{
		id: ConversationId,
		title: Type.String({ maxLength: MAX_STRING_LENGTH }),
		sceneTitle: Type.String({ maxLength: MAX_STRING_LENGTH }),
		unread: Type.Boolean(),
		updatedAt: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const ConversationListRequest = Type.Object({}, { additionalProperties: false });
export const ConversationListResponse = Type.Object(
	{
		conversations: Type.Array(ConversationSummary, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

export const ConversationCreateRequest = Type.Object(
	{
		title: Type.Optional(Type.String({ maxLength: MAX_STRING_LENGTH })),
	},
	{ additionalProperties: false },
);
export const ConversationCreateResponse = Type.Object(
	{
		id: ConversationId,
	},
	{ additionalProperties: false },
);

export const ConversationSelectRequest = Type.Object(
	{
		id: ConversationId,
		branchId: Type.Optional(BranchId),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const MessageRole = Type.Union(
	[Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")],
	{ additionalProperties: false },
);

export const MessageVersion = Type.Object(
	{
		id: MessageVersionId,
		role: MessageRole,
		content: Type.String({ maxLength: 65536 }),
		editedByUser: Type.Boolean(),
		createdAt: Type.String({ maxLength: 64 }),
		adopted: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const Message = Type.Object(
	{
		id: MessageId,
		role: MessageRole,
		adoptedVersionId: Type.Optional(MessageVersionId),
		versions: Type.Array(MessageVersion, { maxItems: 20 }),
		createdAt: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const MessageSendRequest = Type.Object(
	{
		conversationId: ConversationId,
		text: Type.String({ minLength: 1, maxLength: 65536 }),
	},
	{ additionalProperties: false },
);

export const MessageSendResponse = Type.Object(
	{
		messageId: MessageId,
	},
	{ additionalProperties: false },
);

export const MessageRegenerateRequest = Type.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
	},
	{ additionalProperties: false },
);

export const MessageSwitchVersionRequest = Type.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
		versionId: MessageVersionId,
	},
	{ additionalProperties: false },
);

export const MessageEditRequest = Type.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
		text: Type.String({ minLength: 1, maxLength: 65536 }),
		isUserMessage: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const MessageContinueRequest = Type.Object(
	{
		conversationId: ConversationId,
	},
	{ additionalProperties: false },
);

export const MessageCorrectRequest = Type.Object(
	{
		conversationId: ConversationId,
		reason: Type.String({ maxLength: MAX_STRING_LENGTH }),
		applyScope: Type.Union(
			[
				Type.Literal("once"),
				Type.Literal("session"),
				Type.Literal("always"),
			],
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const MessageBranchRequest = Type.Object(
	{
		conversationId: ConversationId,
		messageId: MessageId,
	},
	{ additionalProperties: false },
);

export const MessageBranchResponse = Type.Object(
	{
		branchId: BranchId,
	},
	{ additionalProperties: false },
);

export const MessageAbortRequest = Type.Object(
	{
		conversationId: ConversationId,
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryScope = Type.Union(
	[Type.Literal("self"), Type.Literal("relationship"), Type.Literal("scene")],
	{ additionalProperties: false },
);

export const MemoryCandidate = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		kind: Type.Union(
			[
				Type.Literal("fact"),
				Type.Literal("preference"),
				Type.Literal("event"),
				Type.Literal("self_canon_summary"),
			],
			{ additionalProperties: false },
		),
		scope: MemoryScope,
		text: Type.String({ maxLength: MAX_STRING_LENGTH }),
		why: Type.String({ maxLength: MAX_STRING_LENGTH }),
		status: Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("approved"),
				Type.Literal("rejected"),
				Type.Literal("expired"),
			],
			{ additionalProperties: false },
		),
		createdAt: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const MemoryEntry = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		kind: Type.String({ maxLength: 64 }),
		scope: MemoryScope,
		text: Type.String({ maxLength: MAX_STRING_LENGTH }),
		normalizedText: Type.String({ maxLength: MAX_STRING_LENGTH }),
		sourceConversationTitle: Type.String({ maxLength: MAX_STRING_LENGTH }),
		pinned: Type.Boolean(),
		createdAt: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const MemoryListCandidatesRequest = Type.Object({}, { additionalProperties: false });
export const MemoryListCandidatesResponse = Type.Object(
	{
		candidates: Type.Array(MemoryCandidate, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

export const MemoryApprovalDecision = Type.Union(
	[
		Type.Literal("approve"),
		Type.Literal("approve_edited"),
		Type.Literal("reject"),
	],
	{ additionalProperties: false },
);

export const MemoryDecideCandidateRequest = Type.Object(
	{
		candidateId: Type.String({ maxLength: 64 }),
		decision: MemoryApprovalDecision,
		editedText: Type.Optional(Type.String({ maxLength: MAX_STRING_LENGTH })),
		scope: Type.Optional(MemoryScope),
	},
	{ additionalProperties: false },
);

export const MemorySearchRequest = Type.Object(
	{
		query: Type.String({ maxLength: MAX_STRING_LENGTH }),
		scope: Type.Optional(MemoryScope),
	},
	{ additionalProperties: false },
);

export const MemorySearchResponse = Type.Object(
	{
		entries: Type.Array(MemoryEntry, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const ProviderInfo = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		name: Type.String({ maxLength: MAX_STRING_LENGTH }),
		authType: Type.Union(
			[Type.Literal("api_key"), Type.Literal("oauth")],
			{ additionalProperties: false },
		),
		credentialStatus: Type.Union(
			[
				Type.Literal("missing"),
				Type.Literal("session_only"),
				Type.Literal("stored"),
				Type.Literal("weak_storage"),
				Type.Literal("refreshing"),
				Type.Literal("invalid"),
				Type.Literal("unavailable"),
			],
			{ additionalProperties: false },
		),
		availableModels: Type.Array(
			Type.Object(
				{
					id: Type.String({ maxLength: 128 }),
					name: Type.String({ maxLength: MAX_STRING_LENGTH }),
					supportsImages: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
			{ maxItems: MAX_ARRAY_LENGTH },
		),
	},
	{ additionalProperties: false },
);

export const ProviderListRequest = Type.Object({}, { additionalProperties: false });
export const ProviderListResponse = Type.Object(
	{
		providers: Type.Array(ProviderInfo, { maxItems: 30 }),
	},
	{ additionalProperties: false },
);

export const ProviderSetApiKeyRequest = Type.Object(
	{
		providerId: Type.String({ maxLength: 64 }),
		apiKey: Type.String({ minLength: 1, maxLength: 2048 }),
		sessionOnly: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const ProviderLoginRequest = Type.Object(
	{
		providerId: Type.String({ maxLength: 64 }),
		authType: Type.Literal("oauth"),
	},
	{ additionalProperties: false },
);

export const ProviderLoginResponse = Type.Object(
	{
		authUrl: Type.Optional(Type.String({ maxLength: 2048 })),
		deviceCode: Type.Optional(Type.String({ maxLength: 128 })),
		verificationUri: Type.Optional(Type.String({ maxLength: 2048 })),
	},
	{ additionalProperties: false },
);

export const ProviderLogoutRequest = Type.Object(
	{
		providerId: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Voice Stack
// ---------------------------------------------------------------------------

export const VoiceStack = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		providerId: Type.String({ maxLength: 64 }),
		modelId: Type.String({ maxLength: 128 }),
		revision: Type.Integer({ minimum: 0, maximum: MAX_SAFE_INT }),
		label: Type.String({ maxLength: MAX_STRING_LENGTH }),
		active: Type.Boolean(),
		createdAt: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const VoiceStackListRequest = Type.Object({}, { additionalProperties: false });
export const VoiceStackListResponse = Type.Object(
	{
		stacks: Type.Array(VoiceStack, { maxItems: 20 }),
	},
	{ additionalProperties: false },
);

export const VoiceStackSwitchRequest = Type.Object(
	{
		stackId: Type.String({ maxLength: 64 }),
		scope: Type.Union(
			[Type.Literal("next_scene"), Type.Literal("branch_only")],
			{ additionalProperties: false },
		),
		rollbackAvailable: Type.Boolean(),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

export const ActionDraft = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		title: Type.String({ maxLength: MAX_STRING_LENGTH }),
		description: Type.String({ maxLength: MAX_STRING_LENGTH }),
		reads: Type.Array(Type.String({ maxLength: MAX_PATH_LENGTH }), { maxItems: 20 }),
		writes: Type.Array(Type.String({ maxLength: MAX_PATH_LENGTH }), { maxItems: 20 }),
		networkAllowed: Type.Boolean(),
		toolNames: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 20 }),
		hash: Type.String({ maxLength: 128 }),
	},
	{ additionalProperties: false },
);

export const Commission = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		draft: ActionDraft,
		status: Type.Union(
			[
				Type.Literal("draft"),
				Type.Literal("awaiting_approval"),
				Type.Literal("approved"),
				Type.Literal("queued"),
				Type.Literal("running"),
				Type.Literal("needs_user"),
				Type.Literal("completed"),
				Type.Literal("failed"),
				Type.Literal("cancelled"),
			],
			{ additionalProperties: false },
		),
		createdAt: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const CommissionListRequest = Type.Object({}, { additionalProperties: false });
export const CommissionListResponse = Type.Object(
	{
		commissions: Type.Array(Commission, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunStatus = Type.Union(
	[
		Type.Literal("enqueued"),
		Type.Literal("running"),
		Type.Literal("needs_user"),
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
		Type.Literal("interrupted"),
		Type.Literal("forced_termination"),
	],
	{ additionalProperties: false },
);

export const Run = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		commissionId: Type.String({ maxLength: 64 }),
		executorProfile: Type.String({ maxLength: 64 }),
		status: RunStatus,
		startedAt: Type.Optional(Type.String({ maxLength: 64 })),
		completedAt: Type.Optional(Type.String({ maxLength: 64 })),
	},
	{ additionalProperties: false },
);

export const RunListRequest = Type.Object({}, { additionalProperties: false });
export const RunListResponse = Type.Object(
	{
		runs: Type.Array(Run, { maxItems: 10 }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const Artifact = Type.Object(
	{
		id: Type.String({ maxLength: 64 }),
		logicalName: Type.String({ maxLength: MAX_STRING_LENGTH }),
		mime: Type.String({ maxLength: 128 }),
		bytes: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
		sha256: Type.String({ maxLength: 128 }),
		status: Type.Union(
			[
				Type.Literal("created"),
				Type.Literal("verified"),
				Type.Literal("verification_failed"),
				Type.Literal("adopted"),
				Type.Literal("saved"),
			],
			{ additionalProperties: false },
		),
		producerRunId: Type.Optional(Type.String({ maxLength: 64 })),
		createdAt: Type.String({ maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export const ArtifactListRequest = Type.Object({}, { additionalProperties: false });
export const ArtifactListResponse = Type.Object(
	{
		artifacts: Type.Array(Artifact, { maxItems: MAX_ARRAY_LENGTH }),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SettingsData = Type.Object(
	{
		relationshipMemoryEnabled: Type.Boolean(),
		pauseLearning: Type.Boolean(),
		immersionLevel: Type.Union(
			[
				Type.Literal("concise"),
				Type.Literal("roleplay"),
				Type.Literal("narrative"),
			],
			{ additionalProperties: false },
		),
		currentScene: Type.String({ maxLength: MAX_STRING_LENGTH }),
		theme: Type.String({ maxLength: MAX_STRING_LENGTH }),
	},
	{ additionalProperties: false },
);

export const SettingsGetRequest = Type.Object({}, { additionalProperties: false });
export const SettingsResponse = Type.Object(
	{
		settings: SettingsData,
	},
	{ additionalProperties: false },
);

export const SettingsSetRequest = Type.Object(
	{
		settings: Type.Partial(SettingsData),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Channel registry (for main-side validation)
// ---------------------------------------------------------------------------

/** Map of IPC channel name → request schema for the main-side router. */
export const REQUEST_SCHEMAS: Record<string, TSchema> = {
	"snapshot.get:v1": SnapshotGetRequest,
	"events.subscribe:v1": EventSubscribeRequest,
	"onboarding.get:v1": OnboardingGetRequest,
	"onboarding.setName:v1": OnboardingSetNameRequest,
	"onboarding.setRelation:v1": OnboardingSetRelationRequest,
	"onboarding.setMemoryDecision:v1": OnboardingSetMemoryDecisionRequest,
	"conversation.list:v1": ConversationListRequest,
	"conversation.create:v1": ConversationCreateRequest,
	"conversation.select:v1": ConversationSelectRequest,
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
	"provider.list:v1": ProviderListRequest,
	"provider.setApiKey:v1": ProviderSetApiKeyRequest,
	"provider.login:v1": ProviderLoginRequest,
	"provider.logout:v1": ProviderLogoutRequest,
	"voice.list:v1": VoiceStackListRequest,
	"voice.switch:v1": VoiceStackSwitchRequest,
	"commission.list:v1": CommissionListRequest,
	"run.list:v1": RunListRequest,
	"artifact.list:v1": ArtifactListRequest,
	"settings.get:v1": SettingsGetRequest,
	"settings.set:v1": SettingsSetRequest,
};