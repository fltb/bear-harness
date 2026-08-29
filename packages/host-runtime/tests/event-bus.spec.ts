// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventPayloadSchemas, type KnownEventKind } from "@bear-harness/protocol/schema";
import { afterEach, describe, expect, it } from "vitest";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

const roots: string[] = [];

const representativePayloads: Record<KnownEventKind, unknown> = {
	"sync.invalidated": { sync: { epoch: "test-host", revision: 1 }, sources: ["conversations"] },
	"conversationAttachment.upload_changed": { conversationId: "conversation-1" },
	"provider.login_changed": { providerId: "openai-codex" },
	"memory.records_changed": {},
	"memory.embedding_download_changed": { status: "downloading", downloadedBytes: 512 },
	"character.imported": { characterId: "character-1", trust: {} },
	"character.pluginsTrusted": { characterId: "character-1", pluginHash: "hash" },
	"character.activated": { characterId: "character-1" },
	"character.seeded": { id: "character-1", name: "Character" },
	"character.scene_changed": {
		conversationId: "conversation-1",
		characterId: "character-1",
		sceneId: "scene-1",
		visualState: "presence",
	},
	"character.visual_state_changed": {
		conversationId: "conversation-1",
		characterId: "character-1",
		sceneId: "scene-1",
		visualState: "listening",
	},
	"character.state_changed": {
		conversationId: "conversation-1",
		revisions: { conversation: 1, relationship: 0, character: 0 },
		schemaHash: "0".repeat(64),
	},
	"roleplay.unlocks_reset": {},
	"roleplay.state_changed": { conversationId: "conversation-1", state: {} },
	"roleplay.media_presented": { conversationId: "conversation-1", mediaId: "media-1" },
	"roleplay.media_dismissed": { conversationId: "conversation-1", mediaId: "media-1" },
	"roleplay.choices_dismissed": { conversationId: "conversation-1" },
	"roleplay.choices_presented": { conversationId: "conversation-1", choiceSetId: "choices-1" },
	"conversation.created": {
		conversationId: "conversation-1",
		title: "A conversation",
	},
	"conversation.selected": { id: "conversation-1" },
	"conversation.renamed": { conversationId: "conversation-1", title: "Renamed" },
	"conversation.archived": { conversationId: "conversation-1", archived: true },
	"conversation.deleted": { conversationId: "conversation-1" },
	"pi.session.changed": {
		conversationId: "conversation-1",
		sessionId: "pi-session-1",
		reason: "message",
	},
	"conversation.branched": {
		conversationId: "conversation-1",
		messageId: "message-1",
		branchId: "branch-1",
	},
	"settings.changed": { settings: {}, changed: [] },
	"diagnostics.memory_capture_failed": { message: "capture failed" },
	"diagnostics.protocol_violation": { channel: "events.subscribe:v1", issues: [] },
	"canon.source_added": {
		companionId: "character-1",
		sourceId: "source-1",
		logicalName: "Source",
	},
	"canon.package_synced": { companionId: "character-1", version: 1 },
	"canon.source_removed": { companionId: "character-1", sourceId: "source-1" },
	"canon.module_saved": { companionId: "character-1", moduleId: "module-1" },
	"canon.module_removed": { companionId: "character-1", moduleId: "module-1" },
	"evidence.collected": { runId: "run-1", evidenceId: "evidence-1", kind: "trace" },
	"run.enqueued": {
		runId: "run-1",
		conversationId: "conversation-1",
		triggerEntryId: "entry-1",
		executorProfile: "pi-default",
	},
	"run.started": { runId: "run-1" },
	"run.completed": { runId: "run-1", status: "completed" },
	"run.needs_user": {
		runId: "run-1",
		prompt: "Choose",
		requestId: "request-1",
		options: [{ optionId: "option-1", kind: "allow", name: "Allow" }],
	},
	"run.steered": { runId: "run-1", instruction: "Continue" },
	"run.interrupted": { runId: "run-1" },
	"run.resumed": { runId: "run-1" },
	"run.cancelled": { runId: "run-1" },
	"companion.tool_started": {
		conversationId: "conversation-1",
		toolCallId: "tool-call-1",
		tool: "host_memory",
		label: "Remember",
	},
	"companion.tool_finished": {
		conversationId: "conversation-1",
		toolCallId: "tool-call-1",
		tool: "host_memory",
		ok: true,
		message: "Saved",
	},
	"companion.state_changed": { state: "running" },
	"companion.runtime_error": { code: "runtime_error" },
	"companion.runtime_ready": {
		conversationId: "conversation-1",
		skills: [],
		tools: [],
	},
	message_start: { conversationId: "conversation-1" },
	message_update: { conversationId: "conversation-1", text: "Update" },
	message_end: { conversationId: "conversation-1", text: "Done", message: {} },
	"message.user_sent": {
		conversationId: "conversation-1",
		messageId: "message-1",
		versionId: "version-1",
		text: "Hello",
	},
	"message.aborted": { conversationId: "conversation-1" },
	"message.regenerated": {
		conversationId: "conversation-1",
		messageId: "message-1",
		versionId: "version-2",
	},
	"message.version_switched": {
		conversationId: "conversation-1",
		messageId: "message-1",
		versionId: "version-1",
	},
	"message.edited": {
		conversationId: "conversation-1",
		messageId: "message-1",
		versionId: "version-2",
	},
	"message.continued": { conversationId: "conversation-1" },
	"message.corrected": {
		conversationId: "conversation-1",
		reason: "Correction",
		applyScope: "once",
	},
	"message.assistant_committed": {
		conversationId: "conversation-1",
		messageId: "message-1",
		versionId: "version-1",
	},
	"codex.consented": {
		profileId: "profile-1",
		canonicalPath: "/usr/local/bin/codex",
		version: "0.147.0",
		sha256: "hash",
		codexHome: "/tmp/codex",
		consentedAt: "2026-01-01T00:00:00.000Z",
	},
	"codex.launched": {
		executor: "codex",
		profileId: "profile-1",
		runId: "run-1",
		triggerEntryId: "entry-1",
		version: "0.147.0",
		sha256: "hash",
		launchedAt: "2026-01-01T00:00:00.000Z",
	},
	"fsops.plan_created": { planId: "plan-1", opCount: 1 },
	"fsops.journal_entry": {
		entryId: "entry-1",
		planId: "plan-1",
		opIndex: 0,
		status: "done",
	},
	"fsops.undo_entry": {
		entryId: "entry-2",
		planId: "plan-1",
		opIndex: 0,
		status: "undone",
	},
	"model.enabled": { providerId: "provider-1", modelId: "model-1" },
	"model.disabled": { providerId: "provider-1", modelId: "model-1" },
	"model.defaults_changed": { kind: "reply" },
	"model.selected": {
		conversationId: "conversation-1",
		providerId: "provider-1",
		modelId: "model-1",
	},
	"onboarding.state_changed": { status: "active", stateData: {} },
	"onboarding.reset": {},
};

