import {
	createMutation,
	createQuery,
	type QueryClient,
	type QueryKey,
} from "@tanstack/solid-query";

export const queryKeys = {
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
	await input.client.invalidateQueries({ queryKey: input.key, refetchType: "none" });
	return input.client.fetchQuery({ queryKey: input.key, queryFn: input.request });
}
