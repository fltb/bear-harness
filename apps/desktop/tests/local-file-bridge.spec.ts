// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown) => Promise<unknown>;
const electron = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	fromWebContents: vi.fn(),
	showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: electron.fromWebContents },
	dialog: { showOpenDialog: electron.showOpenDialog },
	ipcMain: {
		handle: vi.fn((channel: string, handler: Handler) => electron.handlers.set(channel, handler)),
		removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
	},
}));
vi.mock("../src/main/diagnostics/electron.js", () => ({
	isRegisteredMainFrame: vi.fn(() => true),
}));

import {
	PICK_FILES_CHANNEL,
	PICK_FOLDER_CHANNEL,
	registerLocalFileBridge,
} from "../src/main/local-file-bridge.js";

describe("local file bridge", () => {
	beforeEach(() => {
		electron.handlers.clear();
		electron.fromWebContents.mockReset();
		electron.showOpenDialog.mockReset();
	});

	it("returns selected paths without reading or copying the files", async () => {
		const window = {};
		electron.fromWebContents.mockReturnValue(window);
		electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/tmp/a.pdf"] });
		registerLocalFileBridge(new Map([[7, { allowedUrl: "file:///app" }]]));
		const result = await electron.handlers.get(PICK_FILES_CHANNEL)?.({
			sender: { id: 7, mainFrame: { url: "file:///app" } },
			senderFrame: { url: "file:///app" },
		});
		expect(result).toEqual({ ok: true, data: { paths: ["/tmp/a.pdf"] } });
		expect(electron.showOpenDialog).toHaveBeenCalledWith(window, {
			properties: ["openFile", "multiSelections"],
		});
		expect(electron.handlers.has(PICK_FOLDER_CHANNEL)).toBe(true);
	});
});
