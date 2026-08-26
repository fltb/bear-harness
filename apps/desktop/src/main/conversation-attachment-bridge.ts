import { BrowserWindow, dialog, ipcMain } from "electron";
import { isRegisteredMainFrame, type WindowRegistration } from "./diagnostics/electron.js";
export const ATTACHMENT_PICK_FILES_CHANNEL = "desktop:attachmentPickFiles:v1";
export const ATTACHMENT_PICK_FOLDER_CHANNEL = "desktop:attachmentPickFolder:v1";
export const ATTACHMENT_IMPORT_DROP_CHANNEL = "desktop:attachmentImportDrop:v1";
export interface DesktopAttachmentSummary {
	id: string;
	name: string;
	kind: "file" | "folder" | "generated";
	bytes: number;
	fileCount: number;
	originEntryId?: string;
}
export interface DesktopAttachmentImporter {
	importPaths(conversationId: string, paths: string[]): Promise<DesktopAttachmentSummary[]>;
}
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
const unavailable = () => ({
	ok: false as const,
	error: { kind: "unavailable" as const, reason: "no_window" },
});
const invalid = () => ({
	ok: false as const,
	error: { kind: "validation" as const, reason: "invalid_attachment_request" },
});
function requestId(request: unknown, allowPaths: boolean): string | undefined {
	if (
		typeof request !== "object" ||
		request === null ||
		Object.getPrototypeOf(request) !== Object.prototype
	)
		return;
	const keys = Object.keys(request);
	if (keys.some((key) => key !== "conversationId" && (key !== "paths" || !allowPaths))) return;
	if (!("conversationId" in request)) return;
	const id = request.conversationId;
	return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : undefined;
}
function requestPaths(request: unknown): string[] | undefined {
	if (typeof request !== "object" || request === null || !("paths" in request)) return;
	const paths = request.paths;
	if (!Array.isArray(paths) || paths.length < 1 || paths.length > 10) return;
	if (
		!paths.every(
			(path): path is string => typeof path === "string" && path.length > 0 && path.length <= 4096,
		)
	)
		return;
	return paths;
}
export function registerConversationAttachmentBridge(
	importer: DesktopAttachmentImporter,
	registry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
): () => void {
	const channels = [
		ATTACHMENT_PICK_FILES_CHANNEL,
		ATTACHMENT_PICK_FOLDER_CHANNEL,
		ATTACHMENT_IMPORT_DROP_CHANNEL,
	] as const;
	for (const channel of channels) ipcMain.removeHandler(channel);
	const picker =
		(properties: Array<"openFile" | "openDirectory" | "multiSelections">) =>
		async (event: InvokeEvent, request: unknown) => {
			if (!admitted(event, registry)) return unavailable();
			const conversationId = requestId(request, false);
			if (!conversationId) return invalid();
			const owner = BrowserWindow.fromWebContents(event.sender as Electron.WebContents);
			if (!owner) return unavailable();
			const selected = await dialog.showOpenDialog(owner, { properties });
			if (selected.canceled || selected.filePaths.length === 0)
				return { ok: true as const, data: { attachments: [] } };
			return {
				ok: true as const,
				data: { attachments: await importer.importPaths(conversationId, selected.filePaths) },
			};
		};
	ipcMain.handle(ATTACHMENT_PICK_FILES_CHANNEL, picker(["openFile", "multiSelections"]));
	ipcMain.handle(ATTACHMENT_PICK_FOLDER_CHANNEL, picker(["openDirectory"]));
	ipcMain.handle(ATTACHMENT_IMPORT_DROP_CHANNEL, async (event: InvokeEvent, request: unknown) => {
		if (!admitted(event, registry)) return unavailable();
		const conversationId = requestId(request, true);
		const paths = requestPaths(request);
		if (!conversationId || !paths) return invalid();
		return {
			ok: true as const,
			data: { attachments: await importer.importPaths(conversationId, paths) },
		};
	});
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const channel of channels) ipcMain.removeHandler(channel);
	};
}
