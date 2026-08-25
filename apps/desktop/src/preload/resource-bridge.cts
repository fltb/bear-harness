import { RPC } from "@bear-harness/protocol/schema";
import { ipcRenderer, webUtils } from "electron";

const RESOURCE_DROPPED_CHANNEL = ["desktop", "resourceDropped", "v1"].join(":");

export const resourceBridge = Object.freeze({
	pickFiles: (conversationId: string) =>
		ipcRenderer.invoke(RPC.resource.pickFiles.channel, { conversationId, access: "read" }),
	pickDirectory: (conversationId: string) =>
		ipcRenderer.invoke(RPC.resource.pickDirectory.channel, {
			conversationId,
			access: "read-write",
		}),
	attachDropped: (conversationId: string, files: readonly File[]) => {
		const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
		return ipcRenderer.invoke(RESOURCE_DROPPED_CHANNEL, { conversationId, paths });
	},
	detach: (conversationId: string, resourceId: string) =>
		ipcRenderer.invoke(RPC.resource.detach.channel, { conversationId, resourceId }),
	relocate: (resourceId: string) =>
		ipcRenderer.invoke(RPC.resource.relocate.channel, { resourceId }),
});
