import {
	CanonChunk,
	CharacterDisplay,
	ConfiguredModel,
	ConversationSummary,
	OnboardingResponse,
	ProviderInfo,
	Run,
	SettingsData,
} from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";
import { THEMED_CHARACTER } from "./fixtures.js";

const guard = (schema: { safeParse(value: unknown): { success: boolean } }) => (value: unknown) =>
	schema.safeParse(value).success;
const isCanonChunk = guard(CanonChunk);
const isCharacterDisplay = guard(CharacterDisplay);
const isConversationSummary = guard(ConversationSummary);
const isOnboardingData = guard(OnboardingResponse);
const isProviderInfo = guard(ProviderInfo);
const isRun = guard(Run);
const isSettingsData = guard(SettingsData);
const isConfiguredModel = guard(ConfiguredModel);

const timestamp = "2026-08-16T00:00:00Z";
const conversation = {
	id: "conversation-1",
	title: "Conversation",
	created: timestamp,
	modified: timestamp,
	messageCount: 1,
	firstMessage: "Hello",
};
const provider = {
	id: "provider-1",
	name: "Provider",
	source: "builtin",
	added: true,
	authMethods: [{ type: "api_key", name: "Provider API key" }],
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
const run = {
	id: "run-1",
	conversationId: "conversation-1",
	triggerEntryId: "entry-1",
	executorProfile: "pi-default",
	title: "Direct run",
	status: "running",
	artifacts: [],
	evidence: [],
	startedAt: timestamp,
	completedAt: timestamp,
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
			"created",
			"modified",
			"messageCount",
			"firstMessage",
		]);
		expectRequiredFields(isProviderInfo, provider, [
			"id",
			"name",
			"authMethods",
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
		expectRequiredFields(isRun, run, [
			"id",
			"conversationId",
			"triggerEntryId",
			"executorProfile",
			"title",
			"status",
			"artifacts",
			"evidence",
		]);
		expect(isRun({ ...run, startedAt: 3 })).toBe(false);
		expect(isRun({ ...run, completedAt: 3 })).toBe(false);
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
				decisions: { relationship_memory_enabled: true },
			},
		};
		expect(isOnboardingData(onboarding)).toBe(true);
		expect(isOnboardingData({ ...onboarding, status: "unknown" })).toBe(false);
		expect(isOnboardingData({ ...onboarding, eventSeq: -1 })).toBe(false);
		expect(isOnboardingData({ ...onboarding, eventSeq: 1.5 })).toBe(false);
		expect(isOnboardingData({ ...onboarding, currentStepId: 3 })).toBe(false);
		expect(isOnboardingData({ ...onboarding, stateData: {} })).toBe(false);

		const settings = {
			firstRunStage: "model" as const,
			relationshipMemoryEnabled: true,
			networkProxy: { mode: "direct" as const },
			memoryVectorService: { enabled: false, provider: "none" as const },
			modelDownloadSource: { type: "official" },
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
				theme: { ...valid.theme, tokens: { ...valid.theme.tokens, text: null } },
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
				description: "An inline image.",
				use_when: "When the image helps.",
				loop: false,
				url: "data:image/png;base64,aW1hZ2U=",
			},
			{
				id: "ambient_audio",
				kind: "audio",
				label: "Ambient audio",
				description: "An audio record.",
				use_when: "When the audio helps.",
				loop: true,
				url: "data:audio/mpeg;base64,YXVkaW8=",
				captionsUrl: "data:text/vtt;base64,V0VCVlRU",
			},
			{
				id: "dialog_video",
				kind: "video",
				label: "Dialog video",
				description: "A video record.",
				use_when: "When the video helps.",
				loop: false,
				url: "data:video/mp4;base64,dmlkZW8=",
				captionsUrl: "data:text/vtt;base64,V0VCVlRU",
			},
		] as const;
		const mediaCharacter = {
			...valid,
			media,
		};
		expect(isCharacterDisplay(mediaCharacter)).toBe(true);
		expect(
			isCharacterDisplay({
				...valid,
				media: [{ ...media[0], description: undefined }],
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...mediaCharacter,
				media: [{ ...media[0], presentation: "ambient" }],
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...mediaCharacter,
				media: [{ ...media[0], unknown: true }],
			}),
		).toBe(false);
		expect(
			isCharacterDisplay({
				...mediaCharacter,
				media: [{ ...media[0], use_when: "" }],
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
