// @vitest-environment node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function createFixture(loader: CharacterLoader = characterLoader): {
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
		CREATE TABLE branches (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'main', adopted INTEGER NOT NULL DEFAULT 1);
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
		behavior: new CharacterBehaviorService(orm, eventBus, loader, new RoleplayService(orm)),
	};
}

describe("CharacterBehaviorService", () => {
	const fixtures: Array<{ db: DatabaseSync; behavior: CharacterBehaviorService }> = [];
	const temporaryDirectories: string[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			fixture.behavior.dispose();
			fixture.db.close();
		}
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
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
				sceneId: "study",
				visualState: "calm",
				sceneIds: expect.arrayContaining(["study", "snowfield"]),
				visualStates: expect.arrayContaining(["calm", "reflective"]),
				scenes: expect.arrayContaining([
					expect.objectContaining({ id: "snowfield", useWhen: expect.stringContaining("雪原") }),
				]),
				expressions: expect.arrayContaining([
					expect.objectContaining({ id: "repair", useWhen: expect.stringContaining("修正") }),
				]),
			},
		});

		const changedScene = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_scene",
			args: { sceneId: "snowfield" },
		});
		expect(changedScene).toMatchObject({ ok: true, state: { sceneId: "snowfield" } });

		const changedExpression = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_expression",
			args: { visualState: "reflective" },
		});
		expect(changedExpression).toMatchObject({ ok: true, state: { visualState: "reflective" } });

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
		).toEqual({ scene: "snowfield", state_json: JSON.stringify({ visualState: "reflective" }) });
	});

	it("applies package-declared Host lifecycle reactions", () => {
		const fixture = createFixture();
		fixtures.push(fixture);

		fixture.eventBus.publish("message.user_sent", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "attentive" } });

		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "ready" } });

		fixture.eventBus.publish("message.aborted", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "calm" } });

		const events = fixture.db.prepare("SELECT kind FROM events ORDER BY seq").all() as Array<{
			kind: string;
		}>;
		expect(events.map((event) => event.kind)).toEqual([
			"message.user_sent",
			"character.visual_state_changed",
			"message_end",
			"character.visual_state_changed",
			"message.aborted",
			"character.visual_state_changed",
		]);
	});

	it("rejects an automatic reaction with a forbidden presentation key", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-host-reaction-"));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		writeFileSync(
			manifestPath,
			manifest.replace(
				"      visual_state: attentive",
				"      visual_state: attentive\n      scene: study",
			),
		);

		expect(() => new CharacterLoader(configRoot).load("jizhou")).toThrow(
			/invalid host event reaction/,
		);
	});

	it("applies an arbitrary declared Host event to its visual state", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-host-reaction-generic-"));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		writeFileSync(
			manifestPath,
			manifest.replace(
				"    - event: message.aborted\n      visual_state: calm\n",
				"    - event: message.aborted\n      visual_state: calm\n    - event: workflow.review_requested\n      visual_state: reflective\n",
			),
		);
		const fixture = createFixture(new CharacterLoader(configRoot));
		fixtures.push(fixture);

		fixture.eventBus.publish("workflow.review_requested", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "reflective" } });
	});

	it("keeps undeclared and locked media or choice presentations behind Host gates", () => {
		const fixture = createFixture();
		fixtures.push(fixture);

		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_play_media",
				args: { mediaId: "continuity_light" },
			}),
		).toMatchObject({ ok: false, code: "roleplay_media_locked" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_play_media",
				args: { mediaId: "outside_the_package" },
			}),
		).toMatchObject({ ok: false, code: "invalid_roleplay_media" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present_choices",
				args: { choiceSetId: "outside_the_package" },
			}),
		).toMatchObject({ ok: false, code: "invalid_roleplay_choices" });
		expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
	});

	it("does not overwrite an expression the model selected for the current turn", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.eventBus.publish("message.user_sent", { conversationId: "conversation-1" });
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_expression",
			args: { visualState: "repair" },
		});
		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });

		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "repair" } });
	});

	it("does not carry model expression suppression into the next turn", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.eventBus.publish("message.user_sent", { conversationId: "conversation-1" });
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_expression",
			args: { visualState: "repair" },
		});
		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "repair" } });

		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "ready" } });
	});

	it("clears model expression suppression on failed and aborted turns", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_expression",
			args: { visualState: "repair" },
		});
		fixture.eventBus.publish("message_end", {
			conversationId: "conversation-1",
			failed: true,
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "repair" } });

		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "ready" } });

		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_set_expression",
			args: { visualState: "repair" },
		});
		fixture.eventBus.publish("message.aborted", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "calm" } });

		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "ready" } });
	});

	it("limits roleplay expression suppression to one lifecycle end", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_trigger_roleplay_event",
				args: { eventId: "continuity_opened" },
			}),
		).toMatchObject({ ok: true });
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
		).toMatchObject({ state: { visualState: "reflective" } });

		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "reflective" } });
		fixture.eventBus.publish("message_end", { conversationId: "conversation-1" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "ready" } });
	});

	it("commits queued roleplay effects only after the assistant version is durable", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_trigger_roleplay_event",
				args: { eventId: "continuity_opened" },
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
			args: { eventId: "continuity_opened" },
		});
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});
		expect(fixture.db.prepare("SELECT event_id FROM roleplay_events").get()).toEqual({
			event_id: "continuity_opened",
		});
		expect(fixture.db.prepare("SELECT COUNT(*) count FROM roleplay_unlocks").get()).toEqual({
			count: 0,
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
			args: { eventId: "continuity_opened" },
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toMatchObject({ state: { visualState: "calm" } });
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
		).toMatchObject({ state: { sceneId: "quiet_terminal", visualState: "reflective" } });

		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_trigger_roleplay_event",
			args: { eventId: "continuity_revealed" },
		});
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});

		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_trigger_roleplay_event",
			args: { eventId: "continuity_received" },
		});
		expect(presented).toEqual([]);
		fixture.eventBus.publish("message.assistant_committed", {
			conversationId: "conversation-1",
			versionId: "version",
		});
		expect(presented).toContainEqual({
			conversationId: "conversation-1",
			mediaId: "continuity_light",
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
			eventId: "continuity_opened",
			dedupeKey: "user-opened",
		});
		fixture.behavior.triggerUserRoleplayEvent({
			conversationId: "conversation-1",
			eventId: "continuity_revealed",
			dedupeKey: "user-isolated",
		});
		fixture.behavior.triggerUserRoleplayEvent({
			conversationId: "conversation-1",
			eventId: "continuity_received",
			dedupeKey: "user-confirmed",
		});

		expect(presented).toContainEqual({
			conversationId: "conversation-1",
			mediaId: "continuity_light",
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_roleplay_state",
				args: {},
			}),
		).toMatchObject({ data: { values: { continuity_stage: 3 }, unlocked: ["continuity_record"] } });
	});

	it("rejects roleplay ledger writes from an explicit alternate branch", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.db.prepare("UPDATE branches SET label = ? WHERE id = ?").run("alternate", "main");

		expect(() =>
			fixture.behavior.triggerUserRoleplayEvent({
				conversationId: "conversation-1",
				eventId: "continuity_opened",
				dedupeKey: "alternate-branch",
			}),
		).toThrow(expect.objectContaining({ reason: "roleplay_event_branch_not_canonical" }));
		expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM roleplay_events").get()).toEqual({
			count: 0,
		});
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
			.run("scene-1", "conversation-1", "study", "not-json");

		expect(() =>
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_get_state",
				args: {},
			}),
		).toThrow();
	});
});
