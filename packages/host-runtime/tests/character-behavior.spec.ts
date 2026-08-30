// @vitest-environment node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterBehaviorService } from "../src/companion/character-behavior.js";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { CompanionStore } from "../src/companion/companion-store.js";
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
	companionStore: CompanionStore;
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
	const companionStore = new CompanionStore(database.orm);
	const behavior = new CharacterBehaviorService(
		database.orm,
		eventBus,
		loader,
		new RoleplayService(database.orm, characterState, companionStore),
		characterState,
		() => ({ sessionId: store.sessionId, sessionManager: store.sessionManager }),
		undefined,
		companionStore,
	);
	return {
		db: database,
		eventBus,
		behavior,
		characterState,
		companionStore,
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
		).toMatchObject({ state: { visualState: "calm" } });
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
		fixture.companionStore.markTurnFailed({
			companionId: character.id,
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			sourceUserEntryId: userEntryId,
			toolCallId: "failed-state-correction",
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
			fixture.companionStore.snapshot(
				new CharacterLoader(characterRoot).load("jizhou")!,
				"conversation-1",
			).display,
		).toMatchObject({
			sceneId: "snowfield",
			expressionId: "reflective",
		});
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

	it("restores committed model-selected visuals on a fork path", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.db.orm
			.insert(conversations)
			.values({ id: "conversation-fork", companionId: "jizhou" })
			.run();
		const userEntryId = fixture.appendUser("move to the archive");
		fixture.publishChanged();
		fixture.behavior.invoke({
			conversationId: "conversation-1",
			piSessionId: fixture.store.sessionId,
			triggerEntryId: userEntryId,
			toolCallId: "visual-fork-source",
			tool: "host_visual",
			args: { action: "update", sceneId: "archive_gallery", expressionId: "alert" },
		});
		const assistantEntryId = fixture.appendAssistant("archive opened", "stop");
		fixture.publishChanged();

		expect(assistantEntryId).toBeTruthy();
		const character = new CharacterLoader(characterRoot).load("jizhou");
		if (!character) throw new Error("missing default character");
		fixture.companionStore.forkConversation({
			character,
			sourceConversationId: "conversation-1",
			targetConversationId: "conversation-fork",
			sourceEntryIds: new Set([userEntryId, assistantEntryId]),
		});
		expect(
			fixture.behavior.invoke({
				conversationId: "conversation-fork",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toMatchObject({ state: { sceneId: "archive_gallery", visualState: "alert" } });
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
			fixture.db.connection
				.prepare("SELECT COUNT(*) AS count FROM companion_state_documents WHERE domain = 'display'")
				.get(),
		).toEqual({
			count: 0,
		});
	});

	it("rejects corrupt persisted character state instead of resetting it", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.db.connection
			.prepare(
				`INSERT INTO companion_state_documents
					(id, companion_id, conversation_id, scope, domain, state_json, schema_hash)
				 VALUES (?, ?, ?, 'conversation', 'display', ?, 'display:v1')`,
			)
			.run("display-corrupt", "jizhou", "conversation-1", "not-json");

		expect(() =>
			fixture.behavior.invoke({
				conversationId: "conversation-1",
				tool: "host_visual",
				args: { action: "read" },
			}),
		).toThrow();
	});
});
