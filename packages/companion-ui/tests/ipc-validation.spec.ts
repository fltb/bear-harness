import {
	ActionDraft,
	Artifact,
	CharacterDisplay,
	Commission,
	ConfiguredModel,
	ConversationSummary,
	MemoryCaptureResponse,
	MemoryEntry,
	Message,
	MessageVersion,
	OnboardingResponse,
	ProviderInfo,
	Run,
	SettingsData,
	StoryChange,
} from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";
import { THEMED_CHARACTER } from "./fixtures.js";

const guard = (schema: { safeParse(value: unknown): { success: boolean } }) => (value: unknown) =>
	schema.safeParse(value).success;
const isActionDraft = guard(ActionDraft);
const isArtifact = guard(Artifact);
const isCharacterDisplay = guard(CharacterDisplay);
const isCommission = guard(Commission);
const isConversationSummary = guard(ConversationSummary);
const isMemoryCaptureResponse = guard(MemoryCaptureResponse);
const isMemoryEntry = guard(MemoryEntry);
const isMessage = guard(Message);
const isMessageVersion = guard(MessageVersion);
const isOnboardingData = guard(OnboardingResponse);
const isProviderInfo = guard(ProviderInfo);
const isRun = guard(Run);
const isSettingsData = guard(SettingsData);
const isStoryChange = guard(StoryChange);
const isConfiguredModel = guard(ConfiguredModel);

