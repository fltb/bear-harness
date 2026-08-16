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
		const db = database.connection;
		db.prepare(
			"INSERT INTO companion_packages (id, name, version, hash) VALUES ('character', 'Character', '1', 'hash')",
		).run();
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('character', 'character', 'Character', '')",
		).run();
		db.prepare(
			"INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'character', 'Test')",
		).run();
		models = new ModelRegistry(database.orm, new EventBus(database.orm));
	});

	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("maintains a reusable model pool and a per-conversation selection", () => {
		models.enable({
			providerId: "relay",
			modelId: "text",
			label: "Text",
			supportsImages: false,
		});
		models.enable({
			providerId: "relay",
			modelId: "vision",
			label: "Vision",
			supportsImages: true,
		});
		expect(models.selected("conversation")).toBeUndefined();

		models.select("conversation", "relay", "vision");
		expect(models.selected("conversation")?.modelId).toBe("vision");
	});

	it("automatically chooses a multimodal model only when the selected model cannot read images", () => {
		models.enable({ providerId: "relay", modelId: "text", label: "Text", supportsImages: false });
		models.enable({
			providerId: "vision-provider",
			modelId: "vision",
			label: "Vision",
			supportsImages: true,
		});
		models.select("conversation", "relay", "text");

		expect(models.resolve("conversation", false)?.modelId).toBe("text");
		expect(models.resolve("conversation", true)).toMatchObject({
			providerId: "vision-provider",
			modelId: "vision",
		});
		expect(models.multimodalFallback("character")?.modelId).toBe("vision");
	});

	it("persists an explicitly selected multimodal fallback", () => {
		models.enable({
			providerId: "relay",
			modelId: "vision-a",
			label: "Vision A",
			supportsImages: true,
		});
		models.enable({
			providerId: "relay",
			modelId: "vision-b",
			label: "Vision B",
			supportsImages: true,
		});

		models.setVisionDefault("character", {
			mode: "manual",
			route: { providerId: "relay", modelId: "vision-b" },
		});

		expect(models.multimodalFallback("character")?.modelId).toBe("vision-b");
		expect(() =>
			models.setVisionDefault("character", {
				mode: "manual",
				route: { providerId: "relay", modelId: "missing" },
			}),
		).toThrow();
	});

	it("starts without a reply default and applies a configured default only to new conversations", () => {
		models.enable({ providerId: "relay", modelId: "text", label: "Text", supportsImages: false });
		expect(models.defaults("character").reply).toBeUndefined();
		expect(models.selected("conversation")).toBeUndefined();

		models.setDefaultReply("character", { providerId: "relay", modelId: "text" });
		database.connection
			.prepare(
				"INSERT INTO conversations (id, companion_id, title) VALUES ('new-conversation', 'character', 'New')",
			)
			.run();
		models.applyDefaultToConversation("character", "new-conversation");

		expect(models.selected("conversation")).toBeUndefined();
		expect(models.selected("new-conversation")).toMatchObject({
			providerId: "relay",
			modelId: "text",
		});
	});

	it("resolves automatic vision without creating or changing persisted defaults", () => {
		models.enable({
			providerId: "relay",
			modelId: "vision",
			label: "Vision",
			supportsImages: true,
		});
		const before = database.connection
			.prepare("SELECT COUNT(*) AS count FROM model_route_settings")
			.get() as { count: number };

		expect(models.multimodalFallback("character")?.modelId).toBe("vision");
		const after = database.connection
			.prepare("SELECT COUNT(*) AS count FROM model_route_settings")
			.get() as { count: number };
		expect(after.count).toBe(before.count);
		expect(models.defaults("character").vision).toEqual({ mode: "auto" });
	});

	it("clears reply and manual vision defaults when their configured model is removed", () => {
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

	it("removes a conversation selection without silently choosing another model", () => {
		models.enable({ providerId: "relay", modelId: "first", label: "First", supportsImages: false });
		models.enable({
			providerId: "relay",
			modelId: "second",
			label: "Second",
			supportsImages: false,
		});
		models.select("conversation", "relay", "first");
		models.disable("relay", "first");

		expect(models.list()).toEqual([expect.objectContaining({ modelId: "second" })]);
		expect(models.selected("conversation")).toBeUndefined();
	});
});
