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

export const PROTOCOL_AVAILABILITY_CHANNEL = "desktop:artifactProtocol:v1";

interface IpcInvokeEvent {
	sender: { id: number; mainFrame: { url: string } };
	senderFrame: { url: string } | null;
}

function senderAllowed(
	event: IpcInvokeEvent,
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
): boolean {
	const registration = windowRegistry.get(event.sender.id);
	return Boolean(
		registration &&
			BrowserWindow.fromWebContents(event.sender as Electron.WebContents) &&
			event.senderFrame === event.sender.mainFrame &&
			event.senderFrame?.url === registration.allowedUrl,
	);
}

export function wireElectronIpcHandlers(
	dispatcher: Dispatcher,
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
	options?: { artifactProtocolAvailable?: () => boolean },
): void {
	for (const channel of Object.keys(REQUEST_SCHEMAS)) {
		ipcMain.handle(channel, async (event, params: unknown) => {
			if (!senderAllowed(event, windowRegistry)) {
				return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
			}
			return dispatcher.dispatch(channel, params);
		});
	}
	// Non-RPC host-shell channel: lets the renderer (and tests) learn whether
	// the bear-artifact:// protocol handler is registered in this process.
	ipcMain.handle(PROTOCOL_AVAILABILITY_CHANNEL, async (event) => {
		if (!senderAllowed(event, windowRegistry)) {
			return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
		}
		return { ok: true, data: { available: options?.artifactProtocolAvailable?.() ?? false } };
	});
}
