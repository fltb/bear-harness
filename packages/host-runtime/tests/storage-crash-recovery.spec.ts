// @vitest-environment node

import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Database, type Migration } from "../src/storage/database.js";
import {
	type DurableFileTransactionMarker,
	durableFileTransactionMarkerPath,
	recoverDurableFileTransactionSync,
} from "../src/storage/durable-file-transaction.js";

const READY_MARKER = "STORAGE_CRASH_READY";
const CHILD_TIMEOUT_MS = 15_000;
const childPath = fileURLToPath(new URL("./failpoints/storage-crash-child.mjs", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();

type TargetKind = "file" | "directory";
type CopyGeneration = "old" | "new" | "invalid" | "missing";

const BASE_MIGRATION = {
	id: 1,
	description: "create crash certification fixture",
	up: `
		CREATE TABLE durable_rows (
			id INTEGER PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE durable_children (
			id INTEGER PRIMARY KEY,
			durable_row_id INTEGER NOT NULL REFERENCES durable_rows(id)
		);
	`,
} satisfies Migration;

const SECOND_MIGRATION = {
	id: 2,
	description: "upgrade crash certification fixture",
	up: `
		CREATE TABLE upgraded_rows (
			id INTEGER PRIMARY KEY,
			durable_row_id INTEGER NOT NULL REFERENCES durable_rows(id)
		);
	`,
} satisfies Migration;

function fixtureRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

afterEach(async () => {
	const liveChildren = [...children];
	for (const child of liveChildren) child.kill("SIGKILL");
	await Promise.all(liveChildren.map((child) => waitForChildExit(child, 2_000)));
	children.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCrashChild(args: readonly string[]): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
}> {
	const child = spawn(process.execPath, [childPath, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});

	return await new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			child.kill("SIGKILL");
			settled = true;
			reject(new Error(`storage crash child timed out; stdout=${stdout}; stderr=${stderr}`));
		}, CHILD_TIMEOUT_MS);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			children.delete(child);
			reject(error);
		});
		child.once("close", (code, signal) => {
			children.delete(child);
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const lines = stdout.split(/\r?\n/u).filter(Boolean);
			if (lines.length !== 1 || lines[0] !== READY_MARKER) {
				reject(
					new Error(
						`storage crash child exited before its durable boundary; code=${code}; signal=${signal}; stdout=${stdout}; stderr=${stderr}`,
					),
				);
				return;
			}
			resolve({ code, signal });
		});
	});
}

function expectSigkill(result: { code: number | null; signal: NodeJS.Signals | null }): void {
	expect(result).toEqual({ code: null, signal: "SIGKILL" });
}

function backupPaths(databaseDir: string): string[] {
	return readdirSync(join(databaseDir, "schema-backups"))
		.filter((file) => file.startsWith("canon-") && file.endsWith(".db"))
		.map((file) => join(databaseDir, "schema-backups", file))
		.sort();
}

function createDatabaseFixture(databaseDir: string): string[] {
	const database = new Database(databaseDir);
	try {
		database.migrate([BASE_MIGRATION]);
		database.connection
			.prepare("INSERT INTO durable_rows (id, value) VALUES (?, ?)")
			.run(1, "committed before crash");
		database.connection
			.prepare("INSERT INTO durable_children (id, durable_row_id) VALUES (?, ?)")
			.run(1, 1);
		return backupPaths(databaseDir);
	} finally {
		database.close();
	}
}

