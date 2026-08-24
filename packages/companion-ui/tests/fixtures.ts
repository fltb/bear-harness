import type { CompanionClient } from "@bear-harness/companion-client";
import { type ProductConfig, productConfig } from "@bear-harness/product-config";
import type { ConversationSelectResponse, ConversationSummary } from "@bear-harness/protocol";
import { vi } from "vitest";
import type { CharacterDisplay, SettingsData } from "../src/index.js";

/** The official product config as shipped. */
export const OFFICIAL_PRODUCT: Readonly<ProductConfig> = productConfig;

export const THEMED_CHARACTER: CharacterDisplay = {
	id: "test-character",
	name: "Test Character",
	language: "ja-JP",
	theme: {
		radius: { sm: 3, md: 5, lg: 7 },
		tokens: {
			canvas: "#101820",
			surface: "#18242d",
			surface_raised: "#22313d",
			surface_interactive: "#2b3d4a",
			surface_selected: "#174853",
			text: "#f3f6f5",
			text_muted: "#a8b6b2",
			text_on_accent: "#081c19",
			accent: "#42c7a5",
			accent_hover: "#6ee0c3",
			border: "#395048",
			border_focus: "#6ee0c3",
			success: "#6ee0c3",
			warning: "#f2c56b",
			danger: "#ef6b73",
		},
		font: { body: "system-ui", heading: "serif" },
	},
	character: {
		subtitle: "Test subtitle",
		scene_title: "Test scene",
		greeting: "Hello",
		composer_placeholder: "Message",
		correction: { trigger_label: "Correct", reason_group_label: "Reason" },
		first_meeting: {
			version: 1,
			step_label: "Step",
			dialog_label: "Introduction",
			error_prefix: "Error",
			steps: [
				{
					id: "hello",
					kind: "acknowledge",
					heading: "Hello",
					body: "Welcome",
					submit_label: "Continue",
				},
			],
			completion: { conversation_title: "Test conversation" },
		},
	},
	prompt: {
		description: "Test description",
		personality: "Test personality",
		scenario: "Test scenario",
		system_prompt: "Test system prompt",
		mes_example: "",
	},
	scenes: [{ id: "default", label: "Default", description: "Default scene" }],
	visual: {
		defaultSceneId: "default",
		defaultExpressionId: "default",
		avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+",
		expressions: { default: "data:image/svg+xml;base64,PHN2Zy8+" },
		expressionLabels: { default: "Test Character" },
	},
	roleplay: {
		variables: [],
		media: [],
		unlockables: [],
		choice_sets: [],
	},
};

/** Character projection with declared regular and ambient roleplay media. */
export const ROLEPLAY_MEDIA_CHARACTER: CharacterDisplay = {
	...THEMED_CHARACTER,
	roleplay: {
		...THEMED_CHARACTER.roleplay,
		media: [
			{
				id: "dialog-image",
				kind: "image",
				label: "Dialog image",
				presentation: "dialog",
				url: "data:image/png;base64,ZGlhbG9n",
				loop: false,
			},
			{
				id: "inline-image",
				kind: "image",
				label: "Inline image",
				presentation: "inline",
				url: "data:image/png;base64,aW5saW5l",
				loop: false,
			},
			{
				id: "ambient-audio",
				kind: "audio",
				label: "Ambient audio",
				presentation: "ambient",
				url: "data:audio/ogg;base64,YW1iaWVudA==",
				captionsUrl: "data:text/vtt;base64,V0VCVlRU",
				loop: true,
			},
		],
	},
};

/**
 * A complete fork fixture: different identity fields, data directory,
 * executable, character and brand modification declaration. The generic
 * validator accepts this config (verified in the config tests).
 */
export const FORK_PRODUCT: Readonly<ProductConfig> = {
	productName: "North Companion",
	appId: "io.example.north-companion",
	dataDirectoryName: "north-companion",
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	executableName: "north-companion",
	defaultCharacterId: "beixing",
	brandLicense: {
		spdx: "CC-BY-SA-4.0",
		workTitle: "North Companion Brand Assets",
		creator: "North Studio",
		attribution: "North Studio — North Companion Brand Assets",
		sourceUrl: "https://example.com/north-companion",
		modified: true,
		modificationNotice:
			"Renamed app, character replaced with 北星; UI copy adapted for the North Companion release.",
	},
	icon: null,
};

