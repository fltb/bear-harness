// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { CharacterStateService } from "../src/companion/state-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { conversations } from "../src/storage/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-character-state-"));
	roots.push(root);
	const database = new Database(root);
	database.migrate(MIGRATIONS);
	const loader = new CharacterLoader(resolve(import.meta.dirname, "../../../config/characters"));
	const character = loader.load("jizhou");
	if (!character) throw new Error("missing Jizhou package");
	loader.seed(database.orm, new EventBus(database.orm), character);
	database.orm
		.insert(conversations)
		.values({ id: "conversation", companionId: character.id })
		.run();
	return { database, character, service: new CharacterStateService(database.orm) };
}

describe("CharacterStateService", () => {
	it("stages atomically and commits once only after a successful assistant entry", () => {
		const { database, character, service } = fixture();
		service.stage({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session",
			sourceUserEntryId: "user-1",
			definition: character.state,
			operations: [{ path: "relationship.affinity", op: "increment", value: 2 }],
			expectedRevisions: { relationship: 0 },
			reason: "The user offered sustained help.",
		});
		expect(service.project(character.id, "conversation", character.state).values).toMatchObject({
			"relationship.affinity": 0,
		});
		const committed = service.commitTurn({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session",
			sourceUserEntryId: "user-1",
			assistantEntryId: "assistant-1",
			definition: character.state,
		});
		expect(committed).toMatchObject({
			committed: true,
			state: { values: { "relationship.affinity": 2 }, revisions: { relationship: 1 } },
		});
		expect(
			service.commitTurn({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session",
				sourceUserEntryId: "user-1",
				assistantEntryId: "assistant-1",
				definition: character.state,
			}),
		).toMatchObject({ committed: false, state: { revisions: { relationship: 1 } } });
		database.close();
	});

	it("recovers a durable staged mutation after service restart and discards failed turns", () => {
		const { database, character, service } = fixture();
		service.stage({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session",
			sourceUserEntryId: "user-recover",
			definition: character.state,
			operations: [{ path: "continuity.stage", op: "set", value: 1 }],
			reason: "The user chose to open the continuity record.",
		});
		const recovered = new CharacterStateService(database.orm);
		expect(
			recovered.commitTurn({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session",
				sourceUserEntryId: "user-recover",
				assistantEntryId: "assistant-recover",
				definition: character.state,
			}),
		).toMatchObject({ committed: true, state: { values: { "continuity.stage": 1 } } });
		recovered.stage({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session",
			sourceUserEntryId: "user-failed",
			definition: character.state,
			operations: [{ path: "continuity.stage", op: "set", value: 2 }],
			reason: "Staged before a failed response.",
		});
		recovered.discardTurn("conversation", "session", "user-failed");
		expect(
			recovered.commitTurn({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session",
				sourceUserEntryId: "user-failed",
				assistantEntryId: "assistant-failed",
				definition: character.state,
			}),
		).toMatchObject({ committed: false, state: { values: { "continuity.stage": 1 } } });
		database.close();
	});

	it("enforces schema operations, per-turn limits, transitions and optimistic revisions", () => {
		const { database, character, service } = fixture();
		expect(() =>
			service.stage({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session",
				sourceUserEntryId: "too-large",
				definition: character.state,
				operations: [{ path: "relationship.affinity", op: "increment", value: 3 }],
				reason: "Too large.",
			}),
		).toThrow();
		expect(() =>
			service.stage({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session",
				sourceUserEntryId: "skip-transition",
				definition: character.state,
				operations: [{ path: "continuity.stage", op: "set", value: 3 }],
				reason: "Cannot skip stages.",
			}),
		).toThrow();
		service.stage({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceUserEntryId: "user-a",
			definition: character.state,
			operations: [{ path: "relationship.affinity", op: "increment", value: 1 }],
			expectedRevisions: { relationship: 0 },
			reason: "First writer.",
		});
		service.stage({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session-b",
			sourceUserEntryId: "user-b",
			definition: character.state,
			operations: [{ path: "relationship.affinity", op: "increment", value: 1 }],
			expectedRevisions: { relationship: 0 },
			reason: "Competing writer.",
		});
		service.commitTurn({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session-b",
			sourceUserEntryId: "user-b",
			assistantEntryId: "assistant-b",
			definition: character.state,
		});
		expect(() =>
			service.commitTurn({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session-a",
				sourceUserEntryId: "user-a",
				assistantEntryId: "assistant-a",
				definition: character.state,
			}),
		).toThrow();
		database.close();
	});
});
