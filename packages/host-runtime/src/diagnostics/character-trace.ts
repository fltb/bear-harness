import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TraceIndex, type TraceQuery } from "../storage/database.js";
import type { DiagnosticLevel } from "./contracts.js";
import { diagnosticLevelEnabled } from "./levels.js";
import { redactCredentials } from "./redaction.js";
import { defaultIsPidAlive } from "./retention.js";
import {
	createSpanId,
	createTraceId,
	currentTraceContext,
	runInTrace,
	type TraceContext,
} from "./trace.js";

export interface TracePolicy {
	level: DiagnosticLevel;
	payload: "full" | "metadata";
	traceUntil: number;
	maxAgeDays: number;
	maxBytes: number;
}

export const DEFAULT_TRACE_POLICY: TracePolicy = {
	level: "debug",
	payload: "full",
	traceUntil: 0,
	maxAgeDays: 30,
	maxBytes: 200 * 1024 * 1024,
};
type Outcome = "ok" | "error" | "cancelled" | "interrupted" | "settled";
interface Scope {
	conversationId?: string;
	runId?: string;
	toolCallId?: string;
}
interface TraceRecord extends Scope {
	schemaVersion: 2;
	eventId: string;
	launchId: string;
	systemLaunchId?: string;
	pid: number;
	sequence: number;
	at: string;
	companionId: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	level: DiagnosticLevel;
	event: string;
	attributes: unknown;
	payloadPolicy: "full" | "metadata";
	payload?: { sha256: string; bytes: number };
}

/** Remove credential fields before JSON encoding, including nested errors/headers.
 * Content remains character-local. Circular/unsupported values are explicit. */
export function diagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactCredentials(value);
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	let result: unknown;
	if ("type" in value && value.type === "api_key") {
		result = "[REDACTED_SECRET]";
	} else if (value instanceof Error) {
		result = diagnosticValue(
			{
				name: value.name,
				message: value.message,
				stack: value.stack,
				cause: value.cause,
				...Object.fromEntries(Object.entries(value)),
			},
			seen,
		);
	} else if (Array.isArray(value)) {
		result = value.map((item) => diagnosticValue(item, seen));
	} else {
		result = Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/^(authorization|proxy-authorization|cookie|set-cookie|token|secret|credentials?|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passphrase|private[-_]?key)$/i.test(
					key,
				)
					? "[REDACTED_SECRET]"
					: diagnosticValue(item, seen),
			]),
		);
	}
	seen.delete(value);
	return result;
}

/** Append-only diagnostics, never read by Pi or used as runtime authority.
 * Each instance belongs to exactly one already validated character directory. */
export class CharacterTrace {
	readonly launchId = randomUUID();
	private sequence = 0;
	private pendingBytes = 0;
	private queue: Array<{ record: TraceRecord; payload?: string; bytes: number }> = [];
	private writing?: Promise<void>;
	private closed = false;
	private cleanShutdown = false;
	private recovered = false;
	private index?: TraceIndex;
	private indexing?: Promise<TraceIndex>;
	private lastPrune = 0;
	private readonly active = new Map<string, number>();
	private readonly ambient = { traceId: createTraceId(), spanId: createSpanId() };
	private readonly turns = new Map<string, ReturnType<CharacterTrace["span"]>>();
	private readonly toolSpans = new Map<string, ReturnType<CharacterTrace["span"]>>();
	private readonly protectedTraces = new Set<string>();
	private readonly durations = new Map<
		string,
		{ count: number; sumMs: number; maxMs: number; buckets: number[] }
	>();
	private readonly healthState = {
		written: 0,
		dropped: 0,
		writeFailures: 0,
		lastWriteAt: null as string | null,
	};

	constructor(
		readonly root: string,
		readonly companionId: string,
		private readonly policy: () => TracePolicy = () => DEFAULT_TRACE_POLICY,
		private readonly systemLaunchId?: string,
	) {}

