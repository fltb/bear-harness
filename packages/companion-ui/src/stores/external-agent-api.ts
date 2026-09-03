import type { CompanionClient } from "@bear-harness/companion-client";
import { invoke } from "./ipc.js";

export function createExternalAgentApi(client: CompanionClient) {
	return {
		status: () => invoke(client, () => client.externalAgent.status({})),
		discover: async () =>
			(await invoke(client, () => client.externalAgent.discoverCodex({}))).candidates,
		connect: async (params: {
			canonicalPath: string;
			version: string;
			sha256: string;
		}) => {
			await invoke(client, () => client.externalAgent.connectCodex(params));
		},
	};
}
