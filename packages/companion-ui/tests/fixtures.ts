import type { CompanionClient } from "@bear-harness/companion-client";
import { type ProductConfig, productConfig } from "@bear-harness/product-config";
import type {
	ConversationDetail,
	ConversationSummary,
	PiSessionLiveEvent,
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

	/** Pi sessions created by the fixture. */
	const conversations: ConversationSummary[] = [];
	const conversationList = vi.fn(() => ok({ sessions: [...conversations] }));
	const conversationDetails = new Map<string, ConversationDetail>();
	const conversationProjection = (id: string, title: string): ConversationDetail => ({
		sessionId: id,
		name: title,
		timeline: { entries: [] },
		live: { isStreaming: false, queuedUserMessages: [] },
	});
	const providerList = vi.fn(() => ok({ providers: [] }));
	const piQueue: PiSessionLiveEvent[] = [];
	let receivePi: ((event: PiSessionLiveEvent) => void) | undefined;
	const piStream = async function* (signal: AbortSignal) {
		while (!signal.aborted) {
			const event =
				piQueue.shift() ??
				(await new Promise<PiSessionLiveEvent | undefined>((resolve) => {
					const abort = () => {
						if (receivePi === deliver) receivePi = undefined;
						resolve(undefined);
					};
					const deliver = (next: PiSessionLiveEvent) => {
						signal.removeEventListener("abort", abort);
						resolve(next);
					};
					receivePi = deliver;
					signal.addEventListener("abort", abort, { once: true });
				}));
			if (!event || signal.aborted) return;
			yield event;
		}
	};

	const snapshotGet = vi.fn(() =>
		ok({
			eventSeq: 0,
			model: {
				pool: { models: [DEFAULT_MODEL] },
				defaults: {
					reply: { providerId: DEFAULT_MODEL.providerId, modelId: DEFAULT_MODEL.modelId },
					vision: { mode: "auto" as const },
					onboardingComplete: true,
				},
			},
		}),
	);
	const client = {
		pi: { stream: piStream },
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
					eventSeq: 0,
					stateData: { answers: {}, decisions: {} },
				}),
			),
			submit: vi.fn(() =>
				ok({
					status: "complete",
					eventSeq: 0,
					stateData: { answers: {}, decisions: {} },
				}),
			),
		},
		conversation: {
			list: conversationList,
			create: vi.fn(({ title }: { title?: string }) => {
				// The renderer activates the returned detail, so register it in the list too.
				let summary = conversations.find((conversation) => conversation.id === "c1");
				if (summary === undefined) {
					summary = {
						id: "c1",
						title: title ?? "New conversation",
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-01T00:00:00.000Z",
						messageCount: 0,
						firstMessage: "",
					};
					conversations.push(summary);
				} else if (title !== undefined) {
					summary.title = title;
				}
				const detail = conversationProjection("c1", summary.title);
				conversationDetails.set(detail.sessionId, detail);
				return ok(detail);
			}),
			open: vi.fn(({ id }: { id: string }) => {
				let conversation = conversations.find((item) => item.id === id);
				if (conversation === undefined) {
					conversation = {
						id,
						title: "New conversation",
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-01T00:00:00.000Z",
						messageCount: 0,
						firstMessage: "",
					};
					conversations.push(conversation);
				}
				const detail =
					conversationDetails.get(id) ?? conversationProjection(id, conversation.title);
				conversationDetails.set(id, detail);
				return ok(detail);
			}),
			rename: vi.fn(({ id, title }: { id: string; title: string }) => {
				const conversation = conversations.find((item) => item.id === id);
				if (conversation !== undefined) conversation.title = title;
				const detail = conversationDetails.get(id);
				if (detail) conversationDetails.set(id, { ...detail, name: title });
				return ok(null);
			}),
			archive: vi.fn(({ id, archived }: { id: string; archived: boolean }) => {
				if (archived) {
					const index = conversations.findIndex((conversation) => conversation.id === id);
					if (index >= 0) conversations.splice(index, 1);
				}
				return ok({});
			}),
			delete: vi.fn(({ id }: { id: string }) => {
				const index = conversations.findIndex((conversation) => conversation.id === id);
				if (index >= 0) conversations.splice(index, 1);
				conversationDetails.delete(id);
				return ok({});
			}),
		},
		message: {
			send: vi.fn(() => ok({ accepted: true as const })),
			regenerate: vi.fn(() => ok({})),
			switchVersion: vi.fn(() => ok({})),
			edit: vi.fn(() => ok({})),
			continue: vi.fn(() => ok({})),
			branch: vi.fn(() => {
				const detail = conversationProjection("branch-1", "Branched conversation");
				conversationDetails.set(detail.sessionId, detail);
				conversations.push({
					id: detail.sessionId,
					title: detail.name,
					created: "2026-01-01T00:00:00.000Z",
					modified: "2026-01-01T00:00:00.000Z",
					messageCount: 0,
					firstMessage: "",
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

	// Legacy replay tests feed controlled batches; the default fixture is a push queue.
	const queue: Array<{ events: import("@bear-harness/protocol").DomainEvent[] }> = [];
	let receive: ((value: ReturnType<typeof queue.shift>) => void) | undefined;
	let seq = 0;
	client.events.subscribe = vi.fn(async () => {
		const batch =
			queue.shift() ??
			(await new Promise<ReturnType<typeof queue.shift>>((resolve) => {
				receive = resolve;
			}));
		return { ok: true as const, data: batch ?? { events: [] } };
	});
	client.events.stream = async function* (afterSeq, signal) {
		while (!signal.aborted) {
			const response = await client.events.subscribe({ afterSeq });
			if (!response.ok) throw new Error("fixture event failure");
			if (signal.aborted) return;
			yield response.data.events;
			if (!response.data.events.length) {
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				return;
			}
			afterSeq = response.data.events.at(-1)?.seq ?? afterSeq;
		}
	};
	HOST_EVENT_SENDERS.set(client, (kind, payload) => {
		const batch = { events: [{ seq: ++seq, kind, payload }] };
		if (receive) {
			const deliver = receive;
			receive = undefined;
			deliver(batch);
		} else queue.push(batch);
	});
	PI_EVENT_SENDERS.set(client, (event) => {
		if (receivePi) {
			const deliver = receivePi;
			receivePi = undefined;
			deliver(event);
		} else piQueue.push(event);
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

const PI_EVENT_SENDERS = new WeakMap<
	CompanionClient,
	(event: import("@bear-harness/protocol").PiSessionLiveEvent) => void
>();
export function pushPiEvent(
	client: CompanionClient,
	event: import("@bear-harness/protocol").PiSessionLiveEvent,
): void {
	const send = PI_EVENT_SENDERS.get(client);
	if (!send) throw new Error("client does not expose the Pi event test channel");
	send(event);
}
