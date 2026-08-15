/**
 * Wire model types, guards and the client call helper.
 *
 * The injected `CompanionClient` (from `@bear-harness/companion-types`)
 * exposes one async function per IPC channel; every call resolves to the
 * raw `{ ok: true, data } | { ok: false, error: { kind, reason } }`
 * envelope. Envelope unwrapping lives in `../lib/ipc.ts` (`unwrap`, owned
 * by the component layer); `invoke` wraps it so store code gets
 * `Promise<T>` plus client-unavailable handling.
 *
 * The model types mirror the wire contract of the host IPC schemas. They
 * are mirrored (not imported) so the package never pulls typebox into the
 * page, and every value that crosses the client is validated by a narrow
 * guard before it is allowed into reactive state — hostile or malformed
 * payloads are dropped, never projected.
 */

import type { CompanionClient } from "@bear-harness/companion-types";
import { unwrap } from "../lib/ipc.js";

// ---------------------------------------------------------------------------
// Client call helper
// ---------------------------------------------------------------------------

/**
 * Call a client method and unwrap the IPC envelope. Rejects with a plain
 * Error carrying the wire `kind: reason` when the client reports a failure,
 * or when the call itself throws (e.g. the client is missing).
 */
export async function invoke<T>(client: CompanionClient, call: () => Promise<unknown>): Promise<T> {
	if (!client) {
		throw new Error("unavailable: client not connected");
	}
	let result: unknown;
	try {
		result = await call();
	} catch (cause) {
		throw new Error(cause instanceof Error ? cause.message : "client unavailable");
	}
	return unwrap<T>(result);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read a string field off a domain event payload, defensively. */
export function payloadString(payload: unknown, key: string): string | undefined {
	if (!isRecord(payload)) return undefined;
	const value = payload[key];
	return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Domain models mirror the shared @bear-harness/protocol wire contract.
// ---------------------------------------------------------------------------

export type OnboardingStatus = "active" | "complete";

export interface OnboardingStateData {
	schema_version: 1;
	flow_version: number;
	answers: Record<string, string>;
	decisions: {
		relationship_kind?: string;
		relationship_memory_enabled?: boolean;
	};
}

export interface OnboardingData {
	status: OnboardingStatus;
	currentStepId?: string;
	/** Monotonic Host event cursor paired with this exact state projection. */
	eventSeq: number;
	stateData: OnboardingStateData;
}

export type MessageRole = "user" | "assistant" | "system";

export interface MessageVersion {
	id: string;
	role: MessageRole;
	content: string;
	editedByUser: boolean;
	createdAt: string;
	adopted: boolean;
}

export interface Message {
	id: string;
	role: MessageRole;
	adoptedVersionId?: string;
	versions: MessageVersion[];
	createdAt: string;
}

export interface ConversationSummary {
	id: string;
	title: string;
	sceneTitle: string;
	unread: boolean;
	updatedAt: string;
}

export interface ConversationListData {
	conversations: ConversationSummary[];
}

export interface ConversationCreateResult {
	id: string;
}

export interface MessageSendResult {
	messageId: string;
}

export interface MessageBranchResult {
	branchId: string;
}

export type MessageApplyScope = "once" | "session" | "always";

export type MemoryScope = "self" | "relationship" | "scene";

export type MemoryCandidateKind = "fact" | "preference" | "event" | "self_canon_summary";

export type MemoryCandidateStatus = "pending" | "approved" | "rejected" | "expired";

export interface MemoryCandidate {
	id: string;
	kind: MemoryCandidateKind;
	scope: MemoryScope;
	text: string;
	why: string;
	status: MemoryCandidateStatus;
	createdAt: string;
}

export interface MemoryEntry {
	id: string;
	kind: string;
	scope: MemoryScope;
	text: string;
	normalizedText: string;
	sourceConversationTitle: string;
	pinned: boolean;
	createdAt: string;
}

export type MemoryDecision = "approve" | "approve_edited" | "reject";

export interface MemoryListData {
	candidates: MemoryCandidate[];
}

export interface MemorySearchData {
	entries: MemoryEntry[];
}

export type ProviderAuthType = "api_key" | "oauth";

export type ProviderCredentialStatus =
	| "missing"
	| "session_only"
	| "stored"
	| "weak_storage"
	| "refreshing"
	| "invalid"
	| "unavailable";

export interface ProviderModel {
	id: string;
	name: string;
	supportsImages: boolean;
}

export interface ProviderInfo {
	id: string;
	name: string;
	authType: ProviderAuthType;
	credentialStatus: ProviderCredentialStatus;
	availableModels: ProviderModel[];
}

export interface ProviderListData {
	providers: ProviderInfo[];
}

export interface ProviderLoginResult {
	authUrl?: string;
	deviceCode?: string;
	verificationUri?: string;
}

export interface VoiceStack {
	id: string;
	providerId: string;
	modelId: string;
	revision: number;
	label: string;
	active: boolean;
	createdAt: string;
}

export interface VoiceListData {
	stacks: VoiceStack[];
}

export type VoiceSwitchScope = "next_scene" | "branch_only";

export interface ActionDraft {
	id: string;
	title: string;
	description: string;
	reads: string[];
	writes: string[];
	networkAllowed: boolean;
	toolNames: string[];
	hash: string;
}

export type CommissionStatus =
	| "draft"
	| "awaiting_approval"
	| "approved"
	| "queued"
	| "running"
	| "needs_user"
	| "completed"
	| "failed"
	| "cancelled";

export interface Commission {
	id: string;
	draft: ActionDraft;
	status: CommissionStatus;
	createdAt: string;
}

export interface CommissionListData {
	commissions: Commission[];
}

export interface CommissionDraftParams {
	conversationId: string;
	title: string;
	description: string;
	reads?: string[];
	writes?: string[];
	networkAllowed?: boolean;
	toolNames?: string[];
}

export interface CommissionDraftResult {
	commissionId: string;
	draftHash: string;
}

export interface CommissionLaunchResult {
	runId: string;
	commissionId: string;
	executorProfile: string;
	status: RunStatus;
}

export type RunStatus =
	| "enqueued"
	| "running"
	| "needs_user"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "forced_termination";

export interface RunInfo {
	id: string;
	commissionId: string;
	executorProfile: string;
	status: RunStatus;
	startedAt?: string;
	completedAt?: string;
}

export interface RunListData {
	runs: RunInfo[];
}

export interface RunPermissionOption {
	optionId: string;
	kind: string;
	name: string;
}

export interface RunPermissionRequest {
	runId: string;
	requestId: string;
	prompt: string;
	options: RunPermissionOption[];
}

export type ArtifactStatus = "created" | "verified" | "verification_failed" | "adopted" | "saved";

export interface Artifact {
	id: string;
	logicalName: string;
	mime: string;
	bytes: number;
	sha256: string;
	status: ArtifactStatus;
	producerRunId?: string;
	createdAt: string;
}

export interface ArtifactListData {
	artifacts: Artifact[];
}

export interface SettingsData {
	relationshipMemoryEnabled: boolean;
}

/** Wire shape of `settings.get` — the data sits under a `settings` key. */
export interface SettingsResponseData {
	settings: SettingsData;
}

// ---------------------------------------------------------------------------
// Snapshot + events
// ---------------------------------------------------------------------------

export interface DomainEvent {
	seq: number;
	kind: string;
	payload: unknown;
}

export interface EventBatch {
	events: DomainEvent[];
}

/**
 * Shape of the boot snapshot. The wire schema leaves the per-domain fields
 * open (`Type.Unknown()`); the structured fields below are the renderer's
 * best-known projection, and every value is validated by a narrow guard
 * before it enters reactive state.
 */
export interface ConversationSnapshot {
	conversations?: ConversationSummary[];
	activeConversationId?: string;
	activeBranchId?: string;
	messages?: Message[];
}

export interface MemorySnapshot {
	candidates?: MemoryCandidate[];
	entries?: MemoryEntry[];
}

export interface SceneDisplay {
	id: string;
	label: string;
	description: string;
	backgroundUrl?: string;
}

export interface CharacterOnboardingAcknowledgeStep {
	id: string;
	kind: "acknowledge";
	heading: string;
	body: string;
	quote?: string;
	note?: string;
	submit_label: string;
}

export interface CharacterOnboardingTextStep {
	id: string;
	kind: "text";
	heading: string;
	body: string;
	quote?: string;
	note?: string;
	answer_key: string;
	input_label: string;
	input_placeholder: string;
	min_length: number;
	max_length: number;
	submit_label: string;
}

export interface CharacterOnboardingChoiceStep {
	id: string;
	kind: "choice";
	heading: string;
	body: string;
	quote?: string;
	note?: string;
	answer_key: string;
	choices: Array<{ value: string; label: string; description: string }>;
}

export type CharacterOnboardingStep =
	| CharacterOnboardingAcknowledgeStep
	| CharacterOnboardingTextStep
	| CharacterOnboardingChoiceStep;

export interface CharacterOnboardingFlow {
	version: number;
	step_label: string;
	dialog_label: string;
	error_prefix: string;
	steps: CharacterOnboardingStep[];
}

export interface CharacterDisplay {
	id: string;
	name: string;
	character: {
		subtitle: string;
		scene_title: string;
		greeting: string;
		composer_placeholder: string;
		first_meeting: CharacterOnboardingFlow;
		correction: { trigger_label: string; reason_group_label: string };
	};
	theme: Record<string, unknown>;
	scenes: SceneDisplay[];
	visual: {
		defaultSceneId: string;
		avatarUrl: string;
		presence: Record<string, string>;
		stateLabels: Record<string, string>;
	};
}

/** Host-projected, per-conversation scene and expression state. */
export interface CharacterRuntimeState {
	sceneId: string;
	visualState: string;
}

export interface CharacterRuntimeSnapshot {
	byConversation: Record<string, CharacterRuntimeState>;
}

export interface Snapshot {
	eventSeq: number;
	character?: CharacterDisplay;
	onboarding?: OnboardingData;
	conversation?: ConversationSnapshot;
	memory?: MemorySnapshot;
	provider?: ProviderListData;
	voice?: VoiceListData;
	commission?: CommissionListData;
	run?: RunListData;
	artifact?: ArtifactListData;
	settings?: SettingsData;
	characterRuntime?: CharacterRuntimeSnapshot;
}

// ---------------------------------------------------------------------------
// Narrow guards (validate anything that crosses the bridge)
// ---------------------------------------------------------------------------

const ONBOARDING_STATUSES: readonly OnboardingStatus[] = ["active", "complete"];

const MESSAGE_ROLES: readonly MessageRole[] = ["user", "assistant", "system"];

const MEMORY_SCOPES: readonly MemoryScope[] = ["self", "relationship", "scene"];

const MEMORY_CANDIDATE_KINDS: readonly MemoryCandidateKind[] = [
	"fact",
	"preference",
	"event",
	"self_canon_summary",
];

const MEMORY_CANDIDATE_STATUSES: readonly MemoryCandidateStatus[] = [
	"pending",
	"approved",
	"rejected",
	"expired",
];

const PROVIDER_AUTH_TYPES: readonly ProviderAuthType[] = ["api_key", "oauth"];

const PROVIDER_CREDENTIAL_STATUSES: readonly ProviderCredentialStatus[] = [
	"missing",
	"session_only",
	"stored",
	"weak_storage",
	"refreshing",
	"invalid",
	"unavailable",
];

const COMMISSION_STATUSES: readonly CommissionStatus[] = [
	"draft",
	"awaiting_approval",
	"approved",
	"queued",
	"running",
	"needs_user",
	"completed",
	"failed",
	"cancelled",
];

const RUN_STATUSES: readonly RunStatus[] = [
	"enqueued",
	"running",
	"needs_user",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
	"forced_termination",
];

const ARTIFACT_STATUSES: readonly ArtifactStatus[] = [
	"created",
	"verified",
	"verification_failed",
	"adopted",
	"saved",
];

function isOneOf(value: unknown, options: readonly string[]): value is string {
	return typeof value === "string" && options.includes(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOnboardingStateData(value: unknown): value is OnboardingStateData {
	return (
		isRecord(value) &&
		value.schema_version === 1 &&
		typeof value.flow_version === "number" &&
		Number.isSafeInteger(value.flow_version) &&
		value.flow_version >= 1 &&
		isRecord(value.answers) &&
		Object.entries(value.answers).every(
			([key, answer]) => typeof key === "string" && typeof answer === "string",
		) &&
		isRecord(value.decisions) &&
		(value.decisions.relationship_kind === undefined ||
			typeof value.decisions.relationship_kind === "string") &&
		(value.decisions.relationship_memory_enabled === undefined ||
			typeof value.decisions.relationship_memory_enabled === "boolean")
	);
}

export function isOnboardingData(value: unknown): value is OnboardingData {
	return (
		isRecord(value) &&
		isOneOf(value.status, ONBOARDING_STATUSES) &&
		typeof value.eventSeq === "number" &&
		Number.isSafeInteger(value.eventSeq) &&
		value.eventSeq >= 0 &&
		(value.currentStepId === undefined || typeof value.currentStepId === "string") &&
		isOnboardingStateData(value.stateData)
	);
}

function isCharacterOnboardingStep(value: unknown): value is CharacterOnboardingStep {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.kind !== "string" ||
		typeof value.heading !== "string" ||
		typeof value.body !== "string" ||
		(value.quote !== undefined && typeof value.quote !== "string") ||
		(value.note !== undefined && typeof value.note !== "string")
	) {
		return false;
	}
	if (value.kind === "acknowledge") return typeof value.submit_label === "string";
	if (value.kind === "text") {
		return (
			typeof value.answer_key === "string" &&
			typeof value.input_label === "string" &&
			typeof value.input_placeholder === "string" &&
			typeof value.min_length === "number" &&
			typeof value.max_length === "number" &&
			typeof value.submit_label === "string"
		);
	}
	return (
		value.kind === "choice" &&
		typeof value.answer_key === "string" &&
		Array.isArray(value.choices) &&
		value.choices.every(
			(choice) =>
				isRecord(choice) &&
				typeof choice.value === "string" &&
				typeof choice.label === "string" &&
				typeof choice.description === "string",
		)
	);
}

function isCharacterOnboardingFlow(value: unknown): value is CharacterOnboardingFlow {
	return (
		isRecord(value) &&
		typeof value.version === "number" &&
		Number.isSafeInteger(value.version) &&
		typeof value.step_label === "string" &&
		typeof value.dialog_label === "string" &&
		typeof value.error_prefix === "string" &&
		Array.isArray(value.steps) &&
		value.steps.length > 0 &&
		value.steps.every(isCharacterOnboardingStep)
	);
}

/** Validate the Host-projected, renderer-safe part of a character package. */
export function isCharacterDisplay(value: unknown): value is CharacterDisplay {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
		return false;
	}
	const character = value.character;
	const visual = value.visual;
	if (
		!isRecord(character) ||
		typeof character.subtitle !== "string" ||
		typeof character.scene_title !== "string" ||
		typeof character.greeting !== "string" ||
		typeof character.composer_placeholder !== "string" ||
		!isRecord(character.correction) ||
		typeof character.correction.trigger_label !== "string" ||
		typeof character.correction.reason_group_label !== "string" ||
		!isCharacterOnboardingFlow(character.first_meeting) ||
		!isRecord(value.theme) ||
		!isRecord(visual) ||
		typeof visual.defaultSceneId !== "string" ||
		typeof visual.avatarUrl !== "string" ||
		!isRecord(visual.presence) ||
		!Object.values(visual.presence).every((asset) => typeof asset === "string") ||
		!isRecord(visual.stateLabels) ||
		!Object.values(visual.stateLabels).every((label) => typeof label === "string") ||
		!Array.isArray(value.scenes)
	) {
		return false;
	}
	return value.scenes.every(
		(scene) =>
			isRecord(scene) &&
			typeof scene.id === "string" &&
			typeof scene.label === "string" &&
			typeof scene.description === "string" &&
			(scene.backgroundUrl === undefined || typeof scene.backgroundUrl === "string"),
	);
}

export function isConversationSummary(value: unknown): value is ConversationSummary {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.sceneTitle === "string" &&
		typeof value.unread === "boolean" &&
		typeof value.updatedAt === "string"
	);
}

export function isMessageVersion(value: unknown): value is MessageVersion {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		isOneOf(value.role, MESSAGE_ROLES) &&
		typeof value.content === "string" &&
		typeof value.editedByUser === "boolean" &&
		typeof value.createdAt === "string" &&
		typeof value.adopted === "boolean"
	);
}

