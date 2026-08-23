import { type Accessor } from "solid-js";
import {
	createMutation,
	createQuery,
	type QueryClient,
	type QueryKey,
} from "@tanstack/solid-query";

const inFlightRefreshes = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();

type MaybeAccessor<T> = T | Accessor<T>;

export const queryKeys = {
	snapshot: ["snapshot"] as const,
	conversations: ["conversations"] as const,
	activeConversation: ["conversation", "active"] as const,
	conversationProjection: (conversationId: string, sessionId?: string) =>
		["conversation", "projection", conversationId, sessionId ?? null] as const,
	memory: ["memory"] as const,
	memoryProjection: (scope?: string, query?: string) =>
		["memory", "projection", scope ?? null, query ?? null] as const,
	memoryCandidates: (status?: string) => ["memory", "candidates", status ?? null] as const,
	settingsCapabilities: ["settings", "capabilities"] as const,
	runs: ["runs"] as const,
	commissions: ["commissions"] as const,
	artifacts: ["artifacts"] as const,
	characters: ["characters"] as const,
	characterPackage: (characterId: string) => ["character", "package", characterId] as const,
	canonSources: ["canon", "sources"] as const,
	canonModules: ["canon", "modules"] as const,
	onboarding: ["onboarding"] as const,
	settings: ["settings"] as const,
	providers: ["providers"] as const,
	modelPool: ["models", "pool"] as const,
	modelDefaults: ["models", "defaults"] as const,
	modelRoute: (conversationId: string) => ["models", "route", conversationId] as const,
};

export function createRpcQuery<T>(input: {
	client: QueryClient;
	key: MaybeAccessor<QueryKey>;
	request: () => Promise<T>;
	initialData?: T;
	enabled?: MaybeAccessor<boolean>;
}) {
	return createQuery(
		() => ({
			queryKey:
				typeof input.key === "function" ? (input.key as Accessor<QueryKey>)() : input.key,
			queryFn: input.request,
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
					input.invalidates.map((queryKey) =>
						input.client.invalidateQueries({ queryKey }),
					),
				);
			},
		}),
		() => input.client,
	);
}

export function hydrateRpcQuery<T>(client: QueryClient, key: QueryKey, value: T): void {
	client.setQueryData(key, value);
}

export async function refreshRpcQuery<T>(input: {
	client: QueryClient;
	key: QueryKey;
	request: () => Promise<T>;
}): Promise<T> {
	const refreshes = inFlightRefreshes.get(input.client) ?? new Map<string, Promise<unknown>>();
	inFlightRefreshes.set(input.client, refreshes);
	const refreshKey = JSON.stringify(input.key);
	const existing = refreshes.get(refreshKey);
	if (existing) return existing as Promise<T>;
	const refresh = (async () => {
		await input.client.invalidateQueries({
			queryKey: input.key,
			exact: true,
			refetchType: "none",
		});
		return input.client.fetchQuery({
			queryKey: input.key,
			queryFn: input.request,
			staleTime: 0,
		});
	})();
	refreshes.set(refreshKey, refresh);
	try {
		return await refresh;
	} finally {
		if (refreshes.get(refreshKey) === refresh) refreshes.delete(refreshKey);
	}
}
