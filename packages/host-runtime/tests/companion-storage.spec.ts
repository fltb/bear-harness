// @vitest-environment node

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionStorageRegistry } from "../src/storage/companion-storage.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-companion-storage-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("companion storage registry", () => {
	it("keeps system and character schemas in different physical databases", () => {
		const registry = new CompanionStorageRegistry(root());
		try {
			const first = registry.open("role-a");
			const second = registry.open("role-b");
			expect(registry.open("role-a")).toBe(first);
			expect(first.database.path).not.toBe(second.database.path);
			expect(
				registry.system.connection
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'")
					.get(),
			).toBeUndefined();
			expect(
				first.database.connection
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_accounts'")
					.get(),
			).toBeUndefined();
			expect(
				first.database.connection.prepare("SELECT companion_id FROM runtime_identity").get(),
			).toEqual({ companion_id: "role-a" });
			expect(
				first.database.connection
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
					.get(),
			).toBeUndefined();
			expect(
				second.database.connection.prepare("SELECT companion_id FROM runtime_identity").get(),
			).toEqual({ companion_id: "role-b" });
		} finally {
			registry.close();
		}
	});

	it("preserves existing v1 data when adding and reopening a character thinking preference", () => {
		const dataRoot = root();
		const original = new CompanionStorageRegistry(dataRoot);
		const otherPath = original.open("role-b").database.path;
		try {
			const connection = original.open("role-a").database.connection;
			connection.exec(`
				INSERT INTO model_route_settings (companion_id, text_provider_id, text_model_id, onboarding_complete)
					VALUES ('role-a', 'provider', 'reply-model', 1);
				INSERT INTO conversations (id, companion_id) VALUES ('existing-session', 'role-a');
				ALTER TABLE model_route_settings DROP COLUMN text_thinking_level;
			`);
		} finally {
			original.close();
		}
		const otherBytes = readFileSync(otherPath);
		const reopened = new CompanionStorageRegistry(dataRoot);
		try {
			const connection = reopened.open("role-a").database.connection;
			expect(
				connection
					.prepare(
						"SELECT text_provider_id, text_model_id, onboarding_complete, text_thinking_level FROM model_route_settings",
					)
					.get(),
			).toEqual({
				text_provider_id: "provider",
				text_model_id: "reply-model",
				onboarding_complete: 1,
				text_thinking_level: null,
			});
			expect(connection.prepare("SELECT id, companion_id FROM conversations").all()).toEqual([
				{ id: "existing-session", companion_id: "role-a" },
			]);
			connection.exec("UPDATE model_route_settings SET text_thinking_level = 'max'");
			reopened.closeCompanion("role-a");
			expect(
				reopened
					.open("role-a")
					.database.connection.prepare("SELECT text_thinking_level FROM model_route_settings")
					.get(),
			).toEqual({ text_thinking_level: "max" });
			expect(readFileSync(otherPath)).toEqual(otherBytes);
		} finally {
			reopened.close();
		}
	});

	it("refuses to open a runtime database moved under another character id", () => {
		const dataRoot = root();
		const first = new CompanionStorageRegistry(dataRoot);
		first.open("role-a");
		first.close();

		const second = new CompanionStorageRegistry(dataRoot);
		try {
			const roleA = second.layout.companion("role-a");
			const roleB = second.layout.ensureCompanionDirectories("role-b");
			copyFileSync(roleA.database, roleB.database);
			expect(() => second.open("role-b")).toThrow(/identity does not match/);
		} finally {
			second.close();
		}
	});
});
