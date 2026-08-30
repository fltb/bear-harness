import type { CompanionClient } from "@bear-harness/companion-client";
import type { MemoryCandidate as MemoryCandidateSchema } from "@bear-harness/protocol/schema";
import type { z } from "@bear-harness/schema";
import type { QueryClient } from "@tanstack/solid-query";
import { createMemo, type Setter } from "solid-js";
import type { MemoryListRequest, MemorySearchData } from "./ipc.js";
import { invoke } from "./ipc.js";
import { createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";
import type { MemoryApi } from "./supplementary-api.js";

type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export function createMemoryApi(c: {
	client: CompanionClient;
	queryClient: QueryClient;
	cacheRevision(): number;
	currentCharacterId(): string | undefined;
	activeCharacterId(): string | undefined;
	memoryProjectionKey(): readonly unknown[] | undefined;
	setMemoryProjectionKey(key: readonly unknown[]): void;
	candidateProjectionKey(): readonly unknown[] | undefined;
	setCandidateProjectionKey(key: readonly unknown[]): void;
	memoryRevision(): number;
	setMemoryRevision: Setter<number>;
	refreshEntries(): Promise<unknown>;
	refreshCandidates(): Promise<unknown>;
	requireActiveConversation(): string;
	onError(operation: string, error: unknown): void;
	clearError(): void;
}): MemoryApi {
	const bump = () => c.setMemoryRevision((value) => value + 1);
	const characterId = (value?: string) => value ?? c.activeCharacterId() ?? c.currentCharacterId();
	const memoryKey = (params?: MemoryListRequest) =>
		queryKeys.memoryProjection(
			params?.scope,
			undefined,
			params?.characterId ?? c.currentCharacterId(),
		);
	const requestList = (params?: MemoryListRequest) =>
		invoke(c.client, () =>
			c.client.memory.list({
				...params,
				...(characterId(params?.characterId)
					? { characterId: characterId(params?.characterId) }
					: {}),
			}),
		);
	const requestCandidates = (status?: MemoryCandidate["status"], id?: string) =>
		invoke(c.client, () =>
			c.client.memory.candidatesList({
				status,
				...(characterId(id) ? { characterId: characterId(id) } : {}),
			}),
		);
	const entries = createMemo(() => {
		c.cacheRevision();
		const selected = c.memoryProjectionKey();
		const key = selected?.[2] === (c.currentCharacterId() ?? null) ? selected : memoryKey();
		return c.queryClient.getQueryData<MemorySearchData>(key)?.entries;
	});
	const candidates = createMemo(() => {
		c.cacheRevision();
		const selected = c.candidateProjectionKey();
		const key =
			selected?.[2] === (c.currentCharacterId() ?? null)
				? selected
				: queryKeys.memoryCandidates(undefined, c.currentCharacterId());
		return c.queryClient.getQueryData<{ candidates: MemoryCandidate[] }>(key)?.candidates;
	});
	return {
		observeList: (scope, text, selectedCharacter) => {
			const query = createRpcQuery({
				client: c.queryClient,
				key: () =>
					queryKeys.memoryProjection(
						scope(),
						text().trim() || undefined,
						selectedCharacter?.() ?? c.currentCharacterId(),
					),
				request: (key) => {
					const [, , id, requestedScope, requestedText] = key as [
						string,
						string,
						string | null,
						Parameters<MemoryApi["search"]>[1],
						string | null,
					];
					return invoke(c.client, () =>
						requestedText
							? c.client.memory.search({
									query: requestedText,
									scope: requestedScope,
									...(id ? { characterId: id } : {}),
								})
							: c.client.memory.list({ scope: requestedScope, ...(id ? { characterId: id } : {}) }),
					);
				},
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		observeCandidates: (selectedCharacter, status) => {
			const query = createRpcQuery({
				client: c.queryClient,
				key: () =>
					queryKeys.memoryCandidates(status, selectedCharacter() ?? c.currentCharacterId()),
				request: (key) => requestCandidates(status, key[2] as string | undefined),
			});
			return { data: () => query.data, loading: () => query.isLoading, error: () => query.error };
		},
		listState: (scope, query, id) => {
			c.cacheRevision();
			const state = c.queryClient.getQueryState<MemorySearchData>(
				queryKeys.memoryProjection(scope, query || undefined, id ?? c.currentCharacterId()),
			);
			return {
				entries: state?.data?.entries ?? [],
				loading: state?.fetchStatus === "fetching",
				error: state?.error ? String(state.error) : null,
			};
		},
		candidateState: (status, id) => {
			c.cacheRevision();
			const state = c.queryClient.getQueryState<{ candidates: MemoryCandidate[] }>(
				queryKeys.memoryCandidates(status, id ?? c.currentCharacterId()),
			);
			return {
				candidates: state?.data?.candidates ?? [],
				loading: state?.fetchStatus === "fetching",
				error: state?.error ? String(state.error) : null,
			};
		},
		entries,
		candidates,
		revision: c.memoryRevision,
		list: async (params) => {
			const scoped = { ...params, characterId: params?.characterId ?? c.currentCharacterId() };
			const key = memoryKey(scoped);
			c.setMemoryProjectionKey(key);
			const data = await refreshRpcQuery({
				client: c.queryClient,
				key,
				request: () => requestList(scoped),
			});
			bump();
			return data.entries;
		},
		search: async (query, scope, id) => {
			const target = id ?? c.currentCharacterId();
			const key = queryKeys.memoryProjection(scope, query, target);
			c.setMemoryProjectionKey(key);
			const data = await refreshRpcQuery({
				client: c.queryClient,
				key,
				request: () =>
					invoke(c.client, () =>
						c.client.memory.search({ query, scope, ...(target ? { characterId: target } : {}) }),
					),
			});
			bump();
			return data.entries;
		},
		capture: async (entryId) => {
			try {
				const result = await invoke(c.client, () =>
					c.client.memory.capture({ conversationId: c.requireActiveConversation(), entryId }),
				);
				bump();
				c.clearError();
				void c.refreshEntries().catch((error) => c.onError("memory.capture", error));
				return result;
			} catch (error) {
				c.onError("memory.capture", error);
				throw error;
			}
		},
		configureLocalEmbedding: async (provider, candidateId, customPath) => {
			const result = await invoke(c.client, () =>
				c.client.memory.configureLocalEmbedding(
					provider === "local"
						? {
								provider,
								...(candidateId ? { candidateId } : {}),
								...(customPath ? { customPath } : {}),
							}
						: { provider },
				),
			);
			c.clearError();
			return result;
		},
		forget: async (entryId, id) => {
			await invoke(c.client, () =>
				c.client.memory.forget({
					entryId,
					...(characterId(id) ? { characterId: characterId(id) } : {}),
				}),
			);
			bump();
			void c.refreshEntries();
		},
		edit: async (entryId, newText, id) => {
			await invoke(c.client, () =>
				c.client.memory.edit({
					entryId,
					newText,
					...(characterId(id) ? { characterId: characterId(id) } : {}),
				}),
			);
			bump();
			void c.refreshEntries();
		},
		exclude: async (memoryId, excluded, id) => {
			await invoke(c.client, () =>
				c.client.memory.exclude({
					memoryId,
					excluded,
					...(characterId(id) ? { characterId: characterId(id) } : {}),
				}),
			);
			bump();
			void c.refreshEntries();
		},
		listCandidates: async (status, id) => {
			const target = id ?? c.currentCharacterId();
			const key = queryKeys.memoryCandidates(status, target);
			c.setCandidateProjectionKey(key);
			const data = await refreshRpcQuery({
				client: c.queryClient,
				key,
				request: () => requestCandidates(status, target),
			});
			bump();
			return data.candidates;
		},
		approveCandidate: async (candidateId, editedText, decidedScope, id) => {
			await invoke(c.client, () =>
				c.client.memory.candidateApprove({
					candidateId,
					editedText,
					decidedScope,
					...(characterId(id) ? { characterId: characterId(id) } : {}),
				}),
			);
			bump();
			void c.refreshCandidates();
			void c.refreshEntries();
		},
		rejectCandidate: async (candidateId, id) => {
			await invoke(c.client, () =>
				c.client.memory.candidateReject({
					candidateId,
					...(characterId(id) ? { characterId: characterId(id) } : {}),
				}),
			);
			bump();
			void c.refreshCandidates();
			void c.refreshEntries();
		},
	};
}
