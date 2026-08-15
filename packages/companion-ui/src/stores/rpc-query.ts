import type { z } from "@bear-harness/schema";
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

type RpcSchema<T> = z.ZodType<T>;

export function createRpcQuery<T>(input: {
	client: QueryClient;
	key: QueryKey;
	request: () => Promise<unknown>;
	schema: RpcSchema<T>;
	initialData?: T;
}) {
	return createQuery(
		() => ({
			queryKey: input.key,
			queryFn: async () => input.schema.parse(await input.request()),
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

export function hydrateRpcQuery<T>(
	client: QueryClient,
	key: QueryKey,
	schema: RpcSchema<T>,
	value: unknown,
): void {
	const parsed = schema.safeParse(value);
	if (parsed.success) client.setQueryData(key, parsed.data);
}
