import type { HostTransport } from "@bear-harness/companion-client";
import { type ProductConfig, validateProductConfig } from "@bear-harness/product-config";

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
	) {
		super(`web-dev ${operation} failed: ${status}`);
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
	return {
		async invoke(endpoint, params) {
			const response = await fetch(`/rpc/${encodeURIComponent(endpoint.channel)}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-bear-web-dev-token": token,
				},
				body: JSON.stringify(params),
			});
			if (!response.ok) {
				// Only pre-dispatch HTTP failures (unauthorized, body limits,
				// malformed JSON, unknown channel/route, internal errors) reject
				// the transport. Domain/RPC failures resolve as HTTP 200 with
				// the original `{ ok: false, error }` envelope, so they must not
				// be converted into a transport rejection here.
				throw new WebDevHttpError("transport", response.status);
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
