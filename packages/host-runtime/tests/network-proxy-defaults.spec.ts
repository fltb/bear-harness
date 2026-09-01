// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettingsStore } from "../src/storage/app-settings-store.js";
import { SYSTEM_SCHEMA_SQL, SystemDatabase } from "../src/storage/database.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("network proxy defaults", () => {
	it("defaults fresh installations to the system proxy", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-proxy-default-"));
		roots.push(root);
		const database = new SystemDatabase(join(root, "system", "settings.db"));
		database.initialize(SYSTEM_SCHEMA_SQL);
		expect(new AppSettingsStore(database.orm).load().networkProxy).toEqual({ mode: "auto" });
		database.close();
	});
});
