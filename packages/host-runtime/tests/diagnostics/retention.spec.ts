// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	LOCK_FILE,
	markUncleanExits,
	runRetention,
	scanUnits,
	writeMarkerAtomic,
} from "../../src/diagnostics/retention.js";
import { smallPolicy } from "../utils";

const DAY_MS = 86_400_000;

function makeRoot(): string {
	return mkdtempSync(join(tmpdir(), "bear-retention-"));
}

function makeUnit(
	root: string,
	launchId: string,
	options: { ageDays?: number; markerPid?: number; markerState?: string; crashFiles?: number } = {},
) {
	const logsDir = join(root, "logs");
	const stateDir = join(root, "state");
	const crashesDir = join(root, "crashes");
	mkdirSync(logsDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(crashesDir, { recursive: true });

	const logFile = join(logsDir, `app-${launchId}-20260801-1.jsonl`);
	writeFileSync(logFile, "{}");
	if (options.ageDays !== undefined) {
		const old = new Date(Date.now() - options.ageDays * DAY_MS);
		utimesSync(logFile, old, old);
	}

	if (options.markerPid !== undefined) {
		writeMarkerAtomic(join(stateDir, `run-${launchId}.json`), {
			launchId,
			pid: options.markerPid,
			startedAt: "2026-08-01T00:00:00.000Z",
			lastSeenAt: "2026-08-01T00:00:00.000Z",
			state: options.markerState ?? "running",
		});
	}

	if (options.crashFiles !== undefined) {
		const crashDir = join(crashesDir, launchId);
		mkdirSync(crashDir, { recursive: true });
		for (let i = 0; i < options.crashFiles; i += 1) {
			const dmp = join(crashDir, `crash-${i}.dmp`);
			writeFileSync(dmp, "minidump");
			if (options.ageDays !== undefined) {
				const old = new Date(Date.now() - options.ageDays * DAY_MS);
				utimesSync(dmp, old, old);
			}
		}
		if (options.ageDays !== undefined) {
			const old = new Date(Date.now() - options.ageDays * DAY_MS);
			utimesSync(crashDir, old, old);
		}
	}
}

function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""]);
	return result.pid;
}

