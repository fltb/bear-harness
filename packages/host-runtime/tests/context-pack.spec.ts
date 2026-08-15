// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const characterLoader = new CharacterLoader(characterRoot);

describe("ContextPackCompiler character package identity", () => {
	it("injects identity_core from the active package without a product fallback", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE companion_identity (id TEXT, package_id TEXT, name TEXT, self_canon TEXT);
			CREATE TABLE conversations (id TEXT, companion_id TEXT);
			CREATE TABLE self_canon_versions (companion_id TEXT, canon TEXT, version INTEGER);
			CREATE TABLE scene_state (conversation_id TEXT, scene TEXT, state_json TEXT, updated_at TEXT);
			CREATE TABLE relationship_memory_entries (
				companion_id TEXT, text TEXT, status TEXT, pinned_at TEXT, updated_at TEXT
			);
		`);
		db.prepare("INSERT INTO companion_identity VALUES (?, ?, ?, ?)").run(
			"jizhou",
			"jizhou",
			"stored-name-is-not-used",
			"stored canon",
		);
		db.prepare("INSERT INTO conversations VALUES (?, ?)").run("conversation-1", "jizhou");

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
