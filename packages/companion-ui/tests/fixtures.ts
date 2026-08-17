import type { CompanionClient } from "@bear-harness/companion-client";
import { type ProductConfig, productConfig } from "@bear-harness/product-config";
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
		color: {
			surface: "#101820",
			surface_alt: "#18242d",
			text: "#f3f6f5",
			text_muted: "#a8b6b2",
			accent: "#42c7a5",
			line: "#395048",
			danger: "#ef6b73",
			amber: "#e2b45e",
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
	scenes: [],
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
};

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
 * Every call resolves a success envelope with empty domain data, so the
 * store boots into the same idle shell a missing bridge used to produce.
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

	const conversationList = vi.fn(() => ok({ conversations: [] }));
	const providerList = vi.fn(() => ok({ providers: [] }));

	const client = {
		snapshot: {
			get: vi.fn(() =>
				ok({
					eventSeq: 0,
					model: {
						pool: { models: [DEFAULT_MODEL] },
						defaults: {
							reply: { providerId: DEFAULT_MODEL.providerId, modelId: DEFAULT_MODEL.modelId },
							vision: { mode: "auto" as const },
						},
					},
				}),
			),
		},
		character: {
			get: vi.fn(() => ok(null)),
			list: vi.fn(() => ok({ characters: [] })),
			activate: vi.fn(() => ok(null)),
		},
		roleplay: {
			get: vi.fn(() => ok({ state: { values: {}, unlocked: [] } })),
			trigger: vi.fn(() => ok({ state: { values: {}, unlocked: [] } })),
			resetUnlocks: vi.fn(() => ok({})),
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
			create: vi.fn(() => ok({ id: "c1" })),
			select: vi.fn(() => ok(null)),
			rename: vi.fn(() => ok(null)),
			archive: vi.fn(() => ok(null)),
			delete: vi.fn(() => ok(null)),
		},
		message: {
			send: vi.fn(() => ok({ messageId: "m1" })),
			regenerate: vi.fn(() => ok(null)),
			switchVersion: vi.fn(() => ok(null)),
			edit: vi.fn(() => ok(null)),
			continue: vi.fn(() => ok(null)),
			correct: vi.fn(() => ok(null)),
			branch: vi.fn(() => ok({ branchId: "b1" })),
			abort: vi.fn(() => ok(null)),
		},
		memory: {
			search: vi.fn(() => ok({ entries: [] })),
			list: vi.fn(() => ok({ entries: [] })),
			capture: vi.fn(({ entryId }: { entryId: string }) =>
				ok({ memoryId: `memory-${entryId}`, sourceEntryId: entryId, createdBy: "user_capture" as const }),
			),
			invalidate: vi.fn(() => ok({})),
			pin: vi.fn(() => ok(null)),
			forget: vi.fn(() => ok(null)),
			edit: vi.fn(() => ok(null)),
		},
		story: {
			listChanges: vi.fn(() => ok({ changes: [] })),
			applyChange: vi.fn(() => ok(null)),
			revertChange: vi.fn(() => ok(null)),
			reset: vi.fn(() => ok(null)),
			listProposals: vi.fn(() => ok({ proposals: [] })),
			resolveProposal: vi.fn(() => ok(null)),
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
			importPiConfig: vi.fn(() => ok({ models: [] })),
			overrideBaseUrl: vi.fn(() => ok(null)),
			setApiKey: vi.fn(() => ok(null)),
			login: vi.fn(() => ok({ providerId: "test", status: "completed" })),
			loginStatus: vi.fn(() => ok({ providerId: "test", status: "completed" })),
			loginAnswer: vi.fn(() => ok({ providerId: "test", status: "running" })),
			logout: vi.fn(() => ok(null)),
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
			cancel: vi.fn(() => ok(null)),
			respondPermission: vi.fn(() => ok(null)),
		},
		artifact: {
			list: vi.fn(() => ok({ artifacts: [] })),
			read: vi.fn(() => ok({ logicalName: "result.txt", mime: "text/plain", base64: "" })),
		},
		settings: { get: settingsGet, set: settingsSet },
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
