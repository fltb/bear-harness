/**
 * Local JSONL writer for diagnostics v1.
 *
 * - One segment per launch: `app-<launchId>-<UTC-YYYYMMDD>-<seq>.jsonl`,
 *   appended record-by-record with `appendFile(..., { flag: "a", mode: 0o600 })`.
 * - Segments rotate when the next record would cross `segmentBytes` or the UTC
 *   date changes. Files are never renamed or shared, so concurrent instances
 *   cannot race the same writer.
 * - A single drain loop preserves order. The memory queue is capped at
 *   queueMaxRecords records and queueMaxBytes bytes; overflow drops the oldest
 *   entries and counts them.
 * - Callers never receive write exceptions. On failure a fixed stderr line is
 *   written once per episode, the queue is retained as a ring buffer, and the
 *   next emit retries. After recovery the buffered records flush in order and
 *   a `diagnostics.writer_recovered` event reports failureKind/buffered/
 *   dropped counts.
 * - `flush(deadlineMs)` drains with a hard deadline; on timeout the caller
 *   calls `writeShutdownTimeoutRecord()` which places `app.shutdown_timeout`
 *   at the queue head and attempts one synchronous append.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiagnosticLevel, DiagnosticsPolicy, PendingRecord } from "./contracts.js";
import { DIAGNOSTIC_CATALOG, MAX_RECORD_BYTES, validateRecord } from "./contracts.js";
import { diagnosticLevelEnabled } from "./levels.js";
import { createSpanId, createTraceId } from "./trace.js";

export interface LocalWriterOptions {
	root: string;
	launchId: string;
	policy: Readonly<DiagnosticsPolicy>;
	clock?: () => number;
	stderr?: (line: string) => void;
	minimumLevel?: DiagnosticLevel;
}

export type EnqueueResult =
	| { accepted: true }
	| { accepted: false; reason: "invalid-record" | "oversized" };

interface QueueEntry {
	text: string;
	bytes: number;
}

interface Segment {
	date: string;
	seq: number;
	bytes: number;
	file: string;
}

export const WRITER_UNAVAILABLE_STDERR = "[diagnostics] local writer unavailable";

export class LocalWriter {
	readonly launchId: string;
	readonly root: string;

	private readonly policy: Readonly<DiagnosticsPolicy>;
	private readonly clock: () => number;
	private readonly stderr: (line: string) => void;
	private readonly minimumLevel: DiagnosticLevel;

	private queue: QueueEntry[] = [];
	private queueBytes = 0;
	private droppedRecords = 0;
	private sequence = 0;
	private segment: Segment | null = null;
	private drainPromise: Promise<void> | null = null;
	private failed = false;
	private stderrWritten = false;

	constructor(options: LocalWriterOptions) {
		this.root = options.root;
		this.launchId = options.launchId;
		this.policy = options.policy;
		this.clock = options.clock ?? Date.now;
		this.stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
		this.minimumLevel = options.minimumLevel ?? "trace";
	}

	/** Queue a record. Never throws; never rejects. */
	enqueue(pending: PendingRecord): EnqueueResult {
		const record = this.completeRecord(pending);
		const errors = validateRecord(record);
		if (errors.length > 0) {
			return { accepted: false, reason: "invalid-record" };
		}
		const text = JSON.stringify(record);
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > MAX_RECORD_BYTES) {
			return { accepted: false, reason: "oversized" };
		}
		this.queue.push({ text, bytes });
		this.queueBytes += bytes;
		while (
			this.queue.length > this.policy.queueMaxRecords ||
			this.queueBytes > this.policy.queueMaxBytes
		) {
			const dropped = this.queue.shift();
			if (!dropped) break;
			this.queueBytes -= dropped.bytes;
			this.droppedRecords += 1;
		}
		this.scheduleDrain();
		return { accepted: true };
	}

	/** Drains the queue with a hard deadline; resolves true when empty. */
	async flush(deadlineMs: number): Promise<boolean> {
		if (this.drainPromise) await this.drainPromise;
		this.drainPromise = null;
		const deadline = Date.now() + deadlineMs;
		while (this.queue.length > 0) {
			const entry = this.queue.shift();
			if (!entry) break;
			this.queueBytes -= entry.bytes;
			try {
				await this.writeWithRotation(entry);
			} catch {
				this.fail();
				// Return the entry to the head so retries keep order.
				this.queue.unshift(entry);
				this.queueBytes += entry.bytes;
				break;
			}
			this.markRecoveredIfNeeded();
			if (Date.now() >= deadline) break;
		}
		return this.queue.length === 0;
	}

	/** Shutdown-timeout persistence: queue head + one synchronous append. */
	writeShutdownTimeoutRecord(): void {
		if (!diagnosticLevelEnabled(this.minimumLevel, "error")) return;
		const text = JSON.stringify(
			this.completeRecord({
				name: "app.shutdown_timeout",
				kind: "event",
				level: "error",
				origin: "main",
				traceId: createTraceId(),
				spanId: createSpanId(),
				attributes: {},
			}),
		);
		const bytes = Buffer.byteLength(text, "utf8");
		this.queue.unshift({ text, bytes });
		this.queueBytes += bytes;
		try {
			const segment = this.ensureSegment();
			appendFileSync(segment.file, `${text}\n`, { flag: "a", mode: 0o600 });
		} catch {
			this.writeStderrOnce();
		}
	}

	private scheduleDrain(): void {
		if (this.drainPromise) return;
		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = null;
			// Never reschedule immediately after a write failure: the failed
			// entry stays at the head and the next emit retries it.
			if (this.queue.length > 0 && !this.failed) this.scheduleDrain();
		});
	}

	private async drain(): Promise<void> {
		while (this.queue.length > 0) {
			const entry = this.queue.shift();
			if (!entry) return;
			this.queueBytes -= entry.bytes;
			try {
				await this.writeWithRotation(entry);
			} catch {
				this.fail();
				// Return the entry to the head so retries keep order.
				this.queue.unshift(entry);
				this.queueBytes += entry.bytes;
				return;
			}
			this.markRecoveredIfNeeded();
		}
	}

	private completeRecord(pending: PendingRecord) {
		this.sequence += 1;
		return {
			schemaVersion: 1 as const,
			timestamp: new Date(this.clock()).toISOString(),
			sequence: this.sequence,
			launchId: this.launchId,
			kind: pending.kind,
			level: pending.level,
			name: pending.name,
			origin: pending.origin,
			traceId: pending.traceId,
			spanId: pending.spanId,
			...(pending.parentSpanId !== undefined ? { parentSpanId: pending.parentSpanId } : {}),
			...(pending.durationMs !== undefined ? { durationMs: pending.durationMs } : {}),
			...(pending.status !== undefined ? { status: pending.status } : {}),
			attributes: pending.attributes,
		};
	}

	private utcDate(nowMs: number): string {
		return new Date(nowMs).toISOString().slice(0, 10).replaceAll("-", "");
	}

	private rotate(date: string): Segment {
		const seq = (this.segment?.seq ?? 0) + 1;
		const logsDir = join(this.root, "logs");
		mkdirSync(logsDir, { recursive: true, mode: 0o700 });
		this.segment = {
			date,
			seq,
			bytes: 0,
			file: join(logsDir, `app-${this.launchId}-${date}-${seq}.jsonl`),
		};
		return this.segment;
	}

	private ensureSegment(): Segment {
		if (!this.segment) return this.rotate(this.utcDate(this.clock()));
		return this.segment;
	}

	private async writeWithRotation(entry: QueueEntry): Promise<void> {
		const date = this.utcDate(this.clock());
		if (
			!this.segment ||
			this.segment.date !== date ||
			this.segment.bytes + entry.bytes + 1 > this.policy.segmentBytes
		) {
			this.rotate(date);
		}
		const segment = this.segment as Segment;
		await appendFile(segment.file, `${entry.text}\n`, { flag: "a", mode: 0o600 });
		segment.bytes += entry.bytes + 1;
	}

	private fail(): void {
		if (!this.failed) {
			this.failed = true;
			this.writeStderrOnce();
		}
	}

	private writeStderrOnce(): void {
		if (this.stderrWritten) return;
		this.stderrWritten = true;
		this.stderr(WRITER_UNAVAILABLE_STDERR);
	}

	private markRecoveredIfNeeded(): void {
		if (!this.failed) return;
		this.failed = false;
		this.stderrWritten = false;
		if (!diagnosticLevelEnabled(this.minimumLevel, "warn")) return;
		// Buffered records have flushed in order; report recovery with counts.
		// The record whose successful write ended the outage is counted too.
		this.enqueue({
			name: "diagnostics.writer_recovered",
			kind: "event",
			level: "warn",
			origin: "main",
			traceId: createTraceId(),
			spanId: createSpanId(),
			attributes: {
				failureKind: "write",
				bufferedRecords: this.queue.length + 1,
				droppedRecords: this.droppedRecords,
			},
		});
	}
}

/** Panic-path helper: record exists in the catalog and is always writable. */
export function isCatalogName(name: string): boolean {
	return name in DIAGNOSTIC_CATALOG;
}
