// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/models/registry.js";
import { AppSettingsStore } from "../src/storage/app-settings-store.js";
import {
	COMPANION_SCHEMA_SQL,
	CompanionDatabase,
	SYSTEM_SCHEMA_SQL,
	SystemDatabase,
} from "../src/storage/database.js";

describe("ModelRegistry", () => {
	let root: string;
	let systemDatabase: SystemDatabase;
	let companionDatabase: CompanionDatabase;
	let publish: ReturnType<typeof vi.fn>;
	let models: ModelRegistry;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-model-registry-"));
		systemDatabase = new SystemDatabase(join(root, "system", "settings.db"));
		systemDatabase.initialize(SYSTEM_SCHEMA_SQL);
		companionDatabase = new CompanionDatabase(
			join(root, "companions", "character", "runtime.db"),
			"character",
		);
		companionDatabase.initialize(COMPANION_SCHEMA_SQL);
		companionDatabase.ensureRuntimeIdentity();
		publish = vi.fn();
		models = new ModelRegistry(
			systemDatabase.orm,
			companionDatabase.orm,
			{ invalidate: publish } as never,
			new AppSettingsStore(systemDatabase.orm),
			(visit) => visit(companionDatabase.orm),
		);
	});

	afterEach(() => {
		companionDatabase.close();
		systemDatabase.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("uses physically separate databases with no opposite-domain tables", () => {
		expect(
			systemDatabase.connection
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_route_settings'",
				)
				.get(),
		).toBeUndefined();
		expect(
			companionDatabase.connection
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'configured_models'",
				)
				.get(),
		).toBeUndefined();

		models.enable({ providerId: "relay", modelId: "text", label: "Text", supportsImages: false });
		models.setDefaultReply("character", { providerId: "relay", modelId: "text" });

		expect(models.list()).toEqual([
			expect.objectContaining({ providerId: "relay", modelId: "text" }),
		]);
		expect(models.defaults("character")).toMatchObject({
			reply: { providerId: "relay", modelId: "text" },
			vision: { mode: "auto" },
		});
	});

	it("persists reply and vision routes only in the companion database", () => {
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
		expect(
			companionDatabase.connection
				.prepare(
					"SELECT text_provider_id, text_model_id, multimodal_provider_id, multimodal_model_id FROM model_route_settings WHERE companion_id = 'character'",
				)
				.get(),
		).toEqual({
			text_provider_id: "relay",
			text_model_id: "text",
			multimodal_provider_id: "relay",
			multimodal_model_id: "vision",
		});
	});

	it("clears this companion's references before deleting the system model and is idempotent", () => {
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
		publish.mockClear();

		models.disable("relay", "vision");
		expect(() => models.disable("relay", "vision")).not.toThrow();

		expect(models.defaults("character")).toEqual({
			vision: { mode: "auto" },
			onboardingComplete: false,
		});
		expect(models.get("relay", "vision")).toBeUndefined();
		expect(
			publish.mock.calls.filter(([first]) => JSON.stringify(first) === '["models","pool"]'),
		).toHaveLength(1);
	});

	it("does not pretend the cross-database disable sequence is atomic", () => {
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
		systemDatabase.connection.exec(`
			CREATE TRIGGER reject_configured_model_delete
			BEFORE DELETE ON configured_models
			BEGIN
				SELECT RAISE(ABORT, 'system model delete failed');
			END;
		`);

		expect(() => models.disable("relay", "vision")).toThrow();

		expect(models.get("relay", "vision")).toBeDefined();
		expect(
			companionDatabase.connection
				.prepare(
					"SELECT text_provider_id, text_model_id, vision_mode, multimodal_provider_id, multimodal_model_id FROM model_route_settings WHERE companion_id = 'character'",
				)
				.get(),
		).toEqual({
			text_provider_id: null,
			text_model_id: null,
			vision_mode: "auto",
			multimodal_provider_id: null,
			multimodal_model_id: null,
		});
		expect(publish.mock.calls.filter(([kind]) => kind === "model.disabled")).toHaveLength(0);
	});

	it("seeds each character once from the current system default and keeps later role edits isolated", () => {
		models.enable({ providerId: "relay", modelId: "a", label: "A", supportsImages: false });
		models.enable({ providerId: "relay", modelId: "b", label: "B", supportsImages: false });
		models.enable({ providerId: "relay", modelId: "c", label: "C", supportsImages: false });
		models.setSystemDefaults({
			reply: { providerId: "relay", modelId: "a" },
			vision: { mode: "auto" },
		});
		expect(models.seedFromSystemDefaults("character")).toBe("seeded");

		models.setSystemDefaults({
			reply: { providerId: "relay", modelId: "b" },
			vision: { mode: "auto" },
		});
		expect(models.seedFromSystemDefaults("character")).toBe("already_seeded");
		expect(models.defaults("character").reply?.modelId).toBe("a");

		const secondDatabase = new CompanionDatabase(
			join(root, "companions", "second-character", "runtime.db"),
			"second-character",
		);
		secondDatabase.initialize(COMPANION_SCHEMA_SQL);
		secondDatabase.ensureRuntimeIdentity();
		try {
			const second = new ModelRegistry(
				systemDatabase.orm,
				secondDatabase.orm,
				{ invalidate: publish } as never,
				new AppSettingsStore(systemDatabase.orm),
				(visit) => {
					visit(companionDatabase.orm);
					visit(secondDatabase.orm);
				},
			);
			expect(second.seedFromSystemDefaults("second-character")).toBe("seeded");
			expect(second.defaults("second-character").reply?.modelId).toBe("b");
			second.setDefaultReply("second-character", { providerId: "relay", modelId: "c" });
			second.completeOnboarding("second-character");
			expect(second.defaults("second-character")).toMatchObject({
				reply: { modelId: "c" },
				onboardingComplete: true,
			});
			expect(models.defaults("character").reply?.modelId).toBe("a");
			expect(models.systemDefaults().reply?.modelId).toBe("b");

			second.disable("relay", "c");
			expect(second.defaults("second-character")).toMatchObject({
				onboardingComplete: false,
			});
			expect(second.defaults("second-character").reply).toBeUndefined();
			expect(models.defaults("character").reply?.modelId).toBe("a");
		} finally {
			secondDatabase.close();
		}
	});

	it("clears a disabled system reply default and returns setup to fail-closed model selection", () => {
		models.enable({ providerId: "relay", modelId: "reply", label: "Reply", supportsImages: false });
		models.setSystemDefaults({
			reply: { providerId: "relay", modelId: "reply" },
			vision: { mode: "auto" },
		});
		models.disable("relay", "reply");

		expect(models.systemDefaults().reply).toBeUndefined();
		expect(new AppSettingsStore(systemDatabase.orm).load().firstRunStage).toBe("model");
	});
});