export function isMessage(value: unknown): value is Message {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		isOneOf(value.role, MESSAGE_ROLES) &&
		(value.adoptedVersionId === undefined || typeof value.adoptedVersionId === "string") &&
		Array.isArray(value.versions) &&
		value.versions.every(isMessageVersion) &&
		typeof value.createdAt === "string"
	);
}

export function isMemoryCandidate(value: unknown): value is MemoryCandidate {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		isOneOf(value.kind, MEMORY_CANDIDATE_KINDS) &&
		isOneOf(value.scope, MEMORY_SCOPES) &&
		typeof value.text === "string" &&
		typeof value.why === "string" &&
		isOneOf(value.status, MEMORY_CANDIDATE_STATUSES) &&
		typeof value.createdAt === "string"
	);
}

export function isMemoryEntry(value: unknown): value is MemoryEntry {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.kind === "string" &&
		isOneOf(value.scope, MEMORY_SCOPES) &&
		typeof value.text === "string" &&
		typeof value.normalizedText === "string" &&
		typeof value.sourceConversationTitle === "string" &&
		typeof value.pinned === "boolean" &&
		typeof value.createdAt === "string"
	);
}

export function isProviderInfo(value: unknown): value is ProviderInfo {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		!isOneOf(value.authType, PROVIDER_AUTH_TYPES) ||
		!isOneOf(value.credentialStatus, PROVIDER_CREDENTIAL_STATUSES) ||
		!Array.isArray(value.availableModels)
	) {
		return false;
	}
	return value.availableModels.every(
		(model) =>
			isRecord(model) &&
			typeof model.id === "string" &&
			typeof model.name === "string" &&
			typeof model.supportsImages === "boolean",
	);
}

