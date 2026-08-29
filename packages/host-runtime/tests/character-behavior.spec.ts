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
	characterState: CharacterStateService;
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

	const characterState = new CharacterStateService(database.orm);
	const behavior = new CharacterBehaviorService(
		database.orm,
		eventBus,
		loader,
		new RoleplayService(database.orm, characterState),
		characterState,
		() => ({ sessionId: store.sessionId, sessionManager: store.sessionManager }),
	);
	return {
		db: database,
		eventBus,
		behavior,
		characterState,
		store,
		appendUser,
		appendAssistant,
		publishChanged,
	};
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

	it("commits staged cards only with a completed Pi response and rolls back provisional visuals", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const character = new CharacterLoader(characterRoot).load("jizhou");
		if (!character) throw new Error("missing default character");
		const roleplay = new RoleplayService(fixture.db.orm);
		const firstUser = fixture.appendUser("打开未送达的回报入口");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				piSessionId: fixture.store.sessionId,
				triggerEntryId: firstUser,
				toolCallId: "present-1",
				tool: "host_present",
				args: { action: "present_choices", choiceSetId: "undelivered_entry" },
			}),
		).toMatchObject({ ok: true, message: expect.stringContaining("staged") });
		expect(roleplay.presentation(character, "conversation-1").choiceSetId).toBeUndefined();
		fixture.appendAssistant("入口在这里。", "stop");
		fixture.publishChanged();
		expect(roleplay.presentation(character, "conversation-1").choiceSetId).toBe(
			"undelivered_entry",
		);

		const secondUser = fixture.appendUser("试着切换表情后中止");
		fixture.publishChanged();
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			triggerEntryId: secondUser,
			toolCallId: "visual-1",
			tool: "host_visual",
			args: { action: "update", expressionId: "reflective" },
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "reflective" } });
		fixture.appendAssistant("", "aborted");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { visualState: "calm" } });
	});

	it("discards the whole turn journal when any Host effect fails", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const character = new CharacterLoader(characterRoot).load("jizhou");
		if (!character) throw new Error("missing default character");
		const roleplay = new RoleplayService(fixture.db.orm);
		const userEntryId = fixture.appendUser("先告诉我发现了什么，不要替我进入调查");
		fixture.publishChanged();
		fixture.characterState.stage({
			companionId: character.id,
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			sourceUserEntryId: userEntryId,
			definition: character.state,
			operations: [{ path: "/story/undelivered_report/phase", op: "replace", value: "invited" }],
			reason: "A state mutation was staged before a later Host rejection.",
			skillId: "undelivered-report",
			evidence: { source: "current_user", quote: "不要替我进入调查" },
		});
		fixture.eventBus.publish("companion.effect_staged", {
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			sourceUserEntryId: userEntryId,
			toolCallId: "choices-before-failure",
			kind: "choices",
			presentationId: "undelivered_entry",
		});
		fixture.eventBus.publish("companion.turn_effect_failed", {
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			sourceUserEntryId: userEntryId,
			toolCallId: "failed-state-correction",
			tool: "host_state",
			code: "state_transition_not_allowed",
		});
		fixture.appendAssistant("工具失败，状态没有改变。", "stop");
		fixture.publishChanged();
		expect(
			fixture.characterState.project(character.id, "conversation-1", character.state).document,
		).toMatchObject({ story: { undelivered_report: { phase: "dormant" } } });
		expect(roleplay.presentation(character, "conversation-1").choiceSetId).toBeUndefined();
	});

	it("does not settle staged effects on intermediate Pi tool-use assistant entries", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const character = new CharacterLoader(characterRoot).load("jizhou");
		if (!character) throw new Error("missing default character");
		const roleplay = new RoleplayService(fixture.db.orm);
		const userEntryId = fixture.appendUser("打开剧情入口");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				piSessionId: fixture.store.sessionId,
				triggerEntryId: userEntryId,
				toolCallId: "choices-after-tool-use",
				tool: "host_present",
				args: { action: "present_choices", choiceSetId: "undelivered_entry" },
			}),
		).toMatchObject({ ok: true });
		fixture.appendAssistant("calling a tool", "toolUse");
		fixture.publishChanged();
		expect(roleplay.presentation(character, "conversation-1").choiceSetId).toBeUndefined();
		fixture.appendAssistant("入口已经准备好。", "stop");
		fixture.publishChanged();
		expect(roleplay.presentation(character, "conversation-1").choiceSetId).toBe(
			"undelivered_entry",
		);
	});

	it("uses pending story state for same-turn CG gates and never duplicates a staged CG", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const character = new CharacterLoader(characterRoot).load("jizhou");
		if (!character) throw new Error("missing default character");
		fixture.behavior.triggerUserRoleplayEvent({
			conversationId: "conversation-1",
			eventId: "story_enter",
			dedupeKey: "story-enter",
		});
		const userEntryId = fixture.appendUser("检查现有的损坏信号。");
		fixture.publishChanged();
		fixture.characterState.stage({
			companionId: character.id,
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			sourceUserEntryId: userEntryId,
			definition: character.state,
			operations: [
				{ path: "/story/undelivered_report/phase", op: "replace", value: "signal_examined" },
				{ path: "/story/undelivered_report/position", op: "replace", value: "evidence" },
				{ path: "/narrative/frame", op: "replace", value: "archive_record" },
				{ path: "/narrative/location", op: "replace", value: "quiet_terminal" },
				{ path: "/narrative/time_anchor", op: "replace", value: "damaged_signal_record" },
				{ path: "/narrative/evidence_mode", op: "replace", value: "direct_record" },
			],
			reason: "The user asked to inspect the existing signal record.",
			skillId: "undelivered-report",
			evidence: { source: "current_user", quote: "检查现有的损坏信号。" },
		});
		const call = {
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			triggerEntryId: userEntryId,
			toolCallId: "damaged-signal-media",
			tool: "host_present",
			args: { action: "present_media", mediaId: "damaged_signal" },
		};
		expect(fixture.behavior.invoke(call)).toMatchObject({
			ok: true,
			message: expect.stringContaining("staged"),
		});
		expect(fixture.behavior.invoke(call)).toMatchObject({
			ok: true,
			message: expect.stringContaining("already staged"),
		});
		expect(
			new RoleplayService(fixture.db.orm).presentation(character, "conversation-1").mediaId,
		).toBeUndefined();
		fixture.characterState.commitTurn({
			companionId: character.id,
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			sourceUserEntryId: userEntryId,
			assistantEntryId: "assistant-signal",
			definition: character.state,
		});
		fixture.appendAssistant("记录已展开。", "stop");
		fixture.publishChanged();
		expect(
			new RoleplayService(fixture.db.orm).presentation(character, "conversation-1"),
		).toMatchObject({ mediaId: "damaged_signal", seenMediaIds: ["damaged_signal"] });
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
			args: { action: "update", sceneId: "snowfield" },
		});
		expect(changedScene).toMatchObject({ ok: true, state: { sceneId: "snowfield" } });

		const changedExpression = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "update", expressionId: "reflective" },
		});
		expect(changedExpression).toMatchObject({ ok: true, state: { visualState: "reflective" } });

		const rejected = fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "update", sceneId: "outside_the_package" },
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

	it("does not overwrite stable semantic visuals from generic Pi lifecycle events", () => {
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

		// Generic activity is projected separately and never mutates stable semantics.
		fixture.appendUser("what now");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "calm" } });

		// Completion also preserves the last stable semantic expression.
		fixture.appendAssistant("here", "stop");
		fixture.publishChanged();
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { sceneId: "study", visualState: "calm" } });

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
		expect(events.filter((kind) => kind === "pi.session.changed")).toHaveLength(5);
		expect(events.filter((kind) => kind === "companion.turn_effects_settled")).toHaveLength(3);
	});

	it("rejects an undeclared expression in an automatic reaction", () => {
		const configRoot = mkdtempSync(join(tmpdir(), "bear-character-host-reaction-"));
		temporaryDirectories.push(configRoot);
		const packageDir = join(configRoot, "jizhou");
		cpSync(resolve(characterRoot, "jizhou"), packageDir, { recursive: true });
		const manifestPath = join(packageDir, "character.yaml");
		const manifest = readFileSync(manifestPath, "utf8");
		writeFileSync(
			manifestPath,
			manifest.replace(
				"  event_reactions: []",
				"  event_reactions:\n    - event: custom.bad\n      visual_state: outside_the_package",
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
				"  event_reactions: []",
				"  event_reactions:\n    - event: workflow.review_requested\n      visual_state: reflective",
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
				args: { action: "present_media", mediaId: "continuity_light" },
			}),
		).toMatchObject({ ok: false, code: "roleplay_media_locked" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present",
				args: { action: "present_media", mediaId: "outside_the_package" },
			}),
		).toMatchObject({ ok: false, code: "invalid_roleplay_media" });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present",
				args: { action: "present_choices", choiceSetId: "outside_the_package" },
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
			args: { action: "update", expressionId: "repair" },
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
			args: { action: "update", expressionId: "repair" },
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
		).toMatchObject({ state: { visualState: "repair" } });
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
			args: { action: "update", expressionId: "repair" },
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
		).toMatchObject({ state: { visualState: "repair" } });

		// An aborted native turn applies the aborted reaction and clears suppression.
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			tool: "host_visual",
			args: { action: "update", expressionId: "repair" },
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
		).toMatchObject({ state: { visualState: "repair" } });

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
		).toMatchObject({ state: { visualState: "repair" } });
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
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present",
				args: { action: "dismiss", presentationId: "continuity_light" },
			}),
		).toMatchObject({ ok: true });
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_present",
				args: { action: "present_media", mediaId: "continuity_light" },
			}),
		).toMatchObject({ ok: false, code: "roleplay_media_already_seen" });
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
