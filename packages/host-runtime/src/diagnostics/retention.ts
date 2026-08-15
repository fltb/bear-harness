/**
 * Diagnostics retention: age-based and budget-based pruning of inactive
 * launch units, plus unclean-exit marking of stale run markers.
 *
 * A "launch unit" is the set of logs segments, run marker and per-launch
 * Crashpad database for one launchId; all three are always deleted together.
 * An active unit (current launch, or a marker whose PID is alive) is never
 * touched. Crashpad databases are deleted as a whole directory only — the
 * running per-launch database may briefly exceed the byte budget during a
 * crash storm; the next safe prune must converge and emit a fixed-field
 * deferred event instead of pretending a hard cap was enforced.
 *
 * A prune lock (`state/prune.lock`, opened with "wx" 0o600) serializes prunes
 * across processes. If the lock's owner is alive the prune is skipped; a dead
 * owner or a lock older than 10 minutes is removed and re-competed once.
 */

import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DiagnosticsPolicy } from "./contracts.js";

export interface RetentionOptions {
	root: string;
	currentLaunchId: string;
	policy: Readonly<DiagnosticsPolicy>;
	clock?: () => number;
	isPidAlive?: (pid: number) => boolean;
}

export interface PruneResult {
	skipped: boolean;
	inactiveUnits: number;
	deletedUnits: number;
	deletedBytes: number;
	deferred: boolean;
}

export interface LaunchUnit {
	launchId: string;
	files: string[];
	bytes: number;
	mtime: number;
	markerPid?: number;
	markerState?: string;
}

const LOG_FILE_RE = /^app-(.+)-(\d{8})-(\d+)\.jsonl$/;
const RUN_MARKER_RE = /^run-(.+)\.json$/;
const LOCK_STALE_MS = 10 * 60 * 1000;

export const LOCK_FILE = "prune.lock";

export function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM") return true;
		if (code === "ESRCH") return false;
		// Windows or unverifiable: be conservative and treat as alive.
		return true;
	}
}

function safeReadJson(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Collect every launch unit present in the diagnostics root. */
export function scanUnits(root: string): Map<string, LaunchUnit> {
	const units = new Map<string, LaunchUnit>();
	const ensure = (launchId: string): LaunchUnit => {
		let unit = units.get(launchId);
		if (!unit) {
			unit = { launchId, files: [], bytes: 0, mtime: 0 };
			units.set(launchId, unit);
		}
		return unit;
	};
	const addFile = (unit: LaunchUnit, file: string) => {
		let size = 0;
		let mtime = 0;
		try {
			const stat = statSync(file);
			size = stat.size;
			mtime = stat.mtimeMs;
		} catch {
			return;
		}
		unit.files.push(file);
		unit.bytes += size;
		unit.mtime = Math.max(unit.mtime, mtime);
	};

	const logsDir = join(root, "logs");
	try {
		for (const name of readdirSync(logsDir)) {
			const match = LOG_FILE_RE.exec(name);
			if (match?.[1]) addFile(ensure(match[1]), join(logsDir, name));
		}
	} catch {
		// missing logs dir: nothing to scan
	}

	const stateDir = join(root, "state");
	try {
		for (const name of readdirSync(stateDir)) {
			const match = RUN_MARKER_RE.exec(name);
			if (!match?.[1]) continue;
			const unit = ensure(match[1]);
			addFile(unit, join(stateDir, name));
			const marker = safeReadJson(join(stateDir, name));
			if (marker && typeof marker.pid === "number") unit.markerPid = marker.pid;
			if (marker && typeof marker.state === "string") unit.markerState = marker.state;
		}
	} catch {
		// missing state dir
	}

	const crashesDir = join(root, "crashes");
	try {
		for (const name of readdirSync(crashesDir)) {
			const crashDir = join(crashesDir, name);
			let isDir = false;
			try {
				isDir = statSync(crashDir).isDirectory();
			} catch {
				continue;
			}
			if (!isDir) continue;
			const unit = ensure(name);
			const walked = walkSize(crashDir);
			unit.bytes += walked.bytes;
			unit.mtime = Math.max(unit.mtime, walked.mtime);
			unit.files.push(crashDir);
		}
	} catch {
		// missing crashes dir
	}

	return units;
}

/** Recursively sum a crash store's bytes and newest mtime (dirs + files). */
function walkSize(dir: string): { bytes: number; mtime: number } {
	let bytes = 0;
	let mtime = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				const child = walkSize(path);
				bytes += child.bytes;
				mtime = Math.max(mtime, child.mtime);
			} else {
				try {
					const stat = statSync(path);
					bytes += stat.size;
					mtime = Math.max(mtime, stat.mtimeMs);
				} catch {
					// ignore
				}
			}
		}
	} catch {
		// ignore
	}
	return { bytes, mtime };
}

/** Delete a unit's files; the per-launch Crashpad database goes as a whole dir. */
export function deleteUnit(unit: LaunchUnit): number {
	let freed = 0;
	for (const file of unit.files) {
		try {
			const stat = statSync(file);
			if (stat.isDirectory()) {
				rmSync(file, { recursive: true, force: true });
				freed += stat.size;
			} else {
				rmSync(file, { force: true });
				freed += stat.size;
			}
		} catch {
			// best effort
		}
	}
	unit.files = [];
	unit.bytes = 0;
	return freed;
}

