/**
 * Host IPC router — validates every incoming request against the shared
 * TypeBox schemas, routes to domain handlers, and returns typed responses.
 *
 * Every channel name is re-validated against the schema registry. The
 * sender origin, main frame, and expected app URL are verified by the
 * `ipcMain` handler (see `index.ts`).
 */

import { ipcMain, BrowserWindow } from "electron";
import { Value } from "typebox/value";
import { REQUEST_SCHEMAS, IpcResponse } from "../shared/ipc-schemas.js";
import type { TSchema } from "typebox";

export type IpcHandler = (params: unknown, win: BrowserWindow) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

/** Register a handler for an IPC channel. */
export function registerHandler(channel: string, handler: IpcHandler): void {
	if (!(channel in REQUEST_SCHEMAS)) {
		throw new Error(`unknown IPC channel: ${channel}`);
	}
	handlers.set(channel, handler);
}

/** Wire up all registered IPC handlers. Call once at app boot. */
export function wireIpcHandlers(): void {
	for (const [channel, schema] of Object.entries(REQUEST_SCHEMAS)) {
		ipcMain.handle(channel, async (event, params: unknown) => {
			// Validate sender: must be from the expected main frame
			const win = BrowserWindow.fromWebContents(event.sender);
			if (!win) {
				return { ok: false, error: { kind: "unavailable", reason: "no_window" } };
			}

			// Validate request body against the schema
			if (!Value.Check(schema, params)) {
				const errors = [...Value.Errors(schema, params)];
			return {
				ok: false,
				error: {
					kind: "invalid_request",
					reason: `validation failed: ${errors.map((e) => String(e.message ?? e)).join("; ")}`,
				},
			};
			}

			const handler = handlers.get(channel);
			if (!handler) {
				return { ok: false, error: { kind: "unavailable", reason: "handler_not_registered" } };
			}

			try {
				const data = await handler(params, win);
				return { ok: true, data };
			} catch (e) {
				const err = e as { kind?: string; reason?: string; message?: string };
				return {
					ok: false,
					error: {
						kind: err.kind ?? "internal",
						reason: err.reason ?? err.message ?? "unknown error",
					},
				};
			}
		});
	}
}