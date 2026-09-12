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
	compileCharacterStateSchema,
} from "../src/companion/state-schema.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../src/storage/database.js";
import { conversations } from "../src/storage/schema.js";

const roots: string[] = [];
const databases: CompanionDatabase[] = [];
const loader = new CharacterLoader(resolve(import.meta.dirname, "./fixtures/characters"));
const character = loader.load("jizhou");
if (!character) throw new Error("missing default character");
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-state-"));
	roots.push(root);
	const database = new CompanionDatabase(
		join(root, "companions", "jizhou", "runtime.db"),
		"jizhou",
	);
	databases.push(database);
	database.initialize(COMPANION_SCHEMA_SQL);
	database.ensureRuntimeIdentity();
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

	it("keeps unchanged explicit-memory content visible without claiming another change", async () => {
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
		expect(repeated?.content).toEqual([{ type: "text", text: content }]);
		expect(explicitMemory.edit).toHaveBeenCalledTimes(2);
	});

	it("reads explicit memory once and reports the same authoritative content", async () => {
		const explicitMemory = {
			read: vi
				.fn()
				.mockResolvedValueOnce("Saved preference")
				.mockRejectedValue(new Error("Unexpected second read")),
			edit: vi.fn(),
		};
		const tools = registerHostTools({ explicitMemory } as never);
		const result = await tools.explicit_memory?.execute("memory-read", { action: "read" });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Saved preference" }],
			details: { ok: true, data: { content: "Saved preference", changed: false } },
		});
		expect(explicitMemory.edit).not.toHaveBeenCalled();
	});

	it("returns initial memory read failures and never attempts a blind edit", async () => {
		const explicitMemory = {
			read: vi.fn().mockRejectedValue({
				code: "memory_unavailable",
				message: "Memory storage is unavailable.",
			}),
			edit: vi.fn(),
		};
		const tools = registerHostTools({ explicitMemory } as never);
		const result = await tools.explicit_memory?.execute("memory-edit", {
			action: "edit",
			newText: "Remember this",
		});
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Memory storage is unavailable." }],
			details: { ok: false, code: "memory_unavailable", message: "Memory storage is unavailable." },
		});
		expect(explicitMemory.edit).not.toHaveBeenCalled();
	});

	it("reports thrown tool Errors as Host failures with their readable message", async () => {
		const tools = registerHostTools({
			character: () => {
				throw new Error("Character storage could not be read.");
			},
		} as never);
		const result = await tools.host_media?.execute("media-error", { id: "signal" });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Character storage could not be read." }],
			details: {
				ok: false,
				code: "host_media_failed",
				message: "Character storage could not be read.",
			},
		});
	});

	it("updates simple Character values and Display in one optional batch", async () => {
		const { character, store } = fixture();
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
				{ path: "/display/expressionId", value: "reflective" },
			],
			character,
		});
		expect(store.project(character.id, "conversation", character.state).document).toMatchObject({
			relationship: { affinity: 7 },
			story: { summary: "只属于第一条会话。" },
		});
		expect(store.snapshot(character, "conversation").display.expressionId).toBe("reflective");
		const second = store.project(character.id, "second", character.state).document;
		expect(second).toMatchObject({
			relationship: { affinity: 7 },
			story: expect.not.objectContaining({ summary: "只属于第一条会话。" }),
		});
		expect(store.snapshot(character, "second").display.expressionId).toBe(
			character.visual.default_expression,
		);
	});

	it("uses one basic schema validation and declared Display ids", () => {
		const { character, store } = fixture();
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
	});

	it("accepts only top-level global or conversation scope", () => {
		const { character } = fixture();
		const invalid = structuredClone(character.state) as CharacterStateDefinition;
		const affinity = invalid.properties?.relationship?.properties?.affinity;
		if (!affinity) throw new Error("missing affinity schema");
		affinity["x-scope"] = "conversation";
		expect(() => compileCharacterStateSchema(invalid)).toThrow(
			"may not override its partition x-scope",
		);
	});

	it("rejects an excessively deep state schema before recursive library compilation", () => {
		let child: CharacterStateDefinition = { fields: {}, type: "string", default: "" };
		for (let depth = 0; depth < 100; depth += 1) {
			child = { fields: {}, type: "object", properties: { child } };
		}
		const definition = {
			fields: {},
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			properties: {
				root: { ...child, "x-scope": "conversation" as const },
			},
		} as CharacterStateDefinition;

		expect(() => compileCharacterStateSchema(definition)).toThrow("state_schema exceeds depth 64");
	});
});
