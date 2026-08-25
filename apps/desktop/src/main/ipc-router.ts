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
import { type DesktopResourceHost, pickResources, relocateResource } from "./resource-dialog.js";
export const PROTOCOL_AVAILABILITY_CHANNEL = "desktop:artifactProtocol:v1";
export const RESOURCE_DROPPED_CHANNEL = "desktop:resourceDropped:v1";

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

export function wireElectronIpcHandlers(
	dispatcher: Dispatcher,
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
	options?: { artifactProtocolAvailable?: () => boolean; resourceHost?: DesktopResourceHost },
): () => void {
	const disposers: Array<() => void> = [];
	for (const channel of Object.keys(REQUEST_SCHEMAS)) {
		disposers.push(
			replaceIpcHandler(channel, async (event, params: unknown) => {
				if (!senderAllowed(event, windowRegistry)) {
					return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
				}
				if (
					options?.resourceHost &&
					(channel === "resource.pickFiles:v1" || channel === "resource.pickDirectory:v1")
				) {
					const parsed = REQUEST_SCHEMAS[channel]?.safeParse(params);
					if (!parsed?.success)
						return {
							ok: false,
							error: { kind: "invalid_request", reason: "request_validation_failed" },
						};
					const owner = BrowserWindow.fromWebContents(event.sender as Electron.WebContents);
					if (!owner) return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
					try {
						const data = await pickResources(
							owner,
							options.resourceHost,
							parsed.data as { conversationId: string; access?: "read" | "read-write" },
							channel === "resource.pickFiles:v1" ? "file" : "directory",
						);
						return { ok: true, data };
					} catch {
						return { ok: false, error: { kind: "internal", reason: "resource_pick_failed" } };
					}
				}
				if (options?.resourceHost && channel === "resource.relocate:v1") {
					const parsed = REQUEST_SCHEMAS[channel]?.safeParse(params);
					if (!parsed?.success)
						return {
							ok: false,
							error: { kind: "invalid_request", reason: "request_validation_failed" },
						};
					const owner = BrowserWindow.fromWebContents(event.sender as Electron.WebContents);
					if (!owner) return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
					try {
						return {
							ok: true,
							data: await relocateResource(
								owner,
								options.resourceHost,
								(parsed.data as { resourceId: string }).resourceId,
							),
						};
					} catch (error) {
						return {
							ok: false,
							error: {
								kind: "internal",
								reason: error instanceof Error ? error.message : "resource_relocate_failed",
							},
						};
					}
				}
				return dispatcher.dispatch(channel, params);
			}),
		);
	}
	// Non-RPC host-shell channel: lets the renderer (and tests) learn whether
	// the bear-artifact:// protocol handler is registered in this process.
	disposers.push(
		replaceIpcHandler(PROTOCOL_AVAILABILITY_CHANNEL, async (event) => {
			if (!senderAllowed(event, windowRegistry)) {
				return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
			}
			return { ok: true, data: { available: options?.artifactProtocolAvailable?.() ?? false } };
		}),
	);
	if (options?.resourceHost) {
		const resourceHost = options.resourceHost;
		disposers.push(
			replaceIpcHandler(RESOURCE_DROPPED_CHANNEL, async (event, params: unknown) => {
				if (!senderAllowed(event, windowRegistry))
					return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
				if (
					typeof params !== "object" ||
					params === null ||
					typeof (params as { conversationId?: unknown }).conversationId !== "string" ||
					!Array.isArray((params as { paths?: unknown }).paths) ||
					!(params as { paths: unknown[] }).paths.every((path) => typeof path === "string")
				)
					return {
						ok: false,
						error: { kind: "invalid_request", reason: "request_validation_failed" },
					};
				try {
					const input = params as { conversationId: string; paths: string[] };
					return {
						ok: true,
						data: {
							resources: resourceHost.grantResourcePaths(input.paths, {
								conversationId: input.conversationId,
								access: "read-write",
							}),
						},
					};
				} catch {
					return { ok: false, error: { kind: "internal", reason: "resource_drop_failed" } };
				}
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
