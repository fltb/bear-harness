// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterBehaviorService } from "../src/main/companion/character-behavior.js";
import { EventBus } from "../src/main/storage/event-bus.js";

function createFixture(): {
	db: DatabaseSync;
	eventBus: EventBus;
	behavior: CharacterBehaviorService;
} {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);
		CREATE TABLE companion_packages (id TEXT PRIMARY KEY);
		CREATE TABLE companion_identity (id TEXT PRIMARY KEY, package_id TEXT NOT NULL);
		CREATE TABLE conversations (id TEXT PRIMARY KEY, companion_id TEXT NOT NULL);
		CREATE TABLE scene_state (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			scene TEXT NOT NULL,
			state_json TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	db.prepare("INSERT INTO companion_packages (id) VALUES (?)").run("jizhou");
	db.prepare("INSERT INTO companion_identity (id, package_id) VALUES (?, ?)").run("jizhou", "jizhou");
	db.prepare("INSERT INTO conversations (id, companion_id) VALUES (?, ?)").run("conversation-1", "jizhou");
	const eventBus = new EventBus(db);
	return { db, eventBus, behavior: new CharacterBehaviorService(db, eventBus) };
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
		fixture.db.prepare("SELECT scene, state_json FROM scene_state WHERE conversation_id = ?").get("conversation-1"),
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
		const events = fixture.db.prepare("SELECT kind FROM events ORDER BY seq").all() as Array<{ kind: string }>;
		expect(events.map((event) => event.kind)).toEqual([
			"message.user_sent",
			"character.visual_state_changed",
		]);
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
		expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM scene_state").get()).toEqual({ count: 0 });
	});
});
