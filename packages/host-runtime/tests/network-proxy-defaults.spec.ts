// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppSettingsStore, defaultAppSettings } from "../src/storage/app-settings-store.js";
import { SYSTEM_MIGRATIONS, SystemDatabase } from "../src/storage/database.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("network proxy defaults", () => {
	it("defaults fresh installations to the system proxy", () => {
		expect(defaultAppSettings().networkProxy).toEqual({ mode: "auto" });

		const root = mkdtempSync(join(tmpdir(), "bear-proxy-default-"));
		roots.push(root);
		const database = new SystemDatabase(join(root, "system", "settings.db"));
		database.migrate(SYSTEM_MIGRATIONS);
		expect(new AppSettingsStore(database.orm).load().networkProxy).toEqual({ mode: "auto" });
		database.close();
	});

	it("never projects a pending legacy plaintext embedding key", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-embedding-scrub-"));
		roots.push(root);
		const database = new SystemDatabase(join(root, "system", "settings.db"));
		database.migrate(SYSTEM_MIGRATIONS);
		database.connection
			.prepare("UPDATE app_settings SET memory_vector_service = ? WHERE id = 1")
			.run(
				JSON.stringify({
					enabled: true,
					provider: "remote",
					baseUrl: "https://embedding.example/v1",
					apiKey: "legacy-plaintext-secret",
					model: "embedding-model",
					dimensions: 768,
				}),
			);

		const settings = new AppSettingsStore(database.orm).load();
		expect(settings.memoryVectorService).toEqual({
			enabled: true,
			provider: "remote",
			baseUrl: "https://embedding.example/v1",
			model: "embedding-model",
			dimensions: 768,
		});
		const persisted = database.connection
			.prepare("SELECT memory_vector_service FROM app_settings WHERE id = 1")
			.get() as { memory_vector_service: string };
		expect(persisted.memory_vector_service).toContain("legacy-plaintext-secret");
		expect(JSON.stringify(settings)).not.toContain("legacy-plaintext-secret");
		database.close();
	});
});
