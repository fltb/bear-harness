// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { CompanionStore } from "../src/companion/companion-store.js";
import { RoleplayService } from "../src/companion/roleplay-service.js";
import { CharacterStateService } from "../src/companion/state-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { conversations } from "../src/storage/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-roleplay-projection-"));
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
	const companionStore = new CompanionStore(database.orm);
	return {
		database,
		character,
		companionStore,
		service: new RoleplayService(
			database.orm,
			new CharacterStateService(database.orm),
			companionStore,
		),
	};
}

describe("roleplay read-only projection", () => {
	it("has no executable transition path and exposes natural-language choices", () => {
		const { database, character, service } = fixture();
		expect("trigger" in service).toBe(false);
		expect("stageTransition" in service).toBe(false);
		expect(character.roleplay.choice_sets.flatMap((set) => set.choices)).toSatisfy(
			(choices: Array<Record<string, unknown>>) =>
				choices.every((choice) => typeof choice.message === "string" && !("event" in choice)),
		);
		expect(service.project(character, "conversation").state).toMatchObject({
			continuity: { stage: 0, response: "unopened" },
		});
		database.close();
	});

	it("reads presentation and collection only from the unified companion snapshot", () => {
		const { database, character, companionStore, service } = fixture();
		companionStore.commit({
			character,
			conversationId: "conversation",
			commitId: "present-damaged-signal",
			authority: "test",
			mutations: [
				{ domain: "display", op: "present", surface: "inline", resourceId: "damaged_signal" },
				{ domain: "collection", op: "add_seen_media", mediaId: "damaged_signal" },
			],
		});
		expect(service.presentation(character, "conversation")).toMatchObject({
			mediaId: "damaged_signal",
			seenMediaIds: ["damaged_signal"],
		});
		database.close();
	});
});
