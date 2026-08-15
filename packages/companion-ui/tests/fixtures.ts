import type { CompanionClient } from "@bear-harness/companion-types";
import { type ProductConfig, productConfig } from "@bear-harness/product-config";
import { vi } from "vitest";
import type { SettingsData } from "../src/index.js";

/** The official product config as shipped. */
export const OFFICIAL_PRODUCT: Readonly<ProductConfig> = productConfig;

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
};

/**
 * Minimal deterministic `CompanionClient` fixture matching the public
 * interface of `@bear-harness/companion-types`.
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
	const settingsSet = vi.fn(async (patch: Record<string, unknown>) => {
		settings = { ...settings, ...patch } as SettingsData;
		return ok(null);
	});

	const conversationList = vi.fn(() => ok({ conversations: [] }));
	const providerList = vi.fn(() => ok({ providers: [] }));

	const client: CompanionClient = {
		snapshot: { get: vi.fn(() => ok({ eventSeq: 0 })) },
		character: { get: vi.fn(() => ok(null)) },
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
			listCandidates: vi.fn(() => ok({ candidates: [] })),
			decideCandidate: vi.fn(() => ok(null)),
			search: vi.fn(() => ok({ entries: [] })),
			list: vi.fn(() => ok({ entries: [] })),
			pin: vi.fn(() => ok(null)),
			forget: vi.fn(() => ok(null)),
			exclude: vi.fn(() => ok(null)),
			edit: vi.fn(() => ok(null)),
		},
		provider: {
			list: providerList,
			setApiKey: vi.fn(() => ok(null)),
			login: vi.fn(() => ok(null)),
			logout: vi.fn(() => ok(null)),
		},
		voice: {
			list: vi.fn(() => ok({ stacks: [] })),
			switch: vi.fn(() => ok(null)),
		},
		commission: {
			list: vi.fn(() => ok({ commissions: [] })),
			draft: vi.fn(() => ok({ commissionId: "c1", draftHash: "h" })),
			approve: vi.fn(() => ok(null)),
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
		},
		settings: { get: settingsGet, set: settingsSet },
	};

	return {
		client,
		settings: () => settings,
		settingsGet,
		settingsSet,
		conversationList,
		providerList,
	};
}