function expectHealthySqlite(database: DatabaseSync): void {
	expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
	expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function expectBackup(
	backupPath: string,
	expectedRows: ReadonlyArray<{ id: number; value: string }>,
): void {
	const backup = new DatabaseSync(backupPath, { readOnly: true });
	try {
		expectHealthySqlite(backup);
		expect(backup.prepare("SELECT id, value FROM durable_rows ORDER BY id").all()).toEqual(
			expectedRows,
		);
		expect(
			backup.prepare("SELECT id, durable_row_id FROM durable_children ORDER BY id").all(),
		).toEqual(expectedRows.map(({ id }) => ({ id, durable_row_id: id })));
	} finally {
		backup.close();
	}
}

describe("database process-crash recovery", () => {
	it("backs up a row committed to WAL by a SIGKILLed writer before upgrade", async () => {
		const databaseDir = join(fixtureRoot("bear-storage-wal-crash-"), "database");
		const backupsBeforeUpgrade = createDatabaseFixture(databaseDir);
		const result = await runCrashChild(["wal-committed", join(databaseDir, "canon.db")]);
		expectSigkill(result);
		expect(statSync(join(databaseDir, "canon.db-wal")).size).toBeGreaterThan(0);

		const reopened = new Database(databaseDir);
		try {
			expect(
				reopened.connection.prepare("SELECT id, value FROM durable_rows ORDER BY id").all(),
			).toEqual([
				{ id: 1, value: "committed before crash" },
				{ id: 2, value: "committed in crashed WAL writer" },
			]);
			expectHealthySqlite(reopened.connection);
			reopened.migrate([BASE_MIGRATION, SECOND_MIGRATION]);
			expect(reopened.currentVersion()).toBe(2);
			expectHealthySqlite(reopened.connection);
		} finally {
			reopened.close();
		}

		const upgradeBackups = backupPaths(databaseDir).filter(
			(path) => !backupsBeforeUpgrade.includes(path),
		);
		expect(upgradeBackups).toHaveLength(1);
		expectBackup(upgradeBackups[0] as string, [
			{ id: 1, value: "committed before crash" },
			{ id: 2, value: "committed in crashed WAL writer" },
		]);
		expect(existsSync(join(databaseDir, "schema-upgrade.json"))).toBe(false);
	});

	it("rolls back an uncommitted migration transaction after SIGKILL before reopening", async () => {
		const databaseDir = join(fixtureRoot("bear-storage-migration-crash-"), "database");
		const backupsBeforeUpgrade = createDatabaseFixture(databaseDir);
		const result = await runCrashChild(["uncommitted-migration", join(databaseDir, "canon.db")]);
		expectSigkill(result);

		const reopened = new Database(databaseDir);
		try {
			expect(reopened.currentVersion()).toBe(1);
			expect(
				reopened.connection.prepare("SELECT id, value FROM durable_rows ORDER BY id").all(),
			).toEqual([{ id: 1, value: "committed before crash" }]);
			expect(
				reopened.connection.prepare("SELECT id, durable_row_id FROM durable_children").all(),
			).toEqual([{ id: 1, durable_row_id: 1 }]);
			expect(
				reopened.connection
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interrupted_upgrade'",
					)
					.get(),
			).toBeUndefined();
			expectHealthySqlite(reopened.connection);
			reopened.migrate([BASE_MIGRATION, SECOND_MIGRATION]);
			expect(reopened.currentVersion()).toBe(2);
			expectHealthySqlite(reopened.connection);
		} finally {
			reopened.close();
		}

		const upgradeBackups = backupPaths(databaseDir).filter(
			(path) => !backupsBeforeUpgrade.includes(path),
		);
		expect(upgradeBackups).toHaveLength(1);
		expectBackup(upgradeBackups[0] as string, [{ id: 1, value: "committed before crash" }]);
		expect(existsSync(join(databaseDir, "schema-upgrade.json"))).toBe(false);
	});
});

function fileContents(generation: "old" | "new"): string {
	return `${JSON.stringify({ generation, payload: generation.repeat(4096) })}\n`;
}

function createDirectoryContents(path: string, generation: "old" | "new"): void {
	mkdirSync(join(path, "payload", "nested"), { recursive: true });
	writeFileSync(join(path, "manifest.json"), `${JSON.stringify({ generation, files: 2 })}\n`);
	writeFileSync(
		join(path, "payload", "chunk-a.txt"),
		`${generation}:a:${generation.repeat(2048)}\n`,
	);
	writeFileSync(
		join(path, "payload", "nested", "chunk-b.txt"),
		`${generation}:b:${generation.repeat(2048)}\n`,
	);
}

