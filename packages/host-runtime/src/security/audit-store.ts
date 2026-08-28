/**
 * Hash-chained append-only audit store (WorkBuddy-style).
 *
 * Records are appended as JSONL lines to segmented files
 * `segment-<NNNNNN>.jsonl` under `dir`. Every record carries
 * `prevHash` (the hash of the previous record, `sha256('')` for the very
 * first) and `hash = sha256(seq|kind|action|detail|createdAt|prevHash)`, so
 * any modification of an earlier line breaks every subsequent hash — the
 * chain is verifiable end to end.
 *
 * Guarantees:
 * - Append-only, serialized in-process (a promise chain keeps disk order
 *   identical to seq order even under bursts).
 * - `list`/`exportLines` never hold more than one segment in memory at a
 *   time; export's output string is the only accumulation.
 * - Retention mirrors WorkBuddy: segments rotate at `maxBytesPerSegment`,
 *   age pruning drops segments older than `maxAgeDays`, size pruning drops
 *   the oldest segments while total bytes exceed `maxTotalBytes`. The
 *   active (newest) segment is never pruned.
 * - A time source and id source can be injected for deterministic tests.
 *
 * Internal segment deletions use an unlink reference captured at module
 * load, so the fs-protection sentinel (which may be installed later over
 * the data dir this store lives in) does not re-audit retention prunes.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { EventBus } from "../storage/event-bus.js";

// Captured before any fs-protection install can wrap delete APIs.
const unlinkFile = fsp.unlink;

export const AUDIT_KINDS = ["run", "permission", "fsop", "memory", "config"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditRecord {
	id: string;
	seq: number;
	kind: AuditKind;
	action: string;
	detail: string;
	createdAt: string;
	prevHash: string;
	hash: string;
}

export interface AuditListResult {
	entries: AuditRecord[];
	/** Smallest retained seq; 0 when the store is empty. */
	oldestSeq: number;
}

export interface AuditExportResult {
	/** Raw concatenation of every segment's JSONL lines, in seq order. */
	lines: string;
	/** False when any line is unparseable or the recomputed chain breaks. */
	verified: boolean;
}

export interface AuditPruneResult {
	prunedFiles: string[];
	remainingBytes: number;
}

export interface AuditStoreOptions {
	/** Directory for `segment-<NNNNNN>.jsonl` files (created on first use). */
	dir: string;
	logger?: { warn?: (message: string) => void };
	/** Rotate to a new segment when the current one would exceed this. Default 50 MiB. */
	maxBytesPerSegment?: number;
	/** Segments older than this are pruned. Default 90 days. */
	maxAgeDays?: number;
	/** Total budget; oldest segments are pruned while over it. Default 500 MiB. */
	maxTotalBytes?: number;
	/** Injectable clock; defaults to `() => new Date()`. */
	now?: () => Date;
	/** Injectable record id source; defaults to `crypto.randomUUID`. */
	randomId?: () => string;
}

const DAY_MS = 86_400_000;
const HASH_EMPTY = createHash("sha256").update("").digest("hex");
const SEGMENT_RE = /^segment-(\d+)\.jsonl$/;
const MAX_ACTION_LENGTH = 128;
/** Schema `MAX_STRING_LENGTH` is 4096; stay under with headroom. */
const MAX_DETAIL_LENGTH = 4000;
const SAFE_AUDIT_REASON = /^[a-z][a-z0-9_.:-]{0,127}$/;

/** Preserve stable reason codes while excluding arbitrary messages, paths, and user content. */
export function auditReasonCode(reason: string): string {
	return SAFE_AUDIT_REASON.test(reason) ? reason : "handler_failed";
}

function hashRecord(record: Omit<AuditRecord, "hash">): string {
	return createHash("sha256")
		.update(
			`${record.seq}|${record.kind}|${record.action}|${record.detail}|${record.createdAt}|${record.prevHash}`,
		)
		.digest("hex");
}

function parseRecord(line: string): AuditRecord | null {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null) return null;
		const record = value as Record<string, unknown>;
		if (
			typeof record.id !== "string" ||
			typeof record.seq !== "number" ||
			typeof record.kind !== "string" ||
			!AUDIT_KINDS.includes(record.kind as AuditKind) ||
			typeof record.action !== "string" ||
			typeof record.detail !== "string" ||
			typeof record.createdAt !== "string" ||
			typeof record.prevHash !== "string" ||
			typeof record.hash !== "string"
		) {
			return null;
		}
		return record as unknown as AuditRecord;
	} catch {
		return null;
	}
}

export class AuditStore {
	private readonly dir: string;
	private readonly logger: { warn?: (message: string) => void };
	private readonly maxBytesPerSegment: number;
	private readonly maxAgeDays: number;
	private readonly maxTotalBytes: number;
	private readonly now: () => Date;
	private readonly randomId: () => string;

