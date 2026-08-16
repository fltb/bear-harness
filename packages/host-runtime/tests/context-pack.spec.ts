// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import { MIGRATIONS } from "../src/storage/database.js";

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

		const pack = new ContextPackCompiler(db, characterLoader).compile("conversation-1");
		expect(pack.blocks.find((block) => block.layer === "identity")?.content).toBe(
			character.identity_core,
		);
		expect(() =>
			new ContextPackCompiler(db, characterLoader).compile("missing-conversation"),
		).toThrow("conversation has no companion identity");
		db.close();
	});
});
