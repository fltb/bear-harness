import type { CompanionClient } from "@bear-harness/companion-client";
import type { QueryClient } from "@tanstack/solid-query";
import type { RunInfo, RunListData } from "./ipc.js";
import { invoke } from "./ipc.js";
import { queryKeys, refreshRpcQuery } from "./rpc-query.js";
import type { RunApi } from "./supplementary-api.js";

export function createRunApi(input: {
	client: CompanionClient;
	queryClient: QueryClient;
	runsRequest(): Promise<RunListData>;
	activeRuns(): RunInfo[];
	refreshRuns(): Promise<unknown>;
	onRefreshError(error: unknown): void;
}): RunApi {
	const refresh = () => input.refreshRuns().catch(input.onRefreshError);
	return {
		list: () =>
			refreshRpcQuery({
				client: input.queryClient,
				key: queryKeys.runs,
				request: input.runsRequest,
			}),
		pendingPermissions: () =>
			input.activeRuns().flatMap((run) => (run.permission ? [run.permission] : [])),
		steer: async (runId, instruction) => {
			await invoke(input.client, () => input.client.run.steer({ runId, instruction }));
		},
		interrupt: async (runId) => {
			const data = await invoke(input.client, () => input.client.run.interrupt({ runId }));
			void refresh();
			return data;
		},
		resume: async (runId) => {
			const data = await invoke(input.client, () => input.client.run.resume({ runId }));
			void refresh();
			return data;
		},
		cancel: async (runId) => {
			const data = await invoke(input.client, () => input.client.run.cancel({ runId }));
			void refresh();
			return data;
		},
		respondPermission: async (runId, requestId, optionId) => {
			const data = await invoke(input.client, () =>
				input.client.run.respondPermission({ runId, requestId, optionId }),
			);
			void refresh();
			return data;
		},
	};
}