	health() {
		return { ...this.healthState, queued: this.queue.length, queuedBytes: this.pendingBytes };
	}

	protect(traceId: string, protectedNow: boolean): void {
		if (!/^[a-f0-9]{32}$/.test(traceId)) return;
		if (protectedNow) this.protectedTraces.add(traceId);
		else this.protectedTraces.delete(traceId);
	}

	emit(
		event: string,
		level: DiagnosticLevel,
		attributes: unknown = {},
		scope: Scope = {},
		payload?: unknown,
		context = currentTraceContext() ?? this.ambient,
		parentSpanId?: string,
	): void {
		if (this.closed) return;
		try {
			const policy = this.policy();
			if (!diagnosticLevelEnabled(policy.traceUntil > Date.now() ? "trace" : policy.level, level))
				return;
			if (!/^[a-z][a-z0-9_.]+$/.test(event)) throw new Error("invalid diagnostic event name");
			const record: TraceRecord = {
				schemaVersion: 2,
				eventId: randomUUID(),
				launchId: this.launchId,
				...(this.systemLaunchId ? { systemLaunchId: this.systemLaunchId } : {}),
				pid: process.pid,
				sequence: ++this.sequence,
				at: new Date().toISOString(),
				companionId: this.companionId,
				traceId: context?.traceId ?? createTraceId(),
				spanId: context?.spanId ?? createSpanId(),
				...(parentSpanId ? { parentSpanId } : {}),
				...scope,
				level,
				event,
				attributes: diagnosticValue(attributes),
				payloadPolicy: policy.payload,
			};
			const body =
				policy.payload === "full" && payload !== undefined
					? JSON.stringify(diagnosticValue(payload))
					: undefined;
			if (body !== undefined)
				record.payload = {
					sha256: createHash("sha256").update(body).digest("hex"),
					bytes: Buffer.byteLength(body),
				};
			const bytes = Buffer.byteLength(JSON.stringify(record)) + (record.payload?.bytes ?? 0);
			// No hidden truncation: rejected records are reflected in health, independently of level.
			if (this.queue.length >= 500 || this.pendingBytes + bytes > 16 * 1024 * 1024) {
				this.healthState.dropped++;
				this.kick();
				return;
			}
			this.queue.push({ record, ...(body !== undefined ? { payload: body } : {}), bytes });
			this.pendingBytes += bytes;
			this.kick();
		} catch {
			this.healthState.dropped++;
			this.kick();
		}
	}

	span(event: string, scope: Scope = {}, input?: unknown, root = false) {
		const inherited = currentTraceContext();
		const parent = root ? undefined : inherited;
		const context: TraceContext = {
			traceId: parent?.traceId ?? createTraceId(),
			spanId: createSpanId(),
		};
		this.active.set(context.traceId, (this.active.get(context.traceId) ?? 0) + 1);
		const started = performance.now();
		let ended = false;
		this.emit(
			`${event}.start`,
			"info",
			root && inherited ? { links: [inherited] } : {},
			scope,
			input,
			context,
			parent?.spanId,
		);
		return {
			context,
			run: <T>(fn: () => T): T => runInTrace(context, fn),
			end: (outcome: Outcome, error?: unknown, output?: unknown) => {
				if (ended) return;
				ended = true;
				const durationMs = performance.now() - started;
				const metric = this.durations.get(event) ?? {
					count: 0,
					sumMs: 0,
					maxMs: 0,
					buckets: [0, 0, 0, 0, 0, 0],
				};
				metric.count++;
				metric.sumMs += durationMs;
				metric.maxMs = Math.max(metric.maxMs, durationMs);
				const bucket = [10, 100, 1000, 10000, 60000, Infinity].findIndex(
					(bound) => durationMs <= bound,
				);
				metric.buckets[bucket] = (metric.buckets[bucket] ?? 0) + 1;
				if (this.durations.has(event) || this.durations.size < 100)
					this.durations.set(event, metric);
				const remaining = (this.active.get(context.traceId) ?? 1) - 1;
				if (remaining > 0) this.active.set(context.traceId, remaining);
				else this.active.delete(context.traceId);
				this.emit(
					`${event}.end`,
					outcome === "error" ? "error" : "info",
					{
						outcome,
						durationMs,
						...(error !== undefined ? { error } : {}),
					},
					scope,
					output,
					context,
					parent?.spanId,
				);
			},
		};
	}