export function totalBytes(units: Iterable<LaunchUnit>): number {
	let total = 0;
	for (const unit of units) total += unit.bytes;
	return total;
}

export function runRetention(options: RetentionOptions): PruneResult {
	const clock = options.clock ?? Date.now;
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	const now = clock();
	const result: PruneResult = {
		skipped: false,
		inactiveUnits: 0,
		deletedUnits: 0,
		deletedBytes: 0,
		deferred: false,
	};

	const stateDir = join(options.root, "state");
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });

	const lockPath = join(stateDir, LOCK_FILE);
	if (!acquireLock(lockPath, options.currentLaunchId, now, isPidAlive)) {
		result.skipped = true;
		return result;
	}
	try {
		const units = scanUnits(options.root);
		const active = (unit: LaunchUnit) =>
			unit.launchId === options.currentLaunchId ||
			(unit.markerPid !== undefined && isPidAlive(unit.markerPid));

		const inactive: LaunchUnit[] = [];
		for (const unit of units.values()) {
			if (!active(unit)) inactive.push(unit);
		}
		result.inactiveUnits = inactive.length;

		// Phase 1: inactive units untouched for maxAgeDays are deleted entirely.
		const ageCutoff = now - options.policy.maxAgeDays * 86_400_000;
		for (const unit of inactive) {
			if (unit.mtime < ageCutoff) {
				result.deletedBytes += deleteUnit(unit);
				result.deletedUnits += 1;
			}
		}

		// Phase 2: budget. Delete inactive units oldest-last-mtime first until
		// the total fits; if only active units remain, defer with a fixed event.
		let total = totalBytes(units.values());
		if (total > options.policy.maxBytes) {
			const remainingInactive = inactive
				.filter((unit) => unit.files.length > 0)
				.sort((a, b) => a.mtime - b.mtime);
			for (const unit of remainingInactive) {
				if (total <= options.policy.maxBytes) break;
				result.deletedBytes += deleteUnit(unit);
				result.deletedUnits += 1;
				total = totalBytes(units.values());
			}
			if (total > options.policy.maxBytes) result.deferred = true;
		}
	} finally {
		try {
			unlinkSync(lockPath);
		} catch {
			// best effort
		}
	}
	return result;
}

function acquireLock(
	lockPath: string,
	launchId: string,
	now: number,
	isPidAlive: (pid: number) => boolean,
): boolean {
	const tryCreate = (): boolean => {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			writeSync(
				fd,
				JSON.stringify({ pid: process.pid, launchId, createdAt: new Date(now).toISOString() }),
			);
			closeSync(fd);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			return false;
		}
	};
	if (tryCreate()) return true;

	const existing = safeReadJson(lockPath);
	const ownerAlive =
		existing !== null && typeof existing.pid === "number" && isPidAlive(existing.pid);
	const age =
		existing !== null && typeof existing.createdAt === "string"
			? now - Date.parse(existing.createdAt)
			: Number.POSITIVE_INFINITY;
	if (ownerAlive && age < LOCK_STALE_MS) return false;

	try {
		unlinkSync(lockPath);
	} catch {
		return false;
	}
	return tryCreate();
}

export interface UncleanScanOptions {
	root: string;
	isPidAlive?: (pid: number) => boolean;
}

/**
 * Mark stale `running` markers as `unclean` at startup. Only markers whose PID
 * no longer exists are touched; returns the number found. A marker that is
 * `clean` is never rewritten, and an alive PID is never misclassified.
 */
export function markUncleanExits(options: UncleanScanOptions): number {
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	const stateDir = join(options.root, "state");
	let count = 0;
	let names: string[];
	try {
		names = readdirSync(stateDir);
	} catch {
		return 0;
	}
	for (const name of names) {
		const match = RUN_MARKER_RE.exec(name);
		if (!match?.[1]) continue;
		const file = join(stateDir, name);
		const marker = safeReadJson(file);
		if (!marker || marker.state !== "running" || typeof marker.pid !== "number") continue;
		if (isPidAlive(marker.pid)) continue;
		const updated = { ...marker, state: "unclean" };
		writeMarkerAtomic(file, updated);
		count += 1;
	}
	return count;
}

/** Atomic marker write: temp file -> fsync -> rename -> best-effort dir fsync. */
export function writeMarkerAtomic(file: string, marker: Record<string, unknown>): void {
	const temp = `${file}.tmp-${process.pid}`;
	const fd = openSync(temp, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify(marker));
	} finally {
		closeSync(fd);
	}
	// fsync the temp file before rename.
	const syncFd = openSync(temp, "r");
	try {
		fsyncSync(syncFd);
	} finally {
		closeSync(syncFd);
	}
	renameSync(temp, file);
	// Best-effort directory fsync.
	try {
		const dirFd = openSync(join(file, ".."), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// best effort
	}
}