export function isVoiceStack(value: unknown): value is VoiceStack {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.providerId === "string" &&
		typeof value.modelId === "string" &&
		typeof value.revision === "number" &&
		Number.isSafeInteger(value.revision) &&
		typeof value.label === "string" &&
		typeof value.active === "boolean" &&
		typeof value.createdAt === "string"
	);
}

export function isActionDraft(value: unknown): value is ActionDraft {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.description === "string" &&
		isStringArray(value.reads) &&
		isStringArray(value.writes) &&
		typeof value.networkAllowed === "boolean" &&
		isStringArray(value.toolNames) &&
		typeof value.hash === "string"
	);
}

export function isCommission(value: unknown): value is Commission {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		isActionDraft(value.draft) &&
		isOneOf(value.status, COMMISSION_STATUSES) &&
		typeof value.createdAt === "string"
	);
}

export function isRun(value: unknown): value is RunInfo {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.commissionId === "string" &&
		typeof value.executorProfile === "string" &&
		isOneOf(value.status, RUN_STATUSES) &&
		(value.startedAt === undefined || typeof value.startedAt === "string") &&
		(value.completedAt === undefined || typeof value.completedAt === "string")
	);
}

export function isArtifact(value: unknown): value is Artifact {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.logicalName === "string" &&
		typeof value.mime === "string" &&
		typeof value.bytes === "number" &&
		Number.isSafeInteger(value.bytes) &&
		value.bytes >= 0 &&
		typeof value.sha256 === "string" &&
		isOneOf(value.status, ARTIFACT_STATUSES) &&
		(value.producerRunId === undefined || typeof value.producerRunId === "string") &&
		typeof value.createdAt === "string"
	);
}

