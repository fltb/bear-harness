// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { RoleplaySchema } from "../src/companion/roleplay-schema.js";
import { RoleplayService } from "../src/companion/roleplay-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { conversations, onboardingState } from "../src/storage/schema.js";

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
	return { database, character, service: new RoleplayService(database.orm) };
}

describe("roleplay event projection", () => {
	it("recovers scoped presentation and dismissals from Host history without replaying UI events", () => {
		const { database, character } = fixture();
		const configured = {
			...character,
			roleplay: RoleplaySchema.parse({
				variables: [],
				unlockables: [],
				media: [
					{
						id: "image",
						kind: "image",
						label: "Image",
						asset: "image.png",
						presentation: "dialog",
					},
					{
						id: "ambient",
						kind: "audio",
						label: "Ambient",
						asset: "ambient.mp3",
						captions: "ambient.vtt",
						presentation: "ambient",
					},
				],
				choice_sets: [
					{
						id: "reply",
						prompt: "Reply?",
						choices: [
							{ id: "yes", label: "Yes", event: "answer" },
							{ id: "no", label: "No", event: "answer" },
						],
					},
				],
				events: [{ id: "answer", label: "Answer", effects: [{ type: "media", media: "image" }] }],
			}),
		};
		const bus = new EventBus(database.orm);
		bus.publish("roleplay.media_presented", { conversationId: "conversation", mediaId: "image" });
		bus.publish("roleplay.media_presented", { conversationId: "conversation", mediaId: "ambient" });
		bus.publish("roleplay.choices_presented", {
			conversationId: "conversation",
			choiceSetId: "reply",
		});
		bus.publish("roleplay.media_dismissed", { conversationId: "other", mediaId: "image" });
		const reopened = new RoleplayService(database.orm);
		expect(reopened.presentation(configured, "conversation")).toEqual({
			conversationId: "conversation",
			mediaId: "image",
			ambientMediaId: "ambient",
			choiceSetId: "reply",
		});
		bus.publish("roleplay.media_dismissed", { conversationId: "conversation", mediaId: "image" });
		bus.publish("roleplay.choices_dismissed", { conversationId: "conversation" });
		expect(reopened.presentation(configured, "conversation")).toEqual({
			conversationId: "conversation",
			ambientMediaId: "ambient",
		});
		expect(reopened.presentation(configured, "other")).toEqual({ conversationId: "other" });
		database.close();
	});

	it("enforces the continuity chapter order and projects its completed state", () => {
		const { database, character, service } = fixture();
		const trigger = (eventId: string) =>
			service.trigger({
				character,
				eventId,
				conversationId: "conversation",
				piSessionId: "session-a",
				sourceNativeEntryId: "entry-a",
				dedupeKey: `session-a:entry-a:${eventId}`,
			});

		expect(() => trigger("continuity_received")).toThrow();
		trigger("continuity_opened");
		trigger("continuity_revealed");
		trigger("continuity_set_down");

		expect(service.project(character, "conversation")).toMatchObject({
			values: {
				continuity_stage: 3,
				continuity_response: "set_down",
			},
			unlocked: [],
		});
		database.close();
	});

	it("uses persisted onboarding bucket overrides as the roleplay baseline", () => {
		const { database, character, service } = fixture();
		database.orm
			.insert(onboardingState)
			.values({
				companionId: character.id,
				state: "complete",
				stateJson: {
					schema_version: 1,
					flow_version: 5,
					answers: {},
					decisions: { roleplay_initial_values: { continuity_response: "received" } },
				},
			})
			.run();

		expect(service.project(character, "conversation").values).toMatchObject({
			continuity_response: "received",
		});
		database.close();
	});

	it("commits effects atomically and deduplicates a turn event", () => {
		const { database, character, service } = fixture();
		service.trigger({
			character,
			eventId: "continuity_opened",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-a",
			dedupeKey: "session-a:entry-a:continuity_opened",
		});
		service.trigger({
			character,
			eventId: "continuity_opened",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-a",
			dedupeKey: "session-a:entry-a:continuity_opened",
		});
		service.trigger({
			character,
			eventId: "continuity_opened",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-a",
			dedupeKey: "session-a:entry-a:continuity_opened",
		});
		expect(service.project(character, "conversation")).toMatchObject({
			values: { continuity_stage: 1, continuity_response: "unopened" },
			unlocked: [],
		});
		database.close();
	});

	it("projects character-scoped story facts into every conversation", () => {
		const { database, character, service } = fixture();
		service.trigger({
			character,
			eventId: "continuity_opened",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-a",
			dedupeKey: "session-a:entry-a:continuity_opened",
		});
		database.orm.insert(conversations).values({ id: "other", companionId: character.id }).run();
		expect(service.project(character, "other").values).toMatchObject({
			continuity_stage: 1,
		});
		database.close();
	});

	it("keeps conversation-scoped variables isolated while relationship variables persist", () => {
		const { database, character, service } = fixture();
		const conversationScopedCharacter = structuredClone(character);
		const continuityStage = conversationScopedCharacter.roleplay.variables.find(
			(variable) => variable.id === "continuity_stage",
		);
		if (!continuityStage) throw new Error("missing continuity stage variable");
		continuityStage.scope = "conversation";
		database.orm.insert(conversations).values({ id: "other", companionId: character.id }).run();

		service.trigger({
			character: conversationScopedCharacter,
			eventId: "continuity_opened",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-a",
			dedupeKey: "session-a:entry-a:continuity_opened",
		});

		expect(service.project(conversationScopedCharacter, "conversation").values).toMatchObject({
			continuity_stage: 1,
		});
		expect(service.project(conversationScopedCharacter, "other").values).toMatchObject({
			continuity_stage: 0,
		});
		database.close();
	});

	it("records native session provenance and retains committed state on re-delivery", () => {
		const { database, character, service } = fixture();
		service.trigger({
			character,
			eventId: "continuity_opened",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-a",
			dedupeKey: "session-a:entry-a:continuity_opened",
		});
		service.trigger({
			character,
			eventId: "continuity_revealed",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-b",
			dedupeKey: "session-a:entry-b:continuity_revealed",
		});
		service.trigger({
			character,
			eventId: "continuity_received",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-c",
			dedupeKey: "session-a:entry-c:continuity_received",
		});
		service.trigger({
			character,
			eventId: "continuity_received",
			conversationId: "conversation",
			piSessionId: "session-a",
			sourceNativeEntryId: "entry-c",
			dedupeKey: "session-a:entry-c:continuity_received",
		});
		expect(service.project(character, "conversation")).toMatchObject({
			values: { continuity_stage: 3, continuity_response: "received" },
			unlocked: ["continuity_record"],
		});
		database.close();
	});
});
