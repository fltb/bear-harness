// @vitest-environment node

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
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
