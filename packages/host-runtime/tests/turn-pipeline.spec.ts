// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiSessionMessage } from "../src/companion/pi-session-store.js";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
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
	let supervisor: CompanionSupervisor;
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
		events = new EventBus(database.orm);
		commands = [];
		running = true;
		supervisor = {
			get isRunning() {
				return running;
			},
			sendCommand(command: Record<string, unknown>) {
				commands.push(command);
			},
		} as unknown as CompanionSupervisor;
		pipeline = new TurnPipeline(database.orm, supervisor, events);
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
				triggerMessageId: sent.messageId,
				message: "你是谁？",
				images: [],
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
		const sent = await pipeline.sendUserMessage("conversation", "原问题");
		events.publish("message_end", { conversationId: "conversation", text: "原回答" });
		const assistant = database.connection
			.prepare("SELECT id FROM messages WHERE role = 'assistant'")
			.get() as { id: string };

		const regenerated = await pipeline.regenerate("conversation", assistant.id);
		expect(commands.at(-1)).toMatchObject({
			type: "prompt",
			message:
				"请基于上面的对话重新生成对上一条用户消息的回复。直接自然地回答，不要提及重新生成或比较旧回复。",
		});
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
		const regeneratedTurn = database.connection
			.prepare(
				"SELECT t.user_message_id AS userMessageId, v.id AS assistantVersionId FROM turns t JOIN message_versions v ON v.message_id = t.assistant_message_id AND v.adopted = 1 WHERE t.assistant_message_id = ? ORDER BY t.rowid DESC LIMIT 1",
			)
			.get(assistant.id);
		expect(regeneratedTurn).toEqual({
			userMessageId: sent.messageId,
			assistantVersionId: regenerated.versionId,
		});
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

	it("adopts one regenerated assistant version after an edited user branch", async () => {
		pipeline.dispose();
		const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
		store.appendUserMessage("旧问题");
		store.appendSyntheticAssistant("旧回答");
		pipeline = new TurnPipeline(database.orm, supervisor, events, { get: () => store });

		const sent = await pipeline.sendUserMessage("conversation", "旧问题");
		events.publish("message_end", { conversationId: "conversation", text: "旧回答" });
		await pipeline.edit("conversation", sent.messageId, "编辑后的问题", true);
		events.publish("message_end", { conversationId: "conversation", text: "EDITED_OK" });
		const assistant = database.connection
			.prepare("SELECT id FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1")
			.get() as { id: string };

		await pipeline.regenerate("conversation", assistant.id);
		events.publish("message_end", {
			conversationId: "conversation",
			text: "REGENERATED_EDITED_OK",
		});

		const versions = database.connection
			.prepare("SELECT content, adopted FROM message_versions WHERE message_id = ? ORDER BY rowid")
			.all(assistant.id);
		expect(versions).toEqual([
			{ content: "EDITED_OK", adopted: 0 },
			{ content: "REGENERATED_EDITED_OK", adopted: 1 },
		]);
		expect(
			database.connection
				.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'")
				.get(),
		).toEqual({ count: 2 });
		expect(
			store.readMessageEntries().filter(({ message }) => message.role === "assistant"),
		).toHaveLength(1);
	});

	it("keeps the raw Pi context on the edited first-user branch", async () => {
		pipeline.dispose();
		const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
		const originalUser = store.appendUserMessage("original user");
		store.appendSyntheticAssistant("assistant continuation");
		const supervisor = {
			get isRunning() {
				return running;
			},
			sendCommand(command: Record<string, unknown>) {
				commands.push(command);
			},
		} as unknown as CompanionSupervisor;
		pipeline = new TurnPipeline(database.orm, supervisor, events, { get: () => store });

		await pipeline.edit("conversation", originalUser, "edited user", true);

		expect(store.buildContext().messages).toEqual([
			expect.objectContaining({ role: "user", content: "edited user" }),
		]);
		expect(commands.at(-1)).toMatchObject({ type: "prompt", message: "edited user" });
	});

	it("continues and corrects with explicit instructions that create persisted assistant turns", async () => {
		const sent = await pipeline.sendUserMessage("conversation", "开始");
		events.publish("message_end", { conversationId: "conversation", text: "初始回答" });

		await pipeline.continue("conversation");
		expect(commands.at(-1)).toMatchObject({
			type: "prompt",
			message: "请继续上一条回复。不要重复已经说过的内容，直接接着完成。",
		});
		events.publish("message_end", { conversationId: "conversation", text: "续写内容" });

		await pipeline.correct("conversation", "不要替我做决定", "always");
		expect(commands.at(-1)).toMatchObject({
			type: "prompt",
			message: expect.stringContaining("用户刚刚指出上一条回复的问题：“不要替我做决定”"),
		});
		events.publish("message_end", { conversationId: "conversation", text: "修正后的回答" });
		const replies = database.connection
			.prepare("SELECT content FROM message_versions ORDER BY rowid")
			.all() as Array<{ content: string }>;
		expect(replies.map((reply) => reply.content)).toEqual([
			"开始",
			"初始回答",
			"续写内容",
			"修正后的回答",
		]);
		const directive = database.connection
			.prepare("SELECT directive, scope FROM conversation_directives")
			.get();
		expect(directive).toEqual({ directive: "不要替我做决定", scope: "always" });
		const branchId = await pipeline.branch("conversation", sent.messageId);
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

	it("persists a structured safe failure outcome for a provider turn", async () => {
		await pipeline.sendUserMessage("conversation", "会失败吗");
		events.publish("message_end", {
			conversationId: "conversation",
			failed: true,
			status: "failed",
			reason: "provider_request_failed",
		});
		const assistant = database.connection
			.prepare(
				"SELECT m.id, v.id AS versionId, v.content FROM messages m JOIN message_versions v ON v.message_id = m.id WHERE m.role = 'assistant'",
			)
			.get() as { id: string; versionId: string; content: string };
		expect(assistant.content).toContain("provider_request_failed");
		expect(
			database.connection
				.prepare("SELECT status FROM turns WHERE assistant_message_id = ?")
				.get(assistant.id),
		).toEqual({ status: "failed" });
		const committed = events
			.after(0)
			.find((event) => event.kind === "message.assistant_committed");
		expect(committed?.payload).toMatchObject({
			failed: true,
			status: "failed",
			reason: "provider_request_failed",
		});
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

	it("lets native Pi append the user and final assistant exactly once before committing Host state", async () => {
		pipeline.dispose();
		const nativeEntries: Array<{ id: string; message: PiSessionMessage }> = [];
		let nativeLeaf: { type: "message"; id: string; message: PiSessionMessage } | undefined;
		const session = {
			get currentLeaf() {
				return nativeLeaf;
			},
			appendMessage(message: PiSessionMessage) {
				const id = `pi-${nativeEntries.length + 1}`;
				nativeEntries.push({ id, message });
				nativeLeaf = { type: "message", id, message };
				return id;
			},
		};
		const nativeSupervisor = {
			get isRunning() {
				return true;
			},
			sendCommand() {},
		} as unknown as CompanionSupervisor;
		pipeline = new TurnPipeline(database.orm, nativeSupervisor, events, {
			get: () => session,
		});

		await pipeline.sendUserMessage("conversation", "原生请求");
		expect(nativeEntries).toEqual([]);

		session.appendMessage({ role: "user", content: "原生请求", timestamp: Date.now() });
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "原生回答" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as PiSessionMessage;
		session.appendMessage(assistant);
		events.publish("message_end", {
			conversationId: "conversation",
			text: "原生回答",
			message: assistant,
		});

		expect(nativeEntries.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
		expect(nativeLeaf?.message).toBe(assistant);
		expect(
			database.connection
				.prepare(
					"SELECT m.role, v.content FROM messages m JOIN message_versions v ON v.message_id = m.id ORDER BY m.rowid",
				)
				.all(),
		).toEqual([
			{ role: "user", content: "原生请求" },
			{ role: "assistant", content: "原生回答" },
		]);
	});

	it("accepts Pi entry IDs for regenerate, edit, branch, and version switching without legacy DB lookup", async () => {
		pipeline.dispose();
		type FakeEntry = { id: string; parentId: string | null; message: PiSessionMessage };
		const entries: FakeEntry[] = [
			{
				id: "pi-user-1",
				parentId: null,
				message: {
					role: "user",
					content:
						"<host_context>\n已知背景\n</host_context>\n\n<current_user_message>\n原问题\n</current_user_message>",
					timestamp: 1,
				},
			},
			{
				id: "pi-assistant-1",
				parentId: "pi-user-1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "原回答" }],
					api: "openai-completions",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				} as PiSessionMessage,
			},
		];
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		let leaf: FakeEntry | undefined;
		const piCalls: string[] = [];
		const assistantMessage = (text: string): PiSessionMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const session = {
			get currentLeaf() {
				return leaf ? { type: "message" as const, id: leaf.id, message: leaf.message } : undefined;
			},
			appendMessage(message: PiSessionMessage) {
				const id = `pi-${entries.length + 1}`;
				const entry: FakeEntry = { id, parentId: leaf?.id ?? null, message };
				entries.push(entry);
				byId.set(id, entry);
				leaf = entry;
				return id;
			},
			findMessageEntry(role: "user" | "assistant", content: string) {
				const text = content.trim();
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const entry = entries[index];
					if (entry.message.role !== role) continue;
					const entryText =
						typeof entry.message.content === "string"
							? entry.message.content.trim()
							: entry.message.content
									.filter((part) => part?.type === "text" && typeof part.text === "string")
									.map((part) => part.text)
									.join("")
									.trim();
					if (entryText === text) return { id: entry.id, message: entry.message };
				}
				return undefined;
			},
			getMessageEntry(entryId: string) {
				const entry = byId.get(entryId);
				return entry ? { id: entry.id, message: entry.message } : undefined;
			},
			isEntryOnCurrentBranch(entryId: string) {
				return byId.has(entryId);
			},
			findParentUserEntry(entryId: string) {
				let current = byId.get(entryId);
				while (current?.parentId) {
					const parent = byId.get(current.parentId);
					if (!parent) return undefined;
					if (parent.message.role === "user") return { id: parent.id, message: parent.message };
					current = parent;
				}
				return undefined;
			},
			selectBranch(leafId: string) {
				piCalls.push(`selectBranch:${leafId}`);
				leaf = byId.get(leafId);
			},
			branchBefore(entryId: string) {
				piCalls.push(`branchBefore:${entryId}`);
				leaf = byId.get(byId.get(entryId)?.parentId ?? "");
			},
			appendUserMessage(text: string) {
				piCalls.push(`appendUserMessage:${text}`);
				return session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			},
			appendSyntheticAssistant(text: string) {
				piCalls.push(`appendSyntheticAssistant:${text}`);
				return session.appendMessage(assistantMessage(text));
			},
		};
		commands = [];
		const supervisor = {
			get isRunning() {
				return true;
			},
			sendCommand(command: Record<string, unknown>) {
				commands.push(command);
			},
		} as unknown as CompanionSupervisor;
		pipeline = new TurnPipeline(database.orm, supervisor, events, {
			get: () => session,
		});
		database.connection
			.prepare(
				"INSERT INTO branches (id, conversation_id, label, adopted) VALUES ('other', 'conversation', 'other', 0)",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO messages (id, conversation_id, branch_id, role) VALUES ('host-main-assistant', 'conversation', 'main', 'assistant'), ('host-other-assistant', 'conversation', 'other', 'assistant')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO message_versions (id, message_id, content, edited_by_user, adopted) VALUES ('host-main-assistant-v1', 'host-main-assistant', '原回答', 0, 1), ('host-other-assistant-v1', 'host-other-assistant', '原回答', 0, 1)",
			)
			.run();

		const regenerated = await pipeline.regenerate("conversation", "pi-assistant-1");
		expect(regenerated.messageId).toBe("pi-assistant-1");
		expect(piCalls).toContain("branchBefore:pi-assistant-1");
		expect(commands.at(-1)).toMatchObject({
			type: "prompt",
			message: expect.stringContaining("重新生成"),
		});
		expect(
			database.connection
				.prepare(
					"SELECT v.content FROM messages m JOIN message_versions v ON v.message_id = m.id WHERE m.role = 'user' AND v.adopted = 1",
				)
				.all(),
		).toEqual([{ content: "原问题" }]);
		events.publish("message_end", {
			conversationId: "conversation",
			text: "新回答",
			message: assistantMessage("新回答"),
		});
		expect(pipeline.hasActiveTurn("conversation")).toBe(false);
		expect(
			database.connection
				.prepare(
					"SELECT m.id, v.content, v.adopted FROM messages m JOIN message_versions v ON v.message_id = m.id WHERE m.id IN ('host-main-assistant', 'host-other-assistant') ORDER BY m.id, v.rowid",
				)
				.all(),
		).toEqual([
			{ id: "host-main-assistant", content: "原回答", adopted: 0 },
			{ id: "host-main-assistant", content: "新回答", adopted: 1 },
			{ id: "host-other-assistant", content: "原回答", adopted: 1 },
		]);

		await pipeline.edit("conversation", "pi-user-1", "新问题", true);
		expect(piCalls).toContain("branchBefore:pi-user-1");
		expect(piCalls).toContain("appendUserMessage:新问题");
		expect(commands.at(-1)).toMatchObject({ type: "prompt", message: "新问题" });
		events.publish("message_end", {
			conversationId: "conversation",
			text: "新答复",
			message: assistantMessage("新答复"),
		});

		const branchId = await pipeline.branch("conversation", "pi-assistant-1");
		expect(piCalls).toContain("selectBranch:pi-assistant-1");
		const fork = database.connection
			.prepare("SELECT fork_message_id AS forkMessageId FROM branches WHERE id = ?")
			.get(branchId) as { forkMessageId: string };
		expect(fork.forkMessageId).not.toBe("pi-assistant-1");
		expect(
			database.connection
				.prepare(
					"SELECT id FROM messages WHERE id = ? AND conversation_id = 'conversation' AND role = 'assistant'",
				)
				.get(fork.forkMessageId),
		).toBeTruthy();

		const switchCalls = piCalls.length;
		await pipeline.switchVersion("conversation", "pi-assistant-1", "pi-assistant-1-v1");
		expect(piCalls.slice(switchCalls)).toContain("selectBranch:pi-assistant-1");
		await expect(
			pipeline.switchVersion("conversation", "pi-assistant-1", "missing-version"),
		).rejects.toMatchObject({ kind: "not_found", reason: "version_not_found" });

		await pipeline.edit("conversation", "pi-assistant-1", "人工修订", false);
		expect(piCalls).toContain("branchBefore:pi-assistant-1");
		expect(piCalls).toContain("appendSyntheticAssistant:人工修订");

		await expect(
			pipeline.regenerate("conversation", "definitely-not-a-pi-id"),
		).rejects.toMatchObject({ kind: "not_found", reason: "message_not_found" });
	});

	describe("turn committed sink", () => {
		it("feeds the settled turn to the memory capture sink with the user text", async () => {
			const committed: Array<{
				conversationId: string;
				userText: string;
				assistantText: string;
			}> = [];
			const sinkPipeline = new TurnPipeline(database.orm, supervisor, events, undefined, {
				onTurnCommitted: (turn) => committed.push(turn),
			});
			try {
				await sinkPipeline.sendUserMessage("conversation", "记住我的话");
				events.publish("message_end", {
					conversationId: "conversation",
					text: "好的，我记住了。",
				});
				expect(committed).toHaveLength(1);
				expect(committed[0]).toMatchObject({
					conversationId: "conversation",
					userText: "记住我的话",
					assistantText: "好的，我记住了。",
				});
			} finally {
				sinkPipeline.dispose();
			}
		});

		it("never blocks the reply when the sink throws", async () => {
			const sinkPipeline = new TurnPipeline(database.orm, supervisor, events, undefined, {
				onTurnCommitted: () => {
					throw new Error("memory capture exploded");
				},
			});
			try {
				await sinkPipeline.sendUserMessage("conversation", "触发异常");
				events.publish("message_end", {
					conversationId: "conversation",
					text: "仍然落库",
				});
				const version = database.connection
					.prepare(
						"SELECT content FROM message_versions v JOIN messages m ON m.id = v.message_id WHERE m.role = 'assistant'",
					)
					.get() as { content: string };
				expect(version.content).toBe("仍然落库");
			} finally {
				sinkPipeline.dispose();
			}
		});
	});
});
