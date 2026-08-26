// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

type Event = {
	sender: { id: number; mainFrame: { url: string } };
	senderFrame: { url: string } | null;
};
type Handler = (event: Event, request: unknown) => Promise<unknown>;
const electron = vi.hoisted(() => {
	const handlers = new Map<string, Handler>();
	return { handlers, fromWebContents: vi.fn(), showOpenDialog: vi.fn() };
});
vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: electron.fromWebContents },
	dialog: { showOpenDialog: electron.showOpenDialog },
	ipcMain: {
		handle: vi.fn((channel: string, handler: Handler) => electron.handlers.set(channel, handler)),
		removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
	},
}));

import {
	ATTACHMENT_IMPORT_DROP_CHANNEL,
	ATTACHMENT_PICK_FILES_CHANNEL,
	registerConversationAttachmentBridge,
} from "../src/main/conversation-attachment-bridge.js";

const url = "file:///renderer/index.html";
const registry = new Map([[7, { allowedUrl: url }]]);
const event = (): Event => {
	const frame = { url };
	return { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
};

beforeEach(() => {
	electron.handlers.clear();
	electron.fromWebContents.mockReset();
	electron.showOpenDialog.mockReset();
});
describe("conversation attachment bridge", () => {
	it("admits only the registered main frame and returns summaries without source paths", async () => {
		const imported = vi.fn(async () => [
			{ id: "a1", name: "note.txt", kind: "file" as const, bytes: 3, fileCount: 1 },
		]);
		electron.fromWebContents.mockReturnValue({});
		electron.showOpenDialog.mockResolvedValue({
			canceled: false,
			filePaths: ["/private/note.txt"],
		});
		registerConversationAttachmentBridge({ importPaths: imported }, registry);
		const handler = electron.handlers.get(ATTACHMENT_PICK_FILES_CHANNEL);
		if (!handler) throw new Error("picker handler missing");
		const response = await handler(event(), { conversationId: "conversation-1" });
		expect(imported).toHaveBeenCalledWith("conversation-1", ["/private/note.txt"]);
		expect(JSON.stringify(response)).not.toContain("/private/");
		const subframe = event();
		subframe.senderFrame = { url };
		expect(await handler(subframe, { conversationId: "conversation-1" })).toEqual({
			ok: false,
			error: { kind: "unavailable", reason: "no_window" },
		});
	});
	it("imports preload-resolved drop paths but never echoes them", async () => {
		const imported = vi.fn(async () => [
			{ id: "a2", name: "folder", kind: "folder" as const, bytes: 4, fileCount: 1 },
		]);
		electron.fromWebContents.mockReturnValue({});
		registerConversationAttachmentBridge({ importPaths: imported }, registry);
		const handler = electron.handlers.get(ATTACHMENT_IMPORT_DROP_CHANNEL);
		if (!handler) throw new Error("drop handler missing");
		const response = await handler(event(), {
			conversationId: "conversation-1",
			paths: ["/private/folder"],
		});
		expect(imported).toHaveBeenCalledWith("conversation-1", ["/private/folder"]);
		expect(JSON.stringify(response)).not.toContain("/private/folder");
	});
});
