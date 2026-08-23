import {
	ActionDraft,
	Artifact,
	CanonChunk,
	CharacterDisplay,
	Commission,
	ConfiguredModel,
	ConversationSummary,
	MemoryCaptureResponse,
	MemoryEntry,
	OnboardingResponse,
	ProviderInfo,
	Run,
	SettingsData,
} from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";
import { THEMED_CHARACTER } from "./fixtures.js";

const guard = (schema: { safeParse(value: unknown): { success: boolean } }) => (value: unknown) =>
	schema.safeParse(value).success;
const isActionDraft = guard(ActionDraft);
const isArtifact = guard(Artifact);
const isCanonChunk = guard(CanonChunk);
const isCharacterDisplay = guard(CharacterDisplay);
const isCommission = guard(Commission);
const isConversationSummary = guard(ConversationSummary);
const isMemoryCaptureResponse = guard(MemoryCaptureResponse);
const isMemoryEntry = guard(MemoryEntry);
const isOnboardingData = guard(OnboardingResponse);
const isProviderInfo = guard(ProviderInfo);
const isRun = guard(Run);
const isSettingsData = guard(SettingsData);
const isConfiguredModel = guard(ConfiguredModel);

const timestamp = "2026-08-16T00:00:00Z";
const conversation = {
	id: "conversation-1",
	title: "Conversation",
	sceneTitle: "Scene",
	unread: false,
	updatedAt: timestamp,
};
const memoryEntry = {
	id: "memory-1",
	sourceEntryId: "entry-1",
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
	source: "builtin",
	added: true,
	authType: "api_key",
	credentialStatus: "stored",
	availableModels: [
		{
			id: "model-1",
			name: "Model",
			supportsImages: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] },
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
	triggerEntryId: "message-1",
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
const canonChunk = {
	id: "chunk-1",
	sourceId: "source-1",
	sourceName: "Source",
	ordinal: 0,
	content: "text",
	startOffset: 0,
	endOffset: 4,
	origin: "user",
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
		expect(isMemoryEntry({ ...memoryEntry, sourceEntryId: "" })).toBe(false);
		expect(isMemoryEntry({ ...memoryEntry, sourceEntryId: 42 })).toBe(false);
		expect(isMemoryEntry({ ...memoryEntry, sourceEntryId: "e".repeat(129) })).toBe(false);
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

	it("enforces cross-field relationships on character projections", () => {
		const base = structuredClone(THEMED_CHARACTER);
		expect(isCharacterDisplay(base)).toBe(true);
		expect(
			isCharacterDisplay({
				...base,
				visual: { ...base.visual, defaultSceneId: "missing-scene" },
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...base,
				visual: { ...base.visual, defaultExpressionId: "missing-expression" },
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...base,
				visual: { ...base.visual, expressionLabels: { orphan: "Orphan" } },
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...base,
				roleplay: {
					...base.roleplay,
					media: [
						{
							id: "m1",
							kind: "image",
							label: "M1",
							loop: false,
							presentation: "dialog",
							url: "data:image/png;base64,bTE=",
						},
					],
					unlockables: [
						{
							id: "u1",
							kind: "cg",
							label: "U1",
							description: "U1",
							media: "missing-media",
						},
					],
				},
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...base,
				roleplay: {
					...base.roleplay,
					variables: [
						{
							id: "trust",
							type: "number",
							scope: "relationship",
							initial: "high",
							display: { kind: "hidden" },
						},
					],
				},
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...base,
				character: {
					...base.character,
					first_meeting: {
						...base.character.first_meeting,
						steps: [
							{
								id: "name",
								kind: "text",
								heading: "Name",
								body: "Name",
								answer_key: "name",
								input_label: "Name",
								input_placeholder: "Name",
								min_length: 10,
								max_length: 2,
								submit_label: "Continue",
							},
						],
					},
				},
			}),
		).toBe(false);
	});


	it("rejects malformed run timestamp relationships", () => {
		expect(isRun({ ...run, startedAt: timestamp, completedAt: "2025-01-01T00:00:00Z" })).toBe(
			false,
		);
		expect(isRun({ ...run, startedAt: undefined, completedAt: timestamp })).toBe(true);
	});

	it("rejects empty identifiers and unbounded records at the safe maximum", () => {
		expect(isProviderInfo({ ...provider, id: "" })).toBe(false);
		expect(isRun({ ...run, id: "" })).toBe(false);
		expect(isArtifact({ ...artifact, id: "" })).toBe(false);
		expect(isActionDraft({ ...draft, hash: "" })).toBe(false);
		expect(isCommission({ ...commission, id: "" })).toBe(false);
		expect(isConversationSummary({ ...conversation, id: "" })).toBe(false);
		const manyExpressions = Object.fromEntries(
			Array.from({ length: 99 }, (_, i) => [`expression-${i}`, "data:image/png;base64,aW1hZ2U="]),
		);
		const atLimit = { default: "data:image/png;base64,aW1hZ2U=", ...manyExpressions };
		expect(
			isCharacterDisplay({
				...THEMED_CHARACTER,
				visual: { ...THEMED_CHARACTER.visual, expressions: atLimit },
			}),
		).toBe(true);
		expect(
			isCharacterDisplay({
				...THEMED_CHARACTER,
				visual: {
					...THEMED_CHARACTER.visual,
					expressions: { ...atLimit, "expression-99": "data:image/png;base64,aW1hZ2U=" },
				},
			}),
		).toBe(false);
	});

	it("rejects incoherent canon chunk offsets", () => {
		expect(isCanonChunk(canonChunk)).toBe(true);
		expect(isCanonChunk({ ...canonChunk, startOffset: 10, endOffset: 4 })).toBe(false);
		expect(isCanonChunk({ ...canonChunk, startOffset: 4, endOffset: 10 })).toBe(true);
	});
});