export function isSettingsData(value: unknown): value is SettingsData {
	return isRecord(value) && typeof value.relationshipMemoryEnabled === "boolean";
}

// ---------------------------------------------------------------------------
// Snapshot/list normalizers — drop malformed projections, keep what validates
// ---------------------------------------------------------------------------

export function normalizeConversationList(value: unknown): ConversationListData | null {
	if (!isRecord(value) || !Array.isArray(value.conversations)) return null;
	if (!value.conversations.every(isConversationSummary)) return null;
	return { conversations: value.conversations };
}

export function normalizeConversationSnapshot(value: unknown): ConversationSnapshot | null {
	if (!isRecord(value)) return null;
	const out: ConversationSnapshot = {};
	if (typeof value.activeConversationId === "string")
		out.activeConversationId = value.activeConversationId;
	if (typeof value.activeBranchId === "string") out.activeBranchId = value.activeBranchId;
	if (Array.isArray(value.conversations) && value.conversations.every(isConversationSummary)) {
		out.conversations = value.conversations;
	}
	if (Array.isArray(value.messages) && value.messages.every(isMessage)) {
		out.messages = value.messages;
	}
	return out.conversations !== undefined ||
		out.activeConversationId !== undefined ||
		out.activeBranchId !== undefined ||
		out.messages !== undefined
		? out
		: null;
}

