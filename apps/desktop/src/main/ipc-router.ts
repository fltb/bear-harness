/**
 * Electron RPC transport for the transport-neutral Host runtime.
 *
 * This layer accepts calls only from a registered main frame at that window's
 * expected URL. Request validation, handler lookup, and response envelopes
 * belong to HostRuntime.dispatch.
 */

import type { Dispatcher } from "@bear-harness/host-runtime";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { BrowserWindow, ipcMain } from "electron";
import type { WindowRegistration } from "./diagnostics/electron.js";

export function wireElectronIpcHandlers(
	dispatcher: Dispatcher,
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
): void {
	for (const channel of Object.keys(REQUEST_SCHEMAS)) {
		ipcMain.handle(channel, async (event, params: unknown) => {
			const registration = windowRegistry.get(event.sender.id);
			if (
				!BrowserWindow.fromWebContents(event.sender) ||
				!registration ||
				event.senderFrame !== event.sender.mainFrame ||
				event.senderFrame?.url !== registration.allowedUrl
			) {
				return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
			}
			return dispatcher.dispatch(channel, params);
		});
	}
}
