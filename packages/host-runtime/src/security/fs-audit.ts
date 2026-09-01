/**
 * Process-local filesystem deletion audit.
 *
 * Wraps the global `fs` delete APIs (`unlink`/`rmdir`/`rm`, their `Sync`
 * variants, and `fs.promises` equivalents) so that deleting a path that
 * resolves inside an explicit `auditRoots` directory logs a structured WARN
 * and fires an optional `onHit` callback. Deletes are never blocked.
 *
 * Notes:
 * - Only delete APIs are wrapped; reads/writes are never touched.
 * - Installation is a process-wide singleton (a global guard): a second
 *   `installFsAudit` call while one is active returns the same handle
 *   and never double-wraps. `uninstall()` restores every original function.
 * - `node:fs/promises` and `node:fs` `.promises` are the same object at
 *   runtime, so patching `fs.promises` covers both import styles. Modules
 *   that destructured the functions before installation keep their
 *   originals; the sentinel catches property-style call sites (the common
 *   case).
 */

import fs from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type DeleteOperation = "unlink" | "rmdir" | "rm";

export interface FsAuditHit {
	/** The matched audited root (resolved absolute path). */
	root: string;
	/** The resolved absolute delete target. */
	target: string;
	operation: DeleteOperation;
}

export interface FsAuditOptions {
	/**
	 * Absolute or relative directories whose deletion is sentinel-watched.
	 * Each is resolved; prefix confusion (`/data/dir2` vs `/data/dir`) is
	 * prevented by comparing with `path.relative`.
	 */
	auditRoots: string[];
	/** Structured WARN sink; invoked with `[fs-audit] delete: …`. */
	logger?: { warn?: (message: string) => void };
	/** Fired for every audited delete, before the underlying delete runs. */
	onHit?: (hit: FsAuditHit) => void;
}

export interface FsAuditHandle {
	/** Restore the original fs delete functions. Idempotent. */
	uninstall(): void;
}

/** Process-wide guard: at most one installation at a time, never double-wrap. */
let activeInstall: FsAuditHandle | null = null;

export function installFsAudit(options: FsAuditOptions): FsAuditHandle {
	if (activeInstall) return activeInstall;

	const roots = options.auditRoots.map((root) => resolve(String(root)));
	const logger = options.logger ?? {};
	const onHit = options.onHit;

	function auditedRootFor(target: fs.PathLike): string | null {
		let abs: string;
		try {
			abs = resolve(String(target));
		} catch {
			return null;
		}
		for (const root of roots) {
			const rel = relative(root, abs);
			if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return root;
		}
		return null;
	}

	function report(hit: FsAuditHit): void {
		logger.warn?.(
			`[fs-audit] delete: ${JSON.stringify({
				root: hit.root,
				target: hit.target,
				operation: hit.operation,
			})}`,
		);
		onHit?.(hit);
	}

	function check(path: fs.PathLike, operation: DeleteOperation): void {
		const root = auditedRootFor(path);
		if (root) report({ root, target: resolve(String(path)), operation });
	}

	// Capture the originals before any wrapping (also protects against a
	// reinstall after uninstall while another module holds references).
	const original = {
		unlink: fs.unlink,
		rmdir: fs.rmdir,
		rm: fs.rm,
		unlinkSync: fs.unlinkSync,
		rmdirSync: fs.rmdirSync,
		rmSync: fs.rmSync,
		promises: {
			unlink: fs.promises.unlink,
			rmdir: fs.promises.rmdir,
			rm: fs.promises.rm,
		},
	};

	type LooseCallbackFn = (path: fs.PathLike, ...args: unknown[]) => void;
	type LoosePromiseFn = (path: fs.PathLike, ...args: unknown[]) => Promise<unknown>;

	const toLoose = (fn: unknown) => fn as LooseCallbackFn;
	const toLoosePromise = (fn: unknown) => fn as LoosePromiseFn;

	const wrapCallback = (operation: DeleteOperation, orig: LooseCallbackFn): LooseCallbackFn =>
		function (this: unknown, path: fs.PathLike, ...args: unknown[]): void {
			check(path, operation);
			orig.apply(this, [path, ...args]);
		};

	const wrapSync = wrapCallback;

	const wrapPromise = (operation: DeleteOperation, orig: LoosePromiseFn): LoosePromiseFn =>
		function (this: unknown, path: fs.PathLike, ...args: unknown[]): Promise<unknown> {
			check(path, operation);
			return orig.apply(this, [path, ...args]);
		};

	fs.unlink = wrapCallback("unlink", toLoose(original.unlink)) as unknown as typeof fs.unlink;
	fs.rmdir = wrapCallback("rmdir", toLoose(original.rmdir)) as unknown as typeof fs.rmdir;
	fs.rm = wrapCallback("rm", toLoose(original.rm)) as unknown as typeof fs.rm;
	fs.unlinkSync = wrapSync(
		"unlink",
		toLoose(original.unlinkSync),
	) as unknown as typeof fs.unlinkSync;
	fs.rmdirSync = wrapSync("rmdir", toLoose(original.rmdirSync)) as unknown as typeof fs.rmdirSync;
	fs.rmSync = wrapSync("rm", toLoose(original.rmSync)) as unknown as typeof fs.rmSync;
	fs.promises.unlink = wrapPromise(
		"unlink",
		toLoosePromise(original.promises.unlink),
	) as unknown as typeof fs.promises.unlink;
	fs.promises.rmdir = wrapPromise(
		"rmdir",
		toLoosePromise(original.promises.rmdir),
	) as unknown as typeof fs.promises.rmdir;
	fs.promises.rm = wrapPromise(
		"rm",
		toLoosePromise(original.promises.rm),
	) as unknown as typeof fs.promises.rm;

	const handle: FsAuditHandle = {
		uninstall() {
			if (activeInstall !== handle) return;
			activeInstall = null;
			fs.unlink = original.unlink;
			fs.rmdir = original.rmdir;
			fs.rm = original.rm;
			fs.unlinkSync = original.unlinkSync;
			fs.rmdirSync = original.rmdirSync;
			fs.rmSync = original.rmSync;
			fs.promises.unlink = original.promises.unlink;
			fs.promises.rmdir = original.promises.rmdir;
			fs.promises.rm = original.promises.rm;
		},
	};
	activeInstall = handle;
	return handle;
}
