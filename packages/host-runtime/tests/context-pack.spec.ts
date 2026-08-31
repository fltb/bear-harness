// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import { COMPANION_MIGRATIONS } from "../src/storage/database.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const characters = new CharacterLoader(characterRoot);

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.function("bear_sync_changed", () => null);
	for (const migration of COMPANION_MIGRATIONS) db.exec(migration.up);
	db.prepare("INSERT INTO runtime_identity (id, companion_id, nickname) VALUES (1, ?, ?)").run(
		"jizhou",
		"小雪",
	);
	db.prepare("INSERT INTO conversations (id, companion_id) VALUES (?, ?)").run(
		"conversation",
		"jizhou",
	);
	return db;
}

describe("turn context", () => {
	it("contains only current Character and Display state", async () => {
		const db = fixture();
		const compiler = new ContextPackCompiler(drizzle({ client: db }), characters);
		const pack = await compiler.compileForTurn("conversation");
		expect(pack.blocks).toHaveLength(1);
		expect(pack.blocks[0]?.layer).toBe("state");
		const rendered = compiler.render(pack);
		expect(rendered).toContain('"affinity": 0');
		expect(rendered).toContain('"summary": "尚未开始。"');
		expect(rendered).toContain('"display"');
		expect(rendered).not.toContain("explicit_memory");
		expect(rendered).not.toContain("personality");
		expect(rendered).not.toContain("scenario");
		db.close();
	});

	it("keeps the user address in session context rather than every-turn context", async () => {
		const db = fixture();
		const compiler = new ContextPackCompiler(drizzle({ client: db }), characters);
		expect(compiler.sessionContext("conversation")).toContain("称呼用户为：小雪");
		expect(compiler.render(await compiler.compileForTurn("conversation"))).not.toContain("小雪");
		db.close();
	});

	it("does not silently truncate a complete state document", async () => {
		const db = fixture();
		const compiler = new ContextPackCompiler(drizzle({ client: db }), characters);
		const rendered = compiler.render(await compiler.compileForTurn("conversation"));
		expect(rendered.endsWith("\n</host_context>")).toBe(true);
		db.close();
	});
});
