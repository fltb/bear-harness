/**
 * Diagnostics orchestrator: wires the writer, retention, Crashpad, run marker,
 * heartbeat/prune timers and the root session span, and is the only entry
 * point for emitting catalog events and spans.
 *
 * Init order (all before `app.whenReady()` / any BrowserWindow):
 *   1. diagnostics root dirs (logs/crashes/state, 0700)
 *   2. app.setAppLogsPath(logs)
 *   3. writer
 *   4. unclean-exit scan + retention
 *   5. Crashpad (uploadToServer: false, fixed globalExtra only)
 *   6. run marker + heartbeat + 6h prune timer
 *   7. app.session root span + app.started
 *
 * Shutdown: stop timers, end spans, marker -> clean, flush writer within
 * `shutdownFlushMs`, disable AsyncLocalStorage.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AttributeSpec } from "./contracts.js";
import {
	type CatalogEntry,
	DIAGNOSTIC_CATALOG,
	DIAGNOSTICS_POLICY,
	type DiagnosticLevel,
	type DiagnosticName,
	type DiagnosticsPolicy,
	type PendingRecord,
	type SpanStatus,
	validateAttributes,
} from "./contracts.js";
import { type CrashpadReporter, configureCrashpad } from "./crashpad.js";
import {
	diagnosticLevelEnabled,
	effectiveDiagnosticLevel,
	parseDiagnosticLevel,
} from "./levels.js";
import { redactTraceText } from "./redaction.js";
import {
	defaultIsPidAlive,
	markUncleanExits,
	type PruneResult,
	runRetention,
	writeMarkerAtomic,
} from "./retention.js";
import { LocalWriter, WRITER_UNAVAILABLE_STDERR } from "./storage.js";
import {
	createSpanId,
	createTraceId,
	currentTraceContext,
	type RandomSource,
	runInTrace,
	type TraceContext,
	traceStorage,
} from "./trace.js";

export interface DiagnosticsApp {
	setAppLogsPath(path: string): void;
	setPath(name: string, path: string): void;
}

export interface DiagnosticsOptions {
	app: DiagnosticsApp;
	root: string;
	launchId: string;
	policy?: Readonly<DiagnosticsPolicy>;
	clock?: () => number;
	random?: RandomSource;
	stderr?: (line: string) => void;
	isPidAlive?: (pid: number) => boolean;
	packaged?: boolean;
	reporter?: CrashpadReporter;
	/** Minimum persisted level. Defaults to BEAR_LOG_LEVEL, then info. */
	logLevel?: DiagnosticLevel;
	/** 0 disables the heartbeat; default 60000 ms. */
	heartbeatMs?: number;
	/** 0 disables the periodic prune; default 6 hours. */
	pruneIntervalMs?: number;
}

export interface SpanHandle {
	readonly context: TraceContext;
	end(status: SpanStatus, attributes?: Record<string, boolean | number | string>): void;
}

export interface RemoteTrace {
	traceId: string;
	parentSpanId?: string;
}

function normalizePlatform(): string {
	const platform: string = process.platform;
	return platform === "darwin" || platform === "win32" || platform === "linux"
		? platform
		: "unknown";
}

export class Diagnostics {
	readonly launchId: string;
	readonly root: string;
	readonly policy: Readonly<DiagnosticsPolicy>;
	readonly logLevel: DiagnosticLevel;

	private readonly clock: () => number;
	private readonly random: RandomSource;
	private readonly stderr: (line: string) => void;
	private readonly isPidAlive: (pid: number) => boolean;
	private readonly writer: LocalWriter;
	private sessionSpan: SpanHandle | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private pruneTimer: ReturnType<typeof setInterval> | null = null;
	private markerFile: string;
	private shutdownCalled = false;

