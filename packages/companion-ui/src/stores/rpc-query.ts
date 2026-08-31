import {
	createMutation,
	createQuery,
	hashKey,
	type QueryClient,
	type QueryKey,
} from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import { commitQueryValue, readQueryValue } from "./query-sync.js";

type MaybeAccessor<T> = T | Accessor<T>;
interface Refresh {
	promise: Promise<unknown>;
	dirty: boolean;
}
const refreshesByClient = new WeakMap<QueryClient, Map<string, Refresh>>();

export const queryKeys = {
	snapshot: ["snapshot"] as const,
	conversations: ["conversations"] as const,
	archivedConversations: ["conversations", "archived"] as const,
	conversation: (id: string) => ["conversation", id] as const,
	companionState: (conversationId: string) => ["companionState", conversationId] as const,
	settingsCapabilities: ["settings", "capabilities"] as const,
	runs: ["runs"] as const,
	characters: ["characters"] as const,
	characterPackage: (id: string) => ["character", "package", id] as const,
	characterDeletionStatus: (id: string) => ["character", "deletionStatus", id] as const,
	canonSources: (id?: string) => ["canon", "sources", id ?? null] as const,
	canonModules: (id?: string) => ["canon", "modules", id ?? null] as const,
	onboarding: ["onboarding"] as const,
	settings: ["settings"] as const,
	providers: ["providers"] as const,
	embeddingDownload: ["embedding", "download"] as const,
	providerLogin: (id: string) => ["providerLogin", id] as const,
	modelPool: ["models", "pool"] as const,
	modelDefaults: ["models", "defaults"] as const,
	systemModelDefaults: ["models", "systemDefaults"] as const,
	modelRoute: (id: string) => ["models", "route", id] as const,
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
	const refreshes = refreshesByClient.get(input.client) ?? new Map<string, Refresh>();
	refreshesByClient.set(input.client, refreshes);
	const refreshKey = hashKey(input.key);
	const existing = refreshes.get(refreshKey);
	if (existing) {
		existing.dirty = true;
		return existing.promise as Promise<T>;
	}
	const refresh: Refresh = { promise: Promise.resolve(), dirty: false };
	refreshes.set(refreshKey, refresh);
	refresh.promise = (async () => {
		let result!: T;
		let rejected = 0;
		do {
			refresh.dirty = false;
			await input.client.invalidateQueries(
				{
					queryKey: input.key,
					exact: true,
					refetchType: "none",
				},
				{ cancelRefetch: false },
			);
			const value = await input.request();
			if (!commitQueryValue(input.client, input.key, value)) {
				if (rejected >= 2) throw new Error("Host query could not commit a current revision");
				rejected += 1;
				refresh.dirty = true;
				continue;
			}
			result = value;
		} while (refresh.dirty);
		return result;
	})();
	try {
		return (await refresh.promise) as T;
	} finally {
		if (refreshes.get(refreshKey) === refresh) refreshes.delete(refreshKey);
	}
}