function createOldTarget(target: string, targetKind: TargetKind): void {
	if (targetKind === "file") {
		writeFileSync(target, fileContents("old"));
		return;
	}
	createDirectoryContents(target, "old");
}

function copyGeneration(path: string, targetKind: TargetKind): CopyGeneration {
	if (!existsSync(path)) return "missing";
	try {
		if (targetKind === "file") {
			const contents = readFileSync(path, "utf8");
			if (contents === fileContents("old")) return "old";
			if (contents === fileContents("new")) return "new";
			return "invalid";
		}
		if (readdirSync(path).sort().join("/") !== "manifest.json/payload") return "invalid";
		if (readdirSync(join(path, "payload")).sort().join("/") !== "chunk-a.txt/nested") {
			return "invalid";
		}
		if (readdirSync(join(path, "payload", "nested")).join("/") !== "chunk-b.txt") {
			return "invalid";
		}
		for (const generation of ["old", "new"] as const) {
			if (
				readFileSync(join(path, "manifest.json"), "utf8") ===
					`${JSON.stringify({ generation, files: 2 })}\n` &&
				readFileSync(join(path, "payload", "chunk-a.txt"), "utf8") ===
					`${generation}:a:${generation.repeat(2048)}\n` &&
				readFileSync(join(path, "payload", "nested", "chunk-b.txt"), "utf8") ===
					`${generation}:b:${generation.repeat(2048)}\n`
			) {
				return generation;
			}
		}
		return "invalid";
	} catch {
		return "invalid";
	}
}

const TARGET_KINDS = ["file", "directory"] as const;
const CRASH_WINDOWS = [
	{
		name: "target-to-backup rename",
		argument: "after-target-to-backup",
		markerState: "staged",
		action: "activated-staging",
	},
	{
		name: "staging-to-target rename",
		argument: "after-staging-to-target",
		markerState: "old-target-moved",
		action: "completed-activation",
	},
] as const;

describe.each(TARGET_KINDS)("durable %s process-crash recovery", (targetKind) => {
	it.each(CRASH_WINDOWS)(
		"recovers complete content after SIGKILL at the $name boundary",
		async ({ argument, markerState, action }) => {
			const root = fixtureRoot(`bear-durable-${targetKind}-crash-`);
			const target = join(root, "payload-target");
			createOldTarget(target, targetKind);
			const result = await runCrashChild([
				"durable-replacement",
				argument,
				root,
				target,
				targetKind,
			]);
			expectSigkill(result);

			const markerPath = durableFileTransactionMarkerPath(root, target);
			const marker = JSON.parse(readFileSync(markerPath, "utf8")) as DurableFileTransactionMarker;
			expect(marker.state).toBe(markerState);
			const copies = [marker.target, marker.staging, marker.backup].map((path) =>
				copyGeneration(path, targetKind),
			);
			expect(copies.filter((copy) => copy !== "missing").sort()).toEqual(["new", "old"]);
			expect(copies).not.toContain("invalid");
			if (argument === "after-target-to-backup") {
				expect(copies).toEqual(["missing", "new", "old"]);
			} else {
				expect(copies).toEqual(["new", "missing", "old"]);
			}

			const recovery = recoverDurableFileTransactionSync({
				root,
				target,
				verify: (candidate) => {
					const generation = copyGeneration(candidate, targetKind);
					return generation === "old" || generation === "new";
				},
			});
			expect(recovery).toMatchObject({ status: "recovered", action });
			expect(copyGeneration(target, targetKind)).toBe("new");
			expect(existsSync(marker.staging)).toBe(false);
			expect(existsSync(marker.backup)).toBe(false);
			expect(existsSync(markerPath)).toBe(false);
		},
	);
});
