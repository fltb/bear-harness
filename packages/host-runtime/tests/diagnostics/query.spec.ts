import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	exportDiagnosticTrace,
	findLatestCompanionTurnTraceId,
	readDiagnosticTrace,
} from "../../src/diagnostics/query.js";

const roots: string[] = [];

function createTempRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function record(traceId: string, name = "app.started", timestamp = "2026-08-27T00:00:00.000Z") {
	return {
		timestamp,
		sequence: 1,
		launchId: "query-test",
		kind: name === "companion.turn" ? "span" : "event",
		level: "info",
		name,
		origin: "main",
		traceId,
		spanId: "cd".repeat(8),
		...(name === "companion.turn" ? { durationMs: 1, status: "ok" } : {}),
		attributes:
			name === "companion.turn"
				? { conversationId: "conversation", hasImages: false, includeHistory: true }
				: { pid: 1, platform: "darwin", packaged: false },
	};
}

function writeLog(root: string, lines: string[]): void {
	const logs = join(root, "logs");
	mkdirSync(logs, { recursive: true });
	writeFileSync(join(logs, "app-query-test-20260827-1.jsonl"), `${lines.join("\n")}\n`);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("diagnostics trace query", () => {
	it("reads only valid records from the requested trace", async () => {
		const root = createTempRoot("diagnostics-query-");
		roots.push(root);
		const wanted = "ab".repeat(16);
		writeLog(root, [
			JSON.stringify(record(wanted)),
			"{broken",
			JSON.stringify(record("ef".repeat(16))),
		]);

		const result = await readDiagnosticTrace(root, wanted);

		expect(result.records).toHaveLength(1);
		expect(result.invalidLines).toBe(1);
		expect(result.truncated).toBe(false);
	});

	it("finds the latest completed companion turn and exports atomically", async () => {
		const root = createTempRoot("diagnostics-export-");
		roots.push(root);
		const first = "ab".repeat(16);
		const latest = "ef".repeat(16);
		writeLog(root, [
			JSON.stringify(record(first, "companion.turn", "2026-08-27T00:00:00.000Z")),
			JSON.stringify(record(latest, "companion.turn", "2026-08-27T00:00:01.000Z")),
		]);
		const output = join(root, "exports", "latest.json");

		expect(await findLatestCompanionTurnTraceId(root)).toBe(latest);
		await exportDiagnosticTrace(root, latest, output);
		const exported = JSON.parse(readFileSync(output, "utf8"));
		expect(exported.traceId).toBe(latest);
		expect(exported.records).toHaveLength(1);
	});

	it("rejects invalid trace ids and record limits", async () => {
		const root = createTempRoot("diagnostics-query-invalid-");
		roots.push(root);
		await expect(readDiagnosticTrace(root, "../escape")).rejects.toThrow(TypeError);
		await expect(readDiagnosticTrace(root, "ab".repeat(16), { maxRecords: 0 })).rejects.toThrow(
			RangeError,
		);
	});
});
