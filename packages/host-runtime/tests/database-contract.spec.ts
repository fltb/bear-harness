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
	COMPANION_MIGRATIONS,
	CompanionDatabase,
	Database,
	loadInstallationId,
	type Migration,
	SYSTEM_MIGRATIONS,
	SystemDatabase,
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
	it("covers system and character application tables with independent change triggers", () => {
		const databaseRoot = root();
		const system = new SystemDatabase(join(databaseRoot, "system", "settings.db"));
		const companion = new CompanionDatabase(
			join(databaseRoot, "companions", "jizhou", "runtime.db"),
			"jizhou",
		);
		system.migrate(SYSTEM_MIGRATIONS);
		companion.migrate(COMPANION_MIGRATIONS);
		companion.ensureRuntimeIdentity();

		for (const [database, excluded] of [
			[system, new Set<string>(["schema_migrations", "installation_identity", "sync_changes"])],
			[
				companion,
				new Set<string>(["schema_migrations", "runtime_identity", "events", "sync_changes"]),
			],
		] as const) {
			const tables = database.connection
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all();
			const triggers = database.connection
				.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
				.all()
				.map((row) => row.name);
			for (const table of tables) {
				const name = String(table.name);
				if (excluded.has(name) || name.includes("fts") || name.includes("vec")) continue;
				for (const operation of ["insert", "update", "delete"]) {
					expect(
						triggers,
						`${name} ${operation} must invalidate readers of its owning database`,
					).toContain(`sync_${name}_${operation}`);
				}
			}
		}
		system.close();
		companion.close();
	});

	it("journals state writes atomically and only notifies committed revisions", async () => {
		const database = new SystemDatabase(join(root(), "system", "settings.db"));
		database.migrate(SYSTEM_MIGRATIONS);
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
		database.migrate([BASE_MIGRATION]);
		database.migrate([BASE_MIGRATION, SECOND_MIGRATION]);

		expect(database.currentVersion()).toBe(SECOND_MIGRATION.id);
		expect(
			database.connection
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upgraded_first'")
				.get(),
		).toEqual({ name: "upgraded_first" });
		database.close();
	});

	it("creates one UUID identity and preserves it when the database is reopened", () => {
		const databaseDir = root();
		const databasePath = join(databaseDir, "system", "settings.db");
		const database = new SystemDatabase(databasePath);
		database.migrate(SYSTEM_MIGRATIONS);

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

		const reopened = new SystemDatabase(databasePath);
		reopened.migrate(SYSTEM_MIGRATIONS);
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

		const database = new SystemDatabase(join(dataDir, "system", "settings.db"));
		database.migrate(SYSTEM_MIGRATIONS);
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
		const databaseRoot = root();
		const system = new SystemDatabase(join(databaseRoot, "system", "settings.db"));
		const companion = new CompanionDatabase(
			join(databaseRoot, "companions", "jizhou", "runtime.db"),
			"jizhou",
		);
		system.migrate(SYSTEM_MIGRATIONS);
		companion.migrate(COMPANION_MIGRATIONS);
		companion.ensureRuntimeIdentity();
		expect(() => system.assertSchemaContract()).not.toThrow();
		expect(() => companion.assertSchemaContract()).not.toThrow();
		expect(companion.connection.prepare("SELECT created_at FROM runs LIMIT 1").all()).toEqual([]);
		expect(
			system.connection.prepare("SELECT created_at FROM configured_models LIMIT 1").all(),
		).toEqual([]);
		expect(
			system.connection
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
				.get(),
		).toBeUndefined();
		expect(
			companion.connection
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'configured_models'",
				)
				.get(),
		).toBeUndefined();
		system.close();
		companion.close();
	});

	it("does not recreate the deleted Host Pi-session mirror", () => {
		const database = new CompanionDatabase(join(root(), "runtime.db"), "jizhou");
		database.migrate(COMPANION_MIGRATIONS);
		database.ensureRuntimeIdentity();
		const columns = database.connection
			.prepare("PRAGMA table_info(conversation_sessions)")
			.all() as Array<{ name: string; notnull: number }>;
		expect(columns).toEqual([]);
		database.close();
	});

	it("does not recreate deleted Host transcript or memory authorities", () => {
		const database = new CompanionDatabase(join(root(), "runtime.db"), "jizhou");
		database.migrate(COMPANION_MIGRATIONS);
		database.ensureRuntimeIdentity();
		for (const table of [
			"branches",
			"messages",
			"message_versions",
			"turns",
			"relationship_memory_entries",
			"memory_candidates",
			"memory_decisions",
			"memory_presentation",
			"memory_fts",
		]) {
			expect(
				database.connection
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get(table),
			).toBeUndefined();
		}
		expect(() => database.assertSchemaContract()).not.toThrow();
		database.close();
	});

	it("rejects an applied migration whose definition no longer matches", () => {
		const database = new Database(root());
		const staleSql = "CREATE TABLE stale_example (id TEXT PRIMARY KEY)";
		database.connection.exec(staleSql);
		database.connection
			.prepare("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)")
			.run(1, createHash("sha256").update(staleSql, "utf8").digest("hex"));

		expect(() => database.migrate([BASE_MIGRATION])).toThrow(/migration 1 checksum mismatch/);
		database.close();
	});

	it("rejects an unknown migration from a newer application", () => {
		const database = new Database(root());
		database.migrate([BASE_MIGRATION]);
		database.connection
			.prepare("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)")
			.run(10_000, "newer-application");

		expect(() => database.migrate([BASE_MIGRATION])).toThrow(/unknown applied migration 10000/);
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
		const database = new SystemDatabase(join(root(), "settings.db"));
		database.migrate(SYSTEM_MIGRATIONS);
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