	private segment = 1;
	private seq = 0;
	private lastHash = HASH_EMPTY;
	private initPromise?: Promise<void>;
	/** Serializes appends so disk order always equals seq order. */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(options: AuditStoreOptions) {
		if (!options.dir) throw new TypeError("AuditStore requires a dir");
		this.dir = options.dir;
		this.logger = options.logger ?? {};
		this.maxBytesPerSegment = options.maxBytesPerSegment ?? 50 * 1024 * 1024;
		this.maxAgeDays = options.maxAgeDays ?? 90;
		this.maxTotalBytes = options.maxTotalBytes ?? 500 * 1024 * 1024;
		this.now = options.now ?? (() => new Date());
		this.randomId = options.randomId ?? randomUUID;
	}

	/** Append a record; returns the persisted record. */
	append(kind: AuditKind, action: string, detail: string): Promise<AuditRecord> {
		if (!AUDIT_KINDS.includes(kind)) {
			throw new TypeError(`invalid audit kind: ${String(kind)}`);
		}
		const run = this.chain.then(() => this.appendNow(kind, action, detail));
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Wait until every append already accepted by the store has reached disk. */
	async flush(): Promise<void> {
		await this.chain;
	}

	/** List entries with `seq > afterSeq`, newest first, pruned to `limit`. */
	async list(options: { limit?: number; afterSeq?: number } = {}): Promise<AuditListResult> {
		await this.ensureInit();
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		const afterSeq = options.afterSeq ?? 0;
		const names = await this.segmentNames();
		const entries: AuditRecord[] = [];
		for (let i = names.length - 1; i >= 0 && entries.length < limit; i -= 1) {
			const records = await this.readRecords(join(this.dir, names[i]!));
			for (let j = records.length - 1; j >= 0 && entries.length < limit; j -= 1) {
				const record = records[j]!;
				if (record.seq > afterSeq) entries.push(record);
			}
		}
		entries.sort((a, b) => b.seq - a.seq);
		return { entries, oldestSeq: await this.oldestSeq() };
	}

	/** Concatenate all lines and verify the recomputed hash chain. */
	async exportLines(): Promise<AuditExportResult> {
		await this.ensureInit();
		const names = await this.segmentNames();
		let lines = "";
		let verified = true;
		let previousHash = HASH_EMPTY;
		for (const name of names) {
			const text = await fsp.readFile(join(this.dir, name), "utf8");
			lines += text;
			for (const raw of text.split("\n")) {
				if (raw.trim() === "") continue;
				const record = parseRecord(raw);
				if (!record) {
					verified = false;
					continue;
				}
				if (record.hash !== hashRecord(record) || record.prevHash !== previousHash) {
					verified = false;
				}
				previousHash = record.hash;
			}
		}
		return { lines, verified };
	}

	/**
	 * Retention: rotate the active segment if it exceeds `maxBytesPerSegment`,
	 * then delete segments older than `maxAgeDays` and, while total bytes
	 * exceed `maxTotalBytes`, delete the oldest segments. The active (newest)
	 * segment is never pruned.
	 */
	async prune(): Promise<AuditPruneResult> {
		await this.ensureInit();
		await this.rotateIfNeeded(0);
		let names = await this.segmentNames();
		if (names.length === 0) return { prunedFiles: [], remainingBytes: 0 };

		const prunedFiles: string[] = [];
		const cutoffMs = this.now().getTime() - this.maxAgeDays * DAY_MS;
		const active = names[names.length - 1]!;
		for (const name of names) {
			if (name === active) continue;
			const file = join(this.dir, name);
			try {
				if ((await fsp.stat(file)).mtimeMs < cutoffMs) {
					await unlinkFile(file);
					prunedFiles.push(name);
				}
			} catch {
				// already gone — nothing to prune
			}
		}

		names = (await this.segmentNames()).filter((name) => !prunedFiles.includes(name));
		let total = await this.sumBytes(names);
		while (total > this.maxTotalBytes && names.length > 1) {
			const oldest = names[0]!;
			if (oldest === active) break;
			const file = join(this.dir, oldest);
			try {
				const size = (await fsp.stat(file)).size;
				await unlinkFile(file);
				total -= size;
				prunedFiles.push(oldest);
			} catch {
				// already gone — fall through and recompute below
			}
			names = names.slice(1);
		}
		if (prunedFiles.length > 0) {
			this.logger.warn?.(
				`[audit] pruned ${prunedFiles.length} segment(s): ${prunedFiles.join(", ")}`,
			);
		}
		return { prunedFiles, remainingBytes: total };
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	private ensureInit(): Promise<void> {
		if (!this.initPromise) this.initPromise = this.initialize();
		return this.initPromise;
	}

	/** Discover existing segments and restore seq/lastHash state. */
	private async initialize(): Promise<void> {
		await fsp.mkdir(this.dir, { recursive: true });
		const names = await this.segmentNames();
		if (names.length === 0) return;
		this.segment = Number(SEGMENT_RE.exec(names[names.length - 1]!)![1]);
		// Scan newest → oldest until a record is found (an empty segment can
		// only exist as the newest, created by a rotation before any append).
		for (let i = names.length - 1; i >= 0; i -= 1) {
			const records = await this.readRecords(join(this.dir, names[i]!));
			if (records.length > 0) {
				this.seq = records[records.length - 1]!.seq;
				this.lastHash = records[records.length - 1]!.hash;
				return;
			}
		}
	}

	private currentPath(): string {
		return join(this.dir, `segment-${String(this.segment).padStart(6, "0")}.jsonl`);
	}

	private async segmentNames(): Promise<string[]> {
		let names: string[];
		try {
			names = await fsp.readdir(this.dir);
		} catch {
			return [];
		}
		return names
			.filter((name) => SEGMENT_RE.test(name))
			.sort((a, b) => Number(SEGMENT_RE.exec(a)![1]) - Number(SEGMENT_RE.exec(b)![1]));
	}

	private async readRecords(file: string): Promise<AuditRecord[]> {
		let text: string;
		try {
			text = await fsp.readFile(file, "utf8");
		} catch {
			return [];
		}
		const records: AuditRecord[] = [];
		for (const raw of text.split("\n")) {
			if (raw.trim() === "") continue;
			const record = parseRecord(raw);
			if (record) records.push(record);
		}
		return records;
	}

	private async sumBytes(names: string[]): Promise<number> {
		let total = 0;
		for (const name of names) {
			try {
				total += (await fsp.stat(join(this.dir, name))).size;
			} catch {
				// gone
			}
		}
		return total;
	}

	private async oldestSeq(): Promise<number> {
		const names = await this.segmentNames();
		for (const name of names) {
			const records = await this.readRecords(join(this.dir, name));
			if (records.length > 0) return records[0]!.seq;
		}
		return 0;
	}

	/** Roll to a new segment when the next line would exceed the cap. */
	private async rotateIfNeeded(nextLineLength: number): Promise<void> {
		const file = this.currentPath();
		try {
			const size = (await fsp.stat(file)).size;
			if (size + nextLineLength + 1 > this.maxBytesPerSegment) this.segment += 1;
		} catch {
			// no current segment yet — nothing to rotate
		}
	}

	private async appendNow(kind: AuditKind, action: string, detail: string): Promise<AuditRecord> {
		await this.ensureInit();
		this.seq += 1;
		const record: AuditRecord = {
			id: this.randomId(),
			seq: this.seq,
			kind,
			action: action.slice(0, MAX_ACTION_LENGTH),
			detail: detail.slice(0, MAX_DETAIL_LENGTH),
			createdAt: this.now().toISOString(),
			prevHash: this.lastHash,
			hash: "",
		};
		record.hash = hashRecord(record);
		const line = JSON.stringify(record);
		await this.rotateIfNeeded(line.length);
		await fsp.appendFile(this.currentPath(), line + "\n", {
			flag: "a",
			mode: 0o600,
		});
		this.lastHash = record.hash;
		return record;
	}
}

// ---------------------------------------------------------------------------
// EventBus wiring (kept string-based so it survives type churn)
// ---------------------------------------------------------------------------

const EVENT_PREFIX_MAPPING: ReadonlyArray<{ prefix: string; kind: AuditKind }> = [
	{ prefix: "run.", kind: "run" },
	{ prefix: "roleplay.", kind: "memory" },
];

/** Map an event kind to an audit kind, or null to skip it. */
export function auditKindForEvent(eventKind: string): AuditKind | null {
	if (eventKind === "evidence.collected") return "run";
	for (const { prefix, kind } of EVENT_PREFIX_MAPPING) {
		if (eventKind.startsWith(prefix)) return kind;
	}
	return null;
}

/**
 * Subscribe an audit store to the host event bus. Run/evidence events map to
 * `run`; roleplay state maps to `memory`. Audit failures never throw into the
 * event bus.
 */
export function wireAuditToEvents(
	audit: Pick<AuditStore, "append">,
	eventBus: Pick<EventBus, "subscribe">,
): () => void {
	const listener = (event: { kind: string; payload: unknown }): void => {
		// Presentation dismissal is transient UI cleanup, not a durable user or
		// model decision. Recording every dismissal flooded the trace.
		if (event.kind === "roleplay.choices_dismissed") return;
		const kind = auditKindForEvent(event.kind);
		if (!kind) return;
		const dot = event.kind.indexOf(".");
		const action = dot >= 0 ? event.kind.slice(dot + 1) : event.kind;
		// Event payloads may contain prompts, local paths, or user content. The
		// RPC trace already records outcome and reason; keep this channel as a
		// privacy-safe event marker instead of copying arbitrary values.
		const detail = JSON.stringify({ event: event.kind });
		void audit.append(kind, action, detail).catch(() => {
			// Audit is a side channel: never break the host on append failure.
		});
	};
	return eventBus.subscribe(listener);
}
