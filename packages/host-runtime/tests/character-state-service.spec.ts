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
	it("lets the active story Skill advance natural dialogue without granting ordinary model writes", () => {
		const { database, character, service } = fixture();
		const operations = [
			{ path: "story.undelivered_report.phase", op: "set" as const, value: "invited" },
			{ path: "story.undelivered_report.status", op: "set" as const, value: "active" },
			{ path: "narrative.active_story", op: "set" as const, value: "undelivered_report" },
		];
		expect(() =>
			service.stage({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session",
				sourceUserEntryId: "natural-entry-denied",
				definition: character.state,
				operations,
				reason: "An ordinary model cannot open the story state.",
				evidence: { source: "current_user", quote: "我想查看那条未送达的回报。" },
			}),
		).toThrow();
		service.stage({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session",
			sourceUserEntryId: "natural-entry",
			definition: character.state,
			operations,
			reason: "The user explicitly entered the story through natural dialogue.",
			skillId: "undelivered-report",
			evidence: { source: "current_user", quote: "我想查看那条未送达的回报。" },
		});
		expect(
			service.commitTurn({
				companionId: character.id,
				conversationId: "conversation",
				piSessionId: "session",
				sourceUserEntryId: "natural-entry",
				assistantEntryId: "natural-entry-response",
				definition: character.state,
			}),
		).toMatchObject({
			committed: true,
			state: {
				values: {
					"story.undelivered_report.phase": "invited",
					"story.undelivered_report.status": "active",
					"narrative.active_story": "undelivered_report",
				},
			},
		});
		database.close();
	});

	it("accepts a batch of unique strings for a string-list append operation", () => {
		const { database, character, service } = fixture();
		service.stage({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session",
			sourceUserEntryId: "facts",
			definition: character.state,
			operations: [
				{
					path: "story.undelivered_report.known_facts",
					op: "append_unique",
					value: ["损坏边界可见。", "最终接收方未知。", "损坏边界可见。"],
				},
			],
			reason: "The current chapter exposed two directly supported facts.",
			skillId: "undelivered-report",
			evidence: { source: "current_user", quote: "检查这份损坏信号。" },
		});
		const committed = service.commitTurn({
			companionId: character.id,
			conversationId: "conversation",
			piSessionId: "session",
			sourceUserEntryId: "facts",
			assistantEntryId: "facts-response",
			definition: character.state,
		});
		expect(committed.state.values["story.undelivered_report.known_facts"]).toEqual([
			"损坏边界可见。",
			"最终接收方未知。",
		]);
		database.close();
	});

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
			evidence: { source: "current_user", quote: "I trust you with this." },
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
			skillId: "continuity-reveal",
			evidence: { source: "current_user", quote: "Tell me where you came from." },
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
			skillId: "continuity-reveal",
			evidence: { source: "current_user", quote: "Continue." },
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
				evidence: { source: "current_user", quote: "I trust you." },
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
				skillId: "continuity-reveal",
				evidence: { source: "current_user", quote: "Skip ahead." },
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
			evidence: { source: "current_user", quote: "First trust event." },
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
			evidence: { source: "current_user", quote: "Second trust event." },
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
