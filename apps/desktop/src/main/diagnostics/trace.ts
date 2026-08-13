/**
 * W3C trace context support for diagnostics v1.
 *
 * - trace/span IDs are lowercase hex from a random source (never all-zero).
 * - traceparent format: `00-<32 hex traceId>-<16 hex spanId>-<flags>`.
 * - The parser accepts only version 00, lowercase non-zero IDs and flags
 *   `00` or `01`. tracestate and baggage are deliberately not implemented.
 * - Main-process context propagation uses AsyncLocalStorage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface TraceContext {
	traceId: string;
	spanId: string;
}

export type RandomSource = (size: number) => Uint8Array;

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function createTraceId(random: RandomSource = randomBytes): string {
	return nonZeroHex(random, 16);
}

export function createSpanId(random: RandomSource = randomBytes): string {
	return nonZeroHex(random, 8);
}

function nonZeroHex(random: RandomSource, bytes: number): string {
	for (;;) {
		const value = Buffer.from(random(bytes)).toString("hex");
		if (/[1-9a-f]/.test(value)) return value;
	}
}

/** A child span id that stays on the parent's trace. */
export function childContext(
	parent: TraceContext,
	random: RandomSource = randomBytes,
): TraceContext {
	return { traceId: parent.traceId, spanId: createSpanId(random) };
}

export function formatTraceparent(traceId: string, spanId: string): string {
	return `00-${traceId}-${spanId}-01`;
}

/**
 * Strict grammar check. Returns null for anything that is not a valid
 * version-00, lowercase, non-zero traceparent with flags 00|01.
 */
export function parseTraceparent(value: string): TraceContext | null {
	if (typeof value !== "string") return null;
	const parts = value.split("-");
	if (parts.length !== 4) return null;
	const [version, traceId, spanId, flags] = parts;
	if (version !== "00") return null;
	if (!/^[0-9a-f]{32}$/.test(traceId ?? "") || !/[1-9a-f]/.test(traceId ?? "")) return null;
	if (!/^[0-9a-f]{16}$/.test(spanId ?? "") || !/[1-9a-f]/.test(spanId ?? "")) return null;
	if (flags !== "00" && flags !== "01") return null;
	return { traceId: traceId as string, spanId: spanId as string };
}

export function currentTraceContext(): TraceContext | undefined {
	return traceStorage.getStore();
}

/** Run fn inside the given trace context (async continuations inherit it). */
export function runInTrace<T>(context: TraceContext, fn: () => T): T {
	return traceStorage.run(context, fn);
}
