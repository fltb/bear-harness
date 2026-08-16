/**
 * File operations service — plan, execute, journal, undo, conflict detection.
 *
 * File mutations never happen directly: callers submit a plan (every src/dst
 * confined to authorized roots), execute it (each op journaled append-only
 * into the `evidence` table as kind='fsop_journal'), and may undo it later by
 * reversing the journal. Plans persist in `evidence` as kind='fsop_plan' so
 * execute/undo survive restarts (restart-safe journal).
 *
 * Safety model:
 *   - plan(): validates every src/dst is contained in an authorized root
 *     (resolve + startsWith), rejects literal `..` traversal, and rejects
 *     symlink/reparse escapes (the realpath of the deepest existing ancestor
 *     must stay inside the canonical root; the final component must not be a
 *     symlink). It also captures a stat baseline (exists/mtimeMs/size) of each
 *     destination so execute can detect concurrent modification.
 *   - execute(): re-validates paths, then re-stats the destination against
 *     the plan-time baseline — a change means someone else touched the file,
 *     so the op is marked `needs_user` and NOT performed. Every op (done,
 *     needs_user, or error) writes one append-only journal row. Hard failures
 *     stop the plan; content is verified against the op's plan-time
 *     `contentHash`/`size` when provided.
 *   - undo(): reverses a plan's journal in reverse opIndex order; each entry
 *     is only reversed when the destination still matches `afterHash` (no new
 *     changes) and the source still matches `beforeHash` — otherwise the
 *     entry is marked `needs_user`.
 *
 * Ops read bytes from `src` at execution time; `contentHash`/`size` on the op
 * are plan-time expectations used for verification after writing; `create`
 * writes an empty file unless the op carries `contentBase64`.
 *
 * All failures throw `{ kind, reason }` (see FsopError), surfaced as
 * `{ ok: false, error }` by the IPC router.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { evidence } from "../storage/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FsopKind = "create" | "write_new" | "convert" | "mkdir" | "move" | "rename";

export interface FsopOp {
	kind: FsopKind;
	src?: string;
	dst?: string;
	/** Plan-time expected sha256 of the destination content (verification). */
	contentHash?: string;
	/** Plan-time expected size of the destination content (verification). */
	size?: number;
	mime?: string;
	/** `create` only: literal file content (base64); absent → empty file. */
	contentBase64?: string;
}

export interface FsopPlan {
	id: string;
	ops: FsopOp[];
	authorizedRoots: string[];
}

export type FsopJournalStatus = "done" | "error" | "needs_user" | "undone";

export interface FsopJournal {
	id: string;
	planId: string;
	opIndex: number;
	src: string | null;
	dst: string | null;
	beforeHash?: string;
	afterHash?: string;
	status: FsopJournalStatus;
	sameVolume?: boolean;
	error?: string;
}

/** Error convention: every failure is `{ kind, reason }`. */
export interface FsopError {
	kind: string;
	reason: string;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FSOP_KINDS: readonly FsopKind[] = [
	"create",
	"write_new",
	"convert",
	"mkdir",
	"move",
	"rename",
];
const NEEDS_SRC: readonly FsopKind[] = ["write_new", "convert", "move", "rename"];
const NEEDS_DST: readonly FsopKind[] = [
	"create",
	"write_new",
	"convert",
	"mkdir",
	"move",
	"rename",
];

const PLAN_KIND = "fsop_plan";
const JOURNAL_KIND = "fsop_journal";
const UNDO_KIND = "fsop_undo";

/** Spreadsheet formula injection prefixes — guard by prepending `'`. */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"] as const;

/**
 * Formula injection guard — mirrors `materials/codec.ts`; keep in sync.
 * If the value starts with `=`, `+`, `-`, `@`, tab, or CR, prepend a single
 * quote so the cell reads as text instead of evaluating.
 */
export function guardCell(value: string): string {
	return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix)) ? `'${value}` : value;
}

/** Throw a `{ kind, reason }` error (never returns). */
function fail(kind: string, reason: string): never {
	const error: FsopError = { kind, reason };
	throw error;
}

