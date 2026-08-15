// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompanionSupervisor } from "../src/companion/supervisor.js";
import { TurnPipeline } from "../src/companion/turn-pipeline.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

describe("TurnPipeline conversation state contract", () => {
	let root: string;
	let database: Database;
	let events: EventBus;
	let commands: Array<Record<string, unknown>>;
	let running: boolean;
	let pipeline: TurnPipeline;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-turn-pipeline-"));
		database = new Database(root);
		database.migrate(MIGRATIONS);
		const db = database.connection;
		db.prepare(
			"INSERT INTO companion_packages (id, name, version, hash) VALUES ('character', 'Character', '1', 'hash')",
		).run();
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('character', 'character', 'Character', '')",
		).run();
		db.prepare(
			"INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'character', 'Chat')",
		).run();
		db.prepare(
			"INSERT INTO branches (id, conversation_id, label, adopted) VALUES ('main', 'conversation', 'main', 1)",
		).run();
		events = new EventBus(db);
		commands = [];
		running = true;
		const supervisor = {
			get isRunning() {
				return running;
			},
			sendCommand(command: Record<string, unknown>) {
				commands.push(command);
			},
		} as unknown as CompanionSupervisor;
		pipeline = new TurnPipeline(db, supervisor, events);
	});

	afterEach(() => {
		pipeline.dispose();
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("persists the user immediately, accepts only one active turn, and commits one streamed reply", async () => {
		const sent = await pipeline.sendUserMessage("conversation", "你是谁？");
		const user = database.connection
			.prepare("SELECT content FROM message_versions WHERE id = ?")
			.get(sent.versionId) as { content: string };
		expect(user.content).toBe("你是谁？");
		expect(commands).toEqual([
			{
				type: "prompt",
				conversationId: "conversation",
				message: "你是谁？",
				streamingBehavior: "followUp",
			},
		]);
		await expect(pipeline.sendUserMessage("conversation", "重复发送")).rejects.toMatchObject({
			kind: "conflict",
			reason: "turn_already_active",
		});

		events.publish("message_end", { conversationId: "conversation", text: "我是你的伙伴。" });
		events.publish("message_end", { conversationId: "conversation", text: "不应重复落库" });
		const messages = database.connection
			.prepare(
				"SELECT m.role, v.content FROM messages m JOIN message_versions v ON v.message_id = m.id ORDER BY m.rowid",
			)
			.all();
		expect(messages).toEqual([
			{ role: "user", content: "你是谁？" },
			{ role: "assistant", content: "我是你的伙伴。" },
		]);
		expect(pipeline.hasActiveTurn("conversation")).toBe(false);
	});

	it("regenerates from the explicit turn parent even when timestamps are identical", async () => {
		await pipeline.sendUserMessage("conversation", "原问题");
		events.publish("message_end", { conversationId: "conversation", text: "原回答" });
		const assistant = database.connection
			.prepare("SELECT id FROM messages WHERE role = 'assistant'")
			.get() as { id: string };

		const regenerated = await pipeline.regenerate("conversation", assistant.id);
		expect(commands.at(-1)).toMatchObject({ type: "prompt", message: "原问题" });
		events.publish("message_end", { conversationId: "conversation", text: "新回答" });
		const versions = database.connection
			.prepare(
				"SELECT id, content, adopted FROM message_versions WHERE message_id = ? ORDER BY rowid",
			)
			.all(assistant.id);
		expect(versions).toEqual([
			expect.objectContaining({ content: "原回答", adopted: 0 }),
			{ id: regenerated.versionId, content: "新回答", adopted: 1 },
		]);
	});

	it("edits user history into an adopted branch and uses the edited text for the new response", async () => {
		const sent = await pipeline.sendUserMessage("conversation", "旧问题");
		events.publish("message_end", { conversationId: "conversation", text: "旧回答" });
		await pipeline.edit("conversation", sent.messageId, "新问题", true);
		expect(commands.at(-1)).toMatchObject({ type: "prompt", message: "新问题" });
		expect(pipeline.hasActiveTurn("conversation")).toBe(true);
		events.publish("message_end", { conversationId: "conversation", text: "新回答" });
		const adopted = database.connection
			.prepare(
				"SELECT content, edited_by_user FROM message_versions WHERE message_id = ? AND adopted = 1",
			)
			.get(sent.messageId);
		const branches = database.connection
			.prepare(
				"SELECT label, adopted FROM branches WHERE conversation_id = 'conversation' ORDER BY rowid",
			)
			.all();
		expect(adopted).toEqual({ content: "新问题", edited_by_user: 1 });
		expect(branches).toEqual([
			{ label: "main", adopted: 0 },
			{ label: "edited", adopted: 1 },
		]);
	});

	it("handles abort, continuation, correction, branching, and unavailable runtime", async () => {
		const sent = await pipeline.sendUserMessage("conversation", "开始");
		await pipeline.abort("conversation");
		expect(commands.at(-1)).toEqual({ type: "abort", conversationId: "conversation" });
		await pipeline.abort("conversation");
		await pipeline.continue("conversation");
		await pipeline.correct("conversation", "不要替我做决定", "always");
		const branchId = await pipeline.branch("conversation", sent.messageId);
		const directive = database.connection
			.prepare("SELECT directive, scope FROM conversation_directives")
			.get();
		expect(directive).toEqual({ directive: "不要替我做决定", scope: "always" });
		expect(branchId).toEqual(expect.any(String));
		running = false;
		await expect(pipeline.continue("conversation")).rejects.toMatchObject({
			kind: "unavailable",
			reason: "companion_unavailable",
		});
		await expect(pipeline.sendUserMessage("conversation", "不可发送")).rejects.toMatchObject({
			kind: "unavailable",
		});
	});

	it("stores a usable failure message and allows switching assistant versions without a model call", async () => {
		await pipeline.sendUserMessage("conversation", "会失败吗");
		events.publish("message_end", { conversationId: "conversation", failed: true });
		const assistant = database.connection
			.prepare(
				"SELECT m.id, v.id AS versionId, v.content FROM messages m JOIN message_versions v ON v.message_id = m.id WHERE m.role = 'assistant'",
			)
			.get() as { id: string; versionId: string; content: string };
		expect(assistant.content).toContain("回复没有完成");
		await pipeline.edit("conversation", assistant.id, "人工修正版", false);
		const edited = database.connection
			.prepare("SELECT id FROM message_versions WHERE message_id = ? AND adopted = 1")
			.get(assistant.id) as { id: string };
		const commandCount = commands.length;
		await pipeline.switchVersion("conversation", assistant.id, assistant.versionId);
		expect(commands).toHaveLength(commandCount);
		expect(
			database.connection
				.prepare("SELECT adopted FROM message_versions WHERE id = ?")
				.get(edited.id),
		).toEqual({ adopted: 0 });
		await expect(
			pipeline.switchVersion("conversation", assistant.id, "missing-version"),
		).rejects.toMatchObject({ kind: "not_found", reason: "version_not_found" });
	});
});
