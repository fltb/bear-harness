// @vitest-environment node

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialVault } from "../src/providers/credential-store.js";
import { HostRuntime } from "../src/runtime.js";
import {
	Database,
	loadInstallationId,
	MIGRATIONS,
	type Migration,
} from "../src/storage/database.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-database-contract-"));
	roots.push(value);
	return value;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	securityLevel: "session",
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

const BASE_MIGRATION = {
	id: 1,
	description: "create durable rows",
	up: "CREATE TABLE durable_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
} satisfies Migration;

const SECOND_MIGRATION = {
	id: 2,
	description: "add first upgraded table",
	up: "CREATE TABLE upgraded_first (id INTEGER PRIMARY KEY)",
} satisfies Migration;

const THIRD_MIGRATION = {
	id: 3,
	description: "add second upgraded table",
	up: "CREATE TABLE upgraded_second (id INTEGER PRIMARY KEY)",
} satisfies Migration;

function backupPaths(databaseDir: string): string[] {
	return readdirSync(join(databaseDir, "schema-backups"))
		.filter((file) => file.startsWith("canon-") && file.endsWith(".db"))
		.map((file) => join(databaseDir, "schema-backups", file))
		.sort();
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("database schema contract", () => {
	it("covers every application table with transactional change triggers", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		const excluded = new Set([
			"schema_migrations",
			"installation_identity",
			"events",
			"sync_changes",
		]);
		const tables = database.connection
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all();
		const triggers = database.connection
			.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
			.all()
			.map((row) => row.name);
		for (const table of tables) {
			const name = String(table.name);
			// SQLite FTS/vector tables are derived indexes, never authoritative records.
			if (excluded.has(name) || name.includes("fts") || name.includes("vec")) continue;
			for (const operation of ["insert", "update", "delete"]) {
				expect(triggers, `${name} ${operation} must invalidate synchronized readers`).toContain(
					`sync_${name}_${operation}`,
				);
			}
		}
		expect(triggers).toContain("sync_events_insert");
		database.close();
	});

	it("journals state writes atomically and only notifies committed revisions", async () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		const delivered: Array<{ revision: number; sources: string[] }> = [];
		database.subscribeSync((revision, sources) => delivered.push({ revision, sources }));
		try {
			database.connection.exec("BEGIN");
			database.connection
				.prepare("INSERT INTO user_decisions(id,kind) VALUES (?,?)")
				.run("rollback", "test");
			expect(delivered).toEqual([]);
			database.connection.exec("ROLLBACK");
			await Promise.resolve();
			expect(database.syncRevision()).toBe(0);
			expect(delivered).toEqual([]);
			database.connection.exec("BEGIN");
			database.connection
				.prepare("INSERT INTO user_decisions(id,kind) VALUES (?,?)")
				.run("commit", "test");
			database.connection.exec("COMMIT");
			await Promise.resolve();
			expect(delivered).toEqual([{ revision: 1, sources: ["user_decisions"] }]);
			expect(database.connection.prepare("SELECT id FROM user_decisions").all()).toEqual([
				{ id: "commit" },
			]);
		} finally {
			database.close();
		}
	});

	it("automatically applies a valid pending migration", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS.slice(0, -1));
		database.migrate(MIGRATIONS);

		expect(database.currentVersion()).toBe(MIGRATIONS.at(-1)?.id);
		expect(() => database.assertSchemaContract()).not.toThrow();
		database.close();
	});

	it("creates one UUID identity and preserves it when the database is reopened", () => {
		const databaseDir = root();
		const database = new Database(databaseDir);
		database.migrate(MIGRATIONS);

		const installationId = loadInstallationId(database.orm);
		expect(installationId).toMatch(UUID_V4);
		expect(
			database.connection.prepare("SELECT COUNT(*) AS count FROM installation_identity").get(),
		).toEqual({ count: 1 });
		expect(() =>
			database.connection
				.prepare("INSERT INTO installation_identity (id, installation_id) VALUES (?, ?)")
				.run(2, "11111111-1111-4111-8111-111111111111"),
		).toThrow();
		database.close();

		const reopened = new Database(databaseDir);
		reopened.migrate(MIGRATIONS);
		expect(loadInstallationId(reopened.orm)).toBe(installationId);
		expect(
			reopened.connection.prepare("SELECT COUNT(*) AS count FROM installation_identity").get(),
		).toEqual({ count: 1 });
		reopened.close();
	});

	it("uses the stored installation identity for the default runtime memory scope", async () => {
		const dataDir = join(root(), "data");
		const runtime = new HostRuntime({
			dataDir,
			characterSeedRoot: characterRoot,
			productConfig: { defaultCharacterId: "jizhou" },
			credentialVault: vault,
		});
		const installationId = runtime.memoryScope.installationId;
		expect(installationId).toMatch(UUID_V4);
		expect(runtime.memoryScope.userId).toBe("default-user");
		await runtime.close();

		const database = new Database(join(dataDir, "storage"));
		database.migrate(MIGRATIONS);
		expect(loadInstallationId(database.orm)).toBe(installationId);
		database.close();
	});

	it("preserves an explicitly injected runtime memory scope", async () => {
		const memoryScope = { installationId: "custom-installation", userId: "custom-user" };
		const runtime = new HostRuntime({
			dataDir: join(root(), "data"),
			characterSeedRoot: characterRoot,
			productConfig: { defaultCharacterId: "jizhou" },
			credentialVault: vault,
			memoryScope,
		});
		expect(runtime.memoryScope).toEqual(memoryScope);
		await runtime.close();
	});
	it("creates every column required by typed runtime queries", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		expect(() => database.assertSchemaContract()).not.toThrow();
		expect(database.connection.prepare("SELECT created_at FROM runs LIMIT 1").all()).toEqual([]);
		database.close();
	});

	it("keeps only the Pi session locator for each conversation", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		const columns = database.connection
			.prepare("PRAGMA table_info(conversation_sessions)")
			.all() as Array<{ name: string; notnull: number }>;
		expect(columns.map((column) => column.name)).toEqual([
			"conversation_id",
			"pi_session_id",
			"session_file_path",
			"created_at",
			"updated_at",
		]);
		database.close();
	});

	it("rebuilds derived provenance and removes Host transcript mirrors", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		for (const table of ["relationship_memory_entries", "memory_candidates", "roleplay_events"]) {
			const columns = (
				database.connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
			).map((column) => column.name);
			expect(columns).toContain("source_native_entry_id");
			expect(columns).not.toContain("source_message_version_id");
			expect(columns).not.toContain("source_branch_id");
		}
		for (const table of ["branches", "messages", "message_versions", "turns"]) {
			expect(
				database.connection
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get(table),
			).toBeUndefined();
		}
		expect(() => database.assertSchemaContract()).not.toThrow();
		database.close();
	});
	it("stores presentation metadata by backend id and complete memory scope", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		database.connection
			.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)")
			.run("package-a", "Package A", "1.0.0", "hash-a");
		database.connection
			.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
			)
			.run("companion-a", "package-a", "Companion A", "canon");

		const columns = database.connection
			.prepare("PRAGMA table_info(memory_presentation)")
			.all() as Array<{ name: string; notnull: number }>;
		expect(columns.map((column) => column.name)).toEqual([
			"backend_memory_id",
			"installation_id",
			"user_id",
			"companion_id",
			"source_pi_entry_id",
			"created_by",
			"pinned",
			"replacement_memory_id",
			"created_at",
			"updated_at",
			"invalidated_at",
			"excluded_at",
		]);
		expect(columns.some((column) => column.name === "text" || column.name === "content")).toBe(
			false,
		);
		expect(
			columns
				.filter((column) =>
					[
						"backend_memory_id",
						"installation_id",
						"user_id",
						"companion_id",
						"created_by",
						"pinned",
						"created_at",
						"updated_at",
					].includes(column.name),
				)
				.every((column) => column.notnull),
		).toBe(true);

		const insert = database.connection.prepare(`
			INSERT INTO memory_presentation (
				backend_memory_id, installation_id, user_id, companion_id,
				source_pi_entry_id, created_by, pinned, replacement_memory_id, invalidated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		insert.run(
			"memory-1",
			"install-a",
			"user-a",
			"companion-a",
			"pi-entry-1",
			"user_capture",
			1,
			null,
			null,
		);
		insert.run(
			"memory-1",
			"install-a",
			"user-b",
			"companion-a",
			null,
			"imported",
			0,
			"memory-2",
			null,
		);
		insert.run(
			"memory-2",
			"install-a",
			"user-c",
			"companion-a",
			null,
			"assistant_tool",
			0,
			null,
			"2026-08-18T12:00:00.000Z",
		);

		const rows = database.connection
			.prepare(
				`SELECT backend_memory_id, installation_id, user_id, companion_id,
					source_pi_entry_id, created_by, pinned, replacement_memory_id, invalidated_at
				 FROM memory_presentation ORDER BY user_id`,
			)
			.all();
		expect(rows).toEqual([
			{
				backend_memory_id: "memory-1",
				installation_id: "install-a",
				user_id: "user-a",
				companion_id: "companion-a",
				source_pi_entry_id: "pi-entry-1",
				created_by: "user_capture",
				pinned: 1,
				replacement_memory_id: null,
				invalidated_at: null,
			},
			{
				backend_memory_id: "memory-1",
				installation_id: "install-a",
				user_id: "user-b",
				companion_id: "companion-a",
				source_pi_entry_id: null,
				created_by: "imported",
				pinned: 0,
				replacement_memory_id: "memory-2",
				invalidated_at: null,
			},
			{
				backend_memory_id: "memory-2",
				installation_id: "install-a",
				user_id: "user-c",
				companion_id: "companion-a",
				source_pi_entry_id: null,
				created_by: "assistant_tool",
				pinned: 0,
				replacement_memory_id: null,
				invalidated_at: "2026-08-18T12:00:00.000Z",
			},
		]);
		expect(() =>
			insert.run(
				"memory-4",
				"install-a",
				"user-a",
				"companion-a",
				null,
				"imported",
				0,
				null,
				"bad-timestamp",
			),
		).not.toThrow();
		expect(() =>
			insert.run("memory-1", "install-a", "user-a", "companion-a", null, "imported", 0, null),
		).toThrow();
		expect(() =>
			insert.run("memory-2", "install-a", "user-a", "companion-a", null, "invalid", 0, null),
		).toThrow();
		expect(() =>
			insert.run("memory-3", "install-a", "user-a", "companion-a", null, "imported", 2, null),
		).toThrow();
		database.close();
	});

	it("rejects an applied migration whose definition no longer matches", () => {
		const database = new Database(root());
		const staleSql = "CREATE TABLE stale_example (id TEXT PRIMARY KEY)";
		database.connection.exec(staleSql);
		database.connection
			.prepare("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)")
			.run(1, createHash("sha256").update(staleSql, "utf8").digest("hex"));

		expect(() => database.migrate(MIGRATIONS)).toThrow(/migration 1 checksum mismatch/);
		database.close();
	});

	it("safely reconciles the sole known pre-release v1 baseline", () => {
		const databaseDir = root();
		const database = new Database(databaseDir);
		database.migrate(MIGRATIONS);
		database.connection.exec(
			"ALTER TABLE conversations ADD COLUMN scene_title TEXT NOT NULL DEFAULT ''",
		);
		database.connection
			.prepare("UPDATE schema_migrations SET checksum = ? WHERE id = 1")
			.run("0ac4f43cf5d1aed5e85a00bc725e57d6b9a00e3ed17386845ca76cbe4452a3ea");
		database.connection
			.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES ('package-a', 'Package', '1.0.0', 'hash')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('companion-a', 'package-a', 'Companion', '')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO conversations (id, companion_id, title, scene_title) VALUES ('conversation-a', 'companion-a', 'Kept title', 'Old scene')",
			)
			.run();

		database.migrate(MIGRATIONS);

		const columns = database.connection.prepare("PRAGMA table_info(conversations)").all() as Array<{
			name: string;
		}>;
		expect(columns.map((column) => column.name)).not.toContain("scene_title");
		expect(
			database.connection
				.prepare("SELECT title FROM conversations WHERE id = 'conversation-a'")
				.get(),
		).toEqual({ title: "Kept title" });
		expect(
			database.connection.prepare("SELECT checksum FROM schema_migrations WHERE id = 1").get(),
		).toEqual({ checksum: createHash("sha256").update(MIGRATIONS[0]!.up, "utf8").digest("hex") });
		expect(existsSync(join(databaseDir, "schema-upgrade.json"))).toBe(false);
		const backups = backupPaths(databaseDir);
		expect(backups).toHaveLength(2);
		const backup = new DatabaseSync(backups.at(-1)!, { readOnly: true });
		expect(
			(backup.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(
				(column) => column.name,
			),
		).toContain("scene_title");
		expect(
			backup
				.prepare("SELECT title, scene_title FROM conversations WHERE id = 'conversation-a'")
				.get(),
		).toEqual({ title: "Kept title", scene_title: "Old scene" });
		backup.close();
		database.close();
	});

	it("rejects an unknown migration from a newer application", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		database.connection
			.prepare("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)")
			.run(10_000, "newer-application");

		expect(() => database.migrate(MIGRATIONS)).toThrow(/unknown applied migration 10000/);
		database.close();
	});

	it("rejects a migration history with an applied gap", () => {
		const database = new Database(root());
		database.migrate([BASE_MIGRATION, SECOND_MIGRATION, THIRD_MIGRATION]);
		database.connection.prepare("DELETE FROM schema_migrations WHERE id = ?").run(2);

		expect(() => database.migrate([BASE_MIGRATION, SECOND_MIGRATION, THIRD_MIGRATION])).toThrow(
			/migration history gap.*2/,
		);
		database.close();
	});

	it("rejects duplicate or non-contiguous migration definitions", () => {
		const database = new Database(root());
		expect(() => database.migrate([BASE_MIGRATION, BASE_MIGRATION])).toThrow(
			/duplicate migration id 1/,
		);
		expect(() => database.migrate([BASE_MIGRATION, THIRD_MIGRATION])).toThrow(
			/non-contiguous migration definitions.*2/,
		);
		database.close();
	});

	it("rejects a database missing a required runtime column", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		database.connection.exec("DROP TABLE conversation_model_selections");
		database.connection.exec("DROP TABLE configured_models");
		database.connection.exec(
			"CREATE TABLE configured_models (provider_id TEXT, model_id TEXT, label TEXT, supports_images INTEGER)",
		);
		expect(() => database.assertSchemaContract()).toThrow(
			/incompatible database schema.*configured_models\.created_at/,
		);
		database.close();
	});

	it("creates one verified backup for a multi-migration upgrade", () => {
		const databaseDir = root();
		const database = new Database(databaseDir);
		database.migrate([BASE_MIGRATION]);
		const backupsBeforeUpgrade = backupPaths(databaseDir);

		database.migrate([BASE_MIGRATION, SECOND_MIGRATION, THIRD_MIGRATION]);

		const newBackups = backupPaths(databaseDir).filter(
			(backupPath) => !backupsBeforeUpgrade.includes(backupPath),
		);
		expect(newBackups).toHaveLength(1);
		expect(database.currentVersion()).toBe(3);
		expect(
			database.connection
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'upgraded_%' ORDER BY name",
				)
				.all(),
		).toEqual([{ name: "upgraded_first" }, { name: "upgraded_second" }]);
		expect(existsSync(join(databaseDir, "schema-upgrade.json"))).toBe(false);
		database.close();
	});

	it("does not back up a database with no pending migrations", () => {
		const databaseDir = root();
		const database = new Database(databaseDir);
		database.migrate([BASE_MIGRATION]);
		const existingBackups = backupPaths(databaseDir);

		database.migrate([BASE_MIGRATION]);

		expect(backupPaths(databaseDir)).toEqual(existingBackups);
		expect(existsSync(join(databaseDir, "schema-upgrade.json"))).toBe(false);
		database.close();
	});

	it("includes committed WAL rows in the pre-upgrade backup", () => {
		const databaseDir = root();
		const database = new Database(databaseDir);
		database.migrate([BASE_MIGRATION]);
		database.connection.exec("PRAGMA wal_autocheckpoint = 0");
		database.connection
			.prepare("INSERT INTO durable_rows (id, value) VALUES (?, ?)")
			.run(1, "committed in WAL");
		const walPath = join(databaseDir, "canon.db-wal");
		expect(existsSync(walPath)).toBe(true);
		expect(statSync(walPath).size).toBeGreaterThan(0);
		const backupsBeforeUpgrade = backupPaths(databaseDir);

		database.migrate([BASE_MIGRATION, SECOND_MIGRATION]);

		const [backupPath] = backupPaths(databaseDir).filter(
			(candidate) => !backupsBeforeUpgrade.includes(candidate),
		);
		expect(backupPath).toBeDefined();
		const backup = new DatabaseSync(backupPath as string, { readOnly: true });
		try {
			expect(backup.prepare("SELECT id, value FROM durable_rows").all()).toEqual([
				{ id: 1, value: "committed in WAL" },
			]);
			expect(backup.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			backup.close();
		}
		database.close();
	});

	it("leaves a readable verified backup and recovery marker after migration failure", () => {
		const databaseDir = root();
		const database = new Database(databaseDir);
		database.migrate([BASE_MIGRATION]);
		database.connection
			.prepare("INSERT INTO durable_rows (id, value) VALUES (?, ?)")
			.run(1, "recover me");
		const backupsBeforeUpgrade = backupPaths(databaseDir);
		const failingMigration = {
			id: 2,
			description: "fail after changing the schema",
			up: "CREATE TABLE should_roll_back (id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES (1)",
		} satisfies Migration;

		expect(() => database.migrate([BASE_MIGRATION, failingMigration])).toThrow(
			/verified backup.*recovery marker/,
		);

		const newBackups = backupPaths(databaseDir).filter(
			(backupPath) => !backupsBeforeUpgrade.includes(backupPath),
		);
		expect(newBackups).toHaveLength(1);
		const marker = JSON.parse(readFileSync(join(databaseDir, "schema-upgrade.json"), "utf8")) as {
			sourceVersion: number;
			targetVersion: number;
			backupPath: string;
			state: string;
		};
		expect(marker).toEqual({
			sourceVersion: 1,
			targetVersion: 2,
			backupPath: newBackups[0],
			state: "pending",
		});
		const backup = new DatabaseSync(marker.backupPath, { readOnly: true });
		try {
			expect(backup.prepare("SELECT id, value FROM durable_rows").all()).toEqual([
				{ id: 1, value: "recover me" },
			]);
			expect(backup.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
			expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			backup.close();
		}
		expect(database.currentVersion()).toBe(1);
		expect(
			database.connection
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_roll_back'",
				)
				.get(),
		).toBeUndefined();
		database.close();
	});
});
