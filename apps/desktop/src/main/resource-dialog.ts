import type { ResourceRefView } from "@bear-harness/protocol";
import { type BrowserWindow, dialog } from "electron";

export interface DesktopResourceHost {
	grantResourcePaths(
		paths: readonly string[],
		options: { conversationId: string; access: "read" | "read-write" },
	): ResourceRefView[];
}

export async function pickResources(
	window: BrowserWindow,
	host: DesktopResourceHost,
	request: { conversationId: string; access?: "read" | "read-write" },
	kind: "file" | "directory",
): Promise<{ resources: ResourceRefView[] }> {
	const result = await dialog.showOpenDialog(window, {
		properties: kind === "directory" ? ["openDirectory"] : ["openFile", "multiSelections"],
	});
	if (result.canceled) return { resources: [] };
	return {
		resources: host.grantResourcePaths(result.filePaths, {
			conversationId: request.conversationId,
			access: request.access ?? (kind === "directory" ? "read-write" : "read"),
		}),
	};
}
