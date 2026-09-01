import type { HostTransport } from "@bear-harness/companion-client";
import { type ProductConfig, validateProductConfig } from "@bear-harness/product-config";

const INVALIDATION_PATH = "/events/invalidations";
const LIVE_PATH = "/events/live";

export interface WebDevBootstrap {
	product: Readonly<ProductConfig>;
	token: string;
	debugEnabled: boolean;
}

export type WebDevHttpErrorOperation = "transport" | "bootstrap" | "debug channels";

/** An HTTP response rejected before it can become an RPC/protocol result. */
export class WebDevHttpError extends Error {
	readonly kind = "http" as const;

	constructor(
		readonly operation: WebDevHttpErrorOperation,
		readonly status: number,
		readonly traceId?: string,
	) {
		super(`web-dev ${operation} failed: ${status}${traceId ? ` (trace ${traceId})` : ""}`);
		this.name = "WebDevHttpError";
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProductConfig(value: unknown): value is ProductConfig {
	// The server sends the live product config; enforce the shared shape
	// contract (including update feed/URL policy) before any entry is trusted.
	return validateProductConfig(value).length === 0;
}

function assertToken(token: unknown): asserts token is string {
	if (typeof token !== "string" || token.length === 0) {
		throw new TypeError("web-dev token must be a non-empty string");
	}
}

export function parseWebDevBootstrap(value: unknown): WebDevBootstrap {
	if (
		!isRecord(value) ||
		!isProductConfig(value.product) ||
		typeof value.token !== "string" ||
		value.token.length === 0 ||
		typeof value.debugEnabled !== "boolean"
	) {
		throw new Error("web-dev bootstrap response is invalid");
	}
	return {
		product: value.product,
		token: value.token,
		debugEnabled: value.debugEnabled,
	};
}

export function createHttpTransport(token: string): HostTransport {
	assertToken(token);
	let currentToken = token;
	const refreshToken = async (): Promise<void> => {
		currentToken = (await loadBootstrap()).token;
	};
	const requestNdjson = async (
		path: string,
		body: object,
		signal: AbortSignal,
	): Promise<ReadableStream<Uint8Array>> => {
		const request = () =>
			fetch(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/x-ndjson",
					"x-bear-web-dev-token": currentToken,
				},
				body: JSON.stringify(body),
				signal,
			});
		let response = await request();
		if (response.status === 401) {
			await refreshToken();
			response = await request();
		}
		if (!response.ok || !response.body) throw new WebDevHttpError("transport", response.status);
		return response.body;
	};
	const readNdjson = (body: ReadableStream<Uint8Array>): AsyncIterable<unknown> => ({
		async *[Symbol.asyncIterator]() {
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let pending = "";
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) throw new Error("Host event stream disconnected");
					pending += decoder.decode(value, { stream: true });
					for (;;) {
						const newline = pending.indexOf("\n");
						if (newline < 0) break;
						const frame = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (frame) yield JSON.parse(frame);
					}
					if (pending.length > 4 * 1024 * 1024) throw new Error("Host event frame too large");
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
		},
	});
	const listenNdjson = (
		path: string,
		body: object,
		receive: (batch: unknown) => void,
		fail: (error: unknown) => void,
	): (() => void) => {
		const abort = new AbortController();
		void (async () => {
			const stream = readNdjson(await requestNdjson(path, body, abort.signal));
			for await (const batch of stream) receive(batch);
		})().catch((error) => {
			if (!abort.signal.aborted) fail(error);
		});
		return () => abort.abort();
	};
	return {
		listenInvalidations(receive, fail) {
			return listenNdjson(INVALIDATION_PATH, {}, receive, fail);
		},
		async subscribeLive(signal) {
			return readNdjson(await requestNdjson(LIVE_PATH, {}, signal));
		},
		async invoke(endpoint, params) {
			const request = () =>
				fetch(`/rpc/${encodeURIComponent(endpoint.channel)}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-bear-web-dev-token": currentToken,
					},
					body: JSON.stringify(params),
				});
			let response = await request();
			if (response.status === 401) {
				await refreshToken();
				response = await request();
			}
			if (!response.ok) {
				// Only pre-dispatch HTTP failures (unauthorized, body limits,
				// malformed JSON, unknown channel/route, internal errors) reject
				// the transport. Domain/RPC failures resolve as HTTP 200 with
				// the original `{ ok: false, error }` envelope, so they must not
				// be converted into a transport rejection here.
				throw new WebDevHttpError(
					"transport",
					response.status,
					response.headers.get("x-bear-trace-id") ?? undefined,
				);
			}
			// Keep protocol-envelope validation at companion-client's boundary.
			// Network and JSON parsing rejections intentionally pass through.
			return response.json();
		},
	};
}

export async function loadBootstrap(): Promise<WebDevBootstrap> {
	const response = await fetch("/bootstrap", { cache: "no-store" });
	if (!response.ok) throw new WebDevHttpError("bootstrap", response.status);
	return parseWebDevBootstrap(await response.json());
}

export function parseDebugChannels(value: unknown): string[] {
	if (!isRecord(value) || !isStringArray(value.channels)) {
		throw new Error("web-dev debug channels response is invalid");
	}
	return value.channels;
}

export async function loadDebugChannels(token: string): Promise<string[]> {
	assertToken(token);
	const response = await fetch("/debug/channels", {
		headers: { "x-bear-web-dev-token": token },
		cache: "no-store",
	});
	if (!response.ok) throw new WebDevHttpError("debug channels", response.status);
	return parseDebugChannels(await response.json());
}
