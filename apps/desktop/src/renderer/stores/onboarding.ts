/**
 * Onboarding store: reactive wrapper for the first-meeting FSM IPC calls.
 *
 * The bridge exposes `onboarding.get/setName/setRelation/setMemoryDecision`
 * (and, once the host lands it, `onboarding.advance`). State arrives from
 * the `get` response and is patched by `onboarding.state_changed` /
 * `onboarding.reset` domain events; `advance` is an idempotent re-fetch
 * until the host channel exists.
 *
 * Projection precedence: the `applied` signal holds the last authoritative
 * value written by the boot snapshot (`_hydrate`) or a domain event
 * (`_applyEvent`). `data()` prefers `applied` over the resource so that an
 * event delivered while the initial `get` is still in flight is never
 * clobbered by the fetch resolution (Solid's resource lets a pending fetch
 * overwrite an intervening `mutate`). Explicit user-action refetches clear
 * `applied` so the fresh `get` result becomes authoritative again.
 */

import { createResource, createSignal } from "solid-js";
import type { DomainEvent, OnboardingData, OnboardingStep, RelationKind } from "./ipc.js";
import { invoke, isOnboardingData, isOnboardingStep, isRecord } from "./ipc.js";

const INITIAL_ONBOARDING: OnboardingData = { state: "door_closed" };

export interface OnboardingStore {
	/** Reactive snapshot of the first-meeting FSM state (store proxy). */
	data(): OnboardingData;
	/** Convenience: current FSM step ("door_closed" before the first load). */
	state(): OnboardingStep;
	loading(): boolean;
	error(): unknown;
	/** Re-fetch the authoritative onboarding state. */
	refetch(): void;
	get(): Promise<OnboardingData>;
	setName(name: string): Promise<void>;
	setRelation(kind: RelationKind): Promise<void>;
	setMemoryDecision(enabled: boolean): Promise<void>;
	/** Host-driven step forward; falls back to a re-fetch while the channel is absent. */
	advance(): Promise<void>;
	/** @internal hydrate from the boot snapshot; used by createCompanionStore. */
	_hydrate(value: unknown): void;
	/** @internal apply an `onboarding.*` domain event; used by createCompanionStore. */
	_applyEvent(event: DomainEvent): void;
}

export function createOnboardingStore(): OnboardingStore {
	const [resource, actions] = createResource<OnboardingData>(
		() => invoke(() => window.bearDesktop.companion.onboarding.get()),
		{ initialValue: INITIAL_ONBOARDING },
	);

	// Last authoritative projection from snapshot/events; wins over the
	// resource's fetch result (which may resolve after a mutation and
	// otherwise clobber it — see the module doc comment).
	const [applied, setApplied] = createSignal<OnboardingData | undefined>(undefined);

	const data = (): OnboardingData =>
		applied() ??
		(resource.error !== undefined ? INITIAL_ONBOARDING : resource.latest ?? INITIAL_ONBOARDING);

	return {
		data,
		state: () => data().state,
		loading: () => resource.loading,
		error: () => resource.error,
		refetch: () => {
			setApplied(undefined);
			void actions.refetch();
		},
		get: () => invoke(() => window.bearDesktop.companion.onboarding.get()),
		setName: async (name) => {
			await invoke<void>(() => window.bearDesktop.companion.onboarding.setName(name));
			setApplied(undefined);
			void actions.refetch();
		},
		setRelation: async (kind) => {
			await invoke<void>(() => window.bearDesktop.companion.onboarding.setRelation(kind));
			setApplied(undefined);
			void actions.refetch();
		},
		setMemoryDecision: async (enabled) => {
			await invoke<void>(() => window.bearDesktop.companion.onboarding.setMemoryDecision(enabled));
			setApplied(undefined);
			void actions.refetch();
		},
		advance: async () => {
			const bridge = window.bearDesktop.companion.onboarding as unknown as {
				advance?: () => Promise<unknown>;
			};
			const advance = bridge.advance;
			if (typeof advance === "function") {
				await invoke<void>(() => advance());
			} else {
				// onboarding.advance:v1 not wired yet — re-fetching is idempotent.
				await invoke(() => window.bearDesktop.companion.onboarding.get());
			}
			setApplied(undefined);
			void actions.refetch();
		},
		_hydrate: (value) => {
			if (isOnboardingData(value)) {
				// The snapshot is the boot-time projection; it must never clobber a
				// newer event that already applied (the event loop can deliver
				// before the snapshot effect settles).
				if (applied() === undefined) setApplied(value);
				actions.mutate(value);
			}
		},
		_applyEvent: (event) => {
			if (event.kind === "onboarding.state_changed" && isRecord(event.payload)) {
				const next = event.payload.state;
				if (isOnboardingStep(next)) {
					setApplied({ ...data(), state: next });
				}
			} else if (event.kind === "onboarding.reset") {
				setApplied(undefined);
				void actions.refetch();
			}
		},
	};
}
