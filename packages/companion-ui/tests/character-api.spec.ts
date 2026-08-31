import { QueryClient } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonApi, createCharacterApi } from "../src/stores/character-api.js";
import type {
	CanonChunk,
	CanonModule,
	CanonSource,
	CharacterDraft,
	CharacterPackageDocument,
	CharacterSummary,
} from "../src/stores/ipc.js";
import { queryKeys } from "../src/stores/rpc-query.js";
import { createTestClient, THEMED_CHARACTER } from "./fixtures.js";

const disposals: Array<() => void> = [];
const clients: QueryClient[] = [];

afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	for (const client of clients.splice(0)) client.clear();
});

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

const characterSummary: CharacterSummary = {
	id: "character-one",
	name: "Character One",
	subtitle: "A test character",
	avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+",
	active: true,
};

const packageDocument: CharacterPackageDocument = {
	characterId: characterSummary.id,
	origin: "local",
	writable: true,
	yaml: "id: character-one",
	sha256: "a".repeat(64),
	character: THEMED_CHARACTER,
};

const deletionStatus = {
	characterId: characterSummary.id,
	active: false,
	default: false,
	runtimePresent: true,
	packagePresent: true,
};

const draft: CharacterDraft = {
	id: "draft-one",
	status: "draft",
	locale: "en-US",
	currentRevision: 3,
	files: { "character.yaml": { encoding: "utf8", content: "id: character-one" } },
};

function createCharacterHarness() {
	const { client } = createTestClient();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});
	clients.push(queryClient);
	const trust = {
		characterId: characterSummary.id,
		origin: "local" as const,
		pluginHash: "plugin-hash",
		pluginsPresent: true,
		trusted: false,
	};
	Object.assign(client.character, {
		list: vi.fn(() => ok({ characters: [characterSummary] })),
		import: vi.fn(() => ok({})),
		packageGet: vi.fn(() => ok({ package: packageDocument })),
		packageUpdate: vi.fn(() => ok({ package: packageDocument })),
		deletionStatusGet: vi.fn(() => ok({ status: deletionStatus })),
		runtimeDelete: vi.fn(() =>
			ok({ characterId: characterSummary.id, target: "runtime" as const, deleted: true }),
		),
		packageDelete: vi.fn(() =>
			ok({ characterId: characterSummary.id, target: "package" as const, deleted: true }),
		),
		pluginTrustGet: vi.fn(() => ok({ trust })),
		pluginTrustConfirm: vi.fn(() => ok({})),
		draftCreate: vi.fn(() => ok({ draft })),
		draftGet: vi.fn(() => ok({ draft })),
		draftPatch: vi.fn(() => ok({ draft })),
		draftUploadAssets: vi.fn(() => ok({ draft })),
		draftListRevisions: vi.fn(() =>
			ok({ revisions: [{ revision: 2, createdAt: "2026-01-01T00:00:00.000Z" }] }),
		),
		draftRestoreRevision: vi.fn(() => ok({ draft })),
		draftValidate: vi.fn(() => ok({ draft })),
		draftPublish: vi.fn(() => ok({ draft, character: THEMED_CHARACTER })),
	});
	const callbacks = {
		cacheRevision: vi.fn(() => 1),
		refreshCharacters: vi.fn(async () => undefined),
		refreshSnapshot: vi.fn(async () => undefined),
		resyncOnboarding: vi.fn(async () => undefined),
		switchCharacterConversations: vi.fn(async () => undefined),
		invalidateConversations: vi.fn(async () => undefined),
		invalidateActiveConversation: vi.fn(async () => undefined),
	};
	const api = createCharacterApi({
		client,
		queryClient,
		...callbacks,
		currentCharacterId: () => characterSummary.id,
		characters: () => [characterSummary],
	});
	return { api, callbacks, client, queryClient, trust };
}

