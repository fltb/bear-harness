// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ModelProjectionFacts, ModelRegistry } from "../src/models/registry.js";
import { AppSettingsStore } from "../src/storage/app-settings-store.js";
import {
	COMPANION_SCHEMA_SQL,
	CompanionDatabase,
	SYSTEM_SCHEMA_SQL,
	SystemDatabase,
} from "../src/storage/database.js";

const facts: ModelProjectionFacts = {
	providers: [{ providerId: "relay", providerName: "Relay", authenticated: true }],
	catalogModels: ["text", "vision", "a", "b", "c", "reply"].map((modelId) => ({
		providerId: "relay",
		modelId,
	})),
	removingProviderIds: [],
};

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

		models.enable(
			{ providerId: "relay", modelId: "text", label: "Text", supportsImages: false },
			facts,
		);
		models.setDefaultReply("character", { providerId: "relay", modelId: "text" }, facts);

		expect(models.list(facts)).toEqual([
			expect.objectContaining({ providerId: "relay", modelId: "text" }),
		]);
		expect(models.defaults("character", facts)).toMatchObject({
			reply: { providerId: "relay", modelId: "text" },
			vision: { mode: "auto" },
		});
	});

	it("persists reply and vision routes only in the companion database", () => {
		models.enable(
			{ providerId: "relay", modelId: "text", label: "Text", supportsImages: false },
			facts,
		);
		models.enable(
			{
				providerId: "relay",
				modelId: "vision",
				label: "Vision",
				supportsImages: true,
			},
			facts,
		);
		models.setDefaultReply("character", { providerId: "relay", modelId: "text" }, facts);
		models.setVisionDefault(
			"character",
			{
				mode: "manual",
				route: { providerId: "relay", modelId: "vision" },
			},
			facts,
		);

		expect(models.defaults("character", facts)).toMatchObject({
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

	it("clears this companion's references before disabling the system model and is idempotent", () => {
		models.enable(
			{
				providerId: "relay",
				modelId: "vision",
				label: "Vision",
				supportsImages: true,
			},
			facts,
		);
		models.setVisionDefault(
			"character",
			{
				mode: "manual",
				route: { providerId: "relay", modelId: "vision" },
			},
			facts,
		);
		// Switching to an image-capable reply can leave a stored manual vision reference.
		models.setDefaultReply("character", { providerId: "relay", modelId: "vision" }, facts);

		models.disable("relay", "vision");
		const disabled = models.get("relay", "vision", facts);
		expect(disabled).toMatchObject({ enabled: false, readiness: "disabled" });
		models.disable("relay", "vision");

		expect(models.defaults("character", facts)).toEqual({
			vision: { mode: "auto" },
			onboardingComplete: false,
		});
		expect(models.get("relay", "vision", facts)).toEqual(disabled);
	});

	it("does not pretend the cross-database disable sequence is atomic", () => {
		models.enable(
			{
				providerId: "relay",
				modelId: "vision",
				label: "Vision",
				supportsImages: true,
			},
			facts,
		);
		models.setVisionDefault(
			"character",
			{
				mode: "manual",
				route: { providerId: "relay", modelId: "vision" },
			},
			facts,
		);
		// Exercise cleanup of both stored routes after switching the reply model.
		models.setDefaultReply("character", { providerId: "relay", modelId: "vision" }, facts);
		systemDatabase.connection.exec(`
			CREATE TRIGGER reject_configured_model_disable
			BEFORE UPDATE OF enabled ON configured_models
			BEGIN
				SELECT RAISE(ABORT, 'system model disable failed');
			END;
		`);

		expect(() => models.disable("relay", "vision")).toThrow();

		expect(models.get("relay", "vision", facts)).toMatchObject({
			enabled: true,
			readiness: "ready",
		});
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
	});

	it("seeds each character once from the current system default and keeps later role edits isolated", () => {
		models.enable({ providerId: "relay", modelId: "a", label: "A", supportsImages: false }, facts);
		models.enable({ providerId: "relay", modelId: "b", label: "B", supportsImages: false }, facts);
		models.enable({ providerId: "relay", modelId: "c", label: "C", supportsImages: false }, facts);
		models.setSystemDefaults(
			{
				reply: { providerId: "relay", modelId: "a" },
				vision: { mode: "auto" },
			},
			facts,
		);
		expect(models.seedFromSystemDefaults("character", facts)).toBe("seeded");

		models.setSystemDefaults(
			{
				reply: { providerId: "relay", modelId: "b" },
				vision: { mode: "auto" },
			},
			facts,
		);
		expect(models.seedFromSystemDefaults("character", facts)).toBe("already_seeded");
		expect(models.defaults("character", facts).reply?.modelId).toBe("a");

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
			expect(second.seedFromSystemDefaults("second-character", facts)).toBe("seeded");
			expect(second.defaults("second-character", facts).reply?.modelId).toBe("b");
			second.setDefaultReply("second-character", { providerId: "relay", modelId: "c" }, facts);
			second.completeOnboarding("second-character", facts);
			expect(second.defaults("second-character", facts)).toMatchObject({
				reply: { modelId: "c" },
				onboardingComplete: true,
			});
			expect(models.defaults("character", facts).reply?.modelId).toBe("a");
			expect(models.systemDefaults(facts).reply?.modelId).toBe("b");

			second.disable("relay", "c");
			expect(second.defaults("second-character", facts)).toMatchObject({
				onboardingComplete: false,
			});
			expect(second.defaults("second-character", facts).reply).toBeUndefined();
			expect(models.defaults("character", facts).reply?.modelId).toBe("a");
		} finally {
			secondDatabase.close();
		}
	});

	it("clears a disabled system reply default and returns setup to fail-closed model selection", () => {
		models.enable(
			{ providerId: "relay", modelId: "reply", label: "Reply", supportsImages: false },
			facts,
		);
		models.completeSystemModelOnboarding(
			{
				reply: { providerId: "relay", modelId: "reply" },
				vision: { mode: "auto" },
			},
			facts,
		);
		expect(new AppSettingsStore(systemDatabase.orm).load().firstRunStage).toBe("embedding");
		models.disable("relay", "reply");

		expect(models.systemDefaults(facts).reply).toBeUndefined();
		expect(new AppSettingsStore(systemDatabase.orm).load().firstRunStage).toBe("model");
	});
});
