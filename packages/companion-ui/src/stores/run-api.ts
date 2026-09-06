import type { CompanionClient } from "@bear-harness/companion-client";
import { CancelledError, createQuery, type QueryClient } from "@tanstack/solid-query";
import type { RunGetResponse, RunInfo, RunListData, RunListRequest } from "./ipc.js";
import { invoke } from "./ipc.js";
import { queryKeys, refreshRpcQuery } from "./rpc-query.js";
import type { RunApi } from "./supplementary-api.js";

export function createRunApi(input: {
	client: CompanionClient;
	queryClient: QueryClient;
	characterId(): string | undefined;
	runsRequest(request?: RunListRequest, signal?: AbortSignal): Promise<RunListData>;
	activeRuns(): RunInfo[];
	refreshRuns(): Promise<unknown>;
	onRefreshError(error: unknown): void;
}): RunApi {
	const refresh = () => {
		void Promise.all([
			input.refreshRuns(),
			input.queryClient.invalidateQueries({
				queryKey: queryKeys.runs,
				predicate: (query) =>
					query.queryKey[1] !== "active" && query.queryKey[2] === input.characterId(),
			}),
		]).catch(input.onRefreshError);
	};
	const control = async (request: () => Promise<RunInfo>) => {
		const characterId = input.characterId();
		const run = await request();
		if (characterId === input.characterId()) {
			input.queryClient.setQueriesData<RunGetResponse>(
				{
					queryKey: queryKeys.runs,
					predicate: (query) =>
						query.queryKey[1] === "detail" &&
						query.queryKey[2] === (characterId ?? null) &&
						query.queryKey[3] === run.id,
				},
				(detail) => (detail ? { ...detail, run } : undefined),
			);
			refresh();
		}
		return run;
	};
	return {
		list: (request) => {
			const characterId = input.characterId();
			return refreshRpcQuery({
				client: input.queryClient,
				key: request ? queryKeys.runList(characterId, request) : queryKeys.activeRuns(characterId),
				request: () => {
					if (characterId !== input.characterId()) throw new CancelledError({ silent: true });
					return input.runsRequest(request);
				},
			});
		},
		get: (runId, cursor) =>
			refreshRpcQuery({
				client: input.queryClient,
				key: queryKeys.runDetail(input.characterId(), runId, cursor),
				request: () => invoke(input.client, () => input.client.run.get({ runId, cursor })),
			}),
		observeDetail: (runId, cursor) =>
			createQuery<RunGetResponse>(
				() => {
					const queryKey = queryKeys.runDetail(input.characterId(), runId(), cursor?.());
					return {
						queryKey,
						enabled: !!queryKey[2] && !!queryKey[3],
						structuralSharing: false,
						queryFn: async () => {
							const [, , characterId, id, pageCursor] = queryKey;
							if (!characterId || !id)
								throw new Error("Run detail requires a character and run ID");
							return invoke(input.client, () =>
								input.client.run.get({ runId: id, cursor: pageCursor ?? undefined }),
							);
						},
					};
				},
				() => input.queryClient,
			),
		observeHistory: (cursor) =>
			createQuery<RunListData>(
				() => {
					const queryKey = queryKeys.runList(input.characterId(), {
						scope: "history",
						cursor: cursor?.(),
					});
					return {
						queryKey,
						enabled: !!queryKey[2],
						structuralSharing: false,
						queryFn: async ({ signal }) => {
							if (!queryKey[2]) throw new Error("Run history requires a character ID");
							if (queryKey[2] !== input.characterId()) throw new CancelledError({ silent: true });
							return input.runsRequest(queryKey[3], signal);
						},
					};
				},
				() => input.queryClient,
			),
		pendingPermissions: () =>
			input.activeRuns().flatMap((run) => (run.permission ? [run.permission] : [])),
		steer: async (runId, instruction) => {
			const receipt = await invoke(input.client, () =>
				input.client.run.steer({ runId, instruction }),
			);
			refresh();
			return receipt;
		},
		interrupt: (runId) =>
			control(() => invoke(input.client, () => input.client.run.interrupt({ runId }))),
		resume: (runId, instruction) =>
			control(() => invoke(input.client, () => input.client.run.resume({ runId, instruction }))),
		cancel: (runId) =>
			control(() => invoke(input.client, () => input.client.run.cancel({ runId }))),
		retryDelivery: (runId) =>
			control(() => invoke(input.client, () => input.client.run.retryDelivery({ runId }))),
		respondPermission: (runId, requestId, optionId) =>
			control(() =>
				invoke(input.client, () =>
					input.client.run.respondPermission({ runId, requestId, optionId }),
				),
			),
	};
}
