// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database, MIGRATIONS } from "../src/storage/database.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-database-contract-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("database schema contract", () => {
	it("automatically applies a valid pending migration", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS.slice(0, -1));
		database.migrate(MIGRATIONS);

		expect(database.currentVersion()).toBe(MIGRATIONS.at(-1)?.id);
		expect(() => database.assertSchemaContract()).not.toThrow();
		database.close();
	});
	it("renames the commission native trigger anchor during mirror removal", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS.slice(0, -1));
		database.connection
			.prepare(
				"INSERT INTO commissions (id, conversation_id, status, draft_json) VALUES (?, ?, ?, ?)",
			)
			.run("legacy-commission", null, "draft", "{}");
		database.migrate(MIGRATIONS);
		expect(
			database.connection.prepare("SELECT id, trigger_entry_id FROM commissions").get(),
		).toEqual({ id: "legacy-commission", trigger_entry_id: "" });
		database.close();
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
		database.migrate(MIGRATIONS.slice(0, 3));
		database.connection.prepare("DELETE FROM schema_migrations WHERE id = ?").run(2);

		expect(() => database.migrate(MIGRATIONS)).toThrow(/migration history gap.*2/);
		database.close();
	});

	it("rejects duplicate or non-contiguous migration definitions", () => {
		const database = new Database(root());
		expect(() => database.migrate([MIGRATIONS[0], MIGRATIONS[0]])).toThrow(
			/duplicate migration id 1/,
		);
		expect(() => database.migrate([MIGRATIONS[0], MIGRATIONS[2]])).toThrow(
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
});
