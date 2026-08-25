import type { ResourceRefView } from "@bear-harness/protocol";
import { type BrowserWindow, dialog } from "electron";

export interface DesktopResourceHost {
	grantResourcePaths(
		paths: readonly string[],
		options: {
			conversationId: string;
			access: "read" | "read-write";
			securityBookmarks?: readonly string[];
		},
	): ResourceRefView[];
	relocateResourcePath(
		resourceId: string,
		path: string,
		securityBookmark?: string,
	): ResourceRefView;
}

export async function pickResources(
	window: BrowserWindow,
	host: DesktopResourceHost,
	request: { conversationId: string; access?: "read" | "read-write" },
	kind: "file" | "directory",
): Promise<{ resources: ResourceRefView[] }> {
	const result = await dialog.showOpenDialog(window, {
		properties: kind === "directory" ? ["openDirectory"] : ["openFile", "multiSelections"],
		securityScopedBookmarks: process.platform === "darwin",
	});
	if (result.canceled) return { resources: [] };
	return {
		resources: host.grantResourcePaths(result.filePaths, {
			conversationId: request.conversationId,
			access: request.access ?? (kind === "directory" ? "read-write" : "read"),
			securityBookmarks: result.bookmarks,
		}),
	};
}

export async function relocateResource(
	window: BrowserWindow,
	host: DesktopResourceHost,
	resourceId: string,
): Promise<{ resource: ResourceRefView }> {
	const result = await dialog.showOpenDialog(window, {
		properties: ["openFile", "openDirectory"],
		securityScopedBookmarks: process.platform === "darwin",
	});
	if (result.canceled || !result.filePaths[0]) throw new Error("resource_relocation_cancelled");
	return {
		resource: host.relocateResourcePath(resourceId, result.filePaths[0], result.bookmarks?.[0]),
	};
}
