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

	it("creates every column required by typed runtime queries", () => {
		const database = new Database(root());
		database.migrate(MIGRATIONS);
		expect(() => database.assertSchemaContract()).not.toThrow();
		expect(database.connection.prepare("SELECT created_at FROM runs LIMIT 1").all()).toEqual([]);
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
