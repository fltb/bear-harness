import type { CompanionClient } from "@bear-harness/companion-client";
import type { QueryClient } from "@tanstack/solid-query";
import { type Accessor, createMemo } from "solid-js";
import type {
	CanonChunk,
	CanonModule,
	CanonSource,
	CharacterDeletionStatus,
	CharacterListData,
	CharacterPackageDocument,
	CharacterSummary,
} from "./ipc.js";
import { invoke } from "./ipc.js";
import { createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";
import type { CanonApi, CharacterApi } from "./supplementary-api.js";

interface CharacterApiContext {
	client: CompanionClient;
	queryClient: QueryClient;
	cacheRevision(): number;
	currentCharacterId(): string | undefined;
	characters: Accessor<CharacterSummary[]>;
	refreshCharacters(): Promise<unknown>;
	refreshSnapshot(): Promise<unknown>;
	resyncOnboarding(): Promise<unknown>;
	switchCharacterConversations(): Promise<unknown>;
	invalidateConversations(): Promise<unknown> | void;
	invalidateActiveConversation(): Promise<unknown> | void;
}

export function createCharacterApi(c: CharacterApiContext): CharacterApi {
	const { client, queryClient } = c;
	const api: CharacterApi = {
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
			createRpcQuery({
				client: queryClient,
				key: () => ["settings", "character", characterId() ?? ""],
				enabled,
				request: (key) =>
					invoke(client, () => client.settings.get({ characterId: key[2] as string })),
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
				request: () => invoke(client, () => client.character.list()),
			}),
		activate: async (characterId) => {
			await invoke(client, () => client.character.activate({ characterId }));
			await c.switchCharacterConversations();
			await Promise.all([c.resyncOnboarding(), c.refreshCharacters(), c.refreshSnapshot()]);
		},
		import: async (files) => {
			await invoke(client, () => client.character.import({ files }));
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
			queryClient.removeQueries({ queryKey: ["settings", "character", characterId], exact: true });
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
		draftCreate: async (params = {}) =>
			api.draftGet((await invoke(client, () => client.character.draftCreate(params))).draft.id),
		draftGet: async (id) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: ["character", "draft", id],
					request: () => invoke(client, () => client.character.draftGet({ id })),
				})
			).draft,
		draftPatch: async (id, expectedRevision, files) =>
			api.draftGet(
				(await invoke(client, () => client.character.draftPatch({ id, expectedRevision, files })))
					.draft.id,
			),
		draftUploadAssets: async (id, expectedRevision, assets) =>
			api.draftGet(
				(
					await invoke(client, () =>
						client.character.draftUploadAssets({ id, expectedRevision, assets }),
					)
				).draft.id,
			),
		draftListRevisions: async (id) =>
			(
				await refreshRpcQuery({
					client: queryClient,
					key: ["character", "draftRevisions", id],
					request: () => invoke(client, () => client.character.draftListRevisions({ id })),
				})
			).revisions,
		draftRestoreRevision: async (id, expectedRevision, sourceRevision) =>
			api.draftGet(
				(
					await invoke(client, () =>
						client.character.draftRestoreRevision({ id, expectedRevision, sourceRevision }),
					)
				).draft.id,
			),
		draftValidate: async (id, expectedRevision) =>
			api.draftGet(
				(await invoke(client, () => client.character.draftValidate({ id, expectedRevision }))).draft
					.id,
			),
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
			return api.draftGet(draft.id);
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
	canonModules: { data?: { modules: CanonModule[] } };
	refreshSources(): Promise<unknown>;
	refreshModules(): Promise<unknown>;
}
export function createCanonApi(c: CanonApiContext): CanonApi {
	const sources = createMemo(() => c.canonSources.data?.sources ?? []);
	const modules = createMemo(() => c.canonModules.data?.modules ?? []);
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
		modules,
		listSources: async () => {
			await c.refreshSources();
		},
		addSource: async (logicalName, content) => {
			await invoke(c.client, () =>
				c.client.canon.addSource({ logicalName, content, characterId: c.currentCharacterId() }),
			);
			await c.refreshSources();
		},
		search: async (query) =>
			(
				await refreshRpcQuery({
					client: c.queryClient,
					key: ["canon", "search", c.currentCharacterId() ?? null, query],
					request: () =>
						invoke(c.client, () =>
							c.client.canon.search({ query, characterId: c.currentCharacterId() }),
						),
				})
			).chunks,
		removeSource: async (sourceId) => {
			await invoke(c.client, () =>
				c.client.canon.removeSource({ sourceId, characterId: c.currentCharacterId() }),
			);
			await c.refreshSources();
		},
		listModules: async () => {
			await c.refreshModules();
		},
		upsertModule: async (params) => {
			await invoke(c.client, () =>
				c.client.canon.upsertModule({ ...params, characterId: c.currentCharacterId() }),
			);
			await c.refreshModules();
		},
		deleteModule: async (id) => {
			await invoke(c.client, () =>
				c.client.canon.deleteModule({ id, characterId: c.currentCharacterId() }),
			);
			await c.refreshModules();
		},
	};
}
