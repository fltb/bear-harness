import { bindCharacterClient } from "@bear-harness/companion-client";
import { QueryClient } from "@tanstack/solid-query";
import { waitFor } from "@testing-library/dom";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonApi, createCharacterApi } from "../src/stores/character-api.js";
import type {
	CanonChunk,
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
	id: "character-one~00000000-0000-4000-8000-000000000000",
	characterId: "character-one",
	updatedAt: "2026-10-01T00:00:00.000Z",
	status: "draft",
	locale: "en-US",
	currentRevision: 3,
	files: { "character.yaml": { encoding: "utf8", sha256: "a".repeat(64), size: 17 } },
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
		hostClient: client,
		selectCharacter: async () => {},
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
		expect(client.settings.get).not.toHaveBeenCalled();
	});

	it("propagates RPC failures without running success refreshes", async () => {
		const { api, callbacks, client } = createCharacterHarness();
		client.character.archiveBegin = vi.fn(() =>
			Promise.resolve({
				ok: false as const,
				error: { kind: "invalid_request" as const, reason: "bad_package" },
			}),
		);

		await expect(api.import(new File(["bad"], "bad.zip"))).rejects.toMatchObject({
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

describe("canon store API", () => {
	it("projects cached canon data and routes source and search operations", async () => {
		const { client } = createTestClient();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		clients.push(queryClient);
		client.canon.search = vi.fn(() => ok({ chunks: [chunk] }));
		client.canon.addSource = vi.fn(() => ok({ source }));
		client.canon.removeSource = vi.fn(() => ok({}));
		const cacheRevision = vi.fn(() => 2);
		const refreshSources = vi.fn(async () => undefined);
		let api!: ReturnType<typeof createCanonApi>;
		createRoot((dispose) => {
			disposals.push(dispose);
			api = createCanonApi({
				client: bindCharacterClient(client, characterSummary.id),
				queryClient,
				cacheRevision,
				currentCharacterId: () => characterSummary.id,
				canonSources: { data: { sources: [source] } },
				refreshSources,
			});
		});

		expect(api.sources()).toEqual([source]);
		expect(api.searchResults("missing")).toEqual([]);
		queryClient.setQueryData(["canon", "search", characterSummary.id, "cached"], {
			chunks: [chunk],
		});
		expect(api.searchResults("cached")).toEqual([chunk]);
		expect(cacheRevision).toHaveBeenCalledTimes(2);

		await api.listSources();
		await api.addSource("STORY.md", "Once upon a time");
		expect(client.canon.addSource).toHaveBeenCalledWith({
			characterId: characterSummary.id,
			logicalName: "STORY.md",
			content: "Once upon a time",
		});
		expect(await api.search("opening")).toEqual([chunk]);
		expect(client.canon.search).toHaveBeenCalledWith({
			characterId: characterSummary.id,
			query: "opening",
		});
		await api.removeSource(source.id);
		expect(refreshSources).toHaveBeenCalledTimes(3);
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
				client: bindCharacterClient(client, characterSummary.id),
				queryClient,
				cacheRevision: vi.fn(() => 0),
				currentCharacterId: () => undefined,
				canonSources: {},
				refreshSources,
			});
		});

		expect(api.sources()).toEqual([]);
		expect(api.searchResults("missing")).toEqual([]);
		expect(await api.search("missing")).toEqual([]);
		await expect(api.addSource("broken", "content")).rejects.toMatchObject({
			name: "IpcInvocationError",
			reason: "disk_offline",
		});
		expect(refreshSources).not.toHaveBeenCalled();
	});
});

it("transfers large draft assets with revision checks, cancels failed uploads and joins immutable export chunks", async () => {
	const { api, client } = createCharacterHarness();
	const transfer = vi.fn(async (input: { action: string }) =>
		ok(
			input.action === "begin"
				? { uploadId: "upload" }
				: input.action === "finish"
					? { draft }
					: {},
		),
	);
	client.character.draftTransfer = transfer;
	const bytes = new Uint8Array(1024 * 1024 + 3).fill(65);
	const file = {
		size: bytes.length,
		slice: (from: number, to: number) => ({
			arrayBuffer: async () => bytes.slice(from, to).buffer,
		}),
	} as File;
	expect(await api.draftUploadFile(draft.id, 3, "assets/large.png", file)).toEqual(draft);
	const appended = transfer.mock.calls
		.map(([input]) => input)
		.filter((input) => input.action === "append");
	expect(appended).toHaveLength(2);
	expect(appended[1]).toMatchObject({ offset: 1024 * 1024, base64: btoa("AAA") });
	transfer.mockImplementation(async (input) => {
		if (input.action === "append") throw new Error("Disconnected");
		return ok(input.action === "begin" ? { uploadId: "failed" } : {});
	});
	await expect(api.draftUploadFile(draft.id, 3, "assets/large.png", file)).rejects.toThrow(
		"Disconnected",
	);
	expect(transfer).toHaveBeenLastCalledWith({ action: "cancel", id: draft.id, uploadId: "failed" });
	const exportPart = vi.fn(async ({ offset }: { offset: number }) =>
		ok({ base64: btoa(offset === 0 ? "PK" : "ZIP"), totalBytes: 5, sha256: "same" }),
	);
	client.character.draftExport = exportPart;
	expect(new TextDecoder().decode(await api.draftExport(draft.id, 3))).toBe("PKZIP");
	expect(exportPart).toHaveBeenLastCalledWith({ id: draft.id, expectedRevision: 3, offset: 2 });
	exportPart.mockImplementation(async ({ offset }) =>
		ok({ base64: btoa("AA"), totalBytes: 5, sha256: offset ? "changed" : "first" }),
	);
	await expect(api.draftExport(draft.id, 3)).rejects.toThrow("character_draft_revision_mismatch");
	exportPart.mockImplementation(async () => ok({ base64: "", totalBytes: 5, sha256: "same" }));
	await expect(api.draftExport(draft.id, 3)).rejects.toThrow("character_draft_file_corrupt");
});

