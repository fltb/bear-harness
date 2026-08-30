// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { CompanionStore } from "../src/companion/companion-store.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { conversations } from "../src/storage/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-companion-store-"));
	roots.push(root);
	const database = new Database(root);
	database.migrate(MIGRATIONS);
	const loader = new CharacterLoader(resolve(import.meta.dirname, "../../../config/characters"));
	const character = loader.load("jizhou");
	if (!character) throw new Error("missing default character");
	loader.seed(database.orm, new EventBus(database.orm), character);
	database.orm
		.insert(conversations)
		.values([
			{ id: "source", companionId: character.id },
			{ id: "fork", companionId: character.id },
		])
		.run();
	return { database, character, store: new CompanionStore(database.orm) };
}

describe("CompanionStore", () => {
	it("materializes display and collection with independent revisions", () => {
		const { database, character, store } = fixture();
		expect(store.snapshot(character, "source")).toMatchObject({
			display: { sceneId: "study", expressionId: "calm" },
			collection: { seenMediaIds: [], unlocks: [], factIds: [] },
			revisions: { display: 0, collection: 0 },
		});
		store.commit({
			character,
			conversationId: "source",
			commitId: "display-1",
			authority: "test",
			mutations: [{ domain: "display", op: "set_expression", expressionId: "reflective" }],
		});
		expect(store.snapshot(character, "source").revisions).toEqual({ display: 1, collection: 0 });
		store.commit({
			character,
			conversationId: "source",
			commitId: "collection-1",
			authority: "test",
			mutations: [{ domain: "collection", op: "add_seen_media", mediaId: "damaged_signal" }],
		});
		expect(store.snapshot(character, "source")).toMatchObject({
			display: { expressionId: "reflective" },
			collection: { seenMediaIds: ["damaged_signal"] },
			revisions: { display: 1, collection: 1 },
		});
		database.close();
	});

	it("commits or discards all staged display and collection effects as one turn", () => {
		const { database, character, store } = fixture();
		const turn = {
			character,
			conversationId: "source",
			piSessionId: "session",
			sourceUserEntryId: "user-1",
		};
		store.stage({
			...turn,
			toolCallId: "tool-1",
			mutations: [
				{ domain: "display", op: "present", surface: "modal", resourceId: "damaged_signal" },
				{ domain: "collection", op: "add_seen_media", mediaId: "damaged_signal" },
			],
		});
		expect(store.snapshot(character, "source").display.surfaces.modal).toBeNull();
		expect(store.previewTurn(turn).display.surfaces.modal).toBe("damaged_signal");
		store.discardTurn("source", "session", "user-1");
		expect(store.commitTurn({ ...turn, assistantEntryId: "assistant-1" }).committed).toBe(false);

		store.stage({
			...turn,
			sourceUserEntryId: "user-2",
			toolCallId: "tool-2",
			mutations: [
				{ domain: "display", op: "present", surface: "modal", resourceId: "damaged_signal" },
				{ domain: "collection", op: "add_seen_media", mediaId: "damaged_signal" },
			],
		});
		store.commitTurn({ ...turn, sourceUserEntryId: "user-2", assistantEntryId: "assistant-2" });
		expect(store.snapshot(character, "source")).toMatchObject({
			display: { surfaces: { modal: "damaged_signal" } },
			collection: { seenMediaIds: ["damaged_signal"] },
		});
		database.close();
	});

	it("forks only commits whose native entries are on the selected branch", () => {
		const { database, character, store } = fixture();
		for (const [commitId, sourceUserEntryId, expressionId] of [
			["turn-1", "user-1", "reflective"],
			["turn-2", "user-2", "alert"],
		] as const)
			store.commit({
				character,
				conversationId: "source",
				commitId,
				authority: "model_turn",
				sourceUserEntryId,
				mutations: [{ domain: "display", op: "set_expression", expressionId }],
			});
		store.forkConversation({
			character,
			sourceConversationId: "source",
			targetConversationId: "fork",
			sourceEntryIds: new Set(["user-1"]),
		});
		expect(store.snapshot(character, "fork").display.expressionId).toBe("reflective");
		database.close();
	});

	it("rejects malformed or undeclared mutations without partial writes", () => {
		const { database, character, store } = fixture();
		expect(() =>
			store.commit({
				character,
				conversationId: "source",
				commitId: "invalid",
				authority: "test",
				mutations: [
					{ domain: "display", op: "set_expression", expressionId: "reflective" },
					{ domain: "display", op: "set_scene", sceneId: "undeclared" },
				],
			}),
		).toThrow();
		expect(store.snapshot(character, "source").revisions).toEqual({ display: 0, collection: 0 });
		database.close();
	});
});
