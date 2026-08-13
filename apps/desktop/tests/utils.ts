// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	DiagnosticName,
	DiagnosticsPolicy,
	PendingRecord,
} from "../src/main/diagnostics/contracts.js";
import { DIAGNOSTIC_CATALOG, DIAGNOSTICS_POLICY } from "../src/main/diagnostics/contracts.js";
import { createSpanId, createTraceId } from "../src/main/diagnostics/trace.js";

export function waitFor(
	condition: () => boolean,
	timeoutMs = 2000,
	intervalMs = 10,
): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const deadline = Date.now() + timeoutMs;
		const tick = () => {
			try {
				if (condition()) {
					resolvePromise();
					return;
				}
			} catch (error) {
				rejectPromise(error);
				return;
			}
			if (Date.now() > deadline) {
				rejectPromise(new Error(`waitFor timed out after ${timeoutMs} ms`));
				return;
			}
			setTimeout(tick, intervalMs);
		};
		tick();
	});
}

export function makePending(
	name: DiagnosticName,
	attributes: Record<string, boolean | number | string> = {},
	overrides: Partial<PendingRecord> = {},
): PendingRecord {
	const entry = DIAGNOSTIC_CATALOG[name];
	return {
		name,
		kind: entry.kind,
		level: entry.level,
		origin: entry.origin,
		traceId: createTraceId(),
		spanId: createSpanId(),
		...(entry.kind === "span" ? { durationMs: 1, status: "ok" } : {}),
		attributes,
		...overrides,
	};
}

export function readJsonlLines(root: string): Array<Record<string, unknown>> {
	const logsDir = join(root, "logs");
	let names: string[];
	try {
		names = readdirSync(logsDir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const lines: Array<Record<string, unknown>> = [];
	for (const name of names.sort()) {
		for (const line of readFileSync(join(logsDir, name), "utf8").split("\n")) {
			if (line.trim().length > 0) lines.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return lines;
}

export function allJsonlText(root: string): string {
	const logsDir = join(root, "logs");
	let names: string[];
	try {
		names = readdirSync(logsDir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return "";
	}
	return names
		.sort()
		.map((name) => readFileSync(join(logsDir, name), "utf8"))
		.join("\n");
}

export function smallPolicy(overrides: Partial<DiagnosticsPolicy>): Readonly<DiagnosticsPolicy> {
	return { ...DIAGNOSTICS_POLICY, ...overrides };
}
