import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	opendirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "@bear-harness/schema";

export const DURABLE_FILE_TRANSACTION_VERSION = 1 as const;
export type DurableFileTransactionState = "staged" | "old-target-moved" | "activated";
export interface DurableFileTransactionMarker {
	version: typeof DURABLE_FILE_TRANSACTION_VERSION;
	transactionId: string;
	target: string;
	staging: string;
	backup: string;
	state: DurableFileTransactionState;
}
export interface DurableFileTransactionOptions {
	root: string;
	target: string;
	stage(stagingPath: string): void | Promise<void>;
	verify(candidatePath: string): boolean | Promise<boolean>;
	maxEntries?: number;
	maxDepth?: number;
}
export interface DurableFileTransactionSyncOptions {
	root: string;
	target: string;
	stage(stagingPath: string): void;
	verify(candidatePath: string): boolean;
	maxEntries?: number;
	maxDepth?: number;
}
export interface DurableFileRecoveryOptions {
	root: string;
	target: string;
	verify(candidatePath: string): boolean | Promise<boolean>;
}
export interface DurableFileRecoverySyncOptions {
	root: string;
	target: string;
	verify(candidatePath: string): boolean;
}
export type DurableCopyStatus = "missing" | "valid" | "invalid";
export type DurableFileRecoveryResult =
	| { status: "none" }
	| {
			status: "recovered";
			transactionId: string;
			action: "activated-staging" | "restored-backup" | "completed-activation";
	  }
	| {
			status: "recovery-required";
			transactionId?: string;
			reason: string;
			copies: { target: DurableCopyStatus; staging: DurableCopyStatus; backup: DurableCopyStatus };
	  };
export type DurableFileTransactionErrorCode =
	| "invalid-root"
	| "path-outside-root"
	| "symlink-root"
	| "symlink-path"
	| "invalid-target-parent"
	| "transaction-exists"
	| "invalid-staging"
	| "scan-limit-exceeded"
	| "verification-failed"
	| "rollback-failed";
