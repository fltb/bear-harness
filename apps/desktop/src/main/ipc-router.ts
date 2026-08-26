/**
 * Electron RPC transport for the transport-neutral Host runtime.
 *
 * This layer accepts calls only from a registered main frame at that window's
 * expected URL. Request validation, handler lookup, and response envelopes
 * belong to HostRuntime.dispatch. Wiring replaces handlers for these owned
 * channels and returns an idempotent disposer for the active registration.
 */

import type { Dispatcher } from "@bear-harness/host-runtime";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { BrowserWindow, ipcMain } from "electron";
import { isRegisteredMainFrame, type WindowRegistration } from "./diagnostics/electron.js";

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
			isRegisteredMainFrame(event, registration),
	);
}

const activeHandlers = new Map<string, symbol>();

function replaceIpcHandler(
	channel: string,
	handler: (event: IpcInvokeEvent, params: unknown) => Promise<unknown>,
): () => void {
	// The protocol channels belong to this module. Removing an existing
	// registration before handle() makes repeated startup/wiring safe even
	// when a previous owner did not get a chance to dispose.
	ipcMain.removeHandler(channel);
	activeHandlers.delete(channel);
	const token = Symbol(channel);
	ipcMain.handle(channel, handler);
	activeHandlers.set(channel, token);

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		// A later wiring may have replaced this handler. Its disposer owns the
		// current registration, so an old disposer must leave it untouched.
		if (activeHandlers.get(channel) !== token) return;
		ipcMain.removeHandler(channel);
		activeHandlers.delete(channel);
	};
}

interface RendererDispatchContext {
	runForRenderer(rendererWebContentsId: number, callback: () => unknown): unknown;
}

export function wireElectronIpcHandlers(
	dispatcher: Dispatcher,
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
	options?: { attachmentProtocol?: RendererDispatchContext },
): () => void {
	const disposers: Array<() => void> = [];
	for (const channel of Object.keys(REQUEST_SCHEMAS)) {
		disposers.push(
			replaceIpcHandler(channel, async (event, params: unknown) => {
				if (!senderAllowed(event, windowRegistry)) {
					return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
				}
				const dispatch = () => dispatcher.dispatch(channel, params);
				return options?.attachmentProtocol
					? options.attachmentProtocol.runForRenderer(event.sender.id, dispatch)
					: dispatch();
			}),
		);
	}

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const dispose of disposers) dispose();
	};
}
