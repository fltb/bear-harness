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

import { i18n } from "@bear-harness/i18n";
import type { IpcEnvelope } from "@bear-harness/protocol";

export interface IpcError {
	kind: string;
	reason: string;
}

export class IpcInvocationError extends Error {
	constructor(
		readonly kind: string,
		readonly reason: string,
		message: string,
	) {
		super(message);
		this.name = "IpcInvocationError";
	}
}

/** Unwrap the envelope already validated by the generated client. */
export function unwrap<T>(result: IpcEnvelope<T>): T {
	if (result.ok) return result.data;
	throw new IpcInvocationError(
		result.error.kind,
		result.error.reason,
		userFacingError(result.error.kind, result.error.reason),
	);
}

function userFacingError(kind: string, reason: string): string {
	if (reason.startsWith("local_embedding_model_prepare_failed:")) {
		return i18n.t("settings.localModelFailed");
	}
	switch (kind) {
		case "not_found":
			return i18n.t("errors.notFound");
		case "conflict":
			return i18n.t("errors.conflict");
		case "unavailable":
			return i18n.t("errors.unavailable");
		case "invalid_request":
			return i18n.t("errors.invalidRequest");
		default:
			return i18n.t("errors.generic");
	}
}
