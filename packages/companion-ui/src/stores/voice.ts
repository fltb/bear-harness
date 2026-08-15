/**
 * Voice stack store: reactive state for the voice-stack IPC calls.
 *
 * The injected `CompanionClient` exposes `voice.list` and `voice.switch`;
 * state arrives from the `list` response, the boot snapshot, and `voice.*`
 * domain events (`voice.stack_switched` / `voice.stack_pinned`), which
 * re-fetch the list so the active stack is always current.
 *
 * Projection precedence: the `applied` signal holds the last authoritative
 * value written by the boot snapshot (`_hydrate`). `data()` prefers
 * `applied` over the resource so a snapshot projection is never clobbered
 * by the initial `list` fetch resolving afterwards (Solid's resource lets a
 * pending fetch overwrite an intervening `mutate`). Explicit refetches
 * (list, switch, `voice.*` events) clear `applied` so the fresh fetch
 * result becomes authoritative again.
 */

import type { CompanionClient } from "@bear-harness/companion-types";
import { createResource, createSignal } from "solid-js";
import type { DomainEvent, VoiceListData, VoiceStack, VoiceSwitchScope } from "./ipc.js";
import { invoke, normalizeVoiceList } from "./ipc.js";

const INITIAL_VOICE: VoiceListData = { stacks: [] };

export interface VoiceStore {
	/** Reactive voice stack list (store value, stable shape). */
	data(): VoiceListData;
	stacks(): VoiceStack[];
	activeStackId(): string | undefined;
	loading(): boolean;
	error(): unknown;
	refetch(): void;
	list(): Promise<VoiceListData>;
	switch(stackId: string, scope: VoiceSwitchScope): Promise<void>;
	/** @internal hydrate from the boot snapshot; used by createCompanionStore. */
	_hydrate(value: unknown): void;
	/** @internal apply a `voice.*` domain event; used by createCompanionStore. */
	_applyEvent(event: DomainEvent): void;
}

export function createVoiceStore(client: CompanionClient): VoiceStore {
	const [resource, actions] = createResource<VoiceListData>(
		() => invoke(client, () => client.voice.list()),
		{ initialValue: INITIAL_VOICE },
	);

	// Last authoritative projection from the snapshot; wins over the
	// resource's fetch result (which may resolve after a mutation and
	// otherwise clobber it — see the module doc comment).
	const [applied, setApplied] = createSignal<VoiceListData | undefined>(undefined);

	const data = (): VoiceListData =>
		applied() ??
		(resource.error !== undefined ? INITIAL_VOICE : (resource.latest ?? INITIAL_VOICE));

	const refetch = (): void => {
		setApplied(undefined);
		void actions.refetch();
	};

	return {
		data,
		stacks: () => data().stacks,
		activeStackId: () => data().stacks.find((stack) => stack.active)?.id,
		loading: () => resource.loading,
		error: () => resource.error,
		refetch,
		list: () => invoke(client, () => client.voice.list()),
		switch: async (stackId, scope) => {
			await invoke<void>(client, () => client.voice.switch(stackId, scope));
			refetch();
		},
		_hydrate: (value) => {
			const parsed = normalizeVoiceList(value);
			if (parsed) {
				setApplied(parsed);
				actions.mutate(parsed);
			}
		},
		_applyEvent: () => {
			refetch();
		},
	};
}
