// @vitest-environment node

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Database, type Migration } from "../src/storage/database.js";
import { RuntimeLayout } from "../src/storage/layout.js";
import { prepareRuntimeLayout } from "../src/storage/layout-migration.js";
import { BASELINE_V1_SQL } from "./fixtures/legacy-baseline-v1.js";

const LEGACY_LAYOUT_MIGRATIONS: Migration[] = [
	{ id: 1, description: "pre-split layout fixture", up: BASELINE_V1_SQL },
];

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-layout-migration-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function createLegacyFixture(dataRoot: string, sessionId = "session-a"): void {
	const database = new Database(join(dataRoot, "storage"));
	database.migrate(LEGACY_LAYOUT_MIGRATIONS);
	try {
		database.connection.exec("BEGIN");
		database.connection
			.prepare("INSERT INTO companion_packages(id,name,version,hash,origin) VALUES (?,?,?,?,?)")
			.run("role-a", "Role A", "1", "package-hash", "official");
		database.connection
			.prepare("INSERT INTO companion_identity(id,package_id,name,nickname) VALUES (?,?,?,?)")
			.run("role-a", "role-a", "Role A", "Friend");
		database.connection
			.prepare("INSERT INTO active_character(singleton,character_id) VALUES (1,?)")
			.run("role-a");
		database.connection
			.prepare(
				"INSERT INTO configured_models(provider_id,model_id,label,supports_images) VALUES (?,?,?,?)",
			)
			.run("provider-a", "model-a", "Model A", 1);
		database.connection
			.prepare(
				"INSERT INTO model_route_settings(companion_id,text_provider_id,text_model_id,vision_mode,multimodal_provider_id,multimodal_model_id) VALUES (?,?,?,?,?,?)",
			)
			.run("role-a", "provider-a", "model-a", "manual", "provider-a", "model-a");
		database.connection
			.prepare(
				"UPDATE app_settings SET first_run_stage = 'role', memory_vector_service = ? WHERE id = 1",
			)
			.run(
				JSON.stringify({
					enabled: true,
					provider: "remote",
					baseUrl: "https://embedding.example/v1",
					apiKey: "legacy-embedding-secret",
					model: "embedding-model",
					dimensions: 768,
				}),
			);
		database.connection
			.prepare("INSERT INTO conversations(id,companion_id) VALUES (?,?)")
			.run(sessionId, "role-a");
		database.connection
			.prepare("INSERT INTO onboarding_state(companion_id,state,state_json) VALUES (?,?,?)")
			.run(
				"role-a",
				"complete",
				JSON.stringify({
					schema_version: 1,
					flow_version: 1,
					answers: {},
					decisions: {
						relationship_memory_enabled: true,
						conversation_history_read_enabled: true,
					},
				}),
			);
		database.connection
			.prepare(
				"INSERT INTO companion_state_documents(id,companion_id,conversation_id,scope,domain,state_json,revision,schema_hash) VALUES (?,?,?,?,?,?,?,?)",
			)
			.run("state-a", "role-a", sessionId, "conversation", "character", "{}", 1, "schema");
		database.connection.exec("COMMIT");
	} catch (error) {
		database.connection.exec("ROLLBACK");
		throw error;
	} finally {
		database.close();
	}

	mkdirSync(join(dataRoot, "sessions"), { recursive: true });
	writeFileSync(
		join(dataRoot, "sessions", `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/legacy" })}\n`,
	);
	mkdirSync(join(dataRoot, "memory", "role-a"), { recursive: true });
	writeFileSync(join(dataRoot, "memory", "role-a", "persona.md"), "persona\n");
	mkdirSync(join(dataRoot, "explicit-memory", "default-user", "role-a"), { recursive: true });
	writeFileSync(
		join(dataRoot, "explicit-memory", "default-user", "role-a", "MEMORY.md"),
		"remember me\n",
	);
}

describe("flat runtime layout migration", () => {
	it("creates the split layout for a fresh installation", () => {
		const dataRoot = join(root(), "data");
		const result = prepareRuntimeLayout(dataRoot, new Date("2026-08-31T00:00:00.000Z"));
		const layout = new RuntimeLayout(dataRoot);
		expect(result.action).toBe("fresh");
		expect(existsSync(layout.marker)).toBe(true);
		expect(existsSync(layout.systemEmbeddingModels)).toBe(true);
		expect(existsSync(layout.companionsRoot)).toBe(true);
	});

	it("atomically splits Catalog, Session and memory into the owning character", () => {
		const parent = root();
		const dataRoot = join(parent, "data");
		mkdirSync(dataRoot);
		createLegacyFixture(dataRoot);

		const result = prepareRuntimeLayout(dataRoot, new Date("2026-08-31T01:02:03.000Z"));
		expect(result.action).toBe("migrated");
		if (result.action !== "migrated") throw new Error("expected migration");
		const layout = new RuntimeLayout(dataRoot);
		const role = layout.companion("role-a");
		expect(existsSync(result.backupPath)).toBe(true);
		expect(existsSync(layout.systemDatabase)).toBe(true);
		expect(existsSync(role.database)).toBe(true);
		expect(existsSync(join(role.sessions, "2026-01-01T00-00-00-000Z_session-a.jsonl"))).toBe(true);
		expect(readFileSync(role.explicitMemory, "utf8")).toBe("remember me\n");
		expect(readFileSync(join(role.tdaiMemory, "persona.md"), "utf8")).toBe("persona\n");

		const system = new DatabaseSync(layout.systemDatabase, { readOnly: true });
		const runtime = new DatabaseSync(role.database, { readOnly: true });
		try {
			expect(system.prepare("SELECT id FROM companion_identity").all()).toEqual([{ id: "role-a" }]);
			const embeddingSettings = system
				.prepare(
					"SELECT first_run_stage, memory_vector_service, system_model_defaults FROM app_settings WHERE id = 1",
				)
				.get() as {
				first_run_stage: string;
				memory_vector_service: string;
				system_model_defaults: string;
			};
			expect(embeddingSettings.first_run_stage).toBe("role");
			expect(JSON.parse(embeddingSettings.memory_vector_service)).toMatchObject({
				provider: "remote",
				apiKey: "legacy-embedding-secret",
			});
			expect(JSON.parse(embeddingSettings.system_model_defaults)).toEqual({
				reply: { providerId: "provider-a", modelId: "model-a" },
				vision: {
					mode: "manual",
					route: { providerId: "provider-a", modelId: "model-a" },
				},
			});
			expect(
				system.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get(),
			).toBeUndefined();
			expect(runtime.prepare("SELECT companion_id, nickname FROM runtime_identity").get()).toEqual({
				companion_id: "role-a",
				nickname: "Friend",
			});
			expect(
				runtime
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
					.get(),
			).toEqual({ name: "events" });
			expect(runtime.prepare("SELECT id FROM conversations").all()).toEqual([{ id: "session-a" }]);
			expect(
				JSON.parse(
					String(
						runtime
							.prepare("SELECT state_json FROM onboarding_state WHERE companion_id = ?")
							.get("role-a")?.state_json,
					),
				),
			).toEqual({
				answers: {},
				decisions: { relationship_memory_enabled: true },
			});
			expect(
				runtime
					.prepare(
						"SELECT text_provider_id, text_model_id, onboarding_complete FROM model_route_settings",
					)
					.get(),
			).toEqual({
				text_provider_id: "provider-a",
				text_model_id: "model-a",
				onboarding_complete: 1,
			});
			expect(
				runtime
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_accounts'")
					.get(),
			).toBeUndefined();
		} finally {
			system.close();
			runtime.close();
		}
		expect(prepareRuntimeLayout(dataRoot).action).toBe("current");
	});

	it("reopens the system model gate when a legacy install has no valid active default", () => {
		const dataRoot = join(root(), "data");
		mkdirSync(dataRoot);
		createLegacyFixture(dataRoot);
		const legacy = new Database(join(dataRoot, "storage"));
		try {
			legacy.connection.exec("DELETE FROM model_route_settings; DELETE FROM configured_models");
		} finally {
			legacy.close();
		}

		prepareRuntimeLayout(dataRoot);
		const system = new DatabaseSync(new RuntimeLayout(dataRoot).systemDatabase, { readOnly: true });
		try {
			const row = system
				.prepare("SELECT first_run_stage, system_model_defaults FROM app_settings WHERE id = 1")
				.get() as { first_run_stage: string; system_model_defaults: string };
			expect(row.first_run_stage).toBe("model");
			expect(JSON.parse(row.system_model_defaults)).toEqual({ vision: { mode: "auto" } });
		} finally {
			system.close();
		}
	});

	it("completes an interrupted root swap only after verifying the staged tree", () => {
		const dataRoot = join(root(), "data");
		mkdirSync(dataRoot);
		createLegacyFixture(dataRoot);
		const first = prepareRuntimeLayout(dataRoot, new Date("2026-08-31T01:02:03.000Z"));
		if (first.action !== "migrated") throw new Error("expected migration");
		const layout = new RuntimeLayout(dataRoot);
		renameSync(dataRoot, layout.stagingRoot);

		const recovered = prepareRuntimeLayout(dataRoot);
		expect(recovered).toEqual({
			action: "recovered",
			root: dataRoot,
			backupPath: first.backupPath,
		});
		expect(existsSync(layout.systemDatabase)).toBe(true);
		expect(existsSync(layout.companion("role-a").database)).toBe(true);
	});

	it("rolls back a corrupt staged activation to its verified legacy source and retries", () => {
		const dataRoot = join(root(), "data");
		mkdirSync(dataRoot);
		createLegacyFixture(dataRoot);
		const first = prepareRuntimeLayout(dataRoot, new Date("2026-08-31T01:02:03.000Z"));
		if (first.action !== "migrated") throw new Error("expected migration");
		const layout = new RuntimeLayout(dataRoot);
		renameSync(dataRoot, layout.stagingRoot);
		writeFileSync(join(layout.stagingRoot, "unexpected-corruption"), "bad");

		const retried = prepareRuntimeLayout(dataRoot, new Date("2026-09-01T01:02:03.000Z"));
		expect(retried.action).toBe("migrated");
		expect(existsSync(layout.companion("role-a").database)).toBe(true);
		expect(
			existsSync(
				join(layout.companion("role-a").sessions, "2026-01-01T00-00-00-000Z_session-a.jsonl"),
			),
		).toBe(true);
	});

	it("fails closed without altering the source when a Session has no Catalog owner", () => {
		const dataRoot = join(root(), "data");
		mkdirSync(dataRoot);
		createLegacyFixture(dataRoot);
		writeFileSync(
			join(dataRoot, "sessions", "unowned.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "unowned" })}\n`,
		);

		expect(() => prepareRuntimeLayout(dataRoot)).toThrow(/has no Catalog owner/);
		expect(existsSync(join(dataRoot, "storage", "canon.db"))).toBe(true);
		expect(existsSync(join(dataRoot, "sessions", "unowned.jsonl"))).toBe(true);
		expect(existsSync(new RuntimeLayout(dataRoot).marker)).toBe(false);
	});

	it("copies one CAS blob into each owning character instead of hard-linking it", () => {
		const dataRoot = join(root(), "data");
		mkdirSync(dataRoot);
		createLegacyFixture(dataRoot);
		const bytes = Buffer.from("artifact bytes");
		const sha = createHash("sha256").update(bytes).digest("hex");
		const database = new Database(join(dataRoot, "storage"));
		try {
			database.connection
				.prepare(
					"INSERT INTO artifacts(id,logical_name,mime,bytes,sha256,status) VALUES (?,?,?,?,?,?)",
				)
				.run("artifact-a", "note.txt", "text/plain", bytes.length, sha, "verified");
			database.connection
				.prepare(
					"INSERT INTO canon_sources(id,companion_id,logical_name,mime,sha256,artifact_id) VALUES (?,?,?,?,?,?)",
				)
				.run("source-a", "role-a", "note", "text/plain", sha, "artifact-a");
		} finally {
			database.close();
		}
		mkdirSync(join(dataRoot, "artifacts"));
		writeFileSync(join(dataRoot, "artifacts", sha), bytes);

		prepareRuntimeLayout(dataRoot);
		const path = join(new RuntimeLayout(dataRoot).companion("role-a").artifacts, sha);
		expect(readFileSync(path)).toEqual(bytes);
		expect(basename(path)).toBe(sha);
	});
});
