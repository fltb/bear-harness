// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import type { ContextPack } from "../src/companion/context-pack.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import type { MemoryHit } from "../src/memory/backend.js";
import { MIGRATIONS } from "../src/storage/database.js";
import { conversationDirectives, conversations } from "../src/storage/schema.js";

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

describe("ContextPackCompiler character prompt layers", () => {
	it("injects description, personality, and scenario in deterministic order", () => {
		const db = new DatabaseSync(":memory:");
		db.function("bear_sync_changed", () => null);
		for (const migration of MIGRATIONS) db.exec(migration.up);
		db.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)").run(
			"jizhou",
			"季舟",
			"1",
			"test",
		);
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon, nickname) VALUES (?, ?, ?, ?, ?)",
		).run("jizhou", "jizhou", "stored-name-is-not-used", "stored canon", "小雪");
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

		const compiler = new ContextPackCompiler(orm, characterLoader);
		const pack = compiler.compile("conversation-1");
		expect(compiler.accessibleCanonModuleIds("conversation-1")).not.toContain(
			"undelivered_report_entry",
		);
		expect(
			compiler.accessibleCanonModuleIds("conversation-1", {
				"story.undelivered_report.phase": "invited",
			}),
		).toEqual(
			expect.arrayContaining([
				"station_identity",
				"station_background",
				"undelivered_report_entry",
				"undelivered_report_signal",
			]),
		);
		expect(
			compiler.accessibleCanonModuleIds("conversation-1", {
				"story.undelivered_report.phase": "signal_examined",
			}),
		).toEqual(expect.arrayContaining(["undelivered_report_relay", "undelivered_report_snowfield"]));
		expect(
			compiler.accessibleCanonModuleIds("conversation-1", {
				"story.undelivered_report.phase": "signal_examined",
			}),
		).not.toContain("undelivered_report_last_shift");
		expect(pack.blocks.slice(0, 4)).toEqual([
			expect.objectContaining({ layer: "state" }),
			{ layer: "description", content: character.prompt.description },
			{ layer: "personality", content: character.prompt.personality },
			{ layer: "scenario", content: character.prompt.scenario },
		]);
		expect(pack.blocks.find((block) => block.layer === "persona")?.content).toContain(
			"称呼用户为：小雪",
		);
		expect(pack.blocks.find((block) => block.layer === "state")?.content).toContain(
			'"continuity.stage": 0',
		);
		const stateContext = pack.blocks.find((block) => block.layer === "state")?.content ?? "";
		expect(stateContext).toContain('"narrativeAnchor"');
		expect(stateContext).toContain('"activeStory": null');
		expect(stateContext).toContain('"phase": "dormant"');
		const directiveContext = pack.blocks.find((block) => block.layer === "scene")?.content ?? "";
		orm
			.insert(conversations)
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
		expect(pack.manifest.slice(0, 4)).toEqual([
			expect.objectContaining({
				order: 0,
				layer: "state",
				source: "host_real_context",
			}),
			expect.objectContaining({
				order: 1,
				layer: "description",
				source: "character.prompt.description",
			}),
			expect.objectContaining({
				order: 2,
				layer: "personality",
				source: "character.prompt.personality",
			}),
			expect.objectContaining({
				order: 3,
				layer: "scenario",
				source: "character.prompt.scenario",
			}),
		]);
		expect(() =>
			new ContextPackCompiler(orm, characterLoader).compile("missing-conversation"),
		).toThrow("conversation has no character package");
		db.close();
	});

	it("composes externally retrieved memory before rendering the context blocks", async () => {
		const db = new DatabaseSync(":memory:");
		db.function("bear_sync_changed", () => null);
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
});
