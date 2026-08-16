// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { RoleplayService } from "../src/companion/roleplay-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { branches, conversations, messages, messageVersions } from "../src/storage/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-roleplay-"));
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
	database.orm
		.insert(branches)
		.values({ id: "main", conversationId: "conversation", adopted: 1 })
		.run();
	database.orm
		.insert(messages)
		.values({
			id: "assistant",
			conversationId: "conversation",
			branchId: "main",
			role: "assistant",
		})
		.run();
	database.orm
		.insert(messageVersions)
		.values({ id: "version-a", messageId: "assistant", content: "A", adopted: 1 })
		.run();
	return { database, character, service: new RoleplayService(database.orm) };
}

describe("roleplay event projection", () => {
	it("enforces the damaged-log chapter order and projects its completed state", () => {
		const { database, character, service } = fixture();
		const trigger = (eventId: string) =>
			service.trigger({
				character,
				eventId,
				conversationId: "conversation",
				branchId: "main",
				dedupeKey: `user:${eventId}`,
			});

		expect(() => trigger("damaged_log_signal_found")).toThrow();
		trigger("damaged_log_opened");
		trigger("damaged_log_pulse_isolated");
		trigger("damaged_log_preserved");
		trigger("damaged_log_signal_found");

		expect(service.project(character, "conversation")).toMatchObject({
			values: {
				damaged_log_stage: 3,
				damaged_log_snapshot_preserved: true,
				trust: 1,
				resonance: 3,
			},
			unlocked: ["damaged_signal"],
		});
		database.close();
	});

	it("commits effects atomically and deduplicates a turn event", () => {
		const { database, character, service } = fixture();
		service.trigger({
			character,
			eventId: "first_meeting_remembered",
			conversationId: "conversation",
			branchId: "main",
			sourceMessageVersionId: "version-a",
			dedupeKey: "turn:event",
		});
		service.trigger({
			character,
			eventId: "first_meeting_remembered",
			conversationId: "conversation",
			branchId: "main",
			sourceMessageVersionId: "version-a",
			dedupeKey: "turn:event",
		});
		expect(service.project(character, "conversation")).toMatchObject({
			values: { trust: 1 },
			unlocked: ["first_night_memory"],
		});
		database.close();
	});

	it("rolls ordinary state back with an unadopted message version but retains unlocks", () => {
		const { database, character, service } = fixture();
		service.trigger({
			character,
			eventId: "first_meeting_remembered",
			conversationId: "conversation",
			branchId: "main",
			sourceMessageVersionId: "version-a",
			dedupeKey: "turn:event",
		});
		database.orm.update(messageVersions).set({ adopted: 0 }).run();
		expect(service.project(character, "conversation")).toMatchObject({
			values: { trust: 0 },
			unlocked: ["first_night_memory"],
		});
		database.close();
	});
});
