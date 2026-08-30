// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { CompanionStateStore } from "../src/companion/companion-store.js";
import { registerHostTools } from "../src/companion/host-tool-register.js";
import {
	type CharacterStateDefinition,
	compileCharacterStateSchema,
} from "../src/companion/state-schema.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { conversations } from "../src/storage/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-resources-projection-"));
	roots.push(root);
	const database = new Database(root);
	database.migrate(MIGRATIONS);
	const loader = new CharacterLoader(resolve(import.meta.dirname, "../../../config/characters"));
	const character = loader.load("jizhou");
	if (!character) throw new Error("missing default character");
	loader.seed(database.orm, new EventBus(database.orm), character);
	database.orm
		.insert(conversations)
		.values({ id: "conversation", companionId: character.id })
		.run();
	const companionStore = new CompanionStateStore(database.orm);
	return {
		database,
		character,
		companionStore,
	};
}

describe("companion state projection", () => {
	it("reads eligible Character Skill instructions without creating per-turn state", async () => {
		const { database, character, companionStore } = fixture();
		const tools = registerHostTools({
			sessionId: () => "conversation",
			character: () => character,
			store: companionStore,
		});
		const first = await tools.role_skill?.execute("call-1", {
			action: "read",
			skillId: "undelivered-report",
		});
		const second = await tools.role_skill?.execute("call-2", {
			action: "read",
			skillId: "undelivered-report",
		});
		expect(first?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('<resource id="entry">'),
		});
		const firstText = first?.content[0]?.type === "text" ? first.content[0].text : "";
		expect(firstText).toContain("## Display 映射");
		expect(firstText).not.toContain("scene-relay-room.webp");
		expect(second?.content).toEqual(first?.content);
		expect(companionStore.project(character.id, "conversation", character.state).revisions).toEqual(
			{
				global: 0,
				conversation: 0,
			},
		);
		database.close();
	});

	it("exposes action-specific role-skill and JSON Patch state schemas", () => {
		const tools = registerHostTools({} as never);
		expect(JSON.stringify(tools.role_skill?.parameters)).toContain('"skillId"');
		const stateSchema = JSON.stringify(tools.host_state?.parameters);
		expect(stateSchema).toContain('"RFC 6902 operations');
		expect(stateSchema).toContain('"replace"');
		expect(stateSchema).toContain("/display");
		expect(stateSchema).not.toContain('"display":{"type":"object"');
	});

	it("exposes natural-language choices without an event transition path", () => {
		const { database, character, companionStore } = fixture();
		expect(character.roleplay.choice_sets.flatMap((set) => set.choices)).toSatisfy(
			(choices: Array<Record<string, unknown>>) =>
				choices.every((choice) => typeof choice.message === "string" && !("event" in choice)),
		);
		expect(
			companionStore.project(character.id, "conversation", character.state).document,
		).toMatchObject({
			continuity: { stage: 0, response: "unopened" },
		});
		database.close();
	});

	it("reads presentation only from the unified conversation display snapshot", () => {
		const { database, character, companionStore } = fixture();
		companionStore.writeCompanion({
			companionId: character.id,
			conversationId: "conversation",
			definition: character.state,
			operations: [{ op: "replace", path: "/display/surfaces/inline", value: "continuity_light" }],
			authority: "model",
			evidence: true,
			character,
		});
		expect(companionStore.snapshot(character, "conversation").display.surfaces.inline).toBe(
			"continuity_light",
		);
		database.close();
	});

	it("commits Character progress and its Display projection in one transaction", async () => {
		const { database, character, companionStore } = fixture();
		companionStore.writeCompanion({
			companionId: character.id,
			conversationId: "conversation",
			definition: character.state,
			operations: [
				{
					op: "replace",
					path: "/character/story/undelivered_report/phase",
					value: "invited",
				},
				{
					op: "replace",
					path: "/character/story/undelivered_report/status",
					value: "active",
				},
			],
			authority: "skill:undelivered-report",
			evidence: true,
			character,
		});
		const tools = registerHostTools({
			sessionId: () => "conversation",
			character: () => character,
			store: companionStore,
		});
		const result = await tools.host_state?.execute("call", {
			action: "update",
			skillId: "undelivered-report",
			evidence: { user: "inspect" },
			operations: [
				{
					op: "replace",
					path: "/character/story/undelivered_report/phase",
					value: "signal_examined",
				},
				{
					op: "replace",
					path: "/character/story/undelivered_report/position",
					value: "evidence",
				},
				{
					op: "replace",
					path: "/display/surfaces/inline",
					value: "damaged_signal",
				},
			],
		});
		expect(result?.details).toMatchObject({ ok: true });
		expect(
			companionStore.project(character.id, "conversation", character.state).document,
		).toMatchObject({
			story: { undelivered_report: { phase: "signal_examined" } },
		});
		expect(companionStore.snapshot(character, "conversation").display.surfaces.inline).toBe(
			"damaged_signal",
		);
		database.close();
	});

	it("exposes only semantic Character and Display state without storage metadata", async () => {
		const { database, character, companionStore } = fixture();
		const tools = registerHostTools({
			sessionId: () => "conversation",
			character: () => character,
			store: companionStore,
		});
		const result = await tools.host_state?.execute("read", { action: "read" });
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain('"character"');
		expect(text).toContain('"sceneId":"study"');
		expect(text).not.toContain('"catalog"');
		expect(text).not.toContain("schemaHash");
		expect(text).not.toContain("revisions");
		expect(text).not.toContain("scene-relay-room.webp");
		database.close();
	});

	it("uses disjoint top-level partitions and carries only global state into a new conversation", () => {
		const { database, character, companionStore } = fixture();
		database.orm
			.insert(conversations)
			.values({ id: "second-conversation", companionId: character.id })
			.run();
		expect([...compileCharacterStateSchema(character.state).partitions]).toEqual([
			["relationship", "global"],
			["continuity", "global"],
			["story", "conversation"],
			["narrative", "conversation"],
		]);
		companionStore.writeCompanion({
			companionId: character.id,
			conversationId: "conversation",
			definition: character.state,
			operations: [{ op: "replace", path: "/character/relationship/affinity", value: 1 }],
			authority: "model",
			evidence: true,
			character,
		});
		companionStore.writeCompanion({
			companionId: character.id,
			conversationId: "conversation",
			definition: character.state,
			operations: [
				{
					op: "replace",
					path: "/character/story/undelivered_report/phase",
					value: "invited",
				},
			],
			authority: "skill:undelivered-report",
			evidence: true,
			character,
		});
		const second = companionStore.project(
			character.id,
			"second-conversation",
			character.state,
		).document;
		expect(second).toMatchObject({
			relationship: { affinity: 1 },
			story: { undelivered_report: { phase: "dormant" } },
		});
		database.close();
	});

	it("rejects nested scope declarations instead of splitting arbitrary subtrees", () => {
		const { database, character } = fixture();
		const invalid = structuredClone(character.state) as CharacterStateDefinition;
		const relationship = invalid.properties?.relationship;
		const affinity = relationship?.properties?.affinity;
		if (!affinity) throw new Error("missing affinity schema");
		affinity["x-scope"] = "conversation";
		expect(() => compileCharacterStateSchema(invalid)).toThrow(
			"may not override its partition x-scope",
		);
		database.close();
	});
});