const DEFAULT_SETTINGS: SettingsData = {
	relationshipMemoryEnabled: false,
	conversationHistoryReadEnabled: false,
	networkProxy: { mode: "direct" },
	memoryVectorService: { enabled: false, provider: "none" },
	modelDownloadMirror: {},
};
/** Minimal raw embedding binding for partial CompanionStore fixtures. */
export function createEmbeddingBinding() {
	return {
		settingsQuery: {
			data: { settings: { ...DEFAULT_SETTINGS } },
			isPending: false,
			error: null,
		},
		capabilitiesQuery: {
			data: {
				networkProxyModes: [{ id: "direct" }, { id: "auto" }, { id: "manual" }],
				memoryVectorProviders: [
					{ id: "none", onboarding: true },
					{ id: "local", onboarding: true },
					{ id: "remote", onboarding: false },
				],
				memoryVectorPresets: [],
				localEmbeddingCandidates: [
					{ id: "test-embedding", name: "Test embedding", isDefault: true },
				],
			},
			isPending: false,
			error: null,
		},
		settingsMutation: {
			mutateAsync: vi.fn(async () => ({ ok: true })),
			isPending: false,
			error: null,
			isSuccess: false,
		},
		localConfigureMutation: {
			mutateAsync: vi.fn(async () => ({ ready: true })),
			isPending: false,
			error: null,
			isSuccess: false,
		},
	};
}

const DEFAULT_MODEL = {
	providerId: "test-provider",
	modelId: "test-model",
	label: "Test Model",
	supportsImages: true,
	createdAt: "2026-01-01 00:00:00",
};

/**
 * Minimal deterministic `CompanionClient` fixture matching the public
 * interface of `@bear-harness/companion-client`.
 *
 * Most calls resolve a success envelope with empty domain data, so the store
 * boots into the same idle shell a missing bridge used to produce; conversation
 * creation and selection additionally expose the Host-owned active projection.
 * `events.subscribe` parks the subscription loop on a promise that never
 * settles — tests never race polling timers and the loop dies with the
 * store's cleanup. `settings.set` mutates the backing settings so the
 * follow-up `settings.get` re-read reflects the patch, mirroring the host's
 * canonical-settings contract.
 */
