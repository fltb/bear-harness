import type { CompanionClient } from "@bear-harness/companion-types";
import { createResource, createSignal } from "solid-js";
import type { DomainEvent, OnboardingData } from "./ipc.js";
import { invoke, isOnboardingData } from "./ipc.js";

const INITIAL_ONBOARDING: OnboardingData = {
	status: "active",
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
	_hydrate(value: unknown): void;
	/** @internal apply an `onboarding.*` domain event; used by createCompanionStore. */
	_applyEvent(event: DomainEvent): void;
}

/**
 * Reactive client wrapper for a Host-owned, role-defined onboarding flow.
 * The Host returns the next authoritative step with every submission, so the
 * renderer never guesses a transition or temporarily projects stale state.
 */
export function createOnboardingStore(client: CompanionClient): OnboardingStore {
	const [resource, actions] = createResource<OnboardingData>(
		() => invoke(client, () => client.onboarding.get()),
		{ initialValue: INITIAL_ONBOARDING },
	);
	const [applied, setApplied] = createSignal<OnboardingData | undefined>(undefined);

	const data = (): OnboardingData =>
		applied() ??
		(resource.error !== undefined ? INITIAL_ONBOARDING : (resource.latest ?? INITIAL_ONBOARDING));
	const apply = (value: unknown): void => {
		if (isOnboardingData(value)) {
			setApplied(value);
			actions.mutate(value);
			return;
		}
		setApplied(undefined);
		void actions.refetch();
	};

	const get = (): Promise<OnboardingData> => invoke(client, () => client.onboarding.get());

	return {
		data,
		loading: () => resource.loading,
		error: () => resource.error,
		refetch: () => {
			setApplied(undefined);
			void actions.refetch();
		},
		get,
		resync: async () => apply(await get()),
		submit: async (stepId, answer) => {
			const result = await invoke<unknown>(client, () => client.onboarding.submit(stepId, answer));
			apply(result);
		},
		_hydrate: apply,
		_applyEvent: (event) => {
			if (event.kind === "onboarding.state_changed") {
				apply(event.payload);
				return;
			}
			if (event.kind === "onboarding.reset") {
				setApplied(undefined);
				void actions.refetch();
			}
		},
	};
}
