/**
 * Wire envelope helpers.
 *
 * Every bridge call (`window.bearDesktop.companion.*` in the desktop app, or
 * any `HostTransport.invoke` here) resolves to
 * `{ ok: true, data } | { ok: false, error: { kind, reason } }`. `unwrap`
 * validates the envelope and extracts the data payload without ever leaking
 * raw wire errors into the UI: it throws a plain Error on failure, and
 * callers decide how to surface it (toast, disabled state, presence
 * fallback).
 */
import type { IpcError } from "@bear-harness/protocol";

/** Unwrap an IPC response envelope; throws on failure or malformed shape. */
export function unwrap<T>(result: unknown): T {
	if (typeof result !== "object" || result === null) {
		throw new Error("invalid IPC response");
	}
	const envelope = result as { ok?: unknown; data?: unknown; error?: unknown };
	if (envelope.ok === true) {
		return envelope.data as T;
	}
	const error = (
		typeof envelope.error === "object" && envelope.error !== null ? envelope.error : {}
	) as Partial<IpcError>;
	const kind = typeof error.kind === "string" ? error.kind : "internal";
	const reason = typeof error.reason === "string" ? error.reason : "unknown error";
	throw new Error(`${kind}: ${reason}`);
}
