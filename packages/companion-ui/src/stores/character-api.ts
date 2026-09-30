import type {
	CharacterClient as CompanionClient,
	CompanionClient as HostClient,
} from "@bear-harness/companion-client";
import type { QueryClient } from "@tanstack/solid-query";
import { type Accessor, createMemo } from "solid-js";
import type {
	CanonChunk,
	CanonSource,
	CharacterDeletionStatus,
	CharacterListData,
	CharacterPackageDocument,
	CharacterSummary,
} from "./ipc.js";
import { invoke } from "./ipc.js";
import { listAllCharacters } from "./paged-rpc.js";
import { createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";
import type { CanonApi, CharacterApi } from "./supplementary-api.js";

interface CharacterApiContext {
	hostClient: HostClient;
	client: CompanionClient;
	queryClient: QueryClient;
	cacheRevision(): number;
	currentCharacterId(): string | undefined;
	characters: Accessor<CharacterSummary[]>;
	refreshCharacters(): Promise<unknown>;
	refreshSnapshot(): Promise<unknown>;
	resyncOnboarding(): Promise<unknown>;
	selectCharacter(id: string): Promise<void>;
	invalidateConversations(): Promise<unknown> | void;
	invalidateActiveConversation(): Promise<unknown> | void;
}

export function createCharacterApi(c: CharacterApiContext): CharacterApi {
	const { client, queryClient } = c;
	const api: CharacterApi = {
		inspectMemory: (request) => invoke(client, () => c.hostClient.memory.inspect(request)),
		memoryGet: (characterId) =>
			invoke(client, () => c.hostClient.character.memoryGet({ characterId })),
		memorySet: (characterId, enabled) =>
			invoke(client, () => c.hostClient.character.memorySet({ characterId, enabled })),
		observeTrust: (characterId) => {
			const query = createRpcQuery({
				client: queryClient,
				key: () => ["character", "trust", characterId()],
				request: (key) =>
					invoke(client, () => client.character.pluginTrustGet({ characterId: key[2] as string })),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		observePackage: (characterId) => {
			const enabled = () => Boolean(characterId());
			const query = createRpcQuery({
				client: queryClient,
				key: () => queryKeys.characterPackage(characterId() ?? ""),
				enabled,
				request: (key) =>
					invoke(client, () => client.character.packageGet({ characterId: key[2] as string })),
			});
			createRpcQuery({
				client: queryClient,
				key: () => ["character", "trust", characterId() ?? ""],
				enabled,
				request: (key) =>
					invoke(client, () => client.character.pluginTrustGet({ characterId: key[2] as string })),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		observeDeletionStatus: (characterId) => {
			const query = createRpcQuery({
				client: queryClient,
				key: () => queryKeys.characterDeletionStatus(characterId() ?? ""),
				enabled: () => Boolean(characterId()),
				request: (key) =>
					invoke(client, () =>
						client.character.deletionStatusGet({ characterId: key[2] as string }),
					),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		packageData: (id) => {
			c.cacheRevision();
			return queryClient.getQueryData<{ package: CharacterPackageDocument }>(
				queryKeys.characterPackage(id),
			)?.package;
		},
		deletionStatusData: (id) => {
			c.cacheRevision();
			return queryClient.getQueryData<{ status: CharacterDeletionStatus }>(
				queryKeys.characterDeletionStatus(id),
			)?.status;
		},
		pluginTrustData: (id) => {
			c.cacheRevision();
			return queryClient.getQueryData<{ trust: Awaited<ReturnType<CharacterApi["pluginTrust"]>> }>([
				"character",
				"trust",
				id,
			])?.trust;
		},
		characters: c.characters,
		list: () =>
			refreshRpcQuery({
				client: queryClient,
				key: queryKeys.characters,
				request: () => listAllCharacters(client),
			}),
		activate: c.selectCharacter,
		import: async (file) => {
			const { uploadId } = await invoke(client, () => client.character.archiveBegin({}));
			try {
				// Chunk size controls transfer memory, never the accepted file size.
				const chunkSize = 1024 * 1024;
				for (let offset = 0; offset < file.size; offset += chunkSize) {
					const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
					let binary = "";
					for (let at = 0; at < bytes.length; at += 32768)
						binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
					await invoke(client, () =>
						client.character.archiveAppend({ uploadId, offset, base64: btoa(binary) }),
					);
				}
				await invoke(client, () => client.character.archiveFinish({ uploadId }));
			} catch (error) {
				await invoke(client, () => client.character.archiveCancel({ uploadId })).catch(
					() => undefined,
				);
				throw error;
			}
			await c.refreshCharacters();
		},
		pluginTrust: async (characterId) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: ["character", "trust", characterId],
					request: () => invoke(client, () => client.character.pluginTrustGet({ characterId })),
				})
			).trust,
		packageGet: async (characterId) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: queryKeys.characterPackage(characterId),
					request: () => invoke(client, () => client.character.packageGet({ characterId })),
				})
			).package,
		packageUpdate: async (characterId, yaml, expectedSha256) => {
			await invoke(client, () =>
				client.character.packageUpdate({ characterId, yaml, expectedSha256 }),
			);
			return api.packageGet(characterId);
		},
		packageReveal: async (characterId) => {
			await invoke(client, () => client.character.packageReveal({ characterId }));
		},
		deletionStatus: async (characterId) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: queryKeys.characterDeletionStatus(characterId),
					request: () => invoke(client, () => client.character.deletionStatusGet({ characterId })),
				})
			).status,
		runtimeDelete: async (characterId) => {
			const result = await invoke(client, () => client.character.runtimeDelete({ characterId }));
			queryClient.removeQueries({ queryKey: queryKeys.modelRoute(characterId), exact: true });
			await api.deletionStatus(characterId);
			return result;
		},
		packageDelete: async (characterId) => {
			const result = await invoke(client, () => client.character.packageDelete({ characterId }));
			queryClient.removeQueries({ queryKey: queryKeys.characterPackage(characterId), exact: true });
			queryClient.removeQueries({ queryKey: ["character", "trust", characterId], exact: true });
			await Promise.all([api.deletionStatus(characterId), c.refreshCharacters()]);
			return result;
		},
		confirmPluginTrust: async (characterId) => {
			await invoke(client, () => client.character.pluginTrustConfirm({ characterId }));
			await api.pluginTrust(characterId);
		},
		draftCreate: async (params) =>
			(await invoke(client, () => client.character.draftCreate(params))).draft,
		draftList: async () => (await invoke(client, () => client.character.draftList({}))).drafts,
		draftFile: async (id, path) => {
			const pieces: Uint8Array[] = [];
			let offset = 0;
			let hash: string | undefined;
			while (true) {
				const piece = await invoke(client, () =>
					client.character.draftFileGet({ id, path, offset }),
				);
				if (hash && hash !== piece.sha256) throw new Error("character_draft_revision_mismatch");
				hash = piece.sha256;
				const bytes = Uint8Array.from(atob(piece.base64), (char) => char.charCodeAt(0));
				pieces.push(bytes);
				offset += bytes.length;
				if (offset >= piece.totalBytes) break;
				if (!bytes.length) throw new Error("character_draft_file_corrupt");
			}
			const result = new Uint8Array(offset);
			let position = 0;
			for (const piece of pieces) {
				result.set(piece, position);
				position += piece.length;
			}
			return result;
		},
		draftGet: async (id) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: ["character", "draft", id],
					request: () => invoke(client, () => client.character.draftGet({ id })),
				})
			).draft,
		draftPatch: async (id, expectedRevision, files) =>
			(await invoke(client, () => client.character.draftPatch({ id, expectedRevision, files })))
				.draft,
		draftUploadAssets: async (id, expectedRevision, assets) =>
			(
				await invoke(client, () =>
					client.character.draftUploadAssets({ id, expectedRevision, assets }),
				)
			).draft,
		draftListRevisions: async (id) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: ["character", "draftRevisions", id],
					request: () => invoke(client, () => client.character.draftListRevisions({ id })),
				})
			).revisions,
		draftRestoreRevision: async (id, expectedRevision, sourceRevision) =>
			(
				await invoke(client, () =>
					client.character.draftRestoreRevision({ id, expectedRevision, sourceRevision }),
				)
			).draft,
		draftValidate: async (id, expectedRevision) =>
			(await invoke(client, () => client.character.draftValidate({ id, expectedRevision }))).draft,
		draftPublish: async (id, expectedRevision) => {
			const draft = (
				await invoke(client, () => client.character.draftPublish({ id, expectedRevision }))
			).draft;
			await Promise.all([
				c.resyncOnboarding(),
				c.refreshCharacters(),
				c.invalidateConversations(),
				c.invalidateActiveConversation(),
				c.refreshSnapshot(),
			]);
			return draft;
		},
	};
	return api;
}

