import type { CompanionClient } from "@bear-harness/companion-client";
import { QueryClient } from "@tanstack/solid-query";
import { IpcInvocationError } from "../lib/ipc.js";
import type { OnboardingData } from "./ipc.js";
import { invoke } from "./ipc.js";
import { withRpcMutations } from "./mutation-client.js";
import { createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";

const INITIAL_ONBOARDING: OnboardingData = {
	status: "complete",
	stateData: { answers: {} },
};

export interface OnboardingStore {
	data(): OnboardingData;
	loading(): boolean;
	error(): unknown;
	refetch(): void;
	get(): Promise<OnboardingData>;
	resync(): Promise<void>;
	submit(stepId: string, answer?: string): Promise<void>;
	/** @internal hydrate from the boot snapshot; used by createCompanionStore. */
	_hydrate(value: OnboardingData | undefined): void;
}

/**
 * Query-backed wrapper for the Host-owned onboarding projection.
 *
 * Onboarding is persistent Host state, so it deliberately has no local
 * resource/signal shadow. Snapshot hydration and direct RPC results commit to
 * the same QueryClient entry.
 */
export function createOnboardingStore(
	client: CompanionClient,
	queryClient: QueryClient = new QueryClient(),
): OnboardingStore {
	client = withRpcMutations(client, queryClient);
	const hostRequest = () => invoke(client, () => client.onboarding.get());
	const request = hostRequest;
	const query = createRpcQuery({
		client: queryClient,
		key: queryKeys.onboarding,
		request,
	});

	const data = (): OnboardingData => {
		// Observe the Solid Query result so consumers rerun after cache writes, but
		// read the cache itself so a snapshot projection is visible immediately.
		const observedData = query.data;
		return (
			queryClient.getQueryData<OnboardingData>(queryKeys.onboarding) ??
			observedData ??
			INITIAL_ONBOARDING
		);
	};
	const commit = (value: OnboardingData): void => {
		queryClient.setQueryData(queryKeys.onboarding, value);
	};

	return {
		data,
		loading: () => query.isLoading,
		error: () => query.error,
		refetch: () => {
			void refreshRpcQuery({ client: queryClient, key: queryKeys.onboarding, request }).catch(
				() => undefined,
			);
		},
		get: hostRequest,
		resync: async () => {
			commit(await refreshRpcQuery({ client: queryClient, key: queryKeys.onboarding, request }));
		},
		submit: async (stepId, answer) => {
			try {
				const result = await invoke(client, () => client.onboarding.submit({ stepId, answer }));
				commit(result);
			} catch (cause) {
				if (!(cause instanceof IpcInvocationError) || cause.kind !== "conflict") throw cause;
				commit(await hostRequest());
			}
		},
		_hydrate: (value) => {
			if (value !== undefined) commit(value);
		},
	};
}