/** Accept either `{ entries: [...] }` (wire list/search shape) or a bare array. */
export function normalizeMemoryEntries(value: unknown): MemoryEntry[] | null {
	const candidates = isRecord(value) ? value.entries : value;
	if (!Array.isArray(candidates) || !candidates.every(isMemoryEntry)) return null;
	return candidates;
}

export function normalizeMemorySnapshot(value: unknown): MemorySnapshot | null {
	if (!isRecord(value)) return null;
	const out: MemorySnapshot = {};
	if (Array.isArray(value.candidates) && value.candidates.every(isMemoryCandidate)) {
		out.candidates = value.candidates;
	}
	const entries = normalizeMemoryEntries(value.entries);
	if (entries) out.entries = entries;
	return out.candidates !== undefined || out.entries !== undefined ? out : null;
}

export function normalizeProviderList(value: unknown): ProviderListData | null {
	if (!isRecord(value) || !Array.isArray(value.providers)) return null;
	if (!value.providers.every(isProviderInfo)) return null;
	return { providers: value.providers };
}

export function normalizeVoiceList(value: unknown): VoiceListData | null {
	if (!isRecord(value) || !Array.isArray(value.stacks)) return null;
	if (!value.stacks.every(isVoiceStack)) return null;
	return { stacks: value.stacks };
}

