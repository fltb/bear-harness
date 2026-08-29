// @vitest-environment node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterBehaviorService } from "../src/companion/character-behavior.js";
import { CharacterLoader } from "../src/companion/character-loader.js";
import type { PiSessionMessage } from "../src/companion/pi-session-store.js";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
import { RoleplayService } from "../src/companion/roleplay-service.js";
import { CharacterStateService } from "../src/companion/state-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { conversations } from "../src/storage/schema.js";
import { withLegacyRoleplay } from "./fixtures/legacy-roleplay.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));

class LegacyRoleplayLoader extends CharacterLoader {
	override load(id: string) {
		const character = super.load(id);
		return character ? withLegacyRoleplay(character) : null;
	}
}

interface BehaviorFixture {
	db: Database;
	eventBus: EventBus;
	behavior: CharacterBehaviorService;
	/** Native Pi session used to derive turn lifecycle projections. */
	store: PiSessionStore;
	/** Append a native user message and return its SessionManager entry id. */
	appendUser: (text: string) => string;
	/** Append a native assistant message and return its SessionManager entry id. */
	appendAssistant: (text: string, stopReason: string) => string;
	/** Publish pi.session.changed with reason "message" for the fixture conversation. */
	publishChanged: () => void;
}

function createFixture(
	loader: CharacterLoader = new CharacterLoader(characterRoot),
): BehaviorFixture {
	const root = mkdtempSync(join(tmpdir(), "bear-character-behavior-"));
	const database = new Database(join(root, "db"));
	database.migrate(MIGRATIONS);
	const eventBus = new EventBus(database.orm);
	const character = loader.load("jizhou");
	if (!character) throw new Error("missing default character");
	loader.seed(database.orm, eventBus, character);
	database.orm
		.insert(conversations)
		.values({ id: "conversation-1", companionId: character.id })
		.run();

	const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
	const appendUser = (text: string) =>
		store.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	const appendAssistant = (text: string, stopReason: string) =>
		store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		} as PiSessionMessage);
	const publishChanged = () =>
		eventBus.publish("pi.session.changed", {
			conversationId: "conversation-1",
			sessionId: store.sessionId,
			reason: "message",
		});

	const behavior = new CharacterBehaviorService(
		database.orm,
		eventBus,
		loader,
		new RoleplayService(database.orm),
		new CharacterStateService(database.orm),
		() => ({ sessionId: store.sessionId, sessionManager: store.sessionManager }),
	);
	return { db: database, eventBus, behavior, store, appendUser, appendAssistant, publishChanged };
}

