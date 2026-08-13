// @vitest-environment node

import { afterAll, describe, expect, it } from "vitest";
import type { RandomSource } from "../../src/main/diagnostics/trace.js";
import {
	createSpanId,
	createTraceId,
	currentTraceContext,
	formatTraceparent,
	parseTraceparent,
	runInTrace,
	traceStorage,
} from "../../src/main/diagnostics/trace.js";

function queueRandom(...buffers: Buffer[]): RandomSource {
	let index = 0;
	return () => {
		const value = buffers[Math.min(index, buffers.length - 1)] as Buffer;
		index += 1;
		return value;
	};
}

afterAll(() => {
	// Per the diagnostics contract, the ALS store is disabled after use.
	traceStorage.disable();
});

describe("trace ids", () => {
	it("generates lowercase hex trace/span ids of the right length", () => {
		expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/);
		expect(createSpanId()).toMatch(/^[0-9a-f]{16}$/);
	});

	it("never returns an all-zero id, even from a zero-producing source", () => {
		const traceId = createTraceId(
			queueRandom(Buffer.alloc(16), Buffer.from("ab".repeat(16), "hex")),
		);
		expect(traceId).toBe("ab".repeat(16));
		const spanId = createSpanId(queueRandom(Buffer.alloc(8), Buffer.from("cd".repeat(8), "hex")));
		expect(spanId).toBe("cd".repeat(8));
	});

	it("formats a W3C traceparent with sampled flag", () => {
		const traceparent = formatTraceparent("ab".repeat(16), "cd".repeat(8));
		expect(traceparent).toBe(`00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`);
	});
});

describe("traceparent parsing", () => {
	it("round-trips a valid traceparent", () => {
		const parsed = parseTraceparent(formatTraceparent("ab".repeat(16), "cd".repeat(8)));
		expect(parsed).toEqual({ traceId: "ab".repeat(16), spanId: "cd".repeat(8) });
	});

	it.each([
		["wrong version", `01-${"ab".repeat(16)}-${"cd".repeat(8)}-01`],
		["uppercase", `00-${"AB".repeat(16)}-${"cd".repeat(8)}-01`],
		["all-zero traceId", `00-${"0".repeat(32)}-${"cd".repeat(8)}-01`],
		["all-zero spanId", `00-${"ab".repeat(16)}-${"0".repeat(16)}-01`],
		["bad flags", `00-${"ab".repeat(16)}-${"cd".repeat(8)}-02`],
		["short", `00-${"ab".repeat(16)}-${"cd".repeat(8)}`],
		["non-hex", `00-${"g".repeat(32)}-${"cd".repeat(8)}-01`],
	])("rejects %s", (_label, value) => {
		expect(parseTraceparent(value)).toBeNull();
	});

	it("rejects non-string input", () => {
		expect(parseTraceparent(undefined as unknown as string)).toBeNull();
		expect(parseTraceparent(42 as unknown as string)).toBeNull();
	});
});

describe("AsyncLocalStorage context propagation", () => {
	const ctxA = { traceId: "aa".repeat(16), spanId: "aa".repeat(8) };
	const ctxB = { traceId: "bb".repeat(16), spanId: "bb".repeat(8) };

	it("propagates synchronously, across promises and timers", async () => {
		await runInTrace(ctxA, async () => {
			expect(currentTraceContext()).toEqual(ctxA);

			await runInTrace(ctxB, async () => {
				expect(currentTraceContext()).toEqual(ctxB);
				await Promise.resolve();
				expect(currentTraceContext()).toEqual(ctxB);
				await new Promise<void>((resolvePromise) => {
					setTimeout(() => {
						expect(currentTraceContext()).toEqual(ctxB);
						resolvePromise();
					}, 5);
				});
			});

			// Back in the outer context after the inner run exits.
			expect(currentTraceContext()).toEqual(ctxA);
			await Promise.resolve();
			expect(currentTraceContext()).toEqual(ctxA);
		});
	});

	it("returns undefined outside any run", () => {
		expect(currentTraceContext()).toBeUndefined();
	});
});