function openDatabase(): Database {
	const root = mkdtempSync(join(tmpdir(), "bear-event-bus-"));
	roots.push(root);
	const database = new Database(root);
	database.migrate(MIGRATIONS);
	return database;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event bus domain contract", () => {
	it("delivers nested publications in sequence order to every subscriber", () => {
		const database = openDatabase();
		try {
			const bus = new EventBus(database.orm);
			const early: number[] = [];
			const renderer: number[] = [];
			bus.subscribe((event) => {
				early.push(event.seq);
				if (event.kind === "test.parent") bus.publish("test.child", {});
			});
			bus.subscribe((event) => renderer.push(event.seq));
			bus.publish("test.parent", {});
			expect(early).toEqual([1, 2]);
			expect(renderer).toEqual([1, 2]);
			expect(bus.after(0).map((event) => event.seq)).toEqual(renderer);
		} finally {
			database.close();
		}
	});

	it("accepts representative payloads for every registered event kind", () => {
		const database = openDatabase();
		const bus = new EventBus(database.orm);
		const kinds = Object.keys(EventPayloadSchemas) as KnownEventKind[];

		for (const kind of kinds) {
			expect(() => bus.publish(kind, representativePayloads[kind]), kind).not.toThrow();
		}
		expect(bus.currentSeq).toBe(kinds.length);
		database.close();
	});

	it("validates known payloads before persistence and notifies listeners", () => {
		const database = openDatabase();
		const bus = new EventBus(database.orm);
		const received: unknown[] = [];
		bus.subscribe((event) => received.push(event));

		const event = bus.publish("message_update", {
			conversationId: "conversation-1",
			text: "hello",
		});
		expect(event).toMatchObject({ seq: 1, kind: "message_update", payload: { text: "hello" } });
		expect(received).toHaveLength(1);
		expect(database.connection.prepare("SELECT kind, payload FROM events").all()).toHaveLength(1);
		database.close();
	});

	it("rejects malformed known payloads without advancing sequence or writing a row", () => {
		const database = openDatabase();
		const bus = new EventBus(database.orm);

		expect(() => bus.publish("message_update", { conversationId: "", text: "bad" })).toThrow(
			/invalid domain event payload/,
		);
		expect(bus.currentSeq).toBe(0);
		expect(database.connection.prepare("SELECT * FROM events").all()).toEqual([]);
		database.close();
	});

	it("keeps unknown events forward-compatible only with bounded opaque payloads", () => {
		const database = openDatabase();
		const bus = new EventBus(database.orm);
		const event = bus.publish("workflow.review_requested", { conversationId: "conversation-1" });
		expect(event.kind).toBe("workflow.review_requested");
		expect(bus.after(0)).toEqual([event]);
		expect(() => bus.publish("workflow.oversized", "x".repeat(4097))).toThrow(
			/invalid domain event payload/,
		);
		database.close();
	});

	it("surfaces malformed persisted rows instead of hiding replay gaps", () => {
		const database = openDatabase();
		const bus = new EventBus(database.orm);
		const first = bus.publish("message_update", {
			conversationId: "conversation-1",
			text: "first",
		});
		bus.publish("message_update", {
			conversationId: "conversation-1",
			text: "middle",
		});
		const third = bus.publish("message_update", {
			conversationId: "conversation-1",
			text: "third",
		});
		database.connection
			.prepare("UPDATE events SET payload = ? WHERE seq = ?")
			.run(JSON.stringify({ conversationId: "", text: "invalid" }), 2);

		expect(third.seq).toBe(3);
		expect(() => bus.after(0)).toThrow(/malformed persisted event at sequence 2/);
		expect(bus.after(0, 1)).toEqual([first]);
		database.close();
	});
});
