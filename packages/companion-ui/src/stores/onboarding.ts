import type { CompanionClient } from "@bear-harness/companion-client";
import { OnboardingResponse } from "@bear-harness/protocol/schema";
import { QueryClient } from "@tanstack/solid-query";
import type { DomainEvent, OnboardingData } from "./ipc.js";
import { invoke } from "./ipc.js";
import { createRpcQuery, queryKeys, refreshRpcQuery } from "./rpc-query.js";

const INITIAL_ONBOARDING: OnboardingData = {
	status: "active",
	eventSeq: 0,
	stateData: { schema_version: 1, flow_version: 1, answers: {}, decisions: {} },
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
	/** @internal apply an `onboarding.*` domain event; used by createCompanionStore. */
	_applyEvent(event: DomainEvent): void;
}

/**
 * Query-backed wrapper for the Host-owned onboarding projection.
 *
 * Onboarding is persistent Host state, so it deliberately has no local
 * resource/signal shadow. Snapshot hydration, direct RPC results, and domain
 * events all commit to the same QueryClient entry.
 */
export function createOnboardingStore(
	client: CompanionClient,
	queryClient: QueryClient = new QueryClient(),
): OnboardingStore {
	const hostRequest = () => invoke(client, () => client.onboarding.get());
	let projectionGeneration = 0;
	let protectedGeneration: number | undefined;
	const request = async (): Promise<OnboardingData> => {
		const generation = projectionGeneration;
		const value = await hostRequest();
		const current = queryClient.getQueryData<OnboardingData>(queryKeys.onboarding);
		if (
			generation !== projectionGeneration ||
			(protectedGeneration === generation && current !== undefined)
		) {
			return current ?? value;
		}
		return value;
	};
	const query = createRpcQuery({
		client: queryClient,
		key: queryKeys.onboarding,
		request,
		initialData: INITIAL_ONBOARDING,
	});

	const data = (): OnboardingData => {
		// Observe the Solid Query result so consumers rerun after cache writes, but
		// read the cache itself so a snapshot projection is visible immediately.
		const observedData = query.data;
		return queryClient.getQueryData<OnboardingData>(queryKeys.onboarding) ?? observedData ?? INITIAL_ONBOARDING;
	};
	const commit = (value: OnboardingData, force = false): void => {
		const current = queryClient.getQueryData<OnboardingData>(queryKeys.onboarding);
		if (!force && current !== undefined && value.eventSeq < current.eventSeq) return;
		projectionGeneration += 1;
		queryClient.setQueryData(queryKeys.onboarding, value);
		if (force) protectedGeneration = projectionGeneration;
	};

	return {
		data,
		loading: () => query.isLoading,
		error: () => query.error,
		refetch: () => {
			protectedGeneration = undefined;
			void refreshRpcQuery({ client: queryClient, key: queryKeys.onboarding, request });
		},
		get: hostRequest,
		resync: async () => {
			protectedGeneration = undefined;
			commit(await refreshRpcQuery({ client: queryClient, key: queryKeys.onboarding, request }));
		},
		submit: async (stepId, answer) => {
			const result = await invoke(client, () => client.onboarding.submit({ stepId, answer }));
			commit(result, true);
		},
		_hydrate: (value) => {
			if (value !== undefined) commit(value);
		},
		_applyEvent: (event) => {
			if (event.kind === "onboarding.state_changed") {
				const payload =
					typeof event.payload === "object" && event.payload !== null
						? { ...event.payload, eventSeq: event.seq }
						: event.payload;
				commit(OnboardingResponse.parse(payload));
				return;
			}
			if (event.kind === "onboarding.reset") {
				projectionGeneration += 1;
				const generation = projectionGeneration;
				void client.onboarding
					.get()
					.then((response) => {
						if (generation !== projectionGeneration || !response.ok) return;
						commit(response.data);
					})
					.catch(() => undefined);
			}
		},
	};
}