const timestamp = "2026-08-16T00:00:00Z";
const conversation = {
	id: "conversation-1",
	title: "Conversation",
	sceneTitle: "Scene",
	unread: false,
	updatedAt: timestamp,
};
const version = {
	id: "version-1",
	role: "assistant",
	content: "Reply",
	editedByUser: false,
	createdAt: timestamp,
	adopted: true,
};
const message = {
	id: "message-1",
	role: "assistant",
	adoptedVersionId: "version-1",
	versions: [version],
	createdAt: timestamp,
};
const memoryEntry = {
	id: "memory-1",
	kind: "fact",
	scope: "relationship",
	text: "Memory",
	createdAt: timestamp,
	updatedAt: timestamp,
	importance: 0.8,
};
const memoryCaptureResponse = {
	memoryId: "memory-1",
	sourceEntryId: "entry-1",
	createdBy: "user_capture",
};
const provider = {
	id: "provider-1",
	name: "Provider",
	authType: "api_key",
	credentialStatus: "stored",
	availableModels: [
		{
			id: "model-1",
			name: "Model",
			supportsImages: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	],
	unavailable: [],
};
const configuredModel = {
	providerId: "provider-1",
	modelId: "model-1",
	label: "Model",
	supportsImages: false,
	createdAt: timestamp,
};
const draft = {
	id: "draft-1",
	title: "Work",
	description: "Description",
	reads: ["input.txt"],
	writes: ["output.txt"],
	networkAllowed: false,
	toolNames: ["read"],
	hash: "hash",
};
const commission = {
	id: "commission-1",
	conversationId: "conversation-1",
	triggerMessageId: "message-1",
	draft,
	status: "draft",
	createdAt: timestamp,
};
const run = {
	id: "run-1",
	commissionId: "commission-1",
	executorProfile: "pi",
	status: "running",
	startedAt: timestamp,
	completedAt: timestamp,
};
const artifact = {
	id: "artifact-1",
	logicalName: "result.md",
	mime: "text/markdown",
	bytes: 10,
	sha256: "hash",
	status: "verified",
	producerRunId: "run-1",
	createdAt: timestamp,
};
const story = {
	id: "change-1",
	text: "AU change",
	scope: "global",
	source: "user_explicit",
	conversationId: "conversation-1",
	branchId: "branch-1",
	createdAt: timestamp,
};

function expectRequiredFields(
	guard: (value: unknown) => boolean,
	valid: Record<string, unknown>,
	fields: string[],
) {
	expect(guard(valid)).toBe(true);
	for (const field of fields) {
		expect(guard({ ...valid, [field]: null }), field).toBe(false);
	}
}

describe("host projection validation", () => {
	it("rejects every corrupted required field in public domain records", () => {
		expectRequiredFields(isConversationSummary, conversation, [
			"id",
			"title",
			"sceneTitle",
			"unread",
			"updatedAt",
		]);
		expectRequiredFields(isMessageVersion, version, [
			"id",
			"role",
			"content",
			"editedByUser",
			"createdAt",
			"adopted",
		]);
		expectRequiredFields(isMessage, message, ["id", "role", "versions", "createdAt"]);
		expect(isMessage({ ...message, adoptedVersionId: 3 })).toBe(false);
		expect(isMessage({ ...message, versions: [{ ...version, content: null }] })).toBe(false);
		expectRequiredFields(isMemoryEntry, memoryEntry, [
			"id",
			"kind",
			"scope",
			"text",
			"createdAt",
			"updatedAt",
			"importance",
		]);
		expect(isMemoryEntry({ ...memoryEntry, id: "m".repeat(129) })).toBe(false);
		expect(isMemoryEntry({ ...memoryEntry, scope: "global" })).toBe(false);
		expect(isMemoryEntry({ ...memoryEntry, importance: Number.NaN })).toBe(false);
		expect(isMemoryCaptureResponse(memoryCaptureResponse)).toBe(true);
		expect(isMemoryCaptureResponse({ ...memoryCaptureResponse, createdBy: "assistant_tool" })).toBe(
			true,
		);
		expectRequiredFields(isMemoryCaptureResponse, memoryCaptureResponse, [
			"memoryId",
			"sourceEntryId",
			"createdBy",
		]);
		expect(isMemoryCaptureResponse({ ...memoryCaptureResponse, memoryId: "m".repeat(129) })).toBe(
			false,
		);
		expect(
			isMemoryCaptureResponse({ ...memoryCaptureResponse, sourceEntryId: "e".repeat(129) }),
		).toBe(false);
		expect(isMemoryCaptureResponse({ ...memoryCaptureResponse, createdBy: "system" })).toBe(false);
		expectRequiredFields(isProviderInfo, provider, [
			"id",
			"name",
			"authType",
			"credentialStatus",
			"availableModels",
		]);
		expect(isProviderInfo({ ...provider, availableModels: [{ id: "model-1" }] })).toBe(false);
		expectRequiredFields(isConfiguredModel, configuredModel, [
			"providerId",
			"modelId",
			"label",
			"supportsImages",
			"createdAt",
		]);
		expect(isConfiguredModel({ ...configuredModel, supportsImages: "yes" })).toBe(false);
		expectRequiredFields(isActionDraft, draft, [
			"id",
			"title",
			"description",
			"reads",
			"writes",
			"networkAllowed",
			"toolNames",
			"hash",
		]);
		expect(isActionDraft({ ...draft, reads: [3] })).toBe(false);
		expectRequiredFields(isCommission, commission, ["id", "draft", "status", "createdAt"]);
		expect(isCommission({ ...commission, conversationId: 3 })).toBe(false);
		expectRequiredFields(isRun, run, ["id", "commissionId", "executorProfile", "status"]);
		expect(isRun({ ...run, startedAt: 3 })).toBe(false);
		expect(isRun({ ...run, completedAt: 3 })).toBe(false);
		expectRequiredFields(isArtifact, artifact, [
			"id",
			"logicalName",
			"mime",
			"bytes",
			"sha256",
			"status",
			"createdAt",
		]);
		expect(isArtifact({ ...artifact, bytes: -1 })).toBe(false);
		expect(isArtifact({ ...artifact, bytes: 1.5 })).toBe(false);
		expect(isArtifact({ ...artifact, producerRunId: 3 })).toBe(false);
		expectRequiredFields(isStoryChange, story, ["id", "text", "scope", "source", "createdAt"]);
		expect(isStoryChange({ ...story, conversationId: 3 })).toBe(false);
		expect(isStoryChange({ ...story, branchId: 3 })).toBe(false);
	});

	it("validates onboarding and rejects retired model routing settings", () => {
		const onboarding = {
			status: "active",
			currentStepId: "hello",
			eventSeq: 2,
			stateData: {
				schema_version: 1,
				flow_version: 1,
				answers: {},
				decisions: { relationship_kind: "partner", relationship_memory_enabled: true },
			},
		};
		expect(isOnboardingData(onboarding)).toBe(true);
		expect(isOnboardingData({ ...onboarding, status: "unknown" })).toBe(false);
		expect(isOnboardingData({ ...onboarding, eventSeq: -1 })).toBe(false);
		expect(isOnboardingData({ ...onboarding, eventSeq: 1.5 })).toBe(false);
		expect(isOnboardingData({ ...onboarding, currentStepId: 3 })).toBe(false);
		expect(isOnboardingData({ ...onboarding, stateData: {} })).toBe(false);

		const settings = {
			relationshipMemoryEnabled: true,
			conversationHistoryReadEnabled: false,
			networkProxy: { mode: "direct" as const },
			memoryVectorService: { enabled: false, provider: "none" as const },
			modelDownloadMirror: {},
		};
		expect(isSettingsData(settings)).toBe(true);
		expect(isSettingsData({ ...settings, relationshipMemoryEnabled: "yes" })).toBe(false);
		expect(isSettingsData({ ...settings, textFallback: { providerId: "provider-1" } })).toBe(false);
	});

	it("rejects malformed nested character-package presentation data", () => {
		const labels = {
			proposal: "Proposal",
			running: "Running",
			needs_user: "Needs you",
			interrupted: "Paused",
			completed: "Completed",
			failed: "Failed",
			steer_placeholder: "Add guidance",
			interrupt: "Interrupt",
			resume: "Resume",
			approve: "Approve",
			reject: "Reject",
			artifact_open: "Open",
			artifact_reveal: "Show in Finder",
		};
		const themedCharacter = structuredClone(THEMED_CHARACTER);
		const valid = {
			...themedCharacter,
			character: {
				...themedCharacter.character,
				work_presentation: { labels },
			},
		};
		expect(isCharacterDisplay(valid)).toBe(true);
		expect(
			isCharacterDisplay({
				...valid,
				character: { ...valid.character, work_presentation: { labels } },
			}),
		).toBe(true);
		expect(
			isCharacterDisplay({
				...valid,
				character: {
					...valid.character,
					work_presentation: { labels: { ...labels, unknown: "Nope" } },
				},
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...valid,
				character: {
					...valid.character,
					work_presentation: { labels: { ...labels, proposal: " " } },
				},
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...valid,
				character: {
					...valid.character,
					work_presentation: {
						labels,
						execution: "not presentation",
					},
				},
			}),
		).toBe(false);
		for (const field of ["id", "name", "language", "character", "theme", "visual", "scenes"]) {
			expect(isCharacterDisplay({ ...valid, [field]: null }), field).toBe(false);
		}
		expect(isCharacterDisplay({ ...valid, theme: { ...valid.theme, radius: null } })).toBe(false);
		expect(
			isCharacterDisplay({
				...valid,
				theme: { ...valid.theme, radius: { ...valid.theme.radius, sm: "round" } },
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...valid,
				theme: { ...valid.theme, color: { ...valid.theme.color, text: null } },
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({ ...valid, visual: { ...valid.visual, expressions: { idle: 4 } } }),
		).toBe(false);
		expect(
			isCharacterDisplay({ ...valid, visual: { ...valid.visual, expressionLabels: { idle: 4 } } }),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...valid,
				scenes: [{ id: "room", label: "Room", description: "A room", backgroundUrl: 4 }],
			}),
		).toBe(false);

		const media = [
			{
				id: "inline_image",
				kind: "image",
				label: "Inline image",
				loop: false,
				presentation: "inline",
				url: "data:image/png;base64,aW1hZ2U=",
			},
			{
				id: "ambient_audio",
				kind: "audio",
				label: "Ambient audio",
				loop: true,
				presentation: "ambient",
				url: "data:audio/mpeg;base64,YXVkaW8=",
				captionsUrl: "data:text/vtt;base64,V0VCVlRU",
			},
			{
				id: "dialog_video",
				kind: "video",
				label: "Dialog video",
				loop: false,
				presentation: "dialog",
				url: "data:video/mp4;base64,dmlkZW8=",
				captionsUrl: "data:text/vtt;base64,V0VCVlRU",
			},
		] as const;
		const mediaCharacter = {
			...valid,
			roleplay: { ...valid.roleplay, media },
		};
		expect(isCharacterDisplay(mediaCharacter)).toBe(true);
		expect(
			isCharacterDisplay({
				...valid,
				roleplay: {
					...valid.roleplay,
					media: [{ ...media[0], presentation: undefined }],
				},
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...mediaCharacter,
				roleplay: {
					...mediaCharacter.roleplay,
					media: [{ ...media[0], presentation: "ambient" }],
				},
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...mediaCharacter,
				roleplay: {
					...mediaCharacter.roleplay,
					media: [{ ...media[0], unknown: true }],
				},
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...mediaCharacter,
				roleplay: {
					...mediaCharacter.roleplay,
					media: [{ ...media[0], presentation: "modal" }],
				},
			}),
		).toBe(false);

		const textStep = {
			id: "name",
			kind: "text",
			heading: "Name",
			body: "Choose name",
			answer_key: "name",
			input_label: "Name",
			input_placeholder: "Name",
			min_length: 1,
			max_length: 10,
			submit_label: "Continue",
		};
		const choiceStep = {
			id: "relation",
			kind: "choice",
			heading: "Relation",
			body: "Choose relation",
			answer_key: "relation",
			choices: [
				{ value: "friend", label: "Friend", description: "A friend" },
				{ value: "partner", label: "Partner", description: "A partner" },
			],
		};
		for (const step of [textStep, choiceStep]) {
			expect(
				isCharacterDisplay({
					...valid,
					character: {
						...valid.character,
						first_meeting: { ...valid.character.first_meeting, steps: [step] },
					},
				}),
			).toBe(true);
		}
		expect(
			isCharacterDisplay({
				...valid,
				character: {
					...valid.character,
					first_meeting: {
						...valid.character.first_meeting,
						steps: [{ ...choiceStep, choices: [{ value: "friend" }] }],
					},
				},
			}),
		).toBe(false);
	});
});
