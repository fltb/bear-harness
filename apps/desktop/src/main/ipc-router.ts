import type { InvalidationNotice, LivePush } from "@bear-harness/protocol";
/**
 * Electron RPC transport for the transport-neutral Host runtime.
 *
 * This layer accepts calls only from a registered main frame at that window's
 * expected URL. Request validation, handler lookup, and response envelopes
 * belong to HostRuntime.dispatch. Wiring replaces handlers for these owned
 * channels and returns an idempotent disposer for the active registration.
 */

import type { Diagnostics, Dispatcher } from "@bear-harness/host-runtime";
import { CHANNEL_CONTRACTS } from "@bear-harness/protocol/schema";
import { BrowserWindow, ipcMain } from "electron";
import { isRegisteredMainFrame, type WindowRegistration } from "./diagnostics/electron.js";

interface IpcInvokeEvent {
	sender: { id: number; mainFrame: { url: string } };
	senderFrame: { url: string } | null;
}

const INVALIDATION_CHANNELS = {
	listen: "host:invalidations:listen",
	push: "host:invalidations:push",
	unlisten: "host:invalidations:unlisten",
} as const;
const LIVE_CHANNELS = {
	listen: "host:live:listen",
	push: "host:live:push",
	unlisten: "host:live:unlisten",
} as const;

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
	dispatcher: Pick<Dispatcher, "dispatch">,
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>,
	options?: {
		subscribeInvalidations?: (listener: (notice: InvalidationNotice) => void) => () => void;
		subscribeLivePush?: (listener: (event: LivePush) => void) => () => void;
		diagnostics?: Diagnostics;
	},
): () => void {
	const disposers: Array<() => void> = [];
	for (const channel of Object.keys(CHANNEL_CONTRACTS)) {
		disposers.push(
			replaceIpcHandler(channel, async (event, params: unknown) => {
				if (!senderAllowed(event, windowRegistry)) {
					return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
				}
				const span = options?.diagnostics?.startSpan("rpc.request", { channel });
				const invoke = () => dispatcher.dispatch(channel, params);
				try {
					const result = await (span && options?.diagnostics
						? options.diagnostics.runInSpan(span, invoke)
						: invoke());
					const failed =
						typeof result === "object" && result !== null && "ok" in result && result.ok === false;
					span?.end(failed ? "error" : "ok", failed ? { errorCategory: "rpc_error" } : {});
					return result;
				} catch (error) {
					span?.end("error", { errorCategory: "internal_error" });
					throw error;
				}
			}),
		);
	}

	const subscriptions = new Map<string, () => void>();
	if (options?.subscribeInvalidations) {
		const subscribe = options.subscribeInvalidations;
		disposers.push(
			replaceIpcHandler(INVALIDATION_CHANNELS.listen, async (event, params) => {
				if (!senderAllowed(event, windowRegistry)) throw new Error("untrusted_event_subscriber");
				const input = params as { id?: unknown };
				if (typeof input?.id !== "string" || !/^[a-z0-9-]{1,64}$/i.test(input.id))
					throw new Error("invalid_subscription_id");
				const id = input.id;
				const key = `${event.sender.id}:${id}`;
				subscriptions.get(key)?.();
				const sender = event.sender as Electron.WebContents;
				let stop: (() => void) | undefined;
				const cleanup = () => {
					stop?.();
					subscriptions.delete(key);
					sender.removeListener("destroyed", cleanup);
					sender.removeListener("did-start-navigation", cleanup);
				};
				sender.once("destroyed", cleanup);
				sender.once("did-start-navigation", cleanup);
				try {
					stop = subscribe((notice) => {
						if (!sender.isDestroyed() && senderAllowed(event, windowRegistry))
							sender.send(INVALIDATION_CHANNELS.push, {
								id,
								batch: { notices: [notice] },
							});
					});
					subscriptions.set(key, cleanup);
				} catch (error) {
					cleanup();
					throw error;
				}
				return {};
			}),
		);
		disposers.push(
			replaceIpcHandler(INVALIDATION_CHANNELS.unlisten, async (event, params) => {
				if (!senderAllowed(event, windowRegistry)) throw new Error("untrusted_event_subscriber");
				const id = (params as { id?: unknown })?.id;
				if (typeof id === "string") subscriptions.get(`${event.sender.id}:${id}`)?.();
				return {};
			}),
		);
	}
	if (options?.subscribeLivePush) {
		const subscribe = options.subscribeLivePush;
		disposers.push(
			replaceIpcHandler(LIVE_CHANNELS.listen, async (event, params) => {
				if (!senderAllowed(event, windowRegistry)) throw new Error("untrusted_live_subscriber");
				const id = (params as { id?: unknown })?.id;
				if (typeof id !== "string" || !/^[a-z0-9-]{1,64}$/i.test(id))
					throw new Error("invalid_subscription_id");
				const key = `live:${event.sender.id}:${id}`;
				subscriptions.get(key)?.();
				const sender = event.sender as Electron.WebContents;
				let stop: (() => void) | undefined;
				const cleanup = () => {
					stop?.();
					subscriptions.delete(key);
					sender.removeListener("destroyed", cleanup);
					sender.removeListener("did-start-navigation", cleanup);
				};
				sender.once("destroyed", cleanup);
				sender.once("did-start-navigation", cleanup);
				try {
					stop = subscribe((liveEvent) => {
						if (!sender.isDestroyed() && senderAllowed(event, windowRegistry))
							sender.send(LIVE_CHANNELS.push, {
								id,
								batch: { events: [liveEvent] },
							});
					});
					subscriptions.set(key, cleanup);
				} catch (error) {
					cleanup();
					throw error;
				}
				return {};
			}),
		);
		disposers.push(
			replaceIpcHandler(LIVE_CHANNELS.unlisten, async (event, params) => {
				if (!senderAllowed(event, windowRegistry)) throw new Error("untrusted_live_subscriber");
				const id = (params as { id?: unknown })?.id;
				if (typeof id === "string") subscriptions.get(`live:${event.sender.id}:${id}`)?.();
				return {};
			}),
		);
	}
	if (options?.subscribeInvalidations || options?.subscribeLivePush) {
		disposers.push(() => {
			for (const stop of subscriptions.values()) stop();
		});
	}

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const dispose of disposers) dispose();
	};
}
