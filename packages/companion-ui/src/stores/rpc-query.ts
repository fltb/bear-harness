import {
	createMutation,
	createQuery,
	type QueryClient,
	type QueryKey,
} from "@tanstack/solid-query";

export const queryKeys = {
	snapshot: ["snapshot"] as const,
	conversations: ["conversations"] as const,
	memory: ["memory"] as const,
	memoryProjection: (scope?: string, query?: string) =>
		["memory", "projection", scope ?? null, query ?? null] as const,
	memoryCandidates: (status?: string) => ["memory", "candidates", status ?? null] as const,
	runs: ["runs"] as const,
	commissions: ["commissions"] as const,
	artifacts: ["artifacts"] as const,
	storyChanges: ["story", "changes"] as const,
	storyProposals: ["story", "proposals"] as const,
	characters: ["characters"] as const,
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
	key: QueryKey;
	request: () => Promise<T>;
	initialData?: T;
	enabled?: boolean;
}) {
	return createQuery(
		() => ({
			queryKey: input.key,
			queryFn: input.request,
			initialData: input.initialData,
			enabled: input.enabled,
		}),
		() => input.client,
	);
}

export function createRpcMutation<TVariables>(input: {
	client: QueryClient;
	request: (variables: TVariables) => Promise<unknown>;
	invalidates: readonly QueryKey[];
}) {
	return createMutation(
		() => ({
			mutationFn: input.request,
			onSuccess: async () => {
				await Promise.all(
					input.invalidates.map((queryKey) =>
						input.client.invalidateQueries({ queryKey }, { cancelRefetch: false }),
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
	const value = await input.request();
	input.client.setQueryData(input.key, value);
	return value;
}
