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
});
