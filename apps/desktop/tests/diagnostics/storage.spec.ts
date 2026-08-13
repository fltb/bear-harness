// @vitest-environment node

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalWriter, WRITER_UNAVAILABLE_STDERR } from "../../src/main/diagnostics/storage.js";
import { makePending, readJsonlLines, smallPolicy, waitFor } from "../utils";

const LAUNCH = "launch-storage-test";

function makeRoot(): string {
	return mkdtempSync(join(tmpdir(), "bear-storage-"));
}

function recordSize(name: string, attributes: Record<string, boolean | number | string>): number {
	return Buffer.byteLength(JSON.stringify(makePending(name, attributes)), "utf8");
}

describe("LocalWriter", () => {
	it("writes records as one JSONL line each with sequence/launchId filled in", async () => {
		const root = makeRoot();
		const writer = new LocalWriter({ root, launchId: LAUNCH, policy: smallPolicy({}) });
		const stderrLines: string[] = [];
		writer.enqueue(makePending("app.started", { pid: 1, platform: "darwin", packaged: false }));
		writer.enqueue(makePending("app.previous_exit_unclean", { count: 2 }));
		expect(await writer.flush(1000)).toBe(true);

		const records = readJsonlLines(root);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			schemaVersion: 1,
			sequence: 1,
			launchId: LAUNCH,
			kind: "event",
			name: "app.started",
		});
		expect(records[1]).toMatchObject({
			sequence: 2,
			name: "app.previous_exit_unclean",
			attributes: { count: 2 },
		});
		expect(typeof records[0]?.timestamp).toBe("string");
		expect(stderrLines).toHaveLength(0);
		rmSync(root, { recursive: true, force: true });
	});

	it("rotates segments on size and on UTC date change", async () => {
		const root = makeRoot();
		let now = Date.parse("2026-08-13T10:00:00.000Z");
		const size = recordSize("app.started", { pid: 1, platform: "darwin", packaged: false });
		const writer = new LocalWriter({
			root,
			launchId: LAUNCH,
			policy: smallPolicy({ segmentBytes: size + 20 }),
			clock: () => now,
		});
		writer.enqueue(makePending("app.started", { pid: 1, platform: "darwin", packaged: false }));
		writer.enqueue(makePending("app.started", { pid: 2, platform: "darwin", packaged: false }));
		expect(await writer.flush(1000)).toBe(true);
		// Cross into the next UTC day.
		now = Date.parse("2026-08-14T00:00:00.000Z");
		writer.enqueue(makePending("app.started", { pid: 3, platform: "darwin", packaged: false }));
		expect(await writer.flush(1000)).toBe(true);

		const names = readdirSync(join(root, "logs")).sort();
		expect(names).toHaveLength(3);
		expect(names[0]).toContain("20260813-1.jsonl");
		expect(names[1]).toContain("20260813-2.jsonl");
		expect(names[2]).toContain("20260814-3.jsonl");
		rmSync(root, { recursive: true, force: true });
	});

	it("drops the oldest records when the queue exceeds 500 records / 1 MiB", async () => {
		const root = makeRoot();
		const writer = new LocalWriter({
			root,
			launchId: LAUNCH,
			policy: smallPolicy({ queueMaxRecords: 5, queueMaxBytes: 1_048_576 }),
		});
		for (let i = 1; i <= 7; i += 1) {
			writer.enqueue(
				makePending("app.started", { pid: 100 + i, platform: "darwin", packaged: false }),
			);
		}
		expect(await writer.flush(1000)).toBe(true);
		const records = readJsonlLines(root);
		// The first record is already in flight when the cap drops the oldest
		// queued entry, so 6 records land with pid 102 dropped.
		expect(records).toHaveLength(6);
		expect(records.map((r) => (r.attributes as Record<string, unknown>).pid)).toEqual([
			101, 103, 104, 105, 106, 107,
		]);
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects catalog-invalid records", async () => {
		const root = makeRoot();
		const writer = new LocalWriter({ root, launchId: LAUNCH, policy: smallPolicy({}) });
		const result = writer.enqueue(makePending("app.started", { unknownKey: true }));
		expect(result).toEqual({ accepted: false, reason: "invalid-record" });
		await writer.flush(1000);
		expect(readJsonlLines(root)).toHaveLength(0);
		rmSync(root, { recursive: true, force: true });
	});

	it("degrades to a fixed stderr on write failure and recovers in order", async () => {
		const root = makeRoot();
		// Force EACCES by making the logs dir non-writable (POSIX).
		const logsDir = join(root, "logs");
		mkdirSync(logsDir, { recursive: true });
		chmodSync(logsDir, 0o500);
		const stderrLines: string[] = [];
		const writer = new LocalWriter({
			root,
			launchId: LAUNCH,
			policy: smallPolicy({}),
			stderr: (line) => stderrLines.push(line),
		});
		writer.enqueue(makePending("app.started", { pid: 1, platform: "darwin", packaged: false }));
		await waitFor(() => stderrLines.length > 0);
		expect(stderrLines).toEqual([WRITER_UNAVAILABLE_STDERR]);
		expect(readJsonlLines(root)).toHaveLength(0);

		// A second emit while failed keeps buffering and does not repeat stderr.
		writer.enqueue(makePending("app.started", { pid: 2, platform: "darwin", packaged: false }));
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		expect(stderrLines).toEqual([WRITER_UNAVAILABLE_STDERR]);

		// Recovery: buffered records flush in order, then writer_recovered.
		chmodSync(logsDir, 0o700);
		writer.enqueue(makePending("app.started", { pid: 3, platform: "darwin", packaged: false }));
		expect(await writer.flush(1000)).toBe(true);
		const records = readJsonlLines(root);
		expect(records.map((r) => r.name)).toEqual([
			"app.started",
			"app.started",
			"app.started",
			"diagnostics.writer_recovered",
		]);
		expect(records.map((r) => (r.attributes as Record<string, unknown>).pid)).toEqual([
			1,
			2,
			3,
			undefined,
		]);
		const recovered = records[3]?.attributes as Record<string, unknown>;
		expect(recovered.failureKind).toBe("write");
		expect(recovered.bufferedRecords).toBe(3);
		expect(recovered.droppedRecords).toBe(0);
		rmSync(root, { recursive: true, force: true });
	});

	it("shutdown timeout record lands at the queue head and persists synchronously", async () => {
		const root = makeRoot();
		const logsDir = join(root, "logs");
		mkdirSync(logsDir, { recursive: true });
		chmodSync(logsDir, 0o500);
		const stderrLines: string[] = [];
		const writer = new LocalWriter({
			root,
			launchId: LAUNCH,
			policy: smallPolicy({}),
			stderr: (line) => stderrLines.push(line),
		});
		writer.enqueue(makePending("app.started", { pid: 1, platform: "darwin", packaged: false }));
		await waitFor(() => stderrLines.length > 0);

		// With the dir still unwritable the synchronous append also fails: the
		// fixed stderr is already emitted, nothing throws.
		expect(() => writer.writeShutdownTimeoutRecord()).not.toThrow();
		chmodSync(logsDir, 0o700);
		expect(await writer.flush(1000)).toBe(true);
		const records = readJsonlLines(root);
		expect(records[0]?.name).toBe("app.shutdown_timeout");
		expect(records.map((r) => r.name)).toEqual([
			"app.shutdown_timeout",
			"app.started",
			"diagnostics.writer_recovered",
		]);
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps segment files at 0600 permissions", async () => {
		const root = makeRoot();
		const writer = new LocalWriter({ root, launchId: LAUNCH, policy: smallPolicy({}) });
		writer.enqueue(makePending("app.started", { pid: 1, platform: "darwin", packaged: false }));
		await writer.flush(1000);
		const names = readdirSync(join(root, "logs"));
		const mode = statSync(join(root, "logs", names[0] as string)).mode & 0o777;
		expect(mode).toBe(0o600);
		rmSync(root, { recursive: true, force: true });
	});
});