export function normalizeCommissionList(value: unknown): CommissionListData | null {
	if (!isRecord(value) || !Array.isArray(value.commissions)) return null;
	if (!value.commissions.every(isCommission)) return null;
	return { commissions: value.commissions };
}

export function normalizeRunList(value: unknown): RunListData | null {
	if (!isRecord(value) || !Array.isArray(value.runs)) return null;
	if (!value.runs.every(isRun)) return null;
	return { runs: value.runs };
}

export function normalizeArtifactList(value: unknown): ArtifactListData | null {
	if (!isRecord(value) || !Array.isArray(value.artifacts)) return null;
	if (!value.artifacts.every(isArtifact)) return null;
	return { artifacts: value.artifacts };
}

function normalizeCharacterRuntimeSnapshot(value: unknown): CharacterRuntimeSnapshot | null {
	if (!isRecord(value) || !isRecord(value.byConversation)) return null;
	const byConversation: Record<string, CharacterRuntimeState> = {};
	for (const [conversationId, state] of Object.entries(value.byConversation)) {
		if (
			typeof conversationId !== "string" ||
			!isRecord(state) ||
			typeof state.sceneId !== "string" ||
			typeof state.visualState !== "string"
		) {
			return null;
		}
		byConversation[conversationId] = { sceneId: state.sceneId, visualState: state.visualState };
	}
	return { byConversation };
}

/**
 * Sanitize the boot snapshot before it enters reactive state: require a
 * valid `eventSeq`, validate each domain projection, and drop everything
 * that fails. A garbage snapshot degrades to the empty shell rather than
 * poisoning the projected state.
 */
export function sanitizeSnapshot(value: unknown): Snapshot {
	if (
		!isRecord(value) ||
		typeof value.eventSeq !== "number" ||
		!Number.isSafeInteger(value.eventSeq) ||
		value.eventSeq < 0
	) {
		return { eventSeq: 0 };
	}
	const out: Snapshot = { eventSeq: value.eventSeq };
	if (isOnboardingData(value.onboarding)) out.onboarding = value.onboarding;
	const conversation = normalizeConversationSnapshot(value.conversation);
	if (conversation) out.conversation = conversation;
	const memory = normalizeMemorySnapshot(value.memory);
	if (memory) out.memory = memory;
	const provider = normalizeProviderList(value.provider);
	if (provider) out.provider = provider;
	const voice = normalizeVoiceList(value.voice);
	if (voice) out.voice = voice;
	const commission = normalizeCommissionList(value.commission);
	if (commission) out.commission = commission;
	const runs = normalizeRunList(value.run);
	if (runs) out.run = runs;
	const artifacts = normalizeArtifactList(value.artifact);
	if (artifacts) out.artifact = artifacts;
	if (isSettingsData(value.settings)) out.settings = value.settings;
	if (isCharacterDisplay(value.character)) out.character = value.character;
	const characterRuntime = normalizeCharacterRuntimeSnapshot(value.characterRuntime);
	if (characterRuntime) out.characterRuntime = characterRuntime;
	return out;
}
