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

import {
	type AnyRpcEndpoint,
	CHANNEL_CONTRACTS,
	type Channel,
	type RequestOf,
	type ResponseOf,
} from "@bear-harness/protocol/schema";

/** Wire error body: a fixed kind plus a localizable reason string. */
export interface RpcError {
	kind: string;
	reason: string;
}

/** The shared response envelope — every dispatch returns exactly this shape. */
export type RpcResponse = { ok: true; data: unknown } | { ok: false; error: RpcError };

/** A domain handler: validated request params in, response data out. */
export class ProtocolResponseValidationError extends Error {
	constructor(
		readonly channel: Channel,
		readonly issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
	) {
		super(
			`invalid Host response for ${channel}: ${issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
		);
		this.name = "ProtocolResponseValidationError";
	}
}

export interface DispatcherOptions {
	responseValidation?: "throw" | "isolate";
	onProtocolViolation?: (error: ProtocolResponseValidationError) => void;
}

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export class Dispatcher {
	private readonly handlers = new Map<string, RpcHandler>();
	private readonly responseValidation: "throw" | "isolate";
	private readonly onProtocolViolation?: (error: ProtocolResponseValidationError) => void;

	constructor(options: DispatcherOptions = {}) {
		this.responseValidation = options.responseValidation ?? "throw";
		this.onProtocolViolation = options.onProtocolViolation;
	}

	/** Register a handler for an RPC channel. Throws on unknown channels. */
	registerHandler<E extends AnyRpcEndpoint>(
		endpoint: E,
		handler: (params: RequestOf<E>) => ResponseOf<E> | Promise<ResponseOf<E>>,
	): void {
		this.handlers.set(endpoint.channel, handler as RpcHandler);
	}

	/** Validate `params` against the channel schema, run the handler, wrap the result. */
	async dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		const contract = CHANNEL_CONTRACTS[channel as Channel];
		if (!contract) {
			return { ok: false, error: { kind: "unavailable", reason: "handler_not_registered" } };
		}

		// Validate the request body against the schema
		const parsed = contract.request.safeParse(params);
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

		let data: unknown;
		try {
			data = await handler(parsed.data);
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

		const response = contract.response.safeParse(data);
		if (response.success) return { ok: true, data: response.data };
		const violation = new ProtocolResponseValidationError(
			channel as Channel,
			response.error.issues.map((issue) => ({ path: [...issue.path], message: issue.message })),
		);
		this.onProtocolViolation?.(violation);
		if (this.responseValidation === "throw") throw violation;
		return {
			ok: false,
			error: { kind: "internal", reason: "response_validation_failed" },
		};
	}
}
