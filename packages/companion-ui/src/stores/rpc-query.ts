import {
	createMutation,
	createQuery,
	type QueryClient,
	type QueryKey,
} from "@tanstack/solid-query";

export const queryKeys = {
	settings: ["settings"] as const,
	providers: ["providers"] as const,
	voice: ["voice"] as const,
};

export function createRpcQuery<T>(input: {
	client: QueryClient;
	key: QueryKey;
	request: () => Promise<T>;
	initialData?: T;
}) {
	return createQuery(
		() => ({
			queryKey: input.key,
			queryFn: input.request,
			initialData: input.initialData,
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
					input.invalidates.map((queryKey) => input.client.invalidateQueries({ queryKey })),
				);
			},
		}),
		() => input.client,
	);
}

export function hydrateRpcQuery<T>(client: QueryClient, key: QueryKey, value: T): void {
	client.setQueryData(key, value);
}
