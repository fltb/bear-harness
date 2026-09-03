// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { CompanionStateStore } from "../src/companion/companion-store.js";
import { registerHostTools } from "../src/companion/host-tool-register.js";
import {
	type CharacterStateDefinition,
	characterStatePrompt,
	compileCharacterStateSchema,
} from "../src/companion/state-schema.js";
import {
	COMPANION_SCHEMA_SQL,
	CompanionDatabase,
	SYSTEM_SCHEMA_SQL,
	SystemDatabase,
} from "../src/storage/database.js";
import { conversations } from "../src/storage/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-state-"));
	roots.push(root);
	const system = new SystemDatabase(join(root, "system", "settings.db"));
	const database = new CompanionDatabase(
		join(root, "companions", "jizhou", "runtime.db"),
		"jizhou",
	);
	system.initialize(SYSTEM_SCHEMA_SQL);
	database.initialize(COMPANION_SCHEMA_SQL);
	database.ensureRuntimeIdentity();
	const loader = new CharacterLoader(resolve(import.meta.dirname, "../../../config/characters"));
	const character = loader.load("jizhou");
	if (!character) throw new Error("missing default character");
	loader.seed(system.orm, character);
	system.close();
	database.orm
		.insert(conversations)
		.values({ id: "conversation", companionId: character.id })
		.run();
	const store = new CompanionStateStore(database.orm);
	return { database, character, store };
}

function failure(run: () => unknown) {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected operation to fail");
}

