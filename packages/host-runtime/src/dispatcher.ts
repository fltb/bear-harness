/**
 * Host RPC dispatcher — validates every incoming request against the shared
 * Zod schemas, routes to the registered domain handlers, and returns the
 * shared response envelope.
 *
 * This is the runtime-independent replacement for the legacy Electron
 * `ipc-router`: there is no `ipcMain` and no `BrowserWindow`. A channel is
 * only valid when it exists in `REQUEST_SCHEMAS` (from
 * `@bear-harness/protocol/schema`); an unregistered-but-known channel returns
 * `handler_not_registered`, exactly like the legacy router.
 */

import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";

/** Wire error body: a fixed kind plus a localizable reason string. */
export interface RpcError {
	kind: string;
	reason: string;
}

/** The shared response envelope — every dispatch returns exactly this shape. */
export type RpcResponse = { ok: true; data: unknown } | { ok: false; error: RpcError };

/** A domain handler: validated request params in, response data out. */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export class Dispatcher {
	private readonly handlers = new Map<string, RpcHandler>();

	/** Register a handler for an RPC channel. Throws on unknown channels. */
	registerHandler(channel: string, handler: RpcHandler): void {
		if (!(channel in REQUEST_SCHEMAS)) {
			throw new Error(`unknown RPC channel: ${channel}`);
		}
		this.handlers.set(channel, handler);
	}

	/** Validate `params` against the channel schema, run the handler, wrap the result. */
	async dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		const schema = REQUEST_SCHEMAS[channel];
		if (!schema) {
			return { ok: false, error: { kind: "unavailable", reason: "handler_not_registered" } };
		}

		// Validate the request body against the schema
		const parsed = schema.safeParse(params);
		if (!parsed.success) {
			return {
				ok: false,
				error: {
					kind: "invalid_request",
					reason: "request_validation_failed",
				},
			};
		}

		const handler = this.handlers.get(channel);
		if (!handler) {
			return { ok: false, error: { kind: "unavailable", reason: "handler_not_registered" } };
		}

		try {
			const data = await handler(parsed.data);
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
	}
}
