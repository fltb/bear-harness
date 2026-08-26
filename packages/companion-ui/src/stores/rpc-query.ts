import {
	createMutation,
	createQuery,
	hashKey,
	type QueryClient,
	type QueryKey,
} from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { commitQueryValue, readQueryValue } from "./query-sync.js";

interface Refresh {
	promise: Promise<unknown>;
	dirty: boolean;
}
const inFlightRefreshes = new WeakMap<QueryClient, Map<string, Refresh>>();

type MaybeAccessor<T> = T | Accessor<T>;

export const queryKeys = {
	snapshot: ["snapshot"] as const,
	conversations: ["conversations"] as const,
	activeConversation: ["conversation", "active"] as const,
	conversationProjection: (conversationId: string, sessionId?: string) =>
		["conversation", "projection", conversationId, sessionId ?? null] as const,
	memory: ["memory"] as const,
	memoryProjection: (scope?: string, query?: string, characterId?: string) =>
		["memory", "projection", characterId ?? null, scope ?? null, query ?? null] as const,
	memoryCandidates: (status?: string, characterId?: string) =>
		["memory", "candidates", characterId ?? null, status ?? null] as const,
	settingsCapabilities: ["settings", "capabilities"] as const,
	runs: ["runs"] as const,
	characters: ["characters"] as const,
	characterPackage: (characterId: string) => ["character", "package", characterId] as const,
	canonSources: (characterId?: string) => ["canon", "sources", characterId ?? null] as const,
	canonModules: (characterId?: string) => ["canon", "modules", characterId ?? null] as const,
	onboarding: ["onboarding"] as const,
	settings: ["settings"] as const,
	providers: ["providers"] as const,
	embeddingDownload: ["embedding", "download"] as const,
	providerLogin: (providerId: string) => ["providerLogin", providerId] as const,
	modelPool: ["models", "pool"] as const,
	modelDefaults: ["models", "defaults"] as const,
	modelRoute: (conversationId: string) => ["models", "route", conversationId] as const,
};

export function createRpcQuery<T>(input: {
	client: QueryClient;
	key: MaybeAccessor<QueryKey>;
	request: (key: QueryKey) => Promise<T>;
	initialData?: T;
	enabled?: MaybeAccessor<boolean>;
}) {
	return createQuery(
		() => ({
			queryKey: typeof input.key === "function" ? (input.key as Accessor<QueryKey>)() : input.key,
			queryFn: ({ queryKey }) =>
				readQueryValue(input.client, queryKey, () => input.request(queryKey)),
			structuralSharing: false,
			initialData: input.initialData,
			enabled:
				input.enabled === undefined
					? undefined
					: typeof input.enabled === "function"
						? (input.enabled as Accessor<boolean>)()
						: input.enabled,
		}),
		() => input.client,
	);
}

export function createRpcMutation<TVariables, TResult = unknown>(input: {
	client: QueryClient;
	request: (variables: TVariables) => Promise<TResult>;
	invalidates: readonly QueryKey[];
	onSuccess?: (result: TResult, variables: TVariables) => void | Promise<void>;
}) {
	return createMutation(
		() => ({
			mutationFn: input.request,
			onSuccess: async (result, variables) => {
				await input.onSuccess?.(result, variables);
				await Promise.all(
					input.invalidates.map((queryKey) => input.client.invalidateQueries({ queryKey })),
				);
			},
		}),
		() => input.client,
	);
}

export function hydrateRpcQuery<T>(client: QueryClient, key: QueryKey, value: T): void {
	commitQueryValue(client, key, value);
}

export async function refreshRpcQuery<T>(input: {
	client: QueryClient;
	key: QueryKey;
	request: () => Promise<T>;
}): Promise<T> {
	const refreshes = inFlightRefreshes.get(input.client) ?? new Map<string, Refresh>();
	inFlightRefreshes.set(input.client, refreshes);
	const refreshKey = hashKey(input.key);
	const existing = refreshes.get(refreshKey);
	if (existing) {
		existing.dirty = true;
		return existing.promise as Promise<T>;
	}
	const refresh: Refresh = { promise: Promise.resolve(), dirty: false };
	refreshes.set(refreshKey, refresh);
	refresh.promise = (async () => {
		let result: T;
		do {
			refresh.dirty = false;
			await input.client.invalidateQueries({
				queryKey: input.key,
				exact: true,
				refetchType: "none",
			});
			result = await input.client.fetchQuery({
				queryKey: input.key,
				queryFn: () => readQueryValue(input.client, input.key, input.request),
				structuralSharing: false,
				staleTime: 0,
			});
			// A new explicit request during this read is not swallowed. This is
			// an event-driven trailing refresh, with no timer or periodic polling.
		} while (refresh.dirty);
		return result;
	})();
	try {
		return (await refresh.promise) as T;
	} finally {
		if (refreshes.get(refreshKey) === refresh) refreshes.delete(refreshKey);
	}
}
