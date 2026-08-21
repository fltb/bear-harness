/**
 * Host RPC dispatcher — validates every incoming request against the shared
 * Zod schemas, routes to the registered domain handlers, and returns the
 * shared response envelope.
 *
 * This is the runtime-independent replacement for the legacy Electron
 * `ipc-router`: there is no `ipcMain` and no `BrowserWindow`. A channel is
 * valid when it exists in `CHANNEL_CONTRACTS` (from
 * `@bear-harness/protocol/schema`); an unregistered-but-known channel returns
 * `handler_not_registered`, exactly like the legacy router. `REQUEST_SCHEMAS`
 * is intentionally request-only and is not used here because dispatch also
 * validates handler responses.
 */

import {
	type AnyRpcEndpoint,
	CHANNEL_CONTRACTS,
	type Channel,
	type IpcErrorKind,
	type RequestOf,
	type ResponseOf,
} from "@bear-harness/protocol/schema";

/** Wire error body: a protocol kind plus a localizable reason string. */
export interface RpcError {
	kind: IpcErrorKind;
	reason: string;
}

/** The shared response envelope — every dispatch returns exactly this shape. */
export type RpcResponse = { ok: true; data: unknown } | { ok: false; error: RpcError };

/** A domain handler: validated request params in, response data out. */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;
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
	/**
	 * Host-owned behavior for handler response-schema violations:
	 * `throw` rejects dispatch with ProtocolResponseValidationError;
	 * `isolate` returns a protocol internal-error envelope.
	 */
	responseValidation?: "throw" | "isolate";
	onProtocolViolation?: (error: ProtocolResponseValidationError) => void;
}

const IPC_ERROR_KINDS: readonly IpcErrorKind[] = [
	"invalid_request",
	"not_found",
	"conflict",
	"unavailable",
	"internal",
];
const MAX_ERROR_REASON_LENGTH = 4096;

function normalizeHandlerError(error: unknown): RpcError {
	const thrown =
		typeof error === "object" && error !== null
			? (error as { kind?: unknown; reason?: unknown; message?: unknown })
			: undefined;
	const rawKind = thrown?.kind;
	const kind = IPC_ERROR_KINDS.includes(rawKind as IpcErrorKind)
		? (rawKind as IpcErrorKind)
		: "internal";
	const rawReason =
		typeof thrown?.reason === "string"
			? thrown.reason
			: typeof thrown?.message === "string"
				? thrown.message
				: "handler_failed";
	const reason = rawReason.slice(0, MAX_ERROR_REASON_LENGTH);
	return { kind, reason };
}

export class Dispatcher {
	private readonly handlers = new Map<string, RpcHandler>();
	private readonly responseValidation: "throw" | "isolate";
	private readonly onProtocolViolation?: (error: ProtocolResponseValidationError) => void;

	constructor(options: DispatcherOptions = {}) {
		this.responseValidation = options.responseValidation ?? "throw";
		this.onProtocolViolation = options.onProtocolViolation;
	}

	/** Register a handler for a canonical RPC endpoint. */
	registerHandler<E extends AnyRpcEndpoint>(
		endpoint: E,
		handler: (params: RequestOf<E>) => ResponseOf<E> | Promise<ResponseOf<E>>,
	): void {
		if (
			!endpoint ||
			typeof endpoint !== "object" ||
			endpoint.kind !== "rpc" ||
			typeof endpoint.channel !== "string"
		) {
			throw new TypeError("invalid RPC endpoint");
		}
		const contract = CHANNEL_CONTRACTS[endpoint.channel as Channel];
		if (!contract) {
			throw new Error(`unknown RPC endpoint: ${endpoint.channel}`);
		}
		if (this.handlers.has(endpoint.channel)) {
			throw new Error(`duplicate RPC handler registration: ${endpoint.channel}`);
		}
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
		} catch (error) {
			return {
				ok: false,
				error: normalizeHandlerError(error),
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
