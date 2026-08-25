import { ipcRenderer, webUtils } from "electron";

export const resourceBridge = Object.freeze({
	pickFiles: (conversationId: string) =>
		ipcRenderer.invoke("resource.pickFiles:v1", { conversationId, access: "read" }),
	pickDirectory: (conversationId: string) =>
		ipcRenderer.invoke("resource.pickDirectory:v1", { conversationId, access: "read-write" }),
	attachDropped: (conversationId: string, files: readonly File[]) => {
		const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
		return ipcRenderer.invoke("desktop:resourceDropped:v1", { conversationId, paths });
	},
	detach: (conversationId: string, resourceId: string) =>
		ipcRenderer.invoke("resource.detach:v1", { conversationId, resourceId }),
});