	async operation<T>(
		event: string,
		scope: Scope,
		input: unknown,
		work: () => Promise<T>,
	): Promise<T> {
		const span = this.span(event, scope, input);
		return span.run(async () => {
			try {
				const result = await work();
				span.end("ok", undefined, result);
				return result;
			} catch (error) {
				span.end(
					error instanceof Error && error.name === "AbortError" ? "cancelled" : "error",
					error,
				);
				throw error;
			}
		});
	}

	/** Only diagnostic span handles, no copied Pi messages, queues or runtime flags. */
	native(conversationId: string, event: { type: string }): void {
		if (event.type === "agent_start") {
			this.turns.get(conversationId)?.end("interrupted");
			this.turns.set(conversationId, this.span("pi.agent", { conversationId }));
		}
		const span = this.turns.get(conversationId);
		const fields = event as {
			toolCallId?: string;
			isError?: boolean;
			message?: { stopReason?: string };
			assistantMessageEvent?: Record<string, unknown>;
		};
		const toolKey = fields.toolCallId ? `${conversationId}:${fields.toolCallId}` : undefined;
		if (toolKey && event.type === "tool_execution_start") {
			const start = () => this.span("pi.tool", { conversationId, toolCallId: fields.toolCallId });
			this.toolSpans.set(toolKey, span ? span.run(start) : start());
		}
		const failed = fields.isError || fields.message?.stopReason === "error";
		// Native deltas suffice between message_start/end; do not write the growing
		// full partial message on every token (quadratic output).
		const { partial: _partial, ...delta } = fields.assistantMessageEvent ?? {};
		const payload = event.type === "message_update" ? { type: event.type, delta } : event;
		this.emit(
			`pi.${event.type}`,
			failed
				? "error"
				: event.type === "auto_retry_start"
					? "warn"
					: event.type === "message_update"
						? "trace"
						: "debug",
			{ type: event.type },
			{ conversationId, ...(fields.toolCallId ? { toolCallId: fields.toolCallId } : {}) },
			payload,
			(toolKey ? this.toolSpans.get(toolKey)?.context : undefined) ?? span?.context,
		);
		if (toolKey && event.type === "tool_execution_end") {
			this.toolSpans.get(toolKey)?.end(failed ? "error" : "ok");
			this.toolSpans.delete(toolKey);
		}
		if (event.type === "agent_end") {
			// Pi agent_end is settlement, not proof of successful model completion.
			span?.end("settled");
			this.turns.delete(conversationId);
		}
	}

