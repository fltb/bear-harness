// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import { CanonHubService } from "../src/canon/service.js";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import { MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const characterLoader = new CharacterLoader(characterRoot);

describe("ContextPackCompiler character package identity", () => {
	it("injects identity_core from the active package without a product fallback", () => {
		const db = new DatabaseSync(":memory:");
		for (const migration of MIGRATIONS) db.exec(migration.up);
		db.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)").run(
			"jizhou",
			"季舟",
			"1",
			"test",
		);
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
		).run("jizhou", "jizhou", "stored-name-is-not-used", "stored canon");
		db.prepare("INSERT INTO conversations (id, companion_id, title) VALUES (?, ?, ?)").run(
			"conversation-1",
			"jizhou",
			"test",
		);

		const character = characterLoader.load("jizhou");
		expect(character).not.toBeNull();
		if (!character) throw new Error("jizhou package is required for the official build");

		const orm = drizzle({ client: db });
		const pack = new ContextPackCompiler(orm, characterLoader).compile("conversation-1");
		expect(pack.blocks.find((block) => block.layer === "identity")?.content).toBe(
			character.identity_core,
		);
		expect(pack.blocks.find((block) => block.layer === "roleplay")?.content).toContain('"trust":0');
		expect(() =>
			new ContextPackCompiler(orm, characterLoader).compile("missing-conversation"),
		).toThrow("conversation has no companion identity");
		db.close();
	});

	it("places cited original-work evidence before confirmed AU changes", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-context-canon-"));
		const db = new DatabaseSync(":memory:");
		try {
			for (const migration of MIGRATIONS) db.exec(migration.up);
			db.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)",
			).run("jizhou", "极昼", "1", "test");
			db.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
			).run("jizhou", "jizhou", "极昼", "stored canon");
			db.prepare("INSERT INTO conversations (id, companion_id, title) VALUES (?, ?, ?)").run(
				"conversation-canon",
				"jizhou",
				"test",
			);
			db.prepare(
				"INSERT INTO branches (id, conversation_id, label, adopted) VALUES (?, ?, ?, ?)",
			).run("branch-canon", "conversation-canon", "main", 1);
			db.prepare(
				"INSERT INTO story_changes (id, companion_id, branch_id, scope, text, normalized_text, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				"change-canon",
				"jizhou",
				"branch-canon",
				"global",
				"旧塔现在是用户的住处。",
				"旧塔现在是用户的住处",
				"user_confirmed",
				"active",
			);
			const orm = drizzle({ client: db });
			const canon = new CanonHubService(
				orm,
				new ArtifactStore(orm, join(root, "cas")),
				new EventBus(orm),
			);
			canon.addSource("jizhou", "第一卷", "# 旧塔\n\n原作中，旧塔在风暴后被封存。");
			const pack = new ContextPackCompiler(orm, characterLoader, canon).compile(
				"conversation-canon",
				{ canonQuery: "旧塔" },
			);
			const rendered = new ContextPackCompiler(orm, characterLoader, canon).render(pack);
			const evidenceAt = rendered.indexOf("【第一卷 · 旧塔】");
			const overlayAt = rendered.indexOf("旧塔现在是用户的住处");
			expect(evidenceAt).toBeGreaterThan(-1);
			expect(overlayAt).toBeGreaterThan(evidenceAt);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