describe("character store API", () => {
	it("projects cached data and observes package, trust, and character settings reactively", async () => {
		const { api, callbacks, client, queryClient, trust } = createCharacterHarness();
		queryClient.setQueryData(queryKeys.characterPackage(characterSummary.id), {
			package: packageDocument,
		});
		queryClient.setQueryData(["character", "trust", characterSummary.id], { trust });
		queryClient.setQueryData(queryKeys.characterDeletionStatus(characterSummary.id), {
			status: deletionStatus,
		});

		expect(api.characters()).toEqual([characterSummary]);
		expect(api.packageData(characterSummary.id)).toEqual(packageDocument);
		expect(api.pluginTrustData(characterSummary.id)).toEqual(trust);
		expect(api.deletionStatusData(characterSummary.id)).toEqual(deletionStatus);
		expect(api.packageData("missing")).toBeUndefined();
		expect(api.pluginTrustData("missing")).toBeUndefined();
		expect(callbacks.cacheRevision).toHaveBeenCalledTimes(5);

		const [packageId, setPackageId] = createSignal<string | undefined>();
		let trustView!: ReturnType<typeof api.observeTrust>;
		let packageView!: ReturnType<typeof api.observePackage>;
		let deletionView!: ReturnType<typeof api.observeDeletionStatus>;
		createRoot((dispose) => {
			disposals.push(dispose);
			trustView = api.observeTrust(() => "trust-only");
			packageView = api.observePackage(packageId);
			deletionView = api.observeDeletionStatus(packageId);
		});

		expect(packageView.data()).toBeUndefined();
		expect(packageView.loading()).toBe(false);
		setPackageId(characterSummary.id);
		await waitFor(() => expect(packageView.data()?.package).toEqual(packageDocument));
		await waitFor(() => expect(trustView.data()?.trust).toEqual(trust));
		await waitFor(() => expect(deletionView.data()?.status).toEqual(deletionStatus));
		expect(packageView.error()).toBeNull();
		expect(trustView.loading()).toBe(false);
		expect(trustView.error()).toBeNull();
		expect(client.character.packageGet).toHaveBeenCalledWith({
			characterId: characterSummary.id,
		});
		expect(client.character.pluginTrustGet).toHaveBeenCalledWith({
			characterId: characterSummary.id,
		});
		expect(client.character.deletionStatusGet).toHaveBeenCalledWith({
			characterId: characterSummary.id,
		});
		expect(client.settings.get).toHaveBeenCalledWith({ characterId: characterSummary.id });
	});

	it("routes every character and draft mutation and refreshes all affected projections", async () => {
		const { api, callbacks, client, trust } = createCharacterHarness();

		expect(await api.list()).toEqual({ characters: [characterSummary] });
		await api.activate(characterSummary.id);
		for (const callback of [
			callbacks.switchCharacterConversations,
			callbacks.resyncOnboarding,
			callbacks.refreshCharacters,
			callbacks.refreshSnapshot,
		]) {
			expect(callback).toHaveBeenCalledOnce();
		}

		const files = [{ path: "character.yaml", base64: "aWQ6IGNoYXJhY3Rlci1vbmU=" }];
		await api.import(files);
		expect(client.character.import).toHaveBeenCalledWith({ files });
		expect(callbacks.refreshCharacters).toHaveBeenCalledTimes(2);

		expect(await api.pluginTrust(characterSummary.id)).toEqual(trust);
		expect(await api.packageGet(characterSummary.id)).toEqual(packageDocument);
		expect(await api.packageUpdate(characterSummary.id, "id: updated", "b".repeat(64))).toEqual(
			packageDocument,
		);
		expect(client.character.packageUpdate).toHaveBeenCalledWith({
			characterId: characterSummary.id,
			yaml: "id: updated",
			expectedSha256: "b".repeat(64),
		});
		expect(await api.deletionStatus(characterSummary.id)).toEqual(deletionStatus);
		expect(await api.runtimeDelete(characterSummary.id)).toEqual({
			characterId: characterSummary.id,
			target: "runtime",
			deleted: true,
		});
		expect(client.character.runtimeDelete).toHaveBeenCalledWith({
			characterId: characterSummary.id,
		});
		expect(await api.packageDelete(characterSummary.id)).toEqual({
			characterId: characterSummary.id,
			target: "package",
			deleted: true,
		});
		expect(client.character.packageDelete).toHaveBeenCalledWith({
			characterId: characterSummary.id,
		});
		await api.confirmPluginTrust(characterSummary.id);
		expect(client.character.pluginTrustConfirm).toHaveBeenCalledWith({
			characterId: characterSummary.id,
		});

		expect(await api.draftCreate()).toEqual(draft);
		expect(client.character.draftCreate).toHaveBeenCalledWith({});
		expect(await api.draftCreate({ locale: "ja-JP" })).toEqual(draft);
		expect(client.character.draftCreate).toHaveBeenLastCalledWith({ locale: "ja-JP" });
		expect(await api.draftGet(draft.id)).toEqual(draft);
		const draftFiles = { "STORY.md": { encoding: "utf8" as const, content: "Story" } };
		expect(await api.draftPatch(draft.id, 3, draftFiles)).toEqual(draft);
		expect(client.character.draftPatch).toHaveBeenCalledWith({
			id: draft.id,
			expectedRevision: 3,
			files: draftFiles,
		});
		const assets = [{ path: "assets/avatar.png", mime: "image/png", base64: "cG5n" }];
		expect(await api.draftUploadAssets(draft.id, 3, assets)).toEqual(draft);
		expect(client.character.draftUploadAssets).toHaveBeenCalledWith({
			id: draft.id,
			expectedRevision: 3,
			assets,
		});
		expect(await api.draftListRevisions(draft.id)).toEqual([
			{ revision: 2, createdAt: "2026-01-01T00:00:00.000Z" },
		]);
		expect(await api.draftRestoreRevision(draft.id, 3, 2)).toEqual(draft);
		expect(await api.draftValidate(draft.id, 3)).toEqual(draft);
		expect(await api.draftPublish(draft.id, 3)).toEqual(draft);
		for (const callback of [callbacks.resyncOnboarding, callbacks.refreshSnapshot]) {
			expect(callback).toHaveBeenCalledTimes(2);
		}
		for (const callback of [
			callbacks.invalidateConversations,
			callbacks.invalidateActiveConversation,
		]) {
			expect(callback).toHaveBeenCalledOnce();
		}
		expect(callbacks.switchCharacterConversations).toHaveBeenCalledOnce();
		expect(callbacks.refreshCharacters).toHaveBeenCalledTimes(4);
	});

	it("propagates RPC failures without running success refreshes", async () => {
		const { api, callbacks, client } = createCharacterHarness();
		client.character.import = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "invalid_request" as const, reason: "bad_package" },
			}),
		);

		await expect(api.import([{ path: "bad", base64: "!" }])).rejects.toMatchObject({
			name: "IpcInvocationError",
			kind: "invalid_request",
			reason: "bad_package",
		});
		expect(callbacks.refreshCharacters).not.toHaveBeenCalled();
	});
});

