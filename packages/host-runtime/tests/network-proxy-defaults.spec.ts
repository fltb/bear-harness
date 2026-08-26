// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettingsStore, defaultAppSettings } from "../src/storage/app-settings-store.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("network proxy defaults", () => {
	it("defaults fresh installations to the system proxy", () => {
		expect(defaultAppSettings().networkProxy).toEqual({ mode: "auto" });

		const root = mkdtempSync(join(tmpdir(), "bear-proxy-default-"));
		roots.push(root);
		const database = new Database(root);
		database.migrate(MIGRATIONS);
		expect(new AppSettingsStore(database.orm).load().networkProxy).toEqual({ mode: "auto" });
		database.close();
	});

	it("migrates the former direct default to the system proxy", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-proxy-migration-"));
		roots.push(root);
		const database = new Database(root);
		database.migrate(MIGRATIONS.filter((migration) => migration.id <= 23));
		database.connection
			.prepare("UPDATE app_settings SET network_proxy = ? WHERE id = 1")
			.run('{"mode":"direct"}');
		database.migrate(MIGRATIONS);
		expect(new AppSettingsStore(database.orm).load().networkProxy).toEqual({ mode: "auto" });
		database.close();
	});
});
