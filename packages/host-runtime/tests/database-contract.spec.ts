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

function tableNames(database: SystemDatabase | CompanionDatabase): Set<string> {
	return new Set(
		(
			database.connection
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bear 1.0 database schema", () => {
	it("initializes split schemas without version metadata", () => {
		const root = temporaryRoot();
		const system = new SystemDatabase(join(root, "system", "settings.db"));
		const companion = new CompanionDatabase(
			join(root, "companions", "character-a", "runtime.db"),
			"character-a",
		);
		try {
			system.initialize(SYSTEM_SCHEMA_SQL);
			companion.initialize(COMPANION_SCHEMA_SQL);
			companion.ensureRuntimeIdentity();

			const systemTables = tableNames(system);
			const companionTables = tableNames(companion);
			expect(systemTables.has("schema_migrations")).toBe(false);
			expect(companionTables.has("schema_migrations")).toBe(false);
			expect(systemTables.has("installation_identity")).toBe(true);
			expect(systemTables.has("conversations")).toBe(false);
			expect(companionTables.has("runtime_identity")).toBe(true);
			expect(companionTables.has("provider_accounts")).toBe(false);
		} finally {
			companion.close();
			system.close();
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