describe("CharacterBehaviorService", () => {
	const fixtures: BehaviorFixture[] = [];
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
		const afterSeq = fixture.eventBus.currentSeq;

		const initial = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "read" },
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
			tool: "host_visual",
			args: { action: "set_scene", sceneId: "snowfield" },
		});
		expect(changedScene).toMatchObject({ ok: true, state: { sceneId: "snowfield" } });

		const changedExpression = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "set_expression", visualState: "reflective" },
		});
		expect(changedExpression).toMatchObject({ ok: true, state: { visualState: "reflective" } });

		const rejected = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "set_scene", sceneId: "outside_the_package" },
		});
		expect(rejected).toMatchObject({ ok: false, code: "invalid_scene" });
		expect(
			fixture.db.connection
				.prepare("SELECT scene, state_json FROM scene_state WHERE conversation_id = ?")
				.get("conversation-1"),
		).toEqual({ scene: "snowfield", state_json: JSON.stringify({ visualState: "reflective" }) });
		expect(fixture.eventBus.after(afterSeq)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "character.scene_changed",
					payload: expect.objectContaining({
						conversationId: "conversation-1",
						sceneId: "snowfield",
					}),
				}),
			]),
		);
	});

	it("applies package-declared Host lifecycle reactions from native Pi turns", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const afterSeq = fixture.eventBus.currentSeq;

		// First observation seeds the baseline; no reaction yet.
		fixture.appendUser("hello");
		fixture.appendAssistant("hi", "stop");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "calm" } });

		// A new native user entry drives the user_sent reaction.
		fixture.appendUser("what now");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "attentive" } });

		// The completed native assistant entry drives the message_end reaction.
		fixture.appendAssistant("here", "stop");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "ready" } });

		// An aborted native assistant entry drives the aborted reaction.
		fixture.appendUser("cancel this");
		fixture.publishChanged();
		fixture.appendAssistant("", "aborted");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "calm" } });

		const events = fixture.eventBus.after(afterSeq).map((event) => event.kind);
		expect(events).toEqual([
			"pi.session.changed",
			"pi.session.changed",
			"character.visual_state_changed",
			"pi.session.changed",
			"character.visual_state_changed",
			"pi.session.changed",
			"character.visual_state_changed",
			"pi.session.changed",
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
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "reflective" } });
	});

	it("keeps undeclared and locked media or choice presentations behind Host gates", () => {
		const fixture = createFixture(new LegacyRoleplayLoader(characterRoot));
		const afterSeq = fixture.eventBus.currentSeq;
		fixtures.push(fixture);

		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present",
				args: { action: "media", mediaId: "continuity_light" },
			}),
		).toMatchObject({ ok: false, code: "roleplay_media_locked" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present",
				args: { action: "media", mediaId: "outside_the_package" },
			}),
		).toMatchObject({ ok: false, code: "invalid_roleplay_media" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present",
				args: { action: "choices", choiceSetId: "outside_the_package" },
			}),
		).toMatchObject({ ok: false, code: "invalid_roleplay_choices" });
		expect(fixture.eventBus.after(afterSeq)).toEqual([]);
	});

	it("does not overwrite an expression the model selected for the current turn", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.appendUser("hello");
		fixture.appendAssistant("hi", "stop");
		fixture.publishChanged(); // seed baseline

		fixture.appendUser("what now");
		fixture.publishChanged();
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "set_expression", visualState: "repair" },
		});
		fixture.appendAssistant("here", "stop");
		fixture.publishChanged();

		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "repair" } });
	});

	it("does not carry model expression suppression into the next turn", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.appendUser("hello");
		fixture.appendAssistant("hi", "stop");
		fixture.publishChanged(); // seed baseline

		fixture.appendUser("what now");
		fixture.publishChanged();
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "set_expression", visualState: "repair" },
		});
		fixture.appendAssistant("here", "stop");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "repair" } });

		fixture.appendUser("next turn");
		fixture.publishChanged();
		fixture.appendAssistant("next answer", "stop");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "ready" } });
	});

	it("clears model expression suppression on failed and aborted turns", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.appendUser("hello");
		fixture.appendAssistant("hi", "stop");
		fixture.publishChanged(); // seed baseline

		// A failed (error) native turn keeps the model expression and ends suppression.
		fixture.appendUser("ask something");
		fixture.publishChanged();
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "set_expression", visualState: "repair" },
		});
		fixture.appendAssistant("", "error");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "repair" } });

		// The next full turn ends with the default reaction.
		fixture.appendUser("retry");
		fixture.publishChanged();
		fixture.appendAssistant("recovered", "stop");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "ready" } });

		// An aborted native turn applies the aborted reaction and clears suppression.
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "set_expression", visualState: "repair" },
		});
		fixture.appendUser("stop this");
		fixture.publishChanged();
		fixture.appendAssistant("", "aborted");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "calm" } });

		fixture.appendUser("continue");
		fixture.publishChanged();
		fixture.appendAssistant("done", "stop");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "ready" } });
	});

	it("applies the same declared presentation when the user chooses a roleplay event", () => {
		const loader = new LegacyRoleplayLoader(characterRoot);
		const fixture = createFixture(loader);
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
		const character = loader.load("jizhou");
		if (!character) throw new Error("missing default character");
		expect(new RoleplayService(fixture.db.orm).project(character, "conversation-1")).toMatchObject({
			values: { continuity_stage: 3 },
			unlocked: ["continuity_record"],
		});
	});

	it("records native session provenance for user-triggered roleplay events", () => {
		const fixture = createFixture(new LegacyRoleplayLoader(characterRoot));
		fixtures.push(fixture);

		fixture.behavior.triggerUserRoleplayEvent({
			conversationId: "conversation-1",
			eventId: "continuity_opened",
			dedupeKey: "user-opened",
		});
		const row = fixture.db.connection
			.prepare("SELECT pi_session_id, source_native_entry_id, event_id FROM roleplay_events")
			.get() as { pi_session_id: string; source_native_entry_id: string; event_id: string };
		expect(row).toEqual({
			pi_session_id: fixture.store.sessionId,
			source_native_entry_id: null,
			event_id: "continuity_opened",
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
		expect(
			fixture.db.connection.prepare("SELECT COUNT(*) AS count FROM scene_state").get(),
		).toEqual({
			count: 0,
		});
	});

	it("rejects corrupt persisted character state instead of resetting it", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.db.connection
			.prepare(
				"INSERT INTO scene_state (id, conversation_id, scene, state_json) VALUES (?, ?, ?, ?)",
			)
			.run("scene-1", "conversation-1", "study", "not-json");

		expect(() =>
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toThrow();
	});
});