it("routes authoring review, migration approval, pagination and trial events to the Host contracts", async () => {
	const { api, client, callbacks } = createCharacterHarness();
	Object.assign(client.character, {
		draftList: vi.fn(() => ok({ drafts: [draft], nextCursor: "next" })),
		authoringSchema: vi.fn(() => ok({ manifest: { type: "object" }, skill: { type: "object" } })),
		draftReview: vi.fn(() => ok({ issues: [], changes: [] })),
		draftDiff: vi.fn(() => ok({ before: "old", after: "new", truncated: false })),
		draftManage: vi.fn(() => ok({ draft })),
		trial: vi.fn(() => ok({ trialId: "trial" })),
	});
	expect(await api.draftList("character-one")).toEqual([draft]);
	await api.draftList();
	await api.draftListPage("next");
	await api.draftListPage();
	expect(client.character.draftList).toHaveBeenCalledWith({ cursor: "next", limit: 50 });
	expect(await api.authoringSchema()).toHaveProperty("manifest");
	await api.draftReview(draft.id, 3);
	await api.draftDiff(draft.id, 3, "character.yaml");
	expect(client.character.draftDiff).toHaveBeenCalledWith({
		id: draft.id,
		expectedRevision: 3,
		path: "character.yaml",
	});
	await api.draftManage({ action: "prune", id: draft.id, expectedRevision: 3, keep: 20 });
	await api.draftCreate({
		kind: "new",
		characterId: "new-character",
		name: "New",
		locale: "en-US",
	});
	await api.draftPatch(draft.id, 3, { "canon/a.md": { encoding: "utf8", content: "Reference" } });
	await api.draftUploadAssets(draft.id, 3, { "assets/a.png": "aW1hZ2U=" });
	await api.draftGet(draft.id);
	await api.draftListRevisions(draft.id, 2);
	await api.draftRestoreRevision(draft.id, 3, 2);
	await api.draftValidate(draft.id, 3);
	await api.draftPublish(draft.id, 3, "review-token");
	expect(client.character.draftPublish).toHaveBeenCalledWith({
		id: draft.id,
		expectedRevision: 3,
		migrationToken: "review-token",
	});
	expect(callbacks.refreshSnapshot).toHaveBeenCalled();
	await api.trial({ action: "close", trialId: "trial" });
	expect(client.character.trial).toHaveBeenCalledWith({ action: "close", trialId: "trial" });
	const controller = new AbortController();
	await api.trialEvents(controller.signal);
	controller.abort();
	const fileGet = vi.fn(async ({ offset }: { offset: number }) =>
		ok({ base64: btoa(offset ? "llo" : "He"), totalBytes: 5, sha256: "same" }),
	);
	client.character.draftFileGet = fileGet;
	expect(new TextDecoder().decode(await api.draftFile(draft.id, "canon/a.md"))).toBe("Hello");
	fileGet.mockImplementation(async () => ok({ base64: "", totalBytes: 1, sha256: "same" }));
	await expect(api.draftFile(draft.id, "canon/a.md")).rejects.toThrow(
		"character_draft_file_corrupt",
	);
	fileGet.mockImplementation(async ({ offset }) =>
		ok({ base64: btoa("a"), totalBytes: 2, sha256: offset ? "new" : "old" }),
	);
	await expect(api.draftFile(draft.id, "canon/a.md")).rejects.toThrow(
		"character_draft_revision_mismatch",
	);
});

it("reports acknowledged upload bytes and cancels before committing the next chunk", async () => {
	const { api, client } = createCharacterHarness();
	const controller = new AbortController();
	const progress: number[] = [];
	const transfer = vi.fn(async (input: { action: string }) =>
		ok(input.action === "begin" ? { uploadId: "cancelled" } : {}),
	);
	client.character.draftTransfer = transfer;
	const bytes = new Uint8Array(1024 * 1024 + 1);
	const file = {
		size: bytes.length,
		slice: (from: number, to: number) => ({
			arrayBuffer: async () => bytes.slice(from, to).buffer,
		}),
	} as File;
	await expect(
		api.draftUploadFile(draft.id, 3, "assets/large.png", file, {
			signal: controller.signal,
			onProgress: (bytes) => {
				progress.push(bytes);
				if (bytes) controller.abort();
			},
		}),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(progress).toEqual([0, 1024 * 1024]);
	expect(transfer.mock.calls.map(([input]) => input.action)).toEqual(["begin", "append", "cancel"]);
});
