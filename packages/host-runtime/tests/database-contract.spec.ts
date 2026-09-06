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
	it("upgrades Run admission identity without losing existing conversations or historic Runs", () => {
		const path = join(temporaryRoot(), "runtime.db");
		const database = new CompanionDatabase(path, "character-a");
		try {
			// The preceding schema already has active_conversations, but no native
			// tool-call identity. Migration must not stop at that older upgrade.
			database.connection.exec(`
				CREATE TABLE runtime_identity (
					id INTEGER PRIMARY KEY, companion_id TEXT NOT NULL UNIQUE, nickname TEXT
				);
				CREATE TABLE conversations (
					id TEXT PRIMARY KEY,
					companion_id TEXT NOT NULL REFERENCES runtime_identity(companion_id)
				);
				CREATE TABLE active_conversations (
					companion_id TEXT PRIMARY KEY REFERENCES runtime_identity(companion_id),
					conversation_id TEXT NOT NULL REFERENCES conversations(id),
					updated_at TEXT NOT NULL
				);
				CREATE TABLE runs (
					id TEXT PRIMARY KEY,
					conversation_id TEXT NOT NULL REFERENCES conversations(id),
					trigger_entry_id TEXT NOT NULL,
					executor_profile TEXT NOT NULL,
					title TEXT NOT NULL,
					instruction TEXT NOT NULL,
					input_paths TEXT NOT NULL DEFAULT '[]',
					status TEXT NOT NULL DEFAULT 'enqueued',
					permission_json TEXT, summary TEXT, result_reported_at TEXT,
					started_at TEXT, completed_at TEXT,
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				INSERT INTO runtime_identity VALUES (1, 'character-a', 'Saved nickname');
				INSERT INTO conversations VALUES ('conversation-a', 'character-a'), ('conversation-b', 'character-a');
				INSERT INTO active_conversations VALUES ('character-a', 'conversation-a', '2026-01-01T00:00:00.000Z');
				INSERT INTO runs (id, conversation_id, trigger_entry_id, executor_profile, title, instruction, status, summary)
				VALUES
					('historic-a', 'conversation-a', 'entry-a', 'codex-saved', 'Old task', 'Keep this instruction', 'completed', 'Saved result'),
					('historic-b', 'conversation-a', 'entry-b', 'pi-default', 'Pending task', 'Keep pending work', 'interrupted', NULL);
			`);
			database.initialize(COMPANION_SCHEMA_SQL);
			database.ensureRuntimeIdentity();
			expect(
				database.connection.prepare("SELECT id, tool_call_id FROM runs ORDER BY id").all(),
			).toEqual([
				{ id: "historic-a", tool_call_id: null },
				{ id: "historic-b", tool_call_id: null },
			]);
			const admit = database.connection.prepare(`
				INSERT INTO runs (id, conversation_id, trigger_entry_id, tool_call_id, executor_profile, title, instruction)
				VALUES (?, ?, 'native-entry', ?, 'pi-default', 'New task', 'Inspect safely')
			`);
			admit.run("new-a", "conversation-a", "native-tool");
			expect(() => admit.run("duplicate-a", "conversation-a", "native-tool")).toThrow(/UNIQUE/);
			admit.run("new-b", "conversation-b", "native-tool");
			database.initialize(COMPANION_SCHEMA_SQL);
		} finally {
			database.close();
		}

		const reopened = new CompanionDatabase(path, "character-a");
		try {
			reopened.initialize(COMPANION_SCHEMA_SQL);
			reopened.ensureRuntimeIdentity();
			expect(reopened.connection.prepare("SELECT * FROM active_conversations").get()).toEqual({
				companion_id: "character-a",
				conversation_id: "conversation-a",
				updated_at: "2026-01-01T00:00:00.000Z",
			});
			expect(reopened.connection.prepare("SELECT nickname FROM runtime_identity").get()).toEqual({
				nickname: "Saved nickname",
			});
			expect(
				reopened.connection
					.prepare(
						"SELECT id, executor_profile, instruction, status, summary, tool_call_id FROM runs ORDER BY id",
					)
					.all(),
			).toEqual([
				{
					id: "historic-a",
					executor_profile: "codex-saved",
					instruction: "Keep this instruction",
					status: "completed",
					summary: "Saved result",
					tool_call_id: null,
				},
				{
					id: "historic-b",
					executor_profile: "pi-default",
					instruction: "Keep pending work",
					status: "interrupted",
					summary: null,
					tool_call_id: null,
				},
				{
					id: "new-a",
					executor_profile: "pi-default",
					instruction: "Inspect safely",
					status: "enqueued",
					summary: null,
					tool_call_id: "native-tool",
				},
				{
					id: "new-b",
					executor_profile: "pi-default",
					instruction: "Inspect safely",
					status: "enqueued",
					summary: null,
					tool_call_id: "native-tool",
				},
			]);
		} finally {
			reopened.close();
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
