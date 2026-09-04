import type { CompanionClient } from "@bear-harness/companion-client";
import { type ProductConfig, productConfig } from "@bear-harness/product-config";
import type {
	ConversationDetail,
	ConversationSummary,
	EmbeddingDownloadState,
	LivePush,
	ProviderLoginResponse,
} from "@bear-harness/protocol";
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
		greeting: "Hello",
		composer_placeholder: "Message",
		correction: {
			trigger_label: "Correct",
			reason_group_label: "Reason",
			presets: [{ id: "voice", label: "Voice" }],
			custom_label: "Other",
			custom_placeholder: "What was wrong?",
		},
		first_meeting: {
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
		},
	},
	prompt: {
		description: "Test description",
		personality: "Test personality",
		scenario: "Test scenario",
		system_prompt: "Test system prompt",
	},
	scenes: [{ id: "default", label: "Default", description: "Default scene" }],
	visual: {
		defaultSceneId: "default",
		defaultExpressionId: "default",
		avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+",
		expressions: { default: "data:image/svg+xml;base64,PHN2Zy8+" },
		expressionLabels: { default: "Test Character" },
	},
	media: [],
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
	firstRunStage: "role",
	relationshipMemoryEnabled: false,
	networkProxy: { mode: "direct" },
	memoryVectorService: { enabled: false, provider: "none" },
	modelDownloadSource: { type: "official" },
};
/** Minimal raw embedding binding for partial CompanionStore fixtures. */
export function createEmbeddingBinding() {
	return {
		downloadState: () => ({ status: "idle", downloadedBytes: 0 }),
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
					{ id: "test-embedding", name: "Test embedding", dimensions: 768, isDefault: true },
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
 * creation and opening additionally return a Pi-native detail for renderer-local selection.
 * the invalidation stream parks on a promise that never settles — tests never
 * race polling timers and the loop dies with the
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

	/** Pi sessions created by the fixture. */
	const conversations: ConversationSummary[] = [];
	const conversationList = vi.fn(() => ok({ conversations: [...conversations] }));
	const conversationDetails = new Map<string, ConversationDetail>();
	const conversationProjection = (id: string, title: string): ConversationDetail => ({
		conversationId: id,
		name: title,
		branch: { entries: [], hasMoreBefore: false },
		live: { isStreaming: false, pendingToolCallIds: [], steering: [], followUp: [] },
	});
	const providerList = vi.fn(() => ok({ providers: [] }));
	const liveQueue: LivePush[] = [];
	let receiveLive: ((event: LivePush) => void) | undefined;
	const piStream = async function* (signal: AbortSignal) {
		while (!signal.aborted) {
			const event =
				liveQueue.shift() ??
				(await new Promise<LivePush | undefined>((resolve) => {
					const abort = () => {
						if (receiveLive === deliver) receiveLive = undefined;
						resolve(undefined);
					};
					const deliver = (next: LivePush) => {
						signal.removeEventListener("abort", abort);
						resolve(next);
					};
					receiveLive = deliver;
					signal.addEventListener("abort", abort, { once: true });
				}));
			if (!event || signal.aborted) return;
			yield event;
		}
	};

	const snapshotGet = vi.fn(() =>
		ok({
			onboarding: {
				status: "complete" as const,
				stateData: { answers: {}, decisions: {} },
			},
			character: THEMED_CHARACTER,
		}),
	);
	const client = {
		live: { subscribe: async (signal: AbortSignal) => piStream(signal) },
		invalidations: { stream: async function* () {} },
		snapshot: {
			get: snapshotGet,
		},
		character: {
			get: vi.fn(() => ok(null)),
			list: vi.fn(() => ok({ characters: [] })),
			activate: vi.fn(() => ok(null)),
			deletionStatusGet: vi.fn(({ characterId }: { characterId: string }) =>
				ok({
					status: {
						characterId,
						active: characterId === THEMED_CHARACTER.id,
						default: false,
						runtimePresent: true,
						packagePresent: true,
					},
				}),
			),
			runtimeDelete: vi.fn(({ characterId }: { characterId: string }) =>
				ok({ characterId, target: "runtime" as const, deleted: true }),
			),
			packageDelete: vi.fn(({ characterId }: { characterId: string }) =>
				ok({ characterId, target: "package" as const, deleted: true }),
			),
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
		companionState: {
			get: vi.fn(() =>
				ok({
					schema: { type: "object", properties: {} },
					state: {
						character: {
							document: {},
							revisions: { conversation: 0, global: 0 },
						},
						display: { sceneId: "default", expressionId: "default" },
						revisions: { display: 0 },
					},
				}),
			),
			patch: vi.fn(() => ok({})),
		},
		events: { subscribe: vi.fn(() => new Promise<never>(() => {})) },
		onboarding: {
			get: vi.fn(() =>
				ok({
					status: "complete",
					stateData: { answers: {}, decisions: {} },
				}),
			),
			submit: vi.fn(() =>
				ok({
					status: "complete",
					stateData: { answers: {}, decisions: {} },
				}),
			),
		},
		conversation: {
			list: conversationList,
			create: vi.fn(({ title }: { title?: string }) => {
				// The renderer activates the returned detail, so register it in the list too.
				let summary = conversations.find((conversation) => conversation.conversationId === "c1");
				if (summary === undefined) {
					summary = {
						conversationId: "c1",
						name: title ?? "New conversation",
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-01T00:00:00.000Z",
						messageCount: 0,
						firstMessage: "",
						isStreaming: false,
					};
					conversations.push(summary);
				} else if (title !== undefined) {
					summary.name = title;
				}
				const detail = conversationProjection("c1", summary.name ?? summary.firstMessage);
				conversationDetails.set(detail.conversationId, detail);
				return ok(detail);
			}),
			open: vi.fn(({ conversationId }: { conversationId: string }) => {
				let conversation = conversations.find((item) => item.conversationId === conversationId);
				if (conversation === undefined) {
					conversation = {
						conversationId,
						name: "New conversation",
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-01T00:00:00.000Z",
						messageCount: 0,
						firstMessage: "",
						isStreaming: false,
					};
					conversations.push(conversation);
				}
				const detail =
					conversationDetails.get(conversationId) ??
					conversationProjection(conversationId, conversation.name ?? conversation.firstMessage);
				conversationDetails.set(conversationId, detail);
				return ok(detail);
			}),
			rename: vi.fn(({ conversationId, title }: { conversationId: string; title: string }) => {
				const conversation = conversations.find((item) => item.conversationId === conversationId);
				if (conversation !== undefined) conversation.name = title;
				const detail = conversationDetails.get(conversationId);
				if (detail) conversationDetails.set(conversationId, { ...detail, name: title });
				return ok(null);
			}),
			archive: vi.fn(
				({ conversationId, archived }: { conversationId: string; archived: boolean }) => {
					if (archived) {
						const index = conversations.findIndex(
							(conversation) => conversation.conversationId === conversationId,
						);
						if (index >= 0) conversations.splice(index, 1);
					}
					return ok({});
				},
			),
			delete: vi.fn(({ conversationId }: { conversationId: string }) => {
				const index = conversations.findIndex(
					(conversation) => conversation.conversationId === conversationId,
				);
				if (index >= 0) conversations.splice(index, 1);
				conversationDetails.delete(conversationId);
				return ok({});
			}),
		},
		message: {
			send: vi.fn(() => ok({})),
			regenerate: vi.fn(({ conversationId }) => ok(conversationDetails.get(conversationId)!)),
			switchVersion: vi.fn(({ conversationId }) => ok(conversationDetails.get(conversationId)!)),
			edit: vi.fn(({ conversationId }) => ok(conversationDetails.get(conversationId)!)),
			continue: vi.fn(() => ok({})),
			branch: vi.fn(() => {
				const detail = conversationProjection("branch-1", "Branched conversation");
				conversationDetails.set(detail.conversationId, detail);
				conversations.push({
					conversationId: detail.conversationId,
					name: detail.name,
					created: "2026-01-01T00:00:00.000Z",
					modified: "2026-01-01T00:00:00.000Z",
					messageCount: 0,
					firstMessage: "",
					isStreaming: false,
				});
				return ok(detail);
			}),
			abort: vi.fn(() => ok({})),
		},
		memory: {
			localEmbeddingDownloadStatus: vi.fn(() => ok({ status: "preparing", downloadedBytes: 0 })),
			cancelLocalEmbeddingDownload: vi.fn(() => ok({})),
			configureLocalEmbedding: vi.fn(() => ok({ ready: true })),
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
					onboardingComplete: true,
				}),
			),
			defaultsSetReply: vi.fn(({ reply }) =>
				ok({
					...(reply ? { reply } : {}),
					vision: { mode: "auto" as const },
					onboardingComplete: reply !== null,
				}),
			),
			defaultsSetVision: vi.fn((vision) => ok({ vision, onboardingComplete: true })),
			systemDefaultsGet: vi.fn(() =>
				ok({
					reply: { providerId: DEFAULT_MODEL.providerId, modelId: DEFAULT_MODEL.modelId },
					vision: { mode: "auto" as const },
				}),
			),
			systemDefaultsSet: vi.fn(({ reply, vision }) => ok({ reply, vision })),
			defaultsInitialize: vi.fn(() =>
				ok({
					reply: { providerId: DEFAULT_MODEL.providerId, modelId: DEFAULT_MODEL.modelId },
					vision: { mode: "auto" as const },
					onboardingComplete: false,
				}),
			),
			defaultsCompleteOnboarding: vi.fn(() =>
				ok({
					reply: { providerId: DEFAULT_MODEL.providerId, modelId: DEFAULT_MODEL.modelId },
					vision: { mode: "auto" as const },
					onboardingComplete: true,
				}),
			),
			routeGet: vi.fn(({ conversationId }) => ok({ conversationId })),
			routeSet: vi.fn(({ conversationId, selected }) => ok({ conversationId, selected })),
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
			read: vi.fn(({ artifactId, offset = 0 }) =>
				ok({
					artifact: {
						id: artifactId,
						name: artifactId,
						mime: "text/plain",
						bytes: 0,
						sha256: "0".repeat(64),
						status: "verified" as const,
						createdAt: "2026-08-31T00:00:00.000Z",
					},
					offset,
					nextOffset: offset,
					eof: true,
					base64: "",
				}),
			),
			open: vi.fn(() => ok({ outcome: "completed" as const })),
			reveal: vi.fn(() => ok({ outcome: "completed" as const })),
			saveAs: vi.fn(() => ok({ outcome: "completed" as const })),
		},
		externalAgent: {
			discoverCodex: vi.fn(() => ok({ candidates: [] })),
			connectCodex: vi.fn(() => ok({ profileId: "codex-1", version: "1.0.0", hash: "hash" })),
			status: vi.fn(() =>
				ok({
					pi: { available: true as const, profileId: "pi-default" as const },
					codex: { available: false as const },
				}),
			),
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
						{ id: "test-embedding", name: "Test embedding", dimensions: 768, isDefault: true },
					],
				}),
			),
		},
	} as CompanionClient;

	const queue: Array<{ keys: Array<["snapshot"]> }> = [];
	let receive: ((value: { keys: Array<["snapshot"]> } | undefined) => void) | undefined;
	client.invalidations.stream = async function* (signal) {
		while (!signal.aborted) {
			const notice =
				queue.shift() ??
				(await new Promise<{ keys: Array<["snapshot"]> } | undefined>((resolve) => {
					receive = resolve;
					signal.addEventListener("abort", () => resolve(undefined), { once: true });
				}));
			if (signal.aborted) return;
			if (notice) yield notice;
		}
	};
	HOST_EVENT_SENDERS.set(client, (kind, payload) => {
		const event: LivePush =
			kind === "memory.embedding_download_changed"
				? {
						type: "embeddingDownload",
						state: payload as EmbeddingDownloadState,
					}
				: {
						type: "providerLogin",
						providerId: String(payload.providerId),
						state: payload as ProviderLoginResponse,
					};
		const deliver = receiveLive;
		if (deliver) {
			receiveLive = undefined;
			deliver(event);
		} else liveQueue.push(event);
	});
	PI_EVENT_SENDERS.set(client, (event) => {
		if (receiveLive) {
			const deliver = receiveLive;
			receiveLive = undefined;
			deliver(event);
		} else liveQueue.push(event);
	});

	return {
		client,
		settings: () => settings,
		settingsGet,
		settingsSet,
		conversationList,
		providerList,
	};
}

const HOST_EVENT_SENDERS = new WeakMap<
	CompanionClient,
	(kind: string, payload: Record<string, unknown>) => void
>();
export function pushHostEvent(
	client: CompanionClient,
	kind: string,
	payload: Record<string, unknown>,
): void {
	const send = HOST_EVENT_SENDERS.get(client);
	if (!send) throw new Error("missing fixture event channel");
	send(kind, payload);
}

const PI_EVENT_SENDERS = new WeakMap<CompanionClient, (event: LivePush) => void>();
export function pushPiEvent(client: CompanionClient, event: LivePush): void {
	const send = PI_EVENT_SENDERS.get(client);
	if (!send) throw new Error("client does not expose the Pi event test channel");
	send(event);
}
