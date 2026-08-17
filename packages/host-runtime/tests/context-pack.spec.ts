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
import type { ContextPack } from "../src/companion/context-pack.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import type { MemoryHit } from "../src/memory/backend.js";
import { MIGRATIONS } from "../src/storage/database.js";
import { conversationDirectives, conversations } from "../src/storage/schema.js";
import { EventBus } from "../src/storage/event-bus.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
/**
 * Test seam for the async context path: retrieval is completed outside the
 * compiler, then its ordered results are composed as a block before render.
 * The production compiler remains responsible for its normal synchronous path.
 */
async function composeWithExternalMemory(
	pack: ContextPack,
	retrieve: () => Promise<readonly MemoryHit[]>,
): Promise<ContextPack> {
	const hits = await retrieve();
	if (hits.length === 0) return pack;

	const content = `[共同经历（外部检索结果）]\n${hits.map((hit) => hit.record.text).join("\n")}`;
	return {
		...pack,
		blocks: [...pack.blocks, { layer: "relationship", content }],
		manifest: [
			...pack.manifest,
			{
				order: pack.blocks.length,
				layer: "relationship",
				source: "external_memory_recall",
				characters: content.length,
			},
		],
		charge: {
			...pack.charge,
			memoryEntries: pack.charge.memoryEntries + hits.length,
		},
	};
}

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
		orm
			.insert(conversationDirectives)
			.values([
				{
					id: "session-directive",
					conversationId: "conversation-1",
					directive: "保持简洁",
					scope: "session",
				},
				{
					id: "once-directive",
					conversationId: "conversation-1",
					directive: "只影响当前修正",
					scope: "once",
				},
				{
					id: "always-directive",
					conversationId: "conversation-1",
					directive: "始终保持简洁",
					scope: "always",
				},
			])
			.run();

		const pack = new ContextPackCompiler(orm, characterLoader).compile("conversation-1");
		expect(pack.blocks.find((block) => block.layer === "identity")?.content).toBe(
			character.identity_core,
		);
		expect(pack.blocks.find((block) => block.layer === "roleplay")?.content).toContain('"trust":0');
		const directiveContext = pack.blocks.find((block) => block.layer === "scene")?.content ?? "";
		orm.insert(conversations)
			.values({ id: "conversation-2", companionId: "jizhou", title: "second" })
			.run();
		expect(directiveContext).toContain("保持简洁");
		expect(directiveContext).not.toContain("只影响当前修正");
		expect(directiveContext).toContain("始终保持简洁");
		const secondDirectiveContext =
			new ContextPackCompiler(orm, characterLoader)
				.compile("conversation-2")
				.blocks.find((block) => block.layer === "scene")?.content ?? "";
		expect(secondDirectiveContext).toContain("始终保持简洁");
		expect(secondDirectiveContext).not.toContain("- 保持简洁");
		expect(pack.manifest).toEqual([
			expect.objectContaining({
				order: 0,
				layer: "identity",
				source: "character.identity_core",
			}),
			expect.objectContaining({
				order: 1,
				layer: "canon",
				source: "self_canon_or_canon_hub",
			}),
			expect.objectContaining({
				order: 2,
				layer: "scene",
				source: "scene_state_or_conversation_directives",
			}),
			expect.objectContaining({
				order: 3,
				layer: "roleplay",
				source: "roleplay_ledger",
			}),
		]);
		expect(() =>
			new ContextPackCompiler(orm, characterLoader).compile("missing-conversation"),
		).toThrow("conversation has no companion identity");
		db.close();
	});

	it("composes externally retrieved memory before rendering the context blocks", async () => {
		const db = new DatabaseSync(":memory:");
		try {
			for (const migration of MIGRATIONS) db.exec(migration.up);
			db.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)",
			).run("jizhou", "季舟", "1", "test");
			db.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
			).run("jizhou", "jizhou", "季舟", "角色自我设定");
			db.prepare("INSERT INTO conversations (id, companion_id, title) VALUES (?, ?, ?)").run(
				"conversation-external-memory",
				"jizhou",
				"外部记忆",
			);

			const compiler = new ContextPackCompiler(drizzle({ client: db }), characterLoader);
			const asyncCompile = async () =>
				compiler.compile("conversation-external-memory", {
					includeRelationshipMemory: false,
				});
			const basePack = await asyncCompile();
			const hits: readonly MemoryHit[] = [
				{
					record: {
						id: "memory-1",
						scope: {
							installationId: "installation-test",
							userId: "user-test",
							companionId: "jizhou",
						},
						text: "用户喜欢在清晨散步",
						provenance: { kind: "explicit", piSessionEntryIds: ["entry-1"] },
						importance: 1,
						status: "active",
						metadata: {},
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
					score: 0.98,
					rank: 0,
				},
				{
					record: {
						id: "memory-2",
						scope: {
							installationId: "installation-test",
							userId: "user-test",
							companionId: "jizhou",
						},
						text: "用户偏好简洁的回答",
						provenance: { kind: "explicit", piSessionEntryIds: ["entry-2"] },
						importance: 0.9,
						status: "active",
						metadata: {},
						createdAt: "2026-01-02T00:00:00.000Z",
						updatedAt: "2026-01-02T00:00:00.000Z",
					},
					score: 0.87,
					rank: 1,
				},
			];
			let retrievalCalls = 0;
			const composed = await composeWithExternalMemory(basePack, async () => {
				retrievalCalls += 1;
				return hits;
			});
			const rendered = compiler.render(composed);

			expect(retrievalCalls).toBe(1);
			expect(composed.charge.memoryEntries).toBe(2);
			expect(composed.blocks.at(-1)).toEqual({
				layer: "relationship",
				content: "[共同经历（外部检索结果）]\n用户喜欢在清晨散步\n用户偏好简洁的回答",
			});
			expect(composed.manifest.at(-1)).toEqual({
				order: composed.blocks.length - 1,
				layer: "relationship",
				source: "external_memory_recall",
				characters: "[共同经历（外部检索结果）]\n用户喜欢在清晨散步\n用户偏好简洁的回答".length,
			});
			expect(rendered).toContain(
				"【relationship】\n[共同经历（外部检索结果）]\n用户喜欢在清晨散步\n用户偏好简洁的回答",
			);
		} finally {
			db.close();
		}
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
