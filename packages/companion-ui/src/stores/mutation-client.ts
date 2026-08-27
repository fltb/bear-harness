import type { CompanionClient } from "@bear-harness/companion-client";
import { RPC } from "@bear-harness/protocol/schema";
import type { QueryClient } from "@tanstack/solid-query";

const wrapped = new WeakMap<object, { source: CompanionClient; cache: QueryClient }>();
const clients = new WeakMap<QueryClient, WeakMap<CompanionClient, CompanionClient>>();

/** Every command crosses MutationCache, including imperative feature APIs.
 * Request secrets stay in the in-flight closure, never Mutation variables/keys.
 * Domain failures still resolve as envelopes at the CompanionClient boundary.
 */
export function withRpcMutations(client: CompanionClient, cache: QueryClient): CompanionClient {
	const owner = wrapped.get(client);
	if (owner?.cache === cache) return client;
	if (owner) client = owner.source;
	let byClient = clients.get(cache);
	if (!byClient) {
		byClient = new WeakMap();
		clients.set(cache, byClient);
	}
	const existing = byClient.get(client);
	if (existing) return existing;
	const visit = (source: object, contracts: object): object =>
		Object.fromEntries(
			Object.entries(source).map(([name, value]) => {
				const contract = (contracts as Record<string, unknown>)[name];
				if (!contract || typeof contract !== "object") return [name, value];
				if ("kind" in contract && contract.kind === "rpc") {
					if (!("operation" in contract) || contract.operation !== "mutation")
						return [
							name,
							(...args: unknown[]) =>
								(source as Record<string, (...input: unknown[]) => unknown>)[name]!(...args),
						];
					return [
						name,
						async (...args: unknown[]) => {
							let pending: (() => Promise<unknown>) | undefined = () =>
								(source as Record<string, (...input: unknown[]) => Promise<unknown>>)[name]!(
									...args,
								);
							// Drop argument references once the command settles, including OAuth answers.
							const mutation = cache.getMutationCache().build(cache, {
								mutationKey: ["rpcMutation", "channel" in contract ? contract.channel : name],
								retry: false,
								gcTime: 0,
								mutationFn: async () => {
									try {
										const result = await pending?.();
										if (
											result &&
											typeof result === "object" &&
											"ok" in result &&
											result.ok === false
										)
											throw result;
										return result;
									} finally {
										pending = undefined;
										args.length = 0;
									}
								},
							});
							try {
								return await mutation.execute(undefined);
							} catch (error) {
								if (error && typeof error === "object" && "ok" in error && error.ok === false)
									return error;
								throw error;
							}
						},
					];
				}
				return [name, visit(value, contract)];
			}),
		);
	const result = visit(client, RPC) as CompanionClient;
	wrapped.set(result, { source: client, cache });
	byClient.set(client, result);
	return result;
}