export class DurableFileTransactionError extends Error {
	readonly code: DurableFileTransactionErrorCode;
	readonly cause?: unknown;
	constructor(code: DurableFileTransactionErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "DurableFileTransactionError";
		this.code = code;
		this.cause = cause;
	}
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_DEPTH = 64;
const MAX_MARKER_BYTES = 64 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Copies = { target: DurableCopyStatus; staging: DurableCopyStatus; backup: DurableCopyStatus };
interface Paths {
	root: string;
	target: string;
	parent: string;
	marker: string;
	base: string;
}
const MarkerSchema = z.strictObject({
	version: z.literal(DURABLE_FILE_TRANSACTION_VERSION),
	transactionId: z.string().regex(ID_PATTERN),
	target: z.string(),
	staging: z.string(),
	backup: z.string(),
	state: z.enum(["staged", "old-target-moved", "activated"]),
});
interface Bounds {
	maxEntries: number;
	maxDepth: number;
	entries: number;
}

/** Return the deterministic marker location used by replacement and recovery. */
export function durableFileTransactionMarkerPath(root: string, target: string): string {
	return validatePaths(root, target).marker;
}

/** Synchronous counterpart for startup and request paths that cannot yield mid-transaction. */
export function replaceDurableFileSync(options: DurableFileTransactionSyncOptions): void {
	const paths = validatePaths(options.root, options.target);
	if (existsSync(paths.marker)) {
		throw new DurableFileTransactionError(
			"transaction-exists",
			`unfinished transaction exists for ${paths.target}`,
		);
	}
	const transactionId = randomUUID();
	const marker: DurableFileTransactionMarker = {
		version: DURABLE_FILE_TRANSACTION_VERSION,
		transactionId,
		target: paths.target,
		staging: join(paths.parent, `.${paths.base}.staging-${transactionId}`),
		backup: join(paths.parent, `.${paths.base}.backup-${transactionId}`),
		state: "staged",
	};
	const bounds = makeBounds(options.maxEntries, options.maxDepth);
	try {
		options.stage(marker.staging);
		ensureReplaceableRoot(marker.staging);
		syncTree(marker.staging, bounds);
		syncDirectory(paths.parent);
		let stagedValid = false;
		let stagedCause: unknown;
		try {
			stagedValid = options.verify(marker.staging);
		} catch (error) {
			stagedCause = error;
		}
		if (!stagedValid) {
			throw new DurableFileTransactionError(
				"verification-failed",
				`staged replacement failed verification for ${paths.target}`,
				stagedCause,
			);
		}
	} catch (error) {
		remove(marker.staging);
		syncDirectory(paths.parent);
		throw error;
	}
	try {
		writeMarker(paths.marker, marker);
	} catch (error) {
		if (!existsSync(paths.marker)) {
			remove(marker.staging);
			syncDirectory(paths.parent);
		}
		throw error;
	}
	if (existsSync(paths.target)) {
		ensureReplaceableRoot(paths.target);
		renameSync(paths.target, marker.backup);
		syncDirectory(paths.parent);
	}
	marker.state = "old-target-moved";
	writeMarker(paths.marker, marker);
	renameSync(marker.staging, paths.target);
	syncDirectory(paths.parent);
	marker.state = "activated";
	writeMarker(paths.marker, marker);

	let valid = false;
	let cause: unknown;
	try {
		valid = options.verify(paths.target);
	} catch (error) {
		cause = error;
	}
	if (!valid) {
		try {
			rollback(paths, marker);
		} catch (rollbackError) {
			throw new DurableFileTransactionError(
				"rollback-failed",
				"verification failed and rollback failed",
				{ verificationError: cause, rollbackError },
			);
		}
		throw new DurableFileTransactionError(
			"verification-failed",
			`activated replacement failed verification for ${paths.target}`,
			cause,
		);
	}
	finish(paths, marker);
}

/** Stage, activate, verify, and finalize a durable replacement. */
export async function replaceDurableFile(options: DurableFileTransactionOptions): Promise<void> {
	const paths = validatePaths(options.root, options.target);
	if (existsSync(paths.marker)) {
		throw new DurableFileTransactionError(
			"transaction-exists",
			`unfinished transaction exists for ${paths.target}`,
		);
	}
	const transactionId = randomUUID();
	const marker: DurableFileTransactionMarker = {
		version: DURABLE_FILE_TRANSACTION_VERSION,
		transactionId,
		target: paths.target,
		staging: join(paths.parent, `.${paths.base}.staging-${transactionId}`),
		backup: join(paths.parent, `.${paths.base}.backup-${transactionId}`),
		state: "staged",
	};
	const bounds = makeBounds(options.maxEntries, options.maxDepth);
	try {
		await options.stage(marker.staging);
		ensureReplaceableRoot(marker.staging);
		syncTree(marker.staging, bounds);
		syncDirectory(paths.parent);
		let stagedValid = false;
		let stagedCause: unknown;
		try {
			stagedValid = await options.verify(marker.staging);
		} catch (error) {
			stagedCause = error;
		}
		if (!stagedValid) {
			throw new DurableFileTransactionError(
				"verification-failed",
				`staged replacement failed verification for ${paths.target}`,
				stagedCause,
			);
		}
	} catch (error) {
		remove(marker.staging);
		syncDirectory(paths.parent);
		throw error;
	}

	try {
		writeMarker(paths.marker, marker);
	} catch (error) {
		if (!existsSync(paths.marker)) {
			remove(marker.staging);
			syncDirectory(paths.parent);
		}
		throw error;
	}
	if (existsSync(paths.target)) {
		ensureReplaceableRoot(paths.target);
		renameSync(paths.target, marker.backup);
		syncDirectory(paths.parent);
	}
	marker.state = "old-target-moved";
	writeMarker(paths.marker, marker);
	renameSync(marker.staging, paths.target);
	syncDirectory(paths.parent);
	marker.state = "activated";
	writeMarker(paths.marker, marker);

	let valid = false;
	let cause: unknown;
	try {
		valid = await options.verify(paths.target);
	} catch (error) {
		cause = error;
	}
	if (!valid) {
		try {
			rollback(paths, marker);
		} catch (rollbackError) {
			throw new DurableFileTransactionError(
				"rollback-failed",
				"verification failed and rollback failed",
				{
					verificationError: cause,
					rollbackError,
				},
			);
		}
		throw new DurableFileTransactionError(
			"verification-failed",
			`activated replacement failed verification for ${paths.target}`,
			cause,
		);
	}
	finish(paths, marker);
}

/** Recover one target without removing any path unless another verified copy remains. */
export async function recoverDurableFileTransaction(
	options: DurableFileRecoveryOptions,
): Promise<DurableFileRecoveryResult> {
	const paths = validatePaths(options.root, options.target);
	if (!existsSync(paths.marker)) return { status: "none" };
	let marker: DurableFileTransactionMarker;
	try {
		marker = readMarker(paths);
	} catch (error) {
		return required(undefined, markerError(error));
	}
	const target = await assess(marker.target, options.verify);
	const staging = await assess(marker.staging, options.verify);
	const backup = await assess(marker.backup, options.verify);
	const copies: Copies = { target, staging, backup };

	return recoverAssessed(paths, marker, copies);
}

/** Synchronous recovery for startup paths that must finish before package reads begin. */
export function recoverDurableFileTransactionSync(
	options: DurableFileRecoverySyncOptions,
): DurableFileRecoveryResult {
	const paths = validatePaths(options.root, options.target);
	if (!existsSync(paths.marker)) return { status: "none" };
	let marker: DurableFileTransactionMarker;
	try {
		marker = readMarker(paths);
	} catch (error) {
		return required(undefined, markerError(error));
	}
	const copies: Copies = {
		target: assessSync(marker.target, options.verify),
		staging: assessSync(marker.staging, options.verify),
		backup: assessSync(marker.backup, options.verify),
	};
	return recoverAssessed(paths, marker, copies);
}

function recoverAssessed(
	paths: Paths,
	marker: DurableFileTransactionMarker,
	copies: Copies,
): DurableFileRecoveryResult {
	const { target, staging, backup } = copies;
	if (marker.state === "staged") {
		if (staging === "valid" && backup === "missing") {
			if (target === "invalid")
				return required(marker.transactionId, "invalid existing target", copies);
			if (target === "valid") {
				renameSync(marker.target, marker.backup);
				syncDirectory(paths.parent);
			}
			marker.state = "old-target-moved";
			writeMarker(paths.marker, marker);
			activate(paths, marker);
			return recovered(marker, "activated-staging");
		}
		if (staging === "valid" && target === "missing" && backup === "valid") {
			marker.state = "old-target-moved";
			writeMarker(paths.marker, marker);
			activate(paths, marker);
			return recovered(marker, "activated-staging");
		}
		if (
			staging === "missing" &&
			target === "valid" &&
			(backup === "valid" || backup === "missing")
		) {
			finish(paths, marker);
			return recovered(marker, "completed-activation");
		}
	}
	if (marker.state === "old-target-moved") {
		if (
			target === "missing" &&
			staging === "valid" &&
			(backup === "valid" || backup === "missing")
		) {
			activate(paths, marker);
			return recovered(marker, "activated-staging");
		}
		if (
			target === "valid" &&
			staging === "missing" &&
			(backup === "valid" || backup === "missing")
		) {
			finish(paths, marker);
			return recovered(marker, "completed-activation");
		}
	}
	if (marker.state === "activated") {
		if (
			target === "valid" &&
			staging === "missing" &&
			(backup === "valid" || backup === "missing")
		) {
			finish(paths, marker);
			return recovered(marker, "completed-activation");
		}
		if (target !== "valid" && staging === "missing" && backup === "valid") {
			restore(paths, marker);
			return recovered(marker, "restored-backup");
		}
		if (target === "missing" && staging === "valid" && backup === "missing") {
			activate(paths, marker);
			return recovered(marker, "activated-staging");
		}
	}
	if (
		target !== "valid" &&
		staging !== "valid" &&
		backup === "valid" &&
		(target === "missing" || staging === "missing")
	) {
		restore(paths, marker);
		return recovered(marker, "restored-backup");
	}
	return required(marker.transactionId, "ambiguous or invalid transaction layout", copies);
}

function recovered(
	marker: DurableFileTransactionMarker,
	action: "activated-staging" | "restored-backup" | "completed-activation",
): DurableFileRecoveryResult {
	return { status: "recovered", transactionId: marker.transactionId, action };
}
function required(
	id: string | undefined,
	reason: string,
	copies: Copies = {
		target: "missing",
		staging: "missing",
		backup: "missing",
	},
): DurableFileRecoveryResult {
	return { status: "recovery-required", ...(id ? { transactionId: id } : {}), reason, copies };
}

function validatePaths(rootInput: string, targetInput: string): Paths {
	const root = resolve(rootInput);
	let stat: Stats;
	try {
		stat = lstatSync(root);
	} catch (error) {
		throw new DurableFileTransactionError(
			"invalid-root",
			`transaction root does not exist: ${root}`,
			error,
		);
	}
	if (stat.isSymbolicLink())
		throw new DurableFileTransactionError("symlink-root", `root is a symlink: ${root}`);
	if (!stat.isDirectory()) {
		throw new DurableFileTransactionError(
			"invalid-root",
			`root is not a canonical directory: ${root}`,
		);
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(root);
	} catch (error) {
		throw new DurableFileTransactionError(
			"invalid-root",
			`root is not a canonical directory: ${root}`,
			error,
		);
	}
	const target = resolve(targetInput);
	if (!isPathInside(root, target, false)) {
		throw new DurableFileTransactionError("path-outside-root", `target escapes root: ${target}`);
	}
	const parent = dirname(target);
	validateExistingPath(root, parent, true);
	if (existsSync(target)) validateExistingPath(root, target, false);
	const base = basename(target);
	let canonicalParent: string;
	let canonicalTarget: string;
	try {
		canonicalParent = realpathSync(parent);
		canonicalTarget = existsSync(target) ? realpathSync(target) : join(canonicalParent, base);
	} catch (error) {
		throw new DurableFileTransactionError(
			"invalid-target-parent",
			`transaction path cannot be resolved: ${target}`,
			error,
		);
	}
	// Staging and backup paths are direct children of the same canonical parent.
	if (
		!isPathInside(canonicalRoot, canonicalParent, true) ||
		!isPathInside(canonicalRoot, canonicalTarget, false)
	) {
		throw new DurableFileTransactionError("path-outside-root", `target escapes root: ${target}`);
	}
	return { root, target, parent, base, marker: join(parent, `.${base}.durable-transaction.json`) };
}
function isPathInside(root: string, path: string, allowRoot: boolean): boolean {
	const rel = relative(root, path);
	return (
		(allowRoot || rel !== "") && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
	);
}
function validateExistingPath(root: string, path: string, requireDirectory: boolean): void {
	let current = root;
	for (const part of relative(root, path).split(sep).filter(Boolean)) {
		current = join(current, part);
		let stat: Stats;
		try {
			stat = lstatSync(current);
		} catch (error) {
			throw new DurableFileTransactionError(
				"invalid-target-parent",
				`missing path component: ${current}`,
				error,
			);
		}
		if (stat.isSymbolicLink()) {
			throw new DurableFileTransactionError(
				"symlink-path",
				`transaction path contains a symlink: ${current}`,
			);
		}
	}
	if (requireDirectory && !lstatSync(path).isDirectory()) {
		throw new DurableFileTransactionError(
			"invalid-target-parent",
			`target parent is not a directory: ${path}`,
		);
	}
}
function makeBounds(maxEntries = DEFAULT_MAX_ENTRIES, maxDepth = DEFAULT_MAX_DEPTH): Bounds {
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
		throw new DurableFileTransactionError("scan-limit-exceeded", "maxEntries must be positive");
	}
	if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 256) {
		throw new DurableFileTransactionError(
			"scan-limit-exceeded",
			"maxDepth must be between 0 and 256",
		);
	}
	return { maxEntries, maxDepth, entries: 0 };
}
function ensureReplaceableRoot(path: string): void {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		throw new DurableFileTransactionError(
			"invalid-staging",
			`transaction copy does not exist: ${path}`,
			error,
		);
	}
	if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
		throw new DurableFileTransactionError(
			"invalid-staging",
			`copy must be a regular file or directory: ${path}`,
		);
	}
}
function syncTree(path: string, bounds: Bounds, depth = 0): void {
	bounds.entries += 1;
	if (bounds.entries > bounds.maxEntries || depth > bounds.maxDepth) {
		throw new DurableFileTransactionError("scan-limit-exceeded", "staged tree exceeds scan bounds");
	}
	const stat = lstatSync(path);
	if (stat.isFile()) {
		syncFile(path);
		return;
	}
	if (stat.isSymbolicLink()) return;
	if (!stat.isDirectory())
		throw new DurableFileTransactionError("invalid-staging", `unsupported entry: ${path}`);
	const dir = opendirSync(path);
	try {
		for (;;) {
			const entry = dir.readSync();
			if (!entry) break;
			syncTree(join(path, entry.name), bounds, depth + 1);
		}
	} finally {
		dir.closeSync();
	}
	syncDirectory(path);
}
function syncFile(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function syncDirectory(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch (error) {
		if (process.platform !== "win32") throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(code ?? "")) throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function writeMarker(path: string, marker: DurableFileTransactionMarker): void {
	const temp = `${path}.tmp-${marker.transactionId}`;
	remove(temp);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(marker)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temp, path);
		syncDirectory(dirname(path));
	} catch (error) {
		remove(temp);
		throw error;
	}
}
function rollback(paths: Paths, marker: DurableFileTransactionMarker): void {
	renameSync(paths.target, marker.staging);
	syncDirectory(paths.parent);
	if (existsSync(marker.backup)) {
		renameSync(marker.backup, paths.target);
		syncDirectory(paths.parent);
	}
	remove(marker.staging);
	syncDirectory(paths.parent);
	remove(paths.marker);
	syncDirectory(paths.parent);
}
function activate(paths: Paths, marker: DurableFileTransactionMarker): void {
	renameSync(marker.staging, marker.target);
	syncDirectory(paths.parent);
	marker.state = "activated";
	writeMarker(paths.marker, marker);
	finish(paths, marker);
}
function restore(paths: Paths, marker: DurableFileTransactionMarker): void {
	if (existsSync(marker.target)) {
		renameSync(marker.target, marker.staging);
		syncDirectory(paths.parent);
	}
	renameSync(marker.backup, marker.target);
	syncDirectory(paths.parent);
	remove(marker.staging);
	syncDirectory(paths.parent);
	remove(paths.marker);
	syncDirectory(paths.parent);
}
function finish(paths: Paths, marker: DurableFileTransactionMarker): void {
	remove(marker.backup);
	syncDirectory(paths.parent);
	remove(paths.marker);
	syncDirectory(paths.parent);
}
function remove(path: string): void {
	rmSync(path, { recursive: true, force: true });
}
function readMarker(paths: Paths): DurableFileTransactionMarker {
	const stat = lstatSync(paths.marker);
	if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MARKER_BYTES)
		throw new Error("unsafe marker");
	const value = MarkerSchema.parse(JSON.parse(readFileSync(paths.marker, "utf8")));
	if (
		value.target !== paths.target ||
		value.staging !== join(paths.parent, `.${paths.base}.staging-${value.transactionId}`) ||
		value.backup !== join(paths.parent, `.${paths.base}.backup-${value.transactionId}`)
	)
		throw new Error("marker paths are invalid");
	return value;
}
async function assess(
	path: string,
	verify: (candidatePath: string) => boolean | Promise<boolean>,
): Promise<DurableCopyStatus> {
	if (!existsSync(path)) return "missing";
	try {
		ensureReplaceableRoot(path);
		return (await verify(path)) ? "valid" : "invalid";
	} catch {
		return "invalid";
	}
}
function markerError(error: unknown): string {
	return error instanceof Error
		? `invalid transaction marker: ${error.message}`
		: "invalid transaction marker";
}
function assessSync(path: string, verify: (candidatePath: string) => boolean): DurableCopyStatus {
	if (!existsSync(path)) return "missing";
	try {
		ensureReplaceableRoot(path);
		return verify(path) ? "valid" : "invalid";
	} catch {
		return "invalid";
	}
}
