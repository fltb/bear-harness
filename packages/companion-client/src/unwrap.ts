/**
 * Validate and unwrap an RPC response envelope.
 *
 * `unwrap` is intentionally endpoint-agnostic: callers supply the expected
 * TypeScript payload type, while the shared envelope schema validates the
 * runtime wire shape (`ok`, `data`, and the complete protocol error branch).
 * Endpoint-specific payload validation belongs to `createCompanionClient`.
 *
 * A transport failure is not an RPC envelope and therefore rejects the
 * promise before this helper runs. An RPC/domain failure is a valid resolved
 * envelope and is converted to a user-facing `Error` here.
 */

import { RpcResponse } from "@bear-harness/protocol/schema";
import { z } from "@bear-harness/schema";

const AnyEnvelope = RpcResponse(z.unknown());

/** Unwrap an RPC response envelope; malformed envelopes throw a validation error. */
export function unwrap<T>(result: unknown): T {
	const envelope = AnyEnvelope.parse(result);
	if (envelope.ok) return envelope.data as T;
	throw new Error(userFacingError(envelope.error.kind));
}

function userFacingError(kind: string): string {
	if (kind === "not_found") return "The requested item could not be found.";
	if (kind === "conflict") return "The state changed. Refresh and try again.";
	if (kind === "unavailable") return "This service is currently unavailable.";
	if (kind === "invalid_request") return "The submitted information is incomplete.";
	return "The operation could not be completed.";
}