/** Extract the errno code from a node:fs error (undefined when not an errno error). */
function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/** Is `child` equal to `root` or lexically under `root + sep`? */
function isUnder(child: string, root: string): boolean {
	if (child === root) return true;
	if (root === sep) return child.startsWith(sep); // root filesystem
	return child.startsWith(root + sep);
}

/** Canonicalize a path (resolve symlinks); fall back to lexical resolve. */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** Deepest existing ancestor of `path`, found with lstat (does not follow symlinks). */
function deepestExistingAncestor(path: string): string | null {
	let current = path;
	for (;;) {
		try {
			lstatSync(current);
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

/**
 * Validate that `target` stays inside `root`: absolute, no literal `..`
 * segments, lexically under root (resolve + startsWith), no symlink/reparse
 * escape (realpath of the deepest existing ancestor stays inside the
 * canonical root), and the final component is not itself a symlink. Returns
 * the resolved target. Throws `{ kind, reason }` on violation.
 */
function assertContained(target: string, root: string): string {
	if (!isAbsolute(target)) fail("invalid_request", "path_not_absolute");
	for (const segment of target.split(/[\\/]/)) {
		if (segment === "..") fail("invalid_request", "path_traversal");
	}
	const resolved = resolve(target);
	const rootLexical = resolve(root);
	if (!isUnder(resolved, rootLexical)) fail("invalid_request", "path_outside_roots");
	const ancestor = deepestExistingAncestor(resolved);
	if (ancestor !== null) {
		const canonicalRoot = canonicalize(rootLexical);
		const canonicalAncestor = canonicalize(ancestor);
		if (!isUnder(canonicalAncestor, canonicalRoot)) fail("invalid_request", "symlink_escape");
	}
	if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
		fail("invalid_request", "symlink_target");
	}
	return resolved;
}

/** Plan-time stat baseline of a destination, used for execute-time conflict detection. */
interface DstBaseline {
	exists: boolean;
	mtimeMs?: number;
	size?: number;
}

/** Stored plan record (evidence kind='fsop_plan') — public plan plus per-op baselines. */
interface StoredFsopPlan {
	id: string;
	ops: Array<FsopOp & { baseline?: DstBaseline }>;
	authorizedRoots: string[];
}

// ---------------------------------------------------------------------------
// FileOpsService
// ---------------------------------------------------------------------------

export class FileOpsService {
	private db: AppDatabase;
	private eventBus: EventBus;

	constructor(db: AppDatabase, eventBus: EventBus) {
		this.db = db;
		this.eventBus = eventBus;
	}

	// -----------------------------------------------------------------------
	// Planning
	// -----------------------------------------------------------------------

	/** Validate a plan, assign an id, persist it (evidence kind='fsop_plan'), and return it. */
	plan(params: { authorizedRoots: string[]; ops: FsopOp[] }): FsopPlan {
		if (params.authorizedRoots.length === 0) fail("invalid_request", "no_authorized_roots");
		const roots = params.authorizedRoots.map((root) => {
			if (!isAbsolute(root)) fail("invalid_request", "root_not_absolute");
			return resolve(root);
		});
		const storedOps: StoredFsopPlan["ops"] = params.ops.map((op) => {
			if (!FSOP_KINDS.includes(op.kind)) fail("invalid_request", "unknown_op_kind");
			this.validateOpPaths(op, roots);
			return { ...op, baseline: this.captureBaseline(op) };
		});
		const id = randomUUID();
		const stored: StoredFsopPlan = { id, ops: storedOps, authorizedRoots: roots };
		this.db.insert(evidence).values({ id, kind: PLAN_KIND, data: stored }).run();
		this.eventBus.publish("fsops.plan_created", { planId: id, opCount: storedOps.length });
		return { id, ops: params.ops, authorizedRoots: roots };
	}

	// -----------------------------------------------------------------------
	// Execution
	// -----------------------------------------------------------------------

	/**
	 * Execute a plan in op order. Every op appends one journal row to
	 * `evidence` (kind='fsop_journal'). Hard failures stop the plan and are
	 * collected in `errors`; conflicts mark the op `needs_user` (not
	 * performed) and execution continues.
	 */
	async execute(planId: string): Promise<{ journal: FsopJournal[]; errors: string[] }> {
		const stored = this.loadPlan(planId);
		if (!stored) fail("not_found", "plan_not_found");
		const journal: FsopJournal[] = [];
		const errors: string[] = [];
		for (let opIndex = 0; opIndex < stored.ops.length; opIndex++) {
			const op = stored.ops[opIndex];
			if (!op) break;
			const entry = this.executeOp(stored, opIndex, op);
			this.appendJournal(entry);
			this.eventBus.publish("fsops.journal_entry", {
				entryId: entry.id,
				planId,
				opIndex,
				status: entry.status,
			});
			journal.push(entry);
			if (entry.status === "error") {
				errors.push(`op ${opIndex} (${op.kind}): ${entry.error ?? "unknown"}`);
				break;
			}
		}
		return { journal, errors };
	}

	// -----------------------------------------------------------------------
	// Undo
	// -----------------------------------------------------------------------

	/**
	 * Undo a journal. `journalId` may be the plan id or any journal entry id
	 * of that plan. The plan's `done` entries are reversed in reverse opIndex
	 * order; each entry is only reversed when the destination is unchanged
	 * since the op (`afterHash` still matches) and the source is unchanged
	 * (`beforeHash`) — otherwise the entry is marked `needs_user`. Returns the
	 * undo journal (persisted as evidence kind='fsop_undo').
	 */
	undo(journalId: string): FsopJournal[] {
		const planId = this.resolveJournalPlan(journalId);
		if (!planId) fail("not_found", "journal_not_found");
		const entries = this.loadJournalEntries(planId).filter((entry) => entry.status === "done");
		const undoJournal: FsopJournal[] = [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			const undoEntry = this.undoOne(entry);
			this.appendJournal(undoEntry, UNDO_KIND);
			this.eventBus.publish("fsops.undo_entry", {
				entryId: undoEntry.id,
				planId,
				opIndex: entry.opIndex,
				status: undoEntry.status,
			});
			undoJournal.push(undoEntry);
		}
		return undoJournal;
	}

	// -----------------------------------------------------------------------
	// Internals — validation
	// -----------------------------------------------------------------------

	private validateOpPaths(op: FsopOp, roots: string[]): void {
		if (NEEDS_DST.includes(op.kind) && op.dst === undefined)
			fail("invalid_request", "op_missing_dst");
		if (NEEDS_SRC.includes(op.kind) && op.src === undefined)
			fail("invalid_request", "op_missing_src");
		if (op.src !== undefined) this.assertContainedInRoots(op.src, roots);
		if (op.dst !== undefined) this.assertContainedInRoots(op.dst, roots);
	}

	private assertContainedInRoots(target: string, roots: string[]): void {
		let lastError: FsopError = { kind: "invalid_request", reason: "path_outside_roots" };
		for (const root of roots) {
			try {
				assertContained(target, root);
				return;
			} catch (e) {
				lastError = e as FsopError;
			}
		}
		throw lastError;
	}

	/** Snapshot of the destination at plan time (conflict baseline). */
	private captureBaseline(op: FsopOp): DstBaseline | undefined {
		if (op.dst === undefined) return undefined;
		try {
			const st = lstatSync(op.dst);
			if (st.isSymbolicLink()) fail("invalid_request", "symlink_target");
			return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
		} catch {
			return { exists: false };
		}
	}

	// -----------------------------------------------------------------------
	// Internals — execution
	// -----------------------------------------------------------------------

	private executeOp(
		plan: StoredFsopPlan,
		opIndex: number,
		op: FsopOp & { baseline?: DstBaseline },
	): FsopJournal {
		const entry: FsopJournal = {
			id: randomUUID(),
			planId: plan.id,
			opIndex,
			src: op.src ?? null,
			dst: op.dst ?? null,
			status: "done",
		};
		try {
			// Re-validate containment at execution time (defense-in-depth:
			// plans live in the evidence table and are replayed across
			// restarts, so re-checking guards against stale/tampered rows).
			this.validateOpPaths(op, plan.authorizedRoots);

			// Conflict detection: the destination must match its plan-time
			// baseline. A change (or unexpected appearance/disappearance)
			// means someone else touched the file — do not overwrite.
			const conflict = this.checkDstConflict(op);
			if (conflict !== null) {
				entry.status = "needs_user";
				entry.error = conflict;
				return entry;
			}

			// Source snapshot — sha256 of src content when it exists.
			if (op.src !== undefined && this.isFile(op.src)) {
				entry.beforeHash = this.hashFile(op.src);
			}

			const src = op.src;
			const dst = op.dst;
			if (dst === undefined) fail("invalid_request", "op_missing_dst");

			// The destination's parent directory is implied by the authorized
			// dst path — make sure it exists (write/copy/rename all require it).
			mkdirSync(dirname(dst), { recursive: true });

			entry.sameVolume = this.sameVolume(op);

			switch (op.kind) {
				case "create": {
					const content =
						op.contentBase64 !== undefined
							? Buffer.from(op.contentBase64, "base64")
							: Buffer.alloc(0);
					writeFileSync(dst, content);
					break;
				}
				case "write_new": {
					writeFileSync(dst, readFileSync(src!));
					break;
				}
				case "convert": {
					copyFileSync(src!, dst);
					break;
				}
				case "mkdir": {
					mkdirSync(dst, { recursive: true });
					break;
				}
				case "move":
				case "rename": {
					try {
						renameSync(src!, dst);
					} catch (e) {
						if (errnoCode(e) === "EXDEV") {
							// Cross-volume: fall back to copy + delete.
							copyFileSync(src!, dst);
							rmSync(src!);
						} else {
							throw e;
						}
					}
					break;
				}
			}

			// Destination snapshot + plan-time content verification.
			if (this.isFile(dst)) {
				entry.afterHash = this.hashFile(dst);
				if (op.contentHash !== undefined && entry.afterHash !== op.contentHash) {
					entry.status = "error";
					entry.error = `content_hash_mismatch: expected ${op.contentHash}, got ${entry.afterHash}`;
					return entry;
				}
				if (op.size !== undefined && statSync(dst).size !== op.size) {
					entry.status = "error";
					entry.error = `size_mismatch: expected ${op.size}, got ${statSync(dst).size}`;
					return entry;
				}
			}

			return entry;
		} catch (e) {
			entry.status = "error";
			entry.error = e instanceof Error ? e.message : JSON.stringify(e);
			return entry;
		}
	}

	/** Compare the destination against the plan-time baseline; null when clean. */
	private checkDstConflict(op: FsopOp & { baseline?: DstBaseline }): string | null {
		const baseline = op.baseline;
		if (op.dst === undefined || baseline === undefined) return null;
		let current: { mtimeMs: number; size: number } | null = null;
		try {
			const st = statSync(op.dst);
			current = { mtimeMs: st.mtimeMs, size: st.size };
		} catch {
			current = null;
		}
		if (baseline.exists) {
			if (current === null) return "conflict_dst_missing";
			if (current.mtimeMs !== baseline.mtimeMs || current.size !== baseline.size) {
				return "conflict_dst_changed";
			}
			return null;
		}
		if (current !== null) return "conflict_dst_exists";
		return null;
	}

	/** Are src and the destination's parent on the same volume (device)? */
	private sameVolume(op: FsopOp): boolean | undefined {
		if (op.src === undefined || op.dst === undefined) return undefined;
		try {
			return statSync(op.src).dev === statSync(dirname(op.dst)).dev;
		} catch {
			return undefined;
		}
	}

	// -----------------------------------------------------------------------
	// Internals — undo
	// -----------------------------------------------------------------------

	private undoOne(entry: FsopJournal): FsopJournal {
		const base: FsopJournal = {
			id: randomUUID(),
			planId: entry.planId,
			opIndex: entry.opIndex,
			src: entry.src,
			dst: entry.dst,
			beforeHash: entry.beforeHash,
			afterHash: entry.afterHash,
			sameVolume: entry.sameVolume,
			status: "undone",
		};
		const plan = this.loadPlan(entry.planId);
		const op = plan ? plan.ops[entry.opIndex] : undefined;
		try {
			const dst = entry.dst;
			const src = entry.src;
			const kind = op?.kind;
			if (dst === null) fail("invalid_request", "journal_missing_dst");

			// Guard 1: the destination must be exactly as the op left it.
			if (entry.afterHash !== undefined) {
				if (!this.isFile(dst) || this.hashFile(dst) !== entry.afterHash) {
					return { ...base, status: "needs_user", error: "dst_modified_since_op" };
				}
			}

			// Guard 2: the source must be unchanged (src-backed ops), or the
			// original location must still be free (move/rename).
			if (src !== null && (kind === "move" || kind === "rename")) {
				if (existsSync(src)) {
					return { ...base, status: "needs_user", error: "src_occupied" };
				}
			} else if (src !== null && entry.beforeHash !== undefined) {
				if (!this.isFile(src) || this.hashFile(src) !== entry.beforeHash) {
					return { ...base, status: "needs_user", error: "src_modified_since_op" };
				}
			}

			switch (kind) {
				case "create":
				case "write_new":
				case "convert": {
					// Restore the original state: destination absent (for
					// convert the original content is preserved at src).
					rmSync(dst);
					break;
				}
				case "mkdir": {
					if (this.isDir(dst)) {
						try {
							rmdirSync(dst);
						} catch (e) {
							const code = errnoCode(e);
							if (code === "ENOTEMPTY" || code === "EEXIST") {
								return { ...base, status: "needs_user", error: "dir_not_empty" };
							}
							throw e;
						}
					} else if (existsSync(dst)) {
						// A file sits where the directory was created — user replaced it.
						return { ...base, status: "needs_user", error: "dst_modified_since_op" };
					}
					// Already removed → trivially restored.
					break;
				}
				case "move":
				case "rename": {
					if (!existsSync(dst)) {
						return { ...base, status: "needs_user", error: "dst_modified_since_op" };
					}
					if (this.isDir(dst)) {
						if (entry.sameVolume !== true) {
							return { ...base, status: "needs_user", error: "dir_cross_volume" };
						}
						renameSync(dst, src!);
					} else {
						// Restore the original via copy, then remove the moved copy.
						copyFileSync(dst, src!);
						rmSync(dst);
					}
					break;
				}
				default: {
					// Plan row unavailable — cannot infer the reverse operation.
					return { ...base, status: "needs_user", error: "plan_unavailable" };
				}
			}

			return base;
		} catch (e) {
			return {
				...base,
				status: "error",
				error: e instanceof Error ? e.message : JSON.stringify(e),
			};
		}
	}

	// -----------------------------------------------------------------------
	// Internals — persistence
	// -----------------------------------------------------------------------

	/** Map a journalId (plan id or any of its entry ids) to the plan id. */
	private resolveJournalPlan(journalId: string): string | null {
		const row = this.db
			.select({ data: evidence.data })
			.from(evidence)
			.where(eq(evidence.id, journalId))
			.get();
		if (row && this.isJournal(row.data)) return row.data.planId;
		return this.loadPlan(journalId)?.id ?? null;
	}

	private loadPlan(planId: string): StoredFsopPlan | null {
		const row = this.db
			.select({ data: evidence.data })
			.from(evidence)
			.where(and(eq(evidence.id, planId), eq(evidence.kind, PLAN_KIND)))
			.get();
		if (!row) return null;
		return row.data as StoredFsopPlan;
	}

	private loadJournalEntries(planId: string): FsopJournal[] {
		const rows = this.db
			.select({ data: evidence.data })
			.from(evidence)
			.where(eq(evidence.kind, JOURNAL_KIND))
			.all();
		return rows
			.map((row) => row.data)
			.filter((data): data is FsopJournal => this.isJournal(data) && data.planId === planId)
			.sort((a, b) => a.opIndex - b.opIndex);
	}

	private appendJournal(entry: FsopJournal, kind: string = JOURNAL_KIND): void {
		this.db.insert(evidence).values({ id: entry.id, kind, data: entry }).run();
	}

	private isJournal(data: unknown): data is FsopJournal {
		return typeof data === "object" && data !== null && "planId" in data;
	}

	// -----------------------------------------------------------------------
	// Internals — filesystem
	// -----------------------------------------------------------------------

	private hashFile(path: string): string {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	}

	private isFile(path: string): boolean {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	}

	private isDir(path: string): boolean {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	}
}