interface CanonApiContext {
	client: CompanionClient;
	queryClient: QueryClient;
	cacheRevision(): number;
	currentCharacterId(): string | undefined;
	canonSources: { data?: { sources: CanonSource[] } };
	refreshSources(): Promise<unknown>;
}
export function createCanonApi(c: CanonApiContext): CanonApi {
	const sources = createMemo(() => c.canonSources.data?.sources ?? []);
	return {
		searchResults: (query) => {
			c.cacheRevision();
			return (
				c.queryClient.getQueryData<{ chunks: CanonChunk[] }>([
					"canon",
					"search",
					c.currentCharacterId() ?? null,
					query,
				])?.chunks ?? []
			);
		},
		sources,
		listSources: async () => {
			await c.refreshSources();
		},
		addSource: async (logicalName, content) => {
			await invoke(c.client, () => c.client.canon.addSource({ logicalName, content }));
			await c.refreshSources();
		},
		search: async (query) =>
			(
				await refreshRpcQuery({
					client: c.queryClient,
					key: ["canon", "search", c.currentCharacterId() ?? null, query],
					request: () => invoke(c.client, () => c.client.canon.search({ query })),
				})
			).chunks,
		removeSource: async (sourceId) => {
			await invoke(c.client, () => c.client.canon.removeSource({ sourceId }));
			await c.refreshSources();
		},
	};
}
