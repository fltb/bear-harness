import type { CharacterClient as CompanionClient } from "@bear-harness/companion-client";
import type { RunnerSaveRequest } from "@bear-harness/protocol";
import { invoke } from "./ipc.js";

export function createExternalAgentApi(client: CompanionClient) {
	return {
		list: async () => (await invoke(client, () => client.externalAgent.list({}))).items,
		save: (request: RunnerSaveRequest) => invoke(client, () => client.externalAgent.save(request)),
		test: (runnerId: string) => invoke(client, () => client.externalAgent.test({ runnerId })),
		status: () => invoke(client, () => client.externalAgent.status({})),
		discover: async () =>
			(await invoke(client, () => client.externalAgent.discoverCodex({}))).candidates,
		connect: async (params: { canonicalPath: string; version: string; sha256: string }) => {
			await invoke(client, () => client.externalAgent.connectCodex(params));
		},
	};
}