	private kick(): void {
		if (this.writing) return;
		this.writing = this.drain().finally(() => {
			this.writing = undefined;
			if (this.queue.length) this.kick();
		});
	}
	private async append(path: string, body: string): Promise<void> {
		const file = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			if (!(await file.stat()).isFile()) throw new Error("not a regular diagnostic file");
			await file.writeFile(body);
			await file.sync();
		} finally {
			await file.close();
		}
	}
	private async drain(): Promise<void> {
		if (!this.recovered) {
			this.recovered = true;
			try {
				await this.recoverLaunches();
			} catch {
				this.healthState.writeFailures++;
			}
		}
		while (this.queue.length) {
			const item = this.queue.shift();
			if (!item) break;
			try {
				const directory = join(this.root, "traces", item.record.traceId);
				await this.directory(item.record.traceId);
				if (item.payload !== undefined && item.record.payload) {
					const file = await open(
						join(directory, "payloads", `${item.record.payload.sha256}.json`),
						"wx",
						0o600,
					).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "EEXIST") throw error;
						return undefined;
					});
					if (file) {
						try {
							await file.writeFile(item.payload);
							await file.sync();
						} finally {
							await file.close();
						}
					}
				}
				await this.append(join(directory, "events.jsonl"), `${JSON.stringify(item.record)}\n`);
				if (item.record.level === "error" || item.record.level === "fatal") {
					const incident = await open(join(directory, "incident.json"), "wx", 0o600).catch(
						(error: NodeJS.ErrnoException) => {
							if (error.code !== "EEXIST") throw error;
							return undefined;
						},
					);
					if (incident) {
						try {
							await incident.writeFile(
								JSON.stringify({
									eventId: item.record.eventId,
									at: item.record.at,
									launchId: this.launchId,
									reason: item.record.event,
								}),
							);
							await incident.sync();
						} finally {
							await incident.close();
						}
					}
				}
				this.healthState.written++;
				this.healthState.lastWriteAt = new Date().toISOString();
				this.index?.add({ ...item.record, modifiedAt: item.record.at });
			} catch {
				this.healthState.writeFailures++;
			} finally {
				this.pendingBytes -= item.bytes;
			}
		}
		if (Date.now() - this.lastPrune > 60_000) {
			this.lastPrune = Date.now();
			try {
				await this.prune();
			} catch {
				this.healthState.writeFailures++;
			}
		}
		await this.persistHealth();
	}
	private async persistHealth(): Promise<void> {
		try {
			await this.directory();
			const directory = join(this.root, "metrics");
			await mkdir(directory, { recursive: true, mode: 0o700 });
			if (!(await lstat(directory)).isDirectory()) throw new Error("unsafe metrics directory");
			const destination = join(directory, `${this.launchId}.json`);
			const temporary = `${destination}.${randomUUID()}.tmp`;
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(
					JSON.stringify({
						schemaVersion: 2,
						launchId: this.launchId,
						systemLaunchId: this.systemLaunchId,
						pid: process.pid,
						companionId: this.companionId,
						clean: this.cleanShutdown,
						at: new Date().toISOString(),
						...this.health(),
						durations: Object.fromEntries(this.durations),
						bucketUpperBoundsMs: [10, 100, 1000, 10000, 60000, null],
					}),
				);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, destination);
		} catch {
			this.healthState.writeFailures++;
		}
	}
	private async recoverLaunches(): Promise<void> {
		const directory = join(this.root, "metrics");
		const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (!info) return;
		if (!info.isDirectory()) throw new Error("unsafe metrics directory");
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
			const file = await open(
				join(directory, entry.name),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				if ((await file.stat()).size > 65536) continue;
				const health = JSON.parse(await file.readFile("utf8"));
				if (
					health.companionId !== this.companionId ||
					health.clean !== false ||
					!Number.isSafeInteger(health.pid) ||
					health.pid <= 0 ||
					defaultIsPidAlive(health.pid)
				)
					continue;
				this.emit("diagnostics.previous_exit", "error", {
					previousLaunchId: health.launchId,
					systemLaunchId: health.systemLaunchId,
					dropped: health.dropped,
					writeFailures: health.writeFailures,
				});
			} finally {
				await file.close();
			}
		}
	}
	private async directory(traceId?: string, create = true): Promise<void> {
		for (const path of [
			this.root,
			join(this.root, "traces"),
			...(traceId
				? [join(this.root, "traces", traceId), join(this.root, "traces", traceId, "payloads")]
				: []),
		]) {
			if (create) await mkdir(path, { recursive: true, mode: 0o700 });
			if (!(await lstat(path)).isDirectory()) throw new Error("unsafe diagnostic directory");
		}
	}
	async prune(): Promise<void> {
		if (this.indexing) return;
		await this.directory();
		const policy = this.policy();
		const entries = await readdir(join(this.root, "traces"), { withFileTypes: true });
		const candidates = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
			const directory = join(this.root, "traces", entry.name);
			let bytes = 0;
			let modified = 0;
			for (const parent of [directory, join(directory, "payloads")]) {
				if (!(await lstat(parent)).isDirectory()) throw new Error("unsafe trace directory");
				for (const item of await readdir(parent, { withFileTypes: true })) {
					if (!item.isFile()) continue;
					const info = await stat(join(parent, item.name));
					bytes += info.size;
					modified = Math.max(modified, info.mtimeMs);
				}
			}
			candidates.push({ id: entry.name, directory, bytes, modified });
		}
		let total = candidates.reduce((sum, item) => sum + item.bytes, 0);
		const recentIncidents = new Set<string>();
		let reservedBytes = 0;
		for (const item of [...candidates].sort((a, b) => b.modified - a.modified)) {
			if (
				recentIncidents.size >= 20 ||
				reservedBytes + item.bytes > policy.maxBytes / 4 ||
				Date.now() - item.modified > Math.min(7, policy.maxAgeDays) * 86_400_000
			)
				continue;
			const incident = await lstat(join(item.directory, "incident.json")).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return undefined;
				},
			);
			if (incident?.isFile()) {
				recentIncidents.add(item.id);
				reservedBytes += item.bytes;
			}
		}
		for (const item of candidates.sort((a, b) => a.modified - b.modified)) {
			const pinned = await lstat(join(item.directory, "pinned")).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return undefined;
				},
			);
			if (
				recentIncidents.has(item.id) ||
				pinned?.isFile() ||
				this.active.has(item.id) ||
				this.protectedTraces.has(item.id) ||
				this.queue.some((pending) => pending.record.traceId === item.id) ||
				(!this.closed && item.id === this.ambient.traceId)
			)
				continue;
			if (Date.now() - item.modified <= policy.maxAgeDays * 86_400_000 && total <= policy.maxBytes)
				continue;
			await rm(item.directory, { recursive: true });
			this.index?.remove(item.id);
			total -= item.bytes;
		}
		const metricsDirectory = join(this.root, "metrics");
		const metricsInfo = await lstat(metricsDirectory).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (!metricsInfo) return;
		if (!metricsInfo.isDirectory()) throw new Error("unsafe metrics directory");
		const metrics = [];
		for (const entry of await readdir(metricsDirectory, { withFileTypes: true })) {
			if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
			const path = join(metricsDirectory, entry.name);
			const info = await lstat(path);
			metrics.push({ path, name: entry.name, bytes: info.size, modified: info.mtimeMs });
		}
		let metricBytes = metrics.reduce((sum, item) => sum + item.bytes, 0);
		for (const item of metrics.sort((a, b) => a.modified - b.modified)) {
			if (item.name === `${this.launchId}.json`) continue;
			if (
				Date.now() - item.modified <= policy.maxAgeDays * 86_400_000 &&
				metricBytes <= Math.max(65536, policy.maxBytes / 10)
			)
				continue;
			await rm(item.path);
			metricBytes -= item.bytes;
		}
	}
	async pin(traceId: string, pinned: boolean): Promise<void> {
		if (!/^[a-f0-9]{32}$/.test(traceId)) throw new Error("invalid trace id");
		await this.flush();
		await this.directory(traceId, false);
		const path = join(this.root, "traces", traceId, "pinned");
		if (pinned) {
			const file = await open(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await file.sync();
			} finally {
				await file.close();
			}
		} else {
			await rm(path, { force: true });
		}
	}
	async isPinned(traceId: string): Promise<boolean> {
		if (!/^[a-f0-9]{32}$/.test(traceId)) throw new Error("invalid trace id");
		await this.directory(traceId, false);
		const info = await lstat(join(this.root, "traces", traceId, "pinned")).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			},
		);
		if (info && !info.isFile()) throw new Error("unsafe trace pin");
		return Boolean(info);
	}
	metrics() {
		return { ...this.health(), durations: Object.fromEntries(this.durations) };
	}
	async flush(): Promise<void> {
		while (this.writing) await this.writing;
	}
	async close(timeoutMs = 2000): Promise<void> {
		for (const span of this.toolSpans.values()) span.end("interrupted");
		this.toolSpans.clear();
		this.protectedTraces.clear();
		for (const span of this.turns.values()) span.end("interrupted");
		this.turns.clear();
		this.closed = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					await this.flush();
					await this.indexing;
					this.index?.close();
					this.index = undefined;
					this.cleanShutdown = true;
					await this.persistHealth();
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("diagnostic_shutdown_timeout")), timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	private async searchIndex(): Promise<TraceIndex> {
		if (this.indexing) return this.indexing;
		if (this.index) return this.index;
		this.indexing = (async () => {
			await this.directory();
			const path = join(this.root, "search.db");
			for (const suffix of ["", "-wal", "-shm"]) {
				const info = await lstat(path + suffix).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return undefined;
				});
				if (info && !info.isFile()) throw new Error("unsafe diagnostic index");
			}
			const handle = await open(
				path,
				constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
				0o600,
			);
			await handle.close();
			let index: TraceIndex;
			try {
				index = new TraceIndex(path);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!/not a database|database disk image is malformed/.test(error.message)
				)
					throw error;
				// Only a disposable, closed, validated index is removed. Evidence files remain untouched.
				for (const suffix of ["", "-wal", "-shm"]) await rm(path + suffix, { force: true });
				const replacement = await open(path, "wx", 0o600);
				await replacement.close();
				index = new TraceIndex(path);
			}
			try {
				index.clear();
				this.index = index;
				for (const entry of await readdir(join(this.root, "traces"), { withFileTypes: true })) {
					if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
					let offset = 0;
					do {
						const page = await this.page(entry.name, offset, 200, false).catch(
							(error: NodeJS.ErrnoException) => {
								if (error.code !== "ENOENT") throw error;
								return { content: "", next: undefined };
							},
						);
						for (const line of page.content.split("\n").filter(Boolean)) {
							try {
								const record = JSON.parse(line) as TraceRecord;
								if (record.traceId !== entry.name || record.companionId !== this.companionId)
									throw new Error("foreign diagnostic record");
								index.add({ ...record, modifiedAt: record.at });
							} catch {
								this.healthState.writeFailures++;
							}
						}
						offset = page.next ?? 0;
					} while (offset);
				}
				this.index = index;
				return index;
			} catch (error) {
				this.index = undefined;
				index.close();
				throw error;
			}
		})().finally(() => {
			this.indexing = undefined;
		});
		return this.indexing;
	}
	async query(query: TraceQuery = {}) {
		await this.flush();
		return (await this.searchIndex()).query(query);
	}
	async latestDirectory(): Promise<string> {
		const trace = (await this.query({ limit: 1 })).traces[0];
		if (!trace) throw new Error("no diagnostic trace");
		await this.directory(trace.traceId, false);
		return join(this.root, "traces", trace.traceId);
	}
	/** Byte cursor at a verified line boundary; bounded even for damaged files. */
	async page(
		traceId: string,
		offset = 0,
		limit = 200,
		flush = true,
		end?: number,
	): Promise<{ content: string; next?: number }> {
		if (!/^[a-f0-9]{32}$/.test(traceId) || !Number.isSafeInteger(offset) || offset < 0)
			throw new Error("invalid trace cursor");
		if (flush) await this.flush();
		await this.directory(traceId, false);
		const file = await open(
			join(this.root, "traces", traceId, "events.jsonl"),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const info = await file.stat();
			const size = end ?? info.size;
			if (!info.isFile() || !Number.isSafeInteger(size) || size < offset || size > info.size)
				throw new Error("invalid trace cursor");
			if (offset) {
				const previous = Buffer.alloc(1);
				await file.read(previous, 0, 1, offset - 1);
				if (previous[0] !== 10) throw new Error("cursor is not a record boundary");
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			let lines = 0;
			while (offset + bytes < size && lines < Math.max(1, Math.min(200, limit))) {
				const buffer = Buffer.alloc(Math.min(65536, size - offset - bytes));
				const read = await file.read(buffer, 0, buffer.length, offset + bytes);
				if (!read.bytesRead) break;
				let end = read.bytesRead;
				for (let i = 0; i < read.bytesRead; i++) {
					if (buffer[i] === 10 && (++lines >= limit || bytes + i >= 1024 * 1024)) {
						end = i + 1;
						break;
					}
				}
				chunks.push(buffer.subarray(0, end));
				bytes += end;
				if (bytes > 16 * 1024 * 1024) throw new Error("oversized diagnostic record");
				if (end < read.bytesRead || (bytes >= 1024 * 1024 && buffer[end - 1] === 10)) break;
			}
			return {
				content: Buffer.concat(chunks).toString("utf8"),
				...(offset + bytes < size ? { next: offset + bytes } : {}),
			};
		} finally {
			await file.close();
		}
	}
	async list(): Promise<Array<{ traceId: string; modifiedAt: string }>> {
		await this.flush();
		const root = join(this.root, "traces");
		const names = await readdir(root, { withFileTypes: true }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		);
		const rows = await Promise.all(
			names
				.filter((item) => item.isDirectory() && /^[a-f0-9]{32}$/.test(item.name))
				.map(async (item) => ({
					traceId: item.name,
					modifiedAt: (
						await stat(join(root, item.name, "events.jsonl")).catch(
							(error: NodeJS.ErrnoException) => {
								if (error.code !== "ENOENT") throw error;
								return stat(join(root, item.name));
							},
						)
					).mtime.toISOString(),
				})),
		);
		return rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 100);
	}
	async read(traceId: string): Promise<string> {
		if (!/^[a-f0-9]{32}$/.test(traceId)) throw new Error("invalid trace id");
		await this.flush();
		await this.directory(traceId, false);
		const file = await open(
			join(this.root, "traces", traceId, "events.jsonl"),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			if ((await file.stat()).size > 8 * 1024 * 1024)
				throw new Error("trace exceeds inline read limit");
			return await file.readFile("utf8");
		} finally {
			await file.close();
		}
	}
	async payload(traceId: string, sha256: string): Promise<string> {
		if (!/^[a-f0-9]{32}$/.test(traceId) || !/^[a-f0-9]{64}$/.test(sha256))
			throw new Error("invalid payload id");
		let ref: TraceRecord["payload"];
		let offset = 0;
		do {
			const page = await this.page(traceId, offset);
			for (const line of page.content.split("\n").filter(Boolean)) {
				const record = JSON.parse(line) as TraceRecord;
				if (record.payload?.sha256 === sha256) ref = record.payload;
			}
			offset = page.next ?? 0;
		} while (!ref && offset);
		if (!ref || ref.bytes > 16 * 1024 * 1024) throw new Error("payload is not owned by trace");
		return this.readPayloadReference(traceId, ref);
	}
	private async readPayloadReference(
		traceId: string,
		ref: { sha256: string; bytes: number },
	): Promise<string> {
		const { sha256 } = ref;
		if (
			!/^[a-f0-9]{64}$/.test(sha256) ||
			!Number.isSafeInteger(ref.bytes) ||
			ref.bytes < 0 ||
			ref.bytes > 16 * 1024 * 1024
		)
			throw new Error("invalid payload reference");
		const file = await open(
			join(this.root, "traces", traceId, "payloads", `${sha256}.json`),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		let content: string;
		try {
			if ((await file.stat()).size !== ref.bytes)
				throw new Error("diagnostic payload size mismatch");
			content = await file.readFile("utf8");
		} finally {
			await file.close();
		}
		if (
			Buffer.byteLength(content) !== ref.bytes ||
			createHash("sha256").update(content).digest("hex") !== sha256
		)
			throw new Error("diagnostic payload integrity failure");
		return content;
	}

	async exportTrace(traceId: string): Promise<string> {
		const content = await this.read(traceId);
		const records = content
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as TraceRecord);
		const payloads: Record<string, string> = {};
		let bytes = Buffer.byteLength(content);
		for (const record of records) {
			const ref = record.payload;
			if (!ref || payloads[ref.sha256] !== undefined) continue;
			bytes += ref.bytes;
			if (bytes > 32 * 1024 * 1024)
				throw new Error("trace export exceeds 32 MiB; use the native directory");
			payloads[ref.sha256] = await this.payload(traceId, ref.sha256);
		}
		const started = new Set(
			records.filter((record) => record.event.endsWith(".start")).map((record) => record.spanId),
		);
		for (const record of records) if (record.event.endsWith(".end")) started.delete(record.spanId);
		const launchHealth = [];
		for (const launchId of new Set(records.map((record) => record.launchId))) {
			if (!/^[a-f0-9-]{36}$/.test(launchId)) throw new Error("invalid trace launch id");
			try {
				const directory = join(this.root, "metrics");
				if (!(await lstat(directory)).isDirectory()) throw new Error("unsafe metrics directory");
				const file = await open(
					join(directory, `${launchId}.json`),
					constants.O_RDONLY | constants.O_NOFOLLOW,
				);
				let health: { dropped: number; writeFailures: number; clean: boolean };
				try {
					const info = await file.stat();
					if (!info.isFile() || info.size > 65536) throw new Error("invalid metrics file");
					health = JSON.parse(await file.readFile("utf8"));
					if (
						!Number.isSafeInteger(health.dropped) ||
						!Number.isSafeInteger(health.writeFailures) ||
						typeof health.clean !== "boolean"
					)
						throw new Error("invalid metrics record");
				} finally {
					await file.close();
				}
				launchHealth.push({
					launchId,
					dropped: health.dropped,
					writeFailures: health.writeFailures,
					clean: health.clean,
				});
			} catch {
				launchHealth.push({ launchId, unavailable: true });
			}
		}
		return JSON.stringify({
			schemaVersion: 2,
			companionId: this.companionId,
			traceId,
			completeness: { openSpans: started.size, launchHealth, scope: "observed-events" },
			events: records,
			payloads,
		});
	}
	async exportPage(traceId: string, offset = 0, end?: number) {
		if (!/^[a-f0-9]{32}$/.test(traceId)) throw new Error("invalid trace id");
		await this.flush();
		await this.directory(traceId, false);
		if (end === undefined) {
			const file = await open(
				join(this.root, "traces", traceId, "events.jsonl"),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				end = (await file.stat()).size;
			} finally {
				await file.close();
			}
		}
		const page = await this.page(traceId, offset, 200, false, end);
		const events: TraceRecord[] = [];
		let consumed = 0;
		let payloadBytes = 0;
		for (const line of page.content.split("\n").filter(Boolean)) {
			const record = JSON.parse(line) as TraceRecord;
			if (record.traceId !== traceId || record.companionId !== this.companionId)
				throw new Error("foreign diagnostic record");
			if (events.length && payloadBytes + (record.payload?.bytes ?? 0) > 16 * 1024 * 1024) break;
			payloadBytes += record.payload?.bytes ?? 0;
			events.push(record);
			consumed += Buffer.byteLength(line) + 1;
		}
		const payloads: Record<string, string> = {};
		for (const event of events) {
			if (event.payload && payloads[event.payload.sha256] === undefined)
				payloads[event.payload.sha256] = await this.readPayloadReference(traceId, event.payload);
		}
		return {
			end,
			content: JSON.stringify({
				schemaVersion: 2,
				companionId: this.companionId,
				traceId,
				byteRange: { offset, end: Math.min(end, offset + consumed), snapshotEnd: end },
				events,
				payloads,
				completeness: { scope: "observed-events", writer: this.health() },
			}),
			...(offset + consumed < end ? { next: offset + consumed } : {}),
		};
	}
}
