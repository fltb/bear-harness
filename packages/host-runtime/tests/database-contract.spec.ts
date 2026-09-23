import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPANION_SCHEMA_SQL,
	CompanionDatabase,
	SYSTEM_SCHEMA_SQL,
	SystemDatabase,
} from "../src/storage/database.js";

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-schema-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bear 1.0 database schema", () => {
	it("converts mixed Artifact status once while preserving saved facts, adoptions, bytes metadata and foreign keys", () => {
		const path = join(temporaryRoot(), "runtime.db");
		const database = new CompanionDatabase(path, "character-a");
		try {
			const legacySchema = COMPANION_SCHEMA_SQL.replace(
				/CREATE TABLE artifacts \([\s\S]*?\n\);/,
				`CREATE TABLE artifacts (
				id TEXT PRIMARY KEY, logical_name TEXT NOT NULL, mime TEXT NOT NULL,
				bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','verified','verification_failed','adopted','saved')),
				producer_run_id TEXT REFERENCES runs(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);`,
			);
			database.connection.exec(legacySchema);
			database.connection.exec("PRAGMA user_version=1");
			database.ensureRuntimeIdentity();
			database.connection.exec(`
				INSERT INTO conversations(id,companion_id) VALUES('conversation-a','character-a');
				INSERT INTO runs(id,conversation_id,trigger_entry_id,executor_profile,title,instruction)
				VALUES('run-a','conversation-a','entry-a','pi-default','Work','Make files');
			`);
			for (const status of ["created", "verified", "verification_failed", "adopted", "saved"])
				database.connection
					.prepare(
						"INSERT INTO artifacts(id,logical_name,mime,bytes,sha256,status,producer_run_id,created_at) VALUES(?,?,'text/plain',8,?,?,'run-a','2026-09-01T00:00:00Z')",
					)
					.run(status, `${status}.txt`, "a".repeat(64), status);
			database.connection.exec(`
				INSERT INTO artifact_adoptions(id,artifact_id,run_id) VALUES('adoption-a','adopted','run-a');
				INSERT INTO artifact_adoptions(id,artifact_id,run_id) VALUES('adoption-b','saved','run-a');
				INSERT INTO canon_sources(id,companion_id,logical_name,mime,sha256,artifact_id)
				VALUES('source-a','character-a','old artifact','text/plain','${"a".repeat(64)}','saved');
			`);
			database.initialize(COMPANION_SCHEMA_SQL);
			expect(
				database.connection
					.prepare("SELECT id,verification,saved FROM artifacts ORDER BY id")
					.all(),
			).toEqual([
				{ id: "adopted", verification: "pending", saved: 0 },
				{ id: "created", verification: "pending", saved: 0 },
				{ id: "saved", verification: "pending", saved: 1 },
				{ id: "verification_failed", verification: "failed", saved: 0 },
				{ id: "verified", verification: "verified", saved: 0 },
			]);
			expect(
				database.connection
					.prepare("SELECT bytes,sha256,producer_run_id,created_at FROM artifacts WHERE id='saved'")
					.get(),
			).toEqual({
				bytes: 8,
				sha256: "a".repeat(64),
				producer_run_id: "run-a",
				created_at: "2026-09-01T00:00:00Z",
			});
			expect(
				database.connection.prepare("SELECT artifact_id FROM artifact_adoptions ORDER BY id").all(),
			).toEqual([{ artifact_id: "adopted" }, { artifact_id: "saved" }]);
			expect(database.connection.prepare("SELECT artifact_id FROM canon_sources").all()).toEqual([
				{ artifact_id: "saved" },
			]);
			expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(database.connection.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
			expect(
				database.connection
					.prepare("PRAGMA table_info(artifacts)")
					.all()
					.map((column) => column.name),
			).not.toContain("status");
			database.connection.exec("UPDATE artifacts SET verification='verified' WHERE id='saved'");
			database.initialize(COMPANION_SCHEMA_SQL);
			expect(
				database.connection
					.prepare("SELECT verification,saved FROM artifacts WHERE id='saved'")
					.get(),
			).toEqual({ verification: "verified", saved: 1 });
		} finally {
			database.close();
		}
	});

	it("marks every fresh Bear database as schema version 1", () => {
		const root = temporaryRoot();
		const system = new SystemDatabase(join(root, "settings.db"));
		const companion = new CompanionDatabase(join(root, "runtime.db"), "character-a");
		try {
			system.initialize(SYSTEM_SCHEMA_SQL);
			companion.initialize(COMPANION_SCHEMA_SQL);
			expect(system.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
			expect(companion.connection.prepare("PRAGMA user_version").get()).toEqual({
				user_version: 1,
			});
		} finally {
			system.close();
			companion.close();
		}
	});

	it("rejects unversioned pre-release databases instead of migrating them", () => {
		const path = join(temporaryRoot(), "runtime.db");
		const database = new CompanionDatabase(path, "character-a");
		try {
			database.connection.exec(`
				CREATE TABLE runtime_identity (
					id INTEGER PRIMARY KEY, companion_id TEXT NOT NULL UNIQUE, nickname TEXT
				);
				CREATE TABLE conversations (
					id TEXT PRIMARY KEY,
					companion_id TEXT NOT NULL REFERENCES runtime_identity(companion_id)
				);
			`);
			expect(() => database.initialize(COMPANION_SCHEMA_SQL)).toThrow(
				"unsupported database schema version 0; expected 1",
			);
		} finally {
			database.close();
		}
	});

	it("is idempotent and preserves current-schema data", () => {
		const root = temporaryRoot();
		const path = join(root, "settings.db");
		const database = new SystemDatabase(path);
		database.initialize(SYSTEM_SCHEMA_SQL);
		database.connection
			.prepare(
				"INSERT INTO configured_models(provider_id,model_id,label,supports_images) VALUES ('openai-codex','gpt-5.6-sol','Sol',1)",
			)
			.run();
		database.initialize(SYSTEM_SCHEMA_SQL);
		database.close();

		const reopened = new SystemDatabase(path);
		try {
			reopened.initialize(SYSTEM_SCHEMA_SQL);
			expect(
				reopened.connection
					.prepare("SELECT label FROM configured_models WHERE provider_id = 'openai-codex'")
					.get(),
			).toEqual({ label: "Sol" });
		} finally {
			reopened.close();
		}
	});

	it("retires existing v1 window selections without deleting owned data or granting memory consent", () => {
		const root = temporaryRoot();
		const system = new SystemDatabase(join(root, "settings.db"));
		const companion = new CompanionDatabase(join(root, "runtime.db"), "character-a");
		try {
			system.initialize(SYSTEM_SCHEMA_SQL);
			companion.initialize(COMPANION_SCHEMA_SQL);
			companion.ensureRuntimeIdentity();
			system.connection.exec(`
				INSERT INTO companion_packages(id, name) VALUES('character-a', 'A');
				INSERT INTO companion_identity(id, package_id, name) VALUES('character-a', 'character-a', 'A');
				CREATE TABLE active_character(singleton INTEGER PRIMARY KEY, character_id TEXT REFERENCES companion_identity(id));
				INSERT INTO active_character VALUES(1, 'character-a');
			`);
			companion.connection.exec(`
				INSERT INTO conversations(id, companion_id) VALUES('conversation-a', 'character-a');
				CREATE TABLE active_conversations(companion_id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id));
				INSERT INTO active_conversations VALUES('character-a', 'conversation-a');
				DROP TABLE character_memory_settings;
				INSERT INTO runs(id, conversation_id, trigger_entry_id, executor_profile, title, instruction)
				VALUES('run-a', 'conversation-a', 'entry-a', 'pi-default', 'Run', 'Work');
			`);

			system.initialize(SYSTEM_SCHEMA_SQL);
			companion.initialize(COMPANION_SCHEMA_SQL);
			companion.ensureRuntimeIdentity();

			expect(
				system.connection
					.prepare("SELECT name FROM sqlite_master WHERE name='active_character'")
					.get(),
			).toBeUndefined();
			expect(
				companion.connection
					.prepare("SELECT name FROM sqlite_master WHERE name='active_conversations'")
					.get(),
			).toBeUndefined();
			expect(system.connection.prepare("SELECT id FROM companion_identity").all()).toEqual([
				{ id: "character-a" },
			]);
			expect(companion.connection.prepare("SELECT id FROM conversations").all()).toEqual([
				{ id: "conversation-a" },
			]);
			expect(companion.connection.prepare("SELECT id FROM runs").all()).toEqual([{ id: "run-a" }]);
			expect(
				companion.connection.prepare("SELECT id, enabled FROM character_memory_settings").all(),
			).toEqual([{ id: 1, enabled: 0 }]);
			expect(
				system.connection
					.prepare("SELECT name FROM sqlite_master WHERE name='character_memory_settings'")
					.get(),
			).toBeUndefined();
			companion.connection.exec("UPDATE character_memory_settings SET enabled=1 WHERE id=1");
			companion.initialize(COMPANION_SCHEMA_SQL);
			expect(
				companion.connection
					.prepare("SELECT enabled FROM character_memory_settings WHERE id=1")
					.get(),
			).toEqual({ enabled: 1 });
			expect(companion.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			system.close();
			companion.close();
		}
	});
});
