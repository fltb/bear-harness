// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	DIAGNOSTIC_CATALOG,
	DIAGNOSTICS_POLICY,
	validateAttributes,
	validateRecord,
} from "../../src/diagnostics/contracts.js";
import { createSpanId, createTraceId } from "../../src/diagnostics/trace.js";

function validRecord() {
	return {
		timestamp: "2026-08-13T00:00:00.000Z",
		sequence: 1,
		launchId: "launch-1",
		kind: "event",
		level: "info",
		name: "app.started",
		origin: "main",
		traceId: createTraceId(),
		spanId: createSpanId(),
		attributes: { pid: 42, platform: "darwin", packaged: false },
	};
}

describe("DIAGNOSTICS_POLICY", () => {
	it("is frozen with the pinned v1 values", () => {
		expect(Object.isFrozen(DIAGNOSTICS_POLICY)).toBe(true);
		expect(DIAGNOSTICS_POLICY).toEqual({
			localOnly: true,
			contentMode: "metadata-unless-trace",
			maxAgeDays: 30,
			maxBytes: 209715200,
			segmentBytes: 5242880,
			queueMaxRecords: 500,
			queueMaxBytes: 1048576,
			shutdownFlushMs: 2000,
			rendererFaultsPerMinute: 20,
			crashUpload: false,
		});
	});
});

describe("validateRecord", () => {
	it("accepts a well-formed record", () => {
		expect(validateRecord(validRecord())).toEqual([]);
	});

	it("accepts a completed span", () => {
		const record = {
			...validRecord(),
			kind: "span",
			name: "window.load",
			level: "info",
			origin: "main",
			durationMs: 12,
			status: "ok",
			attributes: { webContentsId: 7, ok: true },
		};
		expect(validateRecord(record)).toEqual([]);
	});

	it.each([
		["unknown top-level key", { ...validRecord(), extra: 1 }],
		["non-UTC timestamp", { ...validRecord(), timestamp: "2026-08-13 00:00:00" }],
		["zero sequence", { ...validRecord(), sequence: 0 }],
		["bad kind", { ...validRecord(), kind: "log" }],
		["bad level", { ...validRecord(), level: "verbose" }],
		["bad origin", { ...validRecord(), origin: "network" }],
		["unknown name", { ...validRecord(), name: "custom.free_text" }],
		["bad traceId", { ...validRecord(), traceId: "ZZZ" }],
		["bad spanId", { ...validRecord(), spanId: "12" }],
		["bad parentSpanId", { ...validRecord(), parentSpanId: "xyz" }],
		["span without status", { ...validRecord(), kind: "span", name: "window.load", durationMs: 1 }],
		["event with status", { ...validRecord(), status: "ok" }],
		["event with duration", { ...validRecord(), durationMs: 3 }],
		["unknown attribute key", { ...validRecord(), attributes: { nope: 1 } }],
		["missing required attribute", { ...validRecord(), attributes: { pid: 42 } }],
		[
			"wrong attribute type",
			{ ...validRecord(), attributes: { pid: "42", platform: "darwin", packaged: false } },
		],
		[
			"integer out of range",
			{ ...validRecord(), attributes: { pid: -1, platform: "darwin", packaged: false } },
		],
		[
			"non-enum string",
			{ ...validRecord(), attributes: { pid: 1, platform: "windows11", packaged: false } },
		],
		[
			"attribute value array",
			{ ...validRecord(), attributes: { pid: 1, platform: "darwin", packaged: [] } },
		],
		[
			"NaN attribute",
			{ ...validRecord(), attributes: { pid: Number.NaN, platform: "darwin", packaged: false } },
		],
	])("rejects %s", (_label, record) => {
		expect(validateRecord(record).length).toBeGreaterThan(0);
	});

	it("accepts optional attributes being omitted", () => {
		const record = {
			...validRecord(),
			name: "renderer.fault",
			origin: "renderer",
			attributes: { kind: "error", errorType: "TypeError" },
		};
		expect(validateRecord(record)).toEqual([]);
	});

	it("rejects an attribute string longer than 128 UTF-8 bytes", () => {
		const spanRecord = {
			...validRecord(),
			kind: "span",
			name: "app.session",
			durationMs: 1,
			status: "ok",
			attributes: { launchId: "x".repeat(200), pid: 1, platform: "darwin", packaged: false },
		};
		expect(validateRecord(spanRecord).length).toBeGreaterThan(0);
	});

	it("rejects attributes with more than 16 keys", () => {
		const attributes: Record<string, boolean | number | string> = {};
		for (let i = 0; i < 17; i += 1) attributes[`key${i}`] = i;
		expect(
			validateAttributes(attributes, DIAGNOSTIC_CATALOG["app.started"]).length,
		).toBeGreaterThan(0);
	});
});