	constructor(options: DiagnosticsOptions) {
		this.launchId = options.launchId;
		this.root = options.root;
		this.policy = options.policy ?? DIAGNOSTICS_POLICY;
		this.clock = options.clock ?? Date.now;
		const packaged = options.packaged ?? false;
		this.logLevel = effectiveDiagnosticLevel(
			options.logLevel ?? parseDiagnosticLevel(process.env.BEAR_LOG_LEVEL),
			packaged,
		);
		this.random = options.random ?? randomBytes;
		this.stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
		this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

		const logsDir = join(this.root, "logs");
		const crashesDir = join(this.root, "crashes");
		const stateDir = join(this.root, "state");
		let dirsOk = true;
		for (const dir of [logsDir, crashesDir, stateDir]) {
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
			} catch {
				this.stderr(WRITER_UNAVAILABLE_STDERR);
				dirsOk = false;
			}
		}
		try {
			options.app.setAppLogsPath(logsDir);
		} catch {
			this.stderr(WRITER_UNAVAILABLE_STDERR);
			dirsOk = false;
		}

		this.writer = new LocalWriter({
			root: this.root,
			launchId: this.launchId,
			policy: this.policy,
			clock: this.clock,
			stderr: this.stderr,
			minimumLevel: this.logLevel,
		});

		this.markerFile = join(stateDir, `run-${this.launchId}.json`);

		// Unclean-exit scan before retention: stale running markers become
		// unclean; the count is recorded with a fixed-field event.
		const uncleanCount = markUncleanExits({
			root: this.root,
			isPidAlive: this.isPidAlive,
		});
		if (uncleanCount > 0) {
			this.emit("app.previous_exit_unclean", { count: uncleanCount });
		}

		// Startup retention, then Crashpad (crash dumps only from this point on).
		const pruneSpan = this.startSpan("diagnostics.prune");
		let prune: PruneResult;
		try {
			prune = runRetention({
				root: this.root,
				currentLaunchId: this.launchId,
				policy: this.policy,
				clock: this.clock,
				isPidAlive: this.isPidAlive,
			});
		} catch {
			prune = {
				skipped: true,
				inactiveUnits: 0,
				deletedUnits: 0,
				deletedBytes: 0,
				deferred: false,
			};
		}
		pruneSpan.end(prune.skipped ? "cancelled" : "ok", {
			inactiveUnits: prune.inactiveUnits,
			deletedUnits: prune.deletedUnits,
			deletedBytes: prune.deletedBytes,
			deferred: prune.deferred,
		});
		if (prune.deferred) {
			this.emit("diagnostics.retention_deferred", { reason: "active" });
		}

		if (dirsOk && options.reporter) {
			try {
				configureCrashpad({
					app: { setPath: (name, path) => options.app.setPath(name, path) },
					reporter: options.reporter,
					root: this.root,
					launchId: this.launchId,
				});
			} catch {
				this.stderr(WRITER_UNAVAILABLE_STDERR);
			}
		}

		// Run marker + heartbeat.
		const nowIso = new Date(this.clock()).toISOString();
		this.writeMarker({ state: "running", startedAt: nowIso, lastSeenAt: nowIso });
		const heartbeatMs = options.heartbeatMs ?? 60_000;
		if (heartbeatMs > 0) {
			this.heartbeatTimer = setInterval(() => {
				this.writeMarker({
					state: "running",
					startedAt: undefined,
					lastSeenAt: new Date(this.clock()).toISOString(),
				});
			}, heartbeatMs);
		}
		const pruneIntervalMs = options.pruneIntervalMs ?? 6 * 60 * 60 * 1000;
		if (pruneIntervalMs > 0) {
			this.pruneTimer = setInterval(() => this.runPeriodicPrune(), pruneIntervalMs);
		}

