import {
	isMutationResponse,
	responseRequestSequence,
	responseRevision,
} from "@bear-harness/companion-client";
import type { SyncRevision } from "@bear-harness/protocol";
import { CancelledError, hashKey, type QueryClient, type QueryKey } from "@tanstack/solid-query";

interface Entry {
	accepted: number;
	required: number;
}
interface Coordinator {
	epoch?: string;
	epochRequest: number;
	retired: Set<string>;
	entries: Map<string, Entry>;
}
const coordinators = new WeakMap<QueryClient, Coordinator>();
function coordinator(client: QueryClient): Coordinator {
	let state = coordinators.get(client);
	if (!state) {
		state = { retired: new Set(), entries: new Map(), epochRequest: -1 };
		coordinators.set(client, state);
		client.getQueryCache().subscribe((event) => {
			if (event.type === "removed") {
				coordinator(client).entries.delete(event.query.queryHash);
				return;
			}
			if (event.type !== "updated" || event.action.type !== "success") return;
			const current = coordinator(client);
			const record = current.entries.get(event.query.queryHash);
			if (record && record.required > record.accepted) {
				void client.invalidateQueries(
					{ queryKey: event.query.queryKey, exact: true, refetchType: "all" },
					{ cancelRefetch: false },
				);
			}
		});
	}
	return state;
}
function entry(state: Coordinator, key: QueryKey): Entry {
	const hash = hashKey(key);
	let value = state.entries.get(hash);
	if (!value) {
		value = { accepted: -1, required: -1 };
		state.entries.set(hash, value);
	}
	return value;
}

/** Only a current RPC response can establish an incarnation, never replayed events. */
function acceptEpoch(
	client: QueryClient,
	key: QueryKey,
	sync: SyncRevision,
	request = -1,
): boolean {
	const state = coordinator(client);
	if (state.retired.has(sync.epoch)) return false;
	if (state.epoch === sync.epoch) {
		state.epochRequest = Math.max(state.epochRequest, request);
		return true;
	}
	if (request >= 0 && request < state.epochRequest) return false;
	if (state.epoch !== undefined) {
		state.retired.add(state.epoch);
		state.entries.clear();
		for (const query of client.getQueryCache().getAll()) {
			if (query.queryHash !== hashKey(key)) query.reset();
		}
	}
	state.epoch = sync.epoch;
	state.epochRequest = request;
	return true;
}

/** Shared gate for query reads and snapshot projections. No business data lives here. */
export function acceptsQueryValue(client: QueryClient, key: QueryKey, value: unknown): boolean {
	if (isMutationResponse(value)) return false;
	const sync = responseRevision(value);
	const state = coordinator(client);
	// Unversioned fixtures are allowed only until a real Host has established its epoch.
	if (!sync) return state.epoch === undefined;
	if (!acceptEpoch(client, key, sync, responseRequestSequence(value))) return false;
	const record = entry(state, key);
	if (sync.revision < Math.max(record.accepted, record.required)) return false;
	record.accepted = sync.revision;
	return true;
}

export function commitQueryValue<T>(client: QueryClient, key: QueryKey, value: T): boolean {
	if (!acceptsQueryValue(client, key, value)) return false;
	// Preserve provenance even when the domain payload is JSON-equal to the
	// previous revision (TanStack structural sharing otherwise keeps the old object).
	client.setQueryDefaults(key, { ...client.getQueryDefaults(key), structuralSharing: false });
	const query = client.getQueryCache().find({ queryKey: key, exact: true });
	if (query) query.setOptions({ ...query.options, structuralSharing: false });
	client.setQueryData(key, value);
	return true;
}

export async function readQueryValue<T>(
	client: QueryClient,
	key: QueryKey,
	request: () => Promise<T>,
): Promise<T> {
	const generation = entry(coordinator(client), key);
	for (let attempt = 0; attempt < 3; attempt++) {
		const value = await request();
		if (coordinator(client).entries.get(hashKey(key)) !== generation)
			throw new CancelledError({ silent: true });
		if (acceptsQueryValue(client, key, value)) return value;
		const current = client.getQueryData<T>(key);
		const state = coordinator(client);
		const sync = responseRevision(current);
		if (
			current !== undefined &&
			sync !== undefined &&
			sync.epoch === state.epoch &&
			sync.revision >= entry(state, key).required
		)
			return current;
	}
	throw new Error("Host query could not reach the required committed revision");
}

/** Commit notifications are wakeups, not a second copy of business state. */
export function invalidateCommittedQueries(
	client: QueryClient,
	sync: SyncRevision,
	matches: (key: QueryKey) => boolean,
): void {
	const state = coordinator(client);
	if (state.epoch !== sync.epoch) return;
	for (const query of client.getQueryCache().getAll()) {
		if (!matches(query.queryKey) || !state.entries.has(query.queryHash)) continue;
		const record = entry(state, query.queryKey);
		record.required = Math.max(record.required, sync.revision);
		if (record.accepted >= record.required) continue;
		void client.invalidateQueries(
			{ queryKey: query.queryKey, exact: true, refetchType: "all" },
			{ cancelRefetch: false },
		);
	}
}