describe("runRetention", () => {
	it("deletes inactive units untouched for maxAgeDays (logs, marker, whole crash dir)", () => {
		const root = makeRoot();
		makeUnit(root, "old-unit", { ageDays: 31, crashFiles: 2 });
		makeUnit(root, "fresh-unit", { ageDays: 1 });

		const result = runRetention({
			root,
			currentLaunchId: "current",
			policy: smallPolicy({}),
		});

		expect(result.deletedUnits).toBe(1);
		expect(existsSync(join(root, "logs", "app-old-unit-20260801-1.jsonl"))).toBe(false);
		expect(existsSync(join(root, "crashes", "old-unit"))).toBe(false);
		expect(existsSync(join(root, "logs", "app-fresh-unit-20260801-1.jsonl"))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	it("protects active units even when older than maxAgeDays", () => {
		const root = makeRoot();
		makeUnit(root, "active-unit", { ageDays: 60, markerPid: process.pid, crashFiles: 1 });

		const result = runRetention({ root, currentLaunchId: "other", policy: smallPolicy({}) });

		expect(result.deletedUnits).toBe(0);
		expect(existsSync(join(root, "logs", "app-active-unit-20260801-1.jsonl"))).toBe(true);
		expect(existsSync(join(root, "crashes", "active-unit"))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	it("protects the current launch unit", () => {
		const root = makeRoot();
		makeUnit(root, "current", { ageDays: 60 });

		const result = runRetention({ root, currentLaunchId: "current", policy: smallPolicy({}) });

		expect(result.deletedUnits).toBe(0);
		rmSync(root, { recursive: true, force: true });
	});

	it("enforces the byte budget by deleting whole inactive units oldest first", () => {
		const root = makeRoot();
		// 5 units of ~8 KB each; budget allows ~3.
		for (let i = 1; i <= 5; i += 1) {
			const launchId = `unit-${i}`;
			const logsDir = join(root, "logs");
			mkdirSync(logsDir, { recursive: true });
			const file = join(logsDir, `app-${launchId}-20260801-1.jsonl`);
			writeFileSync(file, "x".repeat(8192));
			// mtime increases with i so oldest-first order is unit-1, unit-2, ...
			utimesSync(
				file,
				new Date(Date.now() - (6 - i) * 1000),
				new Date(Date.now() - (6 - i) * 1000),
			);
		}

		const result = runRetention({
			root,
			currentLaunchId: "current",
			policy: smallPolicy({ maxBytes: 28_000 }),
		});

		expect(result.deletedUnits).toBe(2);
		expect(existsSync(join(root, "logs", "app-unit-1-20260801-1.jsonl"))).toBe(false);
		expect(existsSync(join(root, "logs", "app-unit-2-20260801-1.jsonl"))).toBe(false);
		expect(existsSync(join(root, "logs", "app-unit-3-20260801-1.jsonl"))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	it("defers when only active units exceed the budget", () => {
		const root = makeRoot();
		const logsDir = join(root, "logs");
		mkdirSync(logsDir, { recursive: true });
		const file = join(logsDir, "app-current-20260801-1.jsonl");
		writeFileSync(file, "x".repeat(30_000));

		const result = runRetention({
			root,
			currentLaunchId: "current",
			policy: smallPolicy({ maxBytes: 10_000 }),
		});

		expect(result.deferred).toBe(true);
		expect(result.deletedUnits).toBe(0);
		expect(existsSync(file)).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	it("skips when a live owner holds the prune lock, and proceeds when the owner is dead", () => {
		const root = makeRoot();
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		const lockPath = join(stateDir, LOCK_FILE);
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, launchId: "x", createdAt: new Date().toISOString() }),
		);
		makeUnit(root, "old-unit", { ageDays: 40 });

		const skipped = runRetention({ root, currentLaunchId: "current", policy: smallPolicy({}) });
		expect(skipped.skipped).toBe(true);
		expect(existsSync(join(root, "logs", "app-old-unit-20260801-1.jsonl"))).toBe(true);

		// Dead owner: lock is replaced and the prune proceeds.
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: deadPid(), launchId: "x", createdAt: new Date().toISOString() }),
		);
		const proceeded = runRetention({ root, currentLaunchId: "current", policy: smallPolicy({}) });
		expect(proceeded.skipped).toBe(false);
		expect(proceeded.deletedUnits).toBe(1);
		expect(existsSync(lockPath)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	it("treats a stale lock (older than 10 minutes) as removable even with a live owner", () => {
		const root = makeRoot();
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, LOCK_FILE),
			JSON.stringify({ pid: process.pid, launchId: "x", createdAt: "2020-01-01T00:00:00.000Z" }),
		);

		const result = runRetention({ root, currentLaunchId: "current", policy: smallPolicy({}) });
		expect(result.skipped).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("scanUnits", () => {
	it("unions logs, markers and crash dirs into per-launch units", () => {
		const root = makeRoot();
		makeUnit(root, "a", { markerPid: process.pid, crashFiles: 1 });
		makeUnit(root, "b", { crashFiles: 0 });

		const units = scanUnits(root);
		expect(units.size).toBe(2);
		const unitA = units.get("a");
		expect(unitA?.files).toHaveLength(3); // log + marker + crash dir
		expect(unitA?.markerPid).toBe(process.pid);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("markUncleanExits", () => {
	it("marks stale running markers unclean and leaves live/clean markers alone", () => {
		const root = makeRoot();
		makeUnit(root, "stale", { markerPid: deadPid(), markerState: "running" });
		makeUnit(root, "live", { markerPid: process.pid, markerState: "running" });
		makeUnit(root, "clean", { markerPid: deadPid(), markerState: "clean" });

		const count = markUncleanExits({ root });
		expect(count).toBe(1);

		const stale = JSON.parse(readFileSync(join(root, "state", "run-stale.json"), "utf8")) as {
			state: string;
		};
		const live = JSON.parse(readFileSync(join(root, "state", "run-live.json"), "utf8")) as {
			state: string;
		};
		const clean = JSON.parse(readFileSync(join(root, "state", "run-clean.json"), "utf8")) as {
			state: string;
		};
		expect(stale.state).toBe("unclean");
		expect(live.state).toBe("running");
		expect(clean.state).toBe("clean");
		rmSync(root, { recursive: true, force: true });
	});
});