describe("companion state", () => {
	it("exposes a small read/update Host tool without permission protocol", () => {
		const tools = registerHostTools({} as never);
		const schema = JSON.stringify(tools.host_state?.parameters);
		expect(schema).toContain('"action"');
		expect(schema).toContain('"update"');
		expect(schema).toContain('"changes"');
		expect(schema).toContain('"path"');
		expect(schema).toContain('"value"');
		expect(schema).not.toContain("operations");
		expect(schema).not.toContain("skillId");
		expect(schema).not.toContain("evidence");
		expect(schema).not.toContain("expectedRevision");
	});

	it("returns declared media and response-specific choices as stateless Pi tool details", async () => {
		const media = {
			id: "signal",
			kind: "image" as const,
			label: "Signal",
			description: "A damaged signal.",
			use_when: "When the user opens the signal record.",
			loop: false,
			url: "data:image/png;base64,aW1hZ2U=",
		};
		const tools = registerHostTools({ character: () => ({ media: [media] }) } as never);
		const shown = await tools.host_media?.execute("media-call", { id: media.id });
		expect(shown?.details).toMatchObject({ ok: true, data: { mediaId: media.id } });
		const missing = await tools.host_media?.execute("missing-call", { id: "missing" });
		expect(missing?.details).toMatchObject({ ok: false, code: "character_media_not_found" });
		const choices = await tools.host_choices?.execute("choices-call", {
			prompt: "Continue?",
			choices: [
				{ label: "Continue", message: "Continue." },
				{ label: "Pause", message: "Pause." },
			],
		});
		expect(choices?.details).toMatchObject({
			ok: true,
			data: {
				prompt: "Continue?",
				items: [
					{ label: "Continue", message: "Continue." },
					{ label: "Pause", message: "Pause." },
				],
			},
		});
	});

	it("marks repeated explicit-memory output unchanged so the UI can suppress duplicate updates", async () => {
		let content = "";
		const explicitMemory = {
			read: vi.fn(async () => content),
			edit: vi.fn(async (_oldText: string | undefined, newText: string) => {
				content = newText;
				return content;
			}),
		};
		const tools = registerHostTools({ explicitMemory } as never);
		const first = await tools.explicit_memory?.execute("memory-1", {
			action: "edit",
			newText: "用户明确要求记住北辰。",
		});
		const repeated = await tools.explicit_memory?.execute("memory-2", {
			action: "edit",
			newText: "用户明确要求记住北辰。",
		});

		expect(first?.details).toMatchObject({ ok: true, data: { changed: true } });
		expect(repeated?.details).toMatchObject({ ok: true, data: { changed: false } });
		expect(explicitMemory.edit).toHaveBeenCalledTimes(2);
	});

	it("updates simple Character values and Display in one optional batch", async () => {
		const { database, character, store } = fixture();
		const tools = registerHostTools({
			sessionId: () => "conversation",
			character: () => character,
			store,
		} as never);
		const result = await tools.host_state?.execute("call", {
			action: "update",
			changes: [
				{ path: "/character/relationship/affinity", value: 12 },
				{ path: "/character/story/active", value: true },
				{ path: "/character/story/summary", value: "用户发现了一份未送达记录。" },
				{ path: "/display/expressionId", value: "reflective" },
			],
		});
		expect(result?.details).toMatchObject({ ok: true });
		expect(store.project(character.id, "conversation", character.state).document).toMatchObject({
			relationship: { affinity: 12 },
			story: { active: true, summary: "用户发现了一份未送达记录。" },
		});
		expect(store.snapshot(character, "conversation").display.expressionId).toBe("reflective");
		database.close();
	});

	it("keeps global values across conversations and conversation values isolated", () => {
		const { database, character, store } = fixture();
		database.orm.insert(conversations).values({ id: "second", companionId: character.id }).run();
		store.writeCompanion({
			companionId: character.id,
			conversationId: "conversation",
			definition: character.state,
			changes: [
				{ path: "/character/relationship/affinity", value: 7 },
				{ path: "/character/story/summary", value: "只属于第一条会话。" },
			],
			character,
		});
		const second = store.project(character.id, "second", character.state).document;
		expect(second).toMatchObject({
			relationship: { affinity: 7 },
			story: { summary: "尚未开始。" },
		});
		database.close();
	});

	it("uses one basic schema validation and declared Display ids", () => {
		const { database, character, store } = fixture();
		const base = {
			companionId: character.id,
			conversationId: "conversation",
			definition: character.state,
			character,
		};
		expect(
			failure(() =>
				store.writeCompanion({
					...base,
					changes: [{ path: "/character/relationship/affinity", value: "high" }],
				}),
			),
		).toMatchObject({ kind: "validation_failed", reason: "character_state_invalid" });
		expect(
			failure(() =>
				store.writeCompanion({
					...base,
					changes: [{ path: "/display/expressionId", value: "missing" }],
				}),
			),
		).toMatchObject({ kind: "validation_failed", reason: "display_expression_not_declared" });
		database.close();
	});

	it("keeps Skill loading separate from state field descriptions", async () => {
		const { database, character, store } = fixture();
		const tools = registerHostTools({
			sessionId: () => "conversation",
			character: () => character,
			store,
		} as never);
		const result = await tools.role_skill?.execute("call", {
			action: "read",
			skillId: "undelivered-report",
		});
		const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("<role_skill");
		expect(text).not.toContain("<character_state_contract>");
		expect(text).not.toContain("x-write-authority");
		database.close();
	});

	it("generates model semantics from descriptions without storage metadata", () => {
		const { database, character } = fixture();
		const prompt = characterStatePrompt(character.state);
		expect(prompt).toContain("路径：/character/story/summary");
		expect(prompt).toContain("已发生剧情摘要");
		expect(prompt).toContain("已经确定发生的事实");
		expect(prompt).not.toContain("x-scope");
		expect(prompt).not.toContain("revision");
		expect(prompt).not.toContain("write-authority");
		database.close();
	});

	it("accepts only top-level global or conversation scope", () => {
		const { database, character } = fixture();
		expect([...compileCharacterStateSchema(character.state).partitions]).toEqual([
			["relationship", "global"],
			["continuity", "global"],
			["story", "conversation"],
		]);
		const invalid = structuredClone(character.state) as CharacterStateDefinition;
		const affinity = invalid.properties?.relationship?.properties?.affinity;
		if (!affinity) throw new Error("missing affinity schema");
		affinity["x-scope"] = "conversation";
		expect(() => compileCharacterStateSchema(invalid)).toThrow(
			"may not override its partition x-scope",
		);
		database.close();
	});
});
