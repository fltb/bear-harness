// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/models/registry.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

describe("ModelRegistry", () => {
	let root: string;
	let database: Database;
	let models: ModelRegistry;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-model-registry-"));
		database = new Database(root);
		database.migrate(MIGRATIONS);
		database.connection
			.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES ('character', 'Character', '1', 'hash')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO companion_identity (id, package_id, name) VALUES ('character', 'character', 'Character')",
			)
			.run();
		models = new ModelRegistry(database.orm, new EventBus(database.orm));
	});

	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("maintains the configured model pool without owning session selection", () => {
		models.enable({ providerId: "relay", modelId: "text", label: "Text", supportsImages: false });
		expect(models.list()).toEqual([
			expect.objectContaining({ providerId: "relay", modelId: "text" }),
		]);
		expect(models.get("relay", "text")?.label).toBe("Text");
	});

	it("persists only companion-wide reply and vision defaults", () => {
		models.enable({ providerId: "relay", modelId: "text", label: "Text", supportsImages: false });
		models.enable({
			providerId: "relay",
			modelId: "vision",
			label: "Vision",
			supportsImages: true,
		});
		models.setDefaultReply("character", { providerId: "relay", modelId: "text" });
		models.setVisionDefault("character", {
			mode: "manual",
			route: { providerId: "relay", modelId: "vision" },
		});
		expect(models.defaults("character")).toMatchObject({
			reply: { providerId: "relay", modelId: "text" },
			vision: { mode: "manual", route: { providerId: "relay", modelId: "vision" } },
		});
	});

	it("clears defaults when their configured model is removed", () => {
		models.enable({
			providerId: "relay",
			modelId: "vision",
			label: "Vision",
			supportsImages: true,
		});
		models.setDefaultReply("character", { providerId: "relay", modelId: "vision" });
		models.setVisionDefault("character", {
			mode: "manual",
			route: { providerId: "relay", modelId: "vision" },
		});
		models.disable("relay", "vision");
		expect(models.defaults("character")).toEqual({ vision: { mode: "auto" } });
	});
});
