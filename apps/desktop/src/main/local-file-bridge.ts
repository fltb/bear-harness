import { BrowserWindow, dialog, ipcMain } from "electron";
import { isRegisteredMainFrame, type WindowRegistration } from "./diagnostics/electron.js";

export const PICK_FILES_CHANNEL = "desktop:pickLocalFiles:v1";
export const PICK_FOLDER_CHANNEL = "desktop:pickLocalFolder:v1";

interface InvokeEvent {
	sender: { id: number; mainFrame: { url: string } };
	senderFrame: { url: string } | null;
}

function admitted(
	event: InvokeEvent,
	registry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
): boolean {
	const registration = registry.get(event.sender.id);
	return Boolean(
		registration &&
			BrowserWindow.fromWebContents(event.sender as Electron.WebContents) &&
			isRegisteredMainFrame(event, registration),
	);
}

export function registerLocalFileBridge(
	registry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
): () => void {
	for (const channel of [PICK_FILES_CHANNEL, PICK_FOLDER_CHANNEL]) ipcMain.removeHandler(channel);
	const pick =
		(properties: Array<"openFile" | "openDirectory" | "multiSelections">) =>
		async (event: InvokeEvent) => {
			if (!admitted(event, registry))
				return { ok: false as const, error: { kind: "unavailable", reason: "no_window" } };
			const owner = BrowserWindow.fromWebContents(event.sender as Electron.WebContents);
			if (!owner)
				return { ok: false as const, error: { kind: "unavailable", reason: "no_window" } };
			const selected = await dialog.showOpenDialog(owner, { properties });
			return { ok: true as const, data: { paths: selected.canceled ? [] : selected.filePaths } };
		};
	ipcMain.handle(PICK_FILES_CHANNEL, pick(["openFile", "multiSelections"]));
	ipcMain.handle(PICK_FOLDER_CHANNEL, pick(["openDirectory"]));
	return () => {
		ipcMain.removeHandler(PICK_FILES_CHANNEL);
		ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
	};
}