		// Root session span + started event. `runInSession` keeps the context
		// alive for everything the caller wires inside it (whenReady etc.).
		this.sessionSpan = this.startSpan("app.session", {
			launchId: this.launchId,
			pid: process.pid,
			platform: normalizePlatform(),
			packaged,
		});
		runInTrace(this.sessionSpan.context, () => {
			this.emit("app.started", {
				pid: process.pid,
				platform: normalizePlatform(),
				packaged,
			});
		});
	}

	/** Run fn inside the app.session trace context (async continuations inherit). */
	runInSession<T>(fn: () => T): T {
		const session = this.sessionSpan;
		if (!session) throw new Error("diagnostics session not started");
		return runInTrace(session.context, fn);
	}

	/** Run work inside a started span so nested diagnostics inherit its context. */
	runInSpan<T>(span: SpanHandle, fn: () => T): T {
		return runInTrace(span.context, fn);
	}

	isLevelEnabled(level: DiagnosticLevel): boolean {
		return diagnosticLevelEnabled(this.logLevel, level);
	}

	/** TRACE-only, redacted content evidence. Packaged apps clamp TRACE to DEBUG. */
	traceContent(
		conversationId: string,
		phase: "user" | "host_context" | "assistant" | "tool_arguments" | "tool_result",
		value: string,
	): void {
		if (!this.isLevelEnabled("trace")) return;
		const redacted = redactTraceText(value);
		this.emit("trace.content", {
			conversationId,
			phase,
			content: redacted.content,
			originalBytes: redacted.originalBytes,
			truncated: redacted.truncated,
		});
	}

	/** Emit a catalog event under the current trace context (or a fresh trace). */
	emit(name: DiagnosticName, attributes: Record<string, boolean | number | string> = {}): void {
		const entry = DIAGNOSTIC_CATALOG[name];
		if (!entry || !this.isLevelEnabled(entry.level)) return;
		const parent = currentTraceContext();
		if (parent) {
			this.submit(name, attributes, {
				traceId: parent.traceId,
				spanId: createSpanId(this.random),
				parentSpanId: parent.spanId,
			});
		} else {
			this.submit(name, attributes, {
				traceId: createTraceId(this.random),
				spanId: createSpanId(this.random),
			});
		}
	}

	/** Emit an event carrying a remote trace (renderer faults). */
	emitRemote(
		name: DiagnosticName,
		attributes: Record<string, boolean | number | string>,
		remote: RemoteTrace,
	): void {
		this.submit(name, attributes, {
			traceId: remote.traceId,
			spanId: createSpanId(this.random),
			...(remote.parentSpanId !== undefined ? { parentSpanId: remote.parentSpanId } : {}),
		});
	}

	/** Start a span. The single completed record is written on end(). */
	startSpan(
		name: Extract<DiagnosticName, string>,
		attributes: Record<string, boolean | number | string> = {},
	): SpanHandle {
		const entry: CatalogEntry | undefined = DIAGNOSTIC_CATALOG[name];
		if (!entry || entry.kind !== "span") {
			throw new TypeError(`not a span in the diagnostics catalog: ${name}`);
		}
		const parent = currentTraceContext();
		const traceId = parent?.traceId ?? createTraceId(this.random);
		const spanId = createSpanId(this.random);
		const parentSpanId = parent?.spanId;
		const startedAt = this.clock();
		let ended = false;

		return {
			context: { traceId, spanId },
			end: (status, endAttributes = {}) => {
				if (ended) return;
				ended = true;
				const merged = { ...attributes, ...endAttributes };
				if (validateAttributes(merged, entry).length > 0) {
					this.reject("record");
					return;
				}
				const level = status === "error" ? "error" : entry.level;
				if (!this.isLevelEnabled(level)) return;
				const pending: PendingRecord = {
					name,
					kind: "span",
					level,
					origin: entry.origin,
					traceId,
					spanId,
					...(parentSpanId !== undefined ? { parentSpanId } : {}),
					durationMs: Math.max(0, this.clock() - startedAt),
					status,
					attributes: merged,
				};
				this.enqueueOrReject(pending);
			},
		};
	}

	/**
	 * Graceful shutdown: stop timers, end the session span, mark the run clean,
	 * flush within shutdownFlushMs (timeout record on failure), disable ALS.
	 */
	async shutdown(): Promise<void> {
		if (this.shutdownCalled) return;
		this.shutdownCalled = true;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.pruneTimer) clearInterval(this.pruneTimer);
		this.heartbeatTimer = null;
		this.pruneTimer = null;
		this.sessionSpan?.end("ok");
		this.sessionSpan = null;
		this.writeMarker({ state: "clean", startedAt: undefined, lastSeenAt: undefined });
		const flushed = await this.writer.flush(this.policy.shutdownFlushMs);
		if (!flushed) this.writer.writeShutdownTimeoutRecord();
		traceStorage.disable();
	}

	private writeMarker(partial: { state: string; startedAt?: string; lastSeenAt?: string }): void {
		const nowIso = new Date(this.clock()).toISOString();
		const marker = {
			schemaVersion: 1,
			launchId: this.launchId,
			pid: process.pid,
			startedAt: partial.startedAt ?? nowIso,
			lastSeenAt: partial.lastSeenAt ?? nowIso,
			state: partial.state,
		};
		try {
			writeMarkerAtomic(this.markerFile, marker);
		} catch {
			this.stderr(WRITER_UNAVAILABLE_STDERR);
		}
	}

	private runPeriodicPrune(): void {
		const pruneSpan = this.startSpan("diagnostics.prune");
		let prune: PruneResult;
		try {
			prune = runRetention({
				root: this.root,
				currentLaunchId: this.launchId,
				policy: this.policy,
				clock: this.clock,
				isPidAlive: this.isPidAlive,
			});
		} catch {
			prune = {
				skipped: true,
				inactiveUnits: 0,
				deletedUnits: 0,
				deletedBytes: 0,
				deferred: false,
			};
		}
		pruneSpan.end(prune.skipped ? "cancelled" : "ok", {
			inactiveUnits: prune.inactiveUnits,
			deletedUnits: prune.deletedUnits,
			deletedBytes: prune.deletedBytes,
			deferred: prune.deferred,
		});
		if (prune.deferred) {
			this.emit("diagnostics.retention_deferred", { reason: "active" });
		}
	}

	private submit(
		name: DiagnosticName,
		attributes: Record<string, boolean | number | string>,
		trace: { traceId: string; spanId: string; parentSpanId?: string },
	): void {
		const entry: CatalogEntry | undefined = DIAGNOSTIC_CATALOG[name];
		if (!entry) {
			throw new TypeError(`unknown diagnostics catalog entry: ${name}`);
		}
		if (!this.isLevelEnabled(entry.level)) return;
		if (validateAttributes(attributes, entry).length > 0) {
			this.reject("record");
			return;
		}
		const pending: PendingRecord = {
			name,
			kind: entry.kind,
			level: entry.level,
			origin: entry.origin,
			traceId: trace.traceId,
			spanId: trace.spanId,
			...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
			attributes,
		};
		this.enqueueOrReject(pending);
	}

	private enqueueOrReject(pending: PendingRecord): void {
		if (pending.name === "diagnostics.input_rejected") {
			this.writer.enqueue(pending);
			return;
		}
		const result = this.writer.enqueue(pending);
		if (!result.accepted) {
			this.reject(result.reason === "oversized" ? "oversized" : "record");
		}
	}

	private reject(reason: "record" | "oversized"): void {
		if (!this.isLevelEnabled("warn")) return;
		// Fixed-field rejection event; attributes are empty so it can never
		// recurse through enqueueOrReject.
		this.writer.enqueue({
			name: "diagnostics.input_rejected",
			kind: "event",
			level: "warn",
			origin: "main",
			traceId: createTraceId(this.random),
			spanId: createSpanId(this.random),
			attributes: { reason },
		});
	}
}

export type { AttributeSpec };

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
	return new Diagnostics(options);
}