export function createTestClient() {
	let settings = { ...DEFAULT_SETTINGS };

	const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

	const settingsGet = vi.fn(() => ok({ settings }));
	const settingsSet = vi.fn(async ({ settings: patch }: { settings: Record<string, unknown> }) => {
		const next: Record<string, unknown> = { ...settings };
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete next[key];
			else next[key] = value;
		}
		settings = next as unknown as SettingsData;
		return ok({ settings });
	});

	/** Conversations the fixture has created; kept in sync so an active
	 *  conversation id always has a matching list entry. */
	const conversations: ConversationSummary[] = [];
	let activeConversation: ConversationSelectResponse | undefined;
	const conversationList = vi.fn(() => ok({ conversations: [...conversations] }));
	const conversationProjection = (
		id: string,
		title: string,
		sceneTitle: string,
	): ConversationSelectResponse => ({
		activeConversationId: id,
		id,
		title,
		sceneTitle,
		piTimeline: { entries: [] },
		piSessionId: `${id}-session`,
		piLiveState: { isStreaming: false },
	});
	const providerList = vi.fn(() => ok({ providers: [] }));

	const snapshotGet = vi.fn(() =>
		ok({
			eventSeq: 0,
			...(activeConversation
				? {
						conversation: {
							activeConversationId: activeConversation.activeConversationId,
							piTimeline: activeConversation.piTimeline,
						},
					}
				: {}),
			model: {
				pool: { models: [DEFAULT_MODEL] },
				defaults: {
					reply: { providerId: DEFAULT_MODEL.providerId, modelId: DEFAULT_MODEL.modelId },
					vision: { mode: "auto" as const },
				},
			},
		}),
	);
	const client = {
		snapshot: {
			get: snapshotGet,
		},
		character: {
			get: vi.fn(() => ok(null)),
			list: vi.fn(() => ok({ characters: [] })),
			activate: vi.fn(() => ok(null)),
			pluginTrustGet: vi.fn(() =>
				ok({
					trust: {
						origin: "official" as const,
						pluginHash: "",
						pluginsPresent: false,
						trusted: true,
					},
				}),
			),
			pluginTrustConfirm: vi.fn(() => ok(null)),
		},
		roleplay: {
			get: vi.fn(() => ok({ state: { values: {}, unlocked: [] } })),
			trigger: vi.fn(() => ok({ state: { values: {}, unlocked: [] } })),
			resetUnlocks: vi.fn(() => ok({})),
			dismissMedia: vi.fn(() => ok({})),
		},
		events: { subscribe: vi.fn(() => new Promise<never>(() => {})) },
		onboarding: {
			get: vi.fn(() =>
				ok({
					status: "complete",
					eventSeq: 0,
					stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
				}),
			),
			submit: vi.fn(() =>
				ok({
					status: "complete",
					eventSeq: 0,
					stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
				}),
			),
		},
		conversation: {
			list: conversationList,
			create: vi.fn(({ title }: { title?: string }) => {
				// The store activates the returned projection, so register it in the
				// list the fixture serves back — an active conversation must be listed.
				let summary = conversations.find((conversation) => conversation.id === "c1");
				if (summary === undefined) {
					summary = {
						id: "c1",
						title: title ?? "New conversation",
						sceneTitle: "",
						unread: false,
						updatedAt: "2026-01-01T00:00:00.000Z",
					};
					conversations.push(summary);
				} else if (title !== undefined) {
					summary.title = title;
				}
				activeConversation = conversationProjection("c1", summary.title, summary.sceneTitle);
				return ok(activeConversation);
			}),
			select: vi.fn(({ id }: { id: string }) => {
				let conversation = conversations.find((item) => item.id === id);
				if (conversation === undefined) {
					conversation = {
						id,
						title: "New conversation",
						sceneTitle: "",
						unread: false,
						updatedAt: "2026-01-01T00:00:00.000Z",
					};
					conversations.push(conversation);
				}
				activeConversation = conversationProjection(
					id,
					conversation.title,
					conversation.sceneTitle,
				);
				return ok(activeConversation);
			}),
			activeGet: vi.fn(() =>
				ok(activeConversation === undefined ? {} : { conversation: activeConversation }),
			),
			rename: vi.fn(({ id, title }: { id: string; title: string }) => {
				const conversation = conversations.find((item) => item.id === id);
				if (conversation !== undefined) conversation.title = title;
				if (activeConversation?.id === id) {
					activeConversation = { ...activeConversation, title };
				}
				return ok(null);
			}),
			archive: vi.fn(({ id, archived }: { id: string; archived: boolean }) => {
				if (archived) {
					const index = conversations.findIndex((conversation) => conversation.id === id);
					if (index >= 0) conversations.splice(index, 1);
					if (activeConversation?.id === id) {
						const replacement = conversations.at(-1);
						activeConversation =
							replacement === undefined
								? undefined
								: conversationProjection(replacement.id, replacement.title, replacement.sceneTitle);
					}
				}
				return ok({});
			}),
			delete: vi.fn(({ id }: { id: string }) => {
				const index = conversations.findIndex((conversation) => conversation.id === id);
				if (index >= 0) conversations.splice(index, 1);
				if (activeConversation?.id === id) {
					const replacement = conversations.at(-1);
					activeConversation =
						replacement === undefined
							? undefined
							: conversationProjection(replacement.id, replacement.title, replacement.sceneTitle);
				}
				return ok({});
			}),
		},
		message: {
			send: vi.fn(() => ok({ accepted: true as const, sessionId: "session-1" })),
			regenerate: vi.fn(() => ok(null)),
			switchVersion: vi.fn(() => ok(null)),
			edit: vi.fn(() => ok(null)),
			continue: vi.fn(() => ok(null)),
			correct: vi.fn(() => ok(null)),
			branch: vi.fn(() => ok({ leafId: "leaf-1" })),
			abort: vi.fn(() => ok(null)),
		},
		memory: {
			search: vi.fn(() => ok({ entries: [] })),
			list: vi.fn(() => ok({ entries: [] })),
			capture: vi.fn(({ entryId }: { entryId: string }) =>
				ok({
					memoryId: `memory-${entryId}`,
					sourceEntryId: entryId,
					createdBy: "user_capture" as const,
				}),
			),
			edit: vi.fn(() => ok(null)),
			exclude: vi.fn(() => ok(null)),
			invalidate: vi.fn(() => ok({})),
			pin: vi.fn(() => ok(null)),
			forget: vi.fn(() => ok(null)),
			configureLocalEmbedding: vi.fn(() => ok({ ready: true })),
			candidateApprove: vi.fn(() => ok(null)),
			candidatesList: vi.fn(() => ok({ candidates: [] })),
			candidateReject: vi.fn(() => ok(null)),
		},
		canon: {
			listSources: vi.fn(() => ok({ sources: [] })),
			addSource: vi.fn(() => ok(null)),
			search: vi.fn(() => ok({ chunks: [] })),
			removeSource: vi.fn(() => ok(null)),
			listModules: vi.fn(() => ok({ modules: [] })),
			upsertModule: vi.fn(() => ok(null)),
			deleteModule: vi.fn(() => ok(null)),
		},
		provider: {
			list: providerList,
			customUpsert: vi.fn(() => ok(null)),
			overrideBaseUrl: vi.fn(() => ok(null)),
			setApiKey: vi.fn(() => ok(null)),
			login: vi.fn(() => ok({ providerId: "test", status: "completed" })),
			loginStatus: vi.fn(() => ok({ providerId: "test", status: "completed" })),
			loginAnswer: vi.fn(() => ok({ providerId: "test", status: "running" })),
			loginCancel: vi.fn(() => ok(null)),
			logout: vi.fn(() => ok(null)),
			remove: vi.fn(() => ok(null)),
		},
		model: {
			poolGet: vi.fn(() => ok({ models: [DEFAULT_MODEL] })),
			enable: vi.fn(() => ok(null)),
			disable: vi.fn(() => ok(null)),
			defaultsGet: vi.fn(() =>
				ok({
					reply: { providerId: DEFAULT_MODEL.providerId, modelId: DEFAULT_MODEL.modelId },
					vision: { mode: "auto" as const },
				}),
			),
			defaultsSetReply: vi.fn(({ reply }) =>
				ok({ ...(reply ? { reply } : {}), vision: { mode: "auto" as const } }),
			),
			defaultsSetVision: vi.fn((vision) => ok({ vision })),
			routeGet: vi.fn(({ conversationId }) => ok({ conversationId })),
			routeSet: vi.fn(({ conversationId, selected }) => ok({ conversationId, selected })),
		},
		commission: {
			list: vi.fn(() => ok({ commissions: [] })),
			draft: vi.fn(() => ok({ commissionId: "c1", draftHash: "h" })),
			approve: vi.fn(() => ok(null)),
			reject: vi.fn(() => ok(null)),
			launch: vi.fn(() => ok({ commissionId: "c1", draftHash: "h" })),
		},
		run: {
			list: vi.fn(() => ok({ runs: [] })),
			steer: vi.fn(() => ok(null)),
			interrupt: vi.fn(() => ok(null)),
			resume: vi.fn(() => ok(null)),
			cancel: vi.fn(() => ok(null)),
			respondPermission: vi.fn(() => ok(null)),
		},
		artifact: {
			list: vi.fn(() => ok({ artifacts: [] })),
			read: vi.fn(() => ok({ logicalName: "result.txt", mime: "text/plain", base64: "" })),
		},
		settings: {
			get: settingsGet,
			set: settingsSet,
			capabilitiesGet: vi.fn(() =>
				ok({
					networkProxyModes: [{ id: "direct" }, { id: "auto" }, { id: "manual" }],
					memoryVectorProviders: [
						{ id: "none", onboarding: true },
						{ id: "local", onboarding: true },
						{ id: "remote", onboarding: false },
					],
					memoryVectorPresets: [],
					localEmbeddingCandidates: [
						{ id: "test-embedding", name: "Test embedding", isDefault: true },
					],
				}),
			),
		},
	} as CompanionClient;

	return {
		client,
		settings: () => settings,
		settingsGet,
		settingsSet,
		conversationList,
		providerList,
	};
}
