// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterBehaviorService } from "../src/companion/character-behavior.js";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { RoleplayService } from "../src/companion/roleplay-service.js";
import { EventBus } from "../src/storage/event-bus.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const characterLoader = new CharacterLoader(characterRoot);

function createFixture(): {
	db: DatabaseSync;
	eventBus: EventBus;
	behavior: CharacterBehaviorService;
} {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE companion_packages (id TEXT PRIMARY KEY);
		CREATE TABLE companion_identity (id TEXT PRIMARY KEY, package_id TEXT NOT NULL);
		CREATE TABLE conversations (id TEXT PRIMARY KEY, companion_id TEXT NOT NULL);
		CREATE TABLE branches (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, adopted INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, role TEXT NOT NULL);
		CREATE TABLE message_versions (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, adopted INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE roleplay_events (id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, conversation_id TEXT, branch_id TEXT, source_message_version_id TEXT, event_id TEXT NOT NULL, effects_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE roleplay_unlocks (companion_id TEXT NOT NULL, unlockable_id TEXT NOT NULL, source_event_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (companion_id, unlockable_id));
		CREATE TABLE scene_state (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			scene TEXT NOT NULL,
			state_json TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	db.prepare("INSERT INTO companion_packages (id) VALUES (?)").run("jizhou");
	db.prepare("INSERT INTO companion_identity (id, package_id) VALUES (?, ?)").run(
		"jizhou",
		"jizhou",
	);
	db.prepare("INSERT INTO conversations (id, companion_id) VALUES (?, ?)").run(
		"conversation-1",
		"jizhou",
	);
	db.prepare("INSERT INTO branches (id, conversation_id) VALUES (?, ?)").run(
		"main",
		"conversation-1",
	);
	db.prepare("INSERT INTO messages (id, conversation_id, branch_id, role) VALUES (?, ?, ?, ?)").run(
		"assistant",
		"conversation-1",
		"main",
		"assistant",
	);
	db.prepare("INSERT INTO message_versions (id, message_id) VALUES (?, ?)").run(
		"version",
		"assistant",
	);
	const orm = drizzle({ client: db });
	const eventBus = new EventBus(orm);
	return {
		db,
		eventBus,
		behavior: new CharacterBehaviorService(
			orm,
			eventBus,
			characterLoader,
			new RoleplayService(orm),
		),
	};
}

describe("CharacterBehaviorService", () => {
	const fixtures: Array<{ db: DatabaseSync; behavior: CharacterBehaviorService }> = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			fixture.behavior.dispose();
			fixture.db.close();
		}
	});

	it("persists only package-declared Host scene and expression changes", () => {
		const fixture = createFixture();
		fixtures.push(fixture);

		const initial = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_get_state",
			args: {},
		});
		expect(initial).toMatchObject({
			ok: true,
			state: {
				sceneId: "aurora_study",
				visualState: "presence",
				sceneIds: expect.arrayContaining(["aurora_study", "snow_plains"]),
				visualStates: expect.arrayContaining(["presence", "thinking"]),
				scenes: expect.arrayContaining([
					expect.objectContaining({ id: "snow_plains", useWhen: expect.stringContaining("雪原") }),
				]),
				expressions: expect.arrayContaining([
					expect.objectContaining({ id: "apologetic", useWhen: expect.stringContaining("犯错") }),
				]),
			},
		});

		const changedScene = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_scene",
			args: { sceneId: "snow_plains" },
		});
		expect(changedScene).toMatchObject({ ok: true, state: { sceneId: "snow_plains" } });

		const changedExpression = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_expression",
			args: { visualState: "thinking" },
		});
		expect(changedExpression).toMatchObject({ ok: true, state: { visualState: "thinking" } });

		const rejected = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_scene",
			args: { sceneId: "outside_the_package" },
		});
		expect(rejected).toMatchObject({ ok: false, code: "invalid_scene" });
		expect(
			fixture.db
				.prepare("SELECT scene, state_json FROM scene_state WHERE conversation_id = ?")
				.get("conversation-1"),
		).toEqual({ scene: "snow_plains", state_json: JSON.stringify({ visualState: "thinking" }) });
	});

	it("applies the role's fixed reaction to a trusted Host event", () => {
		const fixture = createFixture();
		fixtures.push(fixture);

		fixture.eventBus.publish("message.user_sent", { conversationId: "conversation-1" });

		const state = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_get_state",
			args: {},
		});
		expect(state).toMatchObject({ ok: true, state: { visualState: "listening" } });
		const events = fixture.db.prepare("SELECT kind FROM events ORDER BY seq").all() as Array<{
			kind: string;
		}>;
		expect(events.map((event) => event.kind)).toEqual([
			"message.user_sent",
			"character.visual_state_changed",
		]);
	});

	it("does not overwrite an expression the model selected for the current turn", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.eventBus.publish("message.user_sent", { conversationId: "conversation-1" });
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_expression",
			args: { visualState: "apologetic" },
		});
		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });

		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "apologetic" } });
	});

	it("commits queued roleplay effects only after the assistant version is durable", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_trigger_roleplay_event",
				args: { eventId: "first_meeting_remembered" },
			}),
		).toMatchObject({ ok: true });
		expect(fixture.db.prepare("SELECT COUNT(*) count FROM roleplay_events").get()).toEqual({
			count: 0,
		});
		fixture.eventBus.publish("message_end", { conversationId: "conversation-1", failed: true });
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});
		expect(fixture.db.prepare("SELECT COUNT(*) count FROM roleplay_events").get()).toEqual({
			count: 0,
		});

		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_trigger_roleplay_event",
			args: { eventId: "first_meeting_remembered" },
		});
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});
		expect(fixture.db.prepare("SELECT event_id FROM roleplay_events").get()).toEqual({
			event_id: "first_meeting_remembered",
		});
		expect(fixture.db.prepare("SELECT unlockable_id FROM roleplay_unlocks").get()).toEqual({
			unlockable_id: "first_night_memory",
		});
	});

	it("applies declared scene, expression and media only after a successful reply commit", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const presented: unknown[] = [];
		fixture.eventBus.subscribe((event) => {
			if (event.kind === "roleplay.media_presented") presented.push(event.payload);
		});

		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_trigger_roleplay_event",
			args: { eventId: "damaged_log_opened" },
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "presence" } });
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { sceneId: "aurora_study", visualState: "thinking" } });

		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_trigger_roleplay_event",
			args: { eventId: "damaged_log_pulse_isolated" },
		});
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});

		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_trigger_roleplay_event",
			args: { eventId: "damaged_log_signal_found" },
		});
		expect(presented).toEqual([]);
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});
		expect(presented).toContainEqual({
			conversationId: "conversation-1",
			mediaId: "damaged_signal_live",
		});
	});

	it("applies the same declared presentation when the user chooses a roleplay event", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const presented: unknown[] = [];
		fixture.eventBus.subscribe((event) => {
			if (event.kind === "roleplay.media_presented") presented.push(event.payload);
		});

		fixture.behavior.triggerUserRoleplayEvent({
			conversationId: "conversation-1",
			eventId: "damaged_log_opened",
			dedupeKey: "user-opened",
		});
		fixture.behavior.triggerUserRoleplayEvent({
			conversationId: "conversation-1",
			eventId: "damaged_log_pulse_isolated",
			dedupeKey: "user-isolated",
		});
		fixture.behavior.triggerUserRoleplayEvent({
			conversationId: "conversation-1",
			eventId: "damaged_log_signal_found",
			dedupeKey: "user-confirmed",
		});

		expect(presented).toContainEqual({
			conversationId: "conversation-1",
			mediaId: "damaged_signal_live",
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_roleplay_state",
				args: {},
			}),
		).toMatchObject({ data: { values: { damaged_log_stage: 3 }, unlocked: ["damaged_signal"] } });
	});

	it("rejects unallowlisted Host tools without mutating state", () => {
		const fixture = createFixture();
		fixtures.push(fixture);

		const result = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_execute_shell",
			args: { command: "echo no" },
		});
		expect(result).toMatchObject({ ok: false, code: "host_tool_not_allowed" });
		expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM scene_state").get()).toEqual({
			count: 0,
		});
	});

	it("rejects corrupt persisted character state instead of resetting it", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.db
			.prepare(
				"INSERT INTO scene_state (id, conversation_id, scene, state_json) VALUES (?, ?, ?, ?)",
			)
			.run("scene-1", "conversation-1", "aurora_study", "not-json");

		expect(() =>
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toThrow();
	});
});
