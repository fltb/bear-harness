/**
 * Renderer-side IPC envelope helpers.
 *
 * Every client call (`CompanionClient.*`) resolves to
 * `{ ok: true, data } | { ok: false, error: { kind, reason } }`. `unwrap`
 * validates the envelope and extracts the data payload without ever leaking
 * raw wire errors into the UI: it throws a plain Error on failure, and
 * callers decide how to surface it (toast, disabled state, presence
 * fallback).
 */

import { productUi } from "@bear-harness/product-config";
import type { IpcEnvelope } from "@bear-harness/protocol";

export interface IpcError {
	kind: string;
	reason: string;
}

export class IpcInvocationError extends Error {
	constructor(
		readonly kind: string,
		message: string,
	) {
		super(message);
		this.name = "IpcInvocationError";
	}
}

/** Unwrap the envelope already validated by the generated client. */
export function unwrap<T>(result: IpcEnvelope<T>): T {
	if (result.ok) return result.data;
	throw new IpcInvocationError(result.error.kind, userFacingError(result.error.kind));
}

function userFacingError(kind: string): string {
	switch (kind) {
		case "not_found":
			return productUi.errors.notFound;
		case "conflict":
			return productUi.errors.conflict;
		case "unavailable":
			return productUi.errors.unavailable;
		case "invalid_request":
			return productUi.errors.invalidRequest;
		default:
			return productUi.errors.generic;
	}
}