const source: CanonSource = {
	id: "source-one",
	logicalName: "STORY.md",
	mime: "text/markdown",
	sha256: "source-hash",
	chunkCount: 1,
	createdAt: "2026-01-01T00:00:00.000Z",
	origin: "user",
	language: "en",
	sourceKind: "story",
};

const chunk: CanonChunk = {
	id: "chunk-one",
	sourceId: source.id,
	sourceName: source.logicalName,
	ordinal: 0,
	content: "Once upon a time",
	startOffset: 0,
	endOffset: 16,
	origin: "user",
};

const module: CanonModule = {
	id: "module-one",
	kind: "arc",
	title: "Opening",
	instructions: "Begin here",
	sourceChunkIds: [chunk.id],
	createdAt: "2026-01-01T00:00:00.000Z",
	origin: "user",
	triggers: [],
};

describe("canon store API", () => {
	it("projects cached canon data and routes source, search, and module operations", async () => {
		const { client } = createTestClient();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		clients.push(queryClient);
		client.canon.search = vi.fn(() => ok({ chunks: [chunk] }));
		client.canon.addSource = vi.fn(() => ok({ source }));
		client.canon.removeSource = vi.fn(() => ok({}));
		client.canon.upsertModule = vi.fn(() => ok({ module }));
		client.canon.deleteModule = vi.fn(() => ok({}));
		const cacheRevision = vi.fn(() => 2);
		const refreshSources = vi.fn(async () => undefined);
		const refreshModules = vi.fn(async () => undefined);
		let api!: ReturnType<typeof createCanonApi>;
		createRoot((dispose) => {
			disposals.push(dispose);
			api = createCanonApi({
				client,
				queryClient,
				cacheRevision,
				currentCharacterId: () => characterSummary.id,
				canonSources: { data: { sources: [source] } },
				canonModules: { data: { modules: [module] } },
				refreshSources,
				refreshModules,
			});
		});

		expect(api.sources()).toEqual([source]);
		expect(api.modules()).toEqual([module]);
		expect(api.searchResults("missing")).toEqual([]);
		queryClient.setQueryData(["canon", "search", characterSummary.id, "cached"], {
			chunks: [chunk],
		});
		expect(api.searchResults("cached")).toEqual([chunk]);
		expect(cacheRevision).toHaveBeenCalledTimes(2);

		await api.listSources();
		await api.addSource("STORY.md", "Once upon a time");
		expect(client.canon.addSource).toHaveBeenCalledWith({
			logicalName: "STORY.md",
			content: "Once upon a time",
			characterId: characterSummary.id,
		});
		expect(await api.search("opening")).toEqual([chunk]);
		expect(client.canon.search).toHaveBeenCalledWith({
			query: "opening",
			characterId: characterSummary.id,
		});
		await api.removeSource(source.id);
		expect(refreshSources).toHaveBeenCalledTimes(3);

		await api.listModules();
		const upsert = {
			kind: "arc" as const,
			title: "Opening",
			instructions: "Begin here",
			sourceChunkIds: [chunk.id],
		};
		await api.upsertModule(upsert);
		expect(client.canon.upsertModule).toHaveBeenCalledWith({
			...upsert,
			characterId: characterSummary.id,
		});
		await api.deleteModule(module.id);
		expect(refreshModules).toHaveBeenCalledTimes(3);
	});

	it("uses empty projections and does not refresh after a failed canon mutation", async () => {
		const { client } = createTestClient();
		const queryClient = new QueryClient();
		clients.push(queryClient);
		client.canon.addSource = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "unavailable" as const, reason: "disk_offline" },
			}),
		);
		const refreshSources = vi.fn(async () => undefined);
		let api!: ReturnType<typeof createCanonApi>;
		createRoot((dispose) => {
			disposals.push(dispose);
			api = createCanonApi({
				client,
				queryClient,
				cacheRevision: vi.fn(() => 0),
				currentCharacterId: () => undefined,
				canonSources: {},
				canonModules: {},
				refreshSources,
				refreshModules: vi.fn(async () => undefined),
			});
		});

		expect(api.sources()).toEqual([]);
		expect(api.modules()).toEqual([]);
		expect(api.searchResults("missing")).toEqual([]);
		expect(await api.search("missing")).toEqual([]);
		await expect(api.addSource("broken", "content")).rejects.toMatchObject({
			name: "IpcInvocationError",
			reason: "disk_offline",
		});
		expect(refreshSources).not.toHaveBeenCalled();
	});
});
