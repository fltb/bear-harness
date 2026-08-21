// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiSessionMessage } from "../src/companion/pi-session-store.js";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
import { ConversationRepository } from "../src/conversations/repository.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";

describe("PiSessionStore", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("creates, appends, branches, reopens, and rebuilds context through SessionManager", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-session-"));
		roots.push(root);
		const sessionDir = join(root, "product-sessions");
		const store = PiSessionStore.create({ sessionDir, cwd: root });
		const user = store.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const assistant = store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
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
			stopReason: "stop",
			timestamp: 2,
		} as PiSessionMessage);
		store.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "lookup",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 3,
		});

		expect(store.metadata).toMatchObject({
			sessionId: expect.any(String),
			sessionFile: expect.stringContaining(sessionDir),
			leafId: expect.any(String),
		});
		expect(store.readMessages()).toHaveLength(3);
		store.selectBranch(user);
		const alternate = store.appendMessage({ role: "user", content: "alternate", timestamp: 4 });
		expect(store.leafId).toBe(alternate);
		expect(store.readMessages().map((message) => message.role)).toEqual(["user", "user"]);

		const reopened = PiSessionStore.open({ sessionDir, sessionFile: store.sessionFile, cwd: root });
		expect(reopened.sessionId).toBe(store.sessionId);
		expect(reopened.leafId).toBe(alternate);
		expect(reopened.buildContext().messages.map((message) => message.role)).toEqual([
			"user",
			"user",
		]);
		reopened.selectBranch(assistant);
		expect(reopened.buildContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("builds an edited first-user branch context from raw Pi messages only", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-edited-branch-"));
		roots.push(root);
		const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
		const originalUser = store.appendUserMessage("original user");
		store.appendSyntheticAssistant("assistant continuation");

		store.branchBefore(originalUser);
		store.appendUserMessage("edited user");

		expect(store.buildContext().messages).toEqual([
			expect.objectContaining({ role: "user", content: "edited user" }),
		]);
	});

	it("keeps a user-only active tail runtime-only until an assistant entry is appended", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-pending-tail-"));
		roots.push(root);
		const sessionDir = join(root, "sessions");
		const store = PiSessionStore.create({ sessionDir, cwd: root });
		const sessionFile = store.sessionFile;
		const userId = store.appendUserMessage("pending prompt", 1);

		expect(store.sessionManager.getEntries()).toHaveLength(1);
		expect(store.findMessageEntry("user", "pending prompt")).toMatchObject({ id: userId });
		expect(existsSync(sessionFile)).toBe(false);

		const reopenedBeforeAssistant = PiSessionStore.open({ sessionDir, sessionFile, cwd: root });
		expect(reopenedBeforeAssistant.readMessageEntries()).toEqual([]);
		expect(reopenedBeforeAssistant.findMessageEntry("user", "pending prompt")).toBeUndefined();

		const assistantId = store.appendSyntheticAssistant("completed response");
		expect(existsSync(sessionFile)).toBe(true);

		const reopenedAfterAssistant = PiSessionStore.open({ sessionDir, sessionFile, cwd: root });
		expect(reopenedAfterAssistant.readMessageEntries().map(({ id }) => id)).toEqual([
			userId,
			assistantId,
		]);
		expect(reopenedAfterAssistant.findMessageEntry("user", "pending prompt")).toMatchObject({
			id: userId,
		});
	});

	it("persists user edits, synthetic assistant edits, and regenerated sibling context through SessionManager", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-actions-"));
		roots.push(root);
		const sessionDir = join(root, "sessions");
		const store = PiSessionStore.create({ sessionDir, cwd: root });

		store.appendUserMessage("opening prompt");
		store.appendSyntheticAssistant("opening response");
		const originalUser = store.appendUserMessage("original prompt");
		const originalAssistant = store.appendSyntheticAssistant("original response");

		store.branchBefore(originalUser);
		store.appendUserMessage("edited prompt");
		const editedAssistant = store.appendSyntheticAssistant("response to edited prompt");

		store.branchBefore(originalAssistant);
		const regeneratedAssistant = store.appendSyntheticAssistant("regenerated response");

		const reopened = PiSessionStore.open({ sessionDir, sessionFile: store.sessionFile, cwd: root });
		expect(reopened.leafId).toBe(regeneratedAssistant);
		expect(reopened.readMessages().map(({ role, content }) => ({ role, content }))).toEqual([
			{ role: "user", content: "opening prompt" },
			{ role: "assistant", content: [{ type: "text", text: "opening response" }] },
			{ role: "user", content: "original prompt" },
			{ role: "assistant", content: [{ type: "text", text: "regenerated response" }] },
		]);
		expect(
			reopened.buildContext().messages.map(({ role, content }) => ({ role, content })),
		).toEqual([
			{ role: "user", content: "opening prompt" },
			{ role: "assistant", content: [{ type: "text", text: "opening response" }] },
			{ role: "user", content: "original prompt" },
			{ role: "assistant", content: [{ type: "text", text: "regenerated response" }] },
		]);

		reopened.selectBranch(editedAssistant);
		expect(reopened.readMessages().map(({ role, content }) => ({ role, content }))).toEqual([
			{ role: "user", content: "opening prompt" },
			{ role: "assistant", content: [{ type: "text", text: "opening response" }] },
			{ role: "user", content: "edited prompt" },
			{ role: "assistant", content: [{ type: "text", text: "response to edited prompt" }] },
		]);
		expect(
			reopened.buildContext().messages.map(({ role, content }) => ({ role, content })),
		).toEqual([
			{ role: "user", content: "opening prompt" },
			{ role: "assistant", content: [{ type: "text", text: "opening response" }] },
			{ role: "user", content: "edited prompt" },
			{ role: "assistant", content: [{ type: "text", text: "response to edited prompt" }] },
		]);

		reopened.selectBranch(regeneratedAssistant);
		expect(
			reopened.buildContext().messages.map(({ role, content }) => ({ role, content })),
		).toEqual([
			{ role: "user", content: "opening prompt" },
			{ role: "assistant", content: [{ type: "text", text: "opening response" }] },
			{ role: "user", content: "original prompt" },
			{ role: "assistant", content: [{ type: "text", text: "regenerated response" }] },
		]);

		reopened.selectBranch(originalAssistant);
		expect(
			reopened.buildContext().messages.map(({ role, content }) => ({ role, content })),
		).toEqual([
			{ role: "user", content: "opening prompt" },
			{ role: "assistant", content: [{ type: "text", text: "opening response" }] },
			{ role: "user", content: "original prompt" },
			{ role: "assistant", content: [{ type: "text", text: "original response" }] },
		]);
	});

	it("keeps native compaction context branch-local", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-compaction-"));
		roots.push(root);
		const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
		const rootUser = store.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const rootAssistant = store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "root answer" }],
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
			stopReason: "stop",
			timestamp: 2,
		} as PiSessionMessage);

		store.selectBranch(rootUser);
		const branchUser = store.appendMessage({ role: "user", content: "branch", timestamp: 3 });
		const branchAssistant = store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "branch answer" }],
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
			stopReason: "stop",
			timestamp: 4,
		} as PiSessionMessage);
		const compactionId = store.appendCompaction("branch summary", branchUser, 12);

		expect(store.buildContextEntries().map((entry) => entry.id)).toEqual([
			compactionId,
			branchUser,
			branchAssistant,
		]);

		const branchContext = store.buildContext().messages;
		expect(branchContext.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
		]);
		expect(branchContext[0]).toMatchObject({
			role: "compactionSummary",
			summary: "branch summary",
		});

		store.selectBranch(rootAssistant);
		const rootContext = store.buildContext().messages;
		expect(rootContext.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(rootContext[0]).toMatchObject({ role: "user", content: "root" });
		expect(rootContext[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "root answer" }],
		});
	});

	it("projects Pi standard messages with stable SessionManager entry IDs", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-projection-"));
		roots.push(root);
		const database = new Database(join(root, "host"));
		database.migrate(MIGRATIONS);
		database.connection
			.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES ('pkg', 'Pkg', '1', 'hash')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('pkg', 'pkg', 'Pkg', '')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'pkg', 'Chat')",
			)
			.run();

		const messages: PiSessionMessage[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
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
				stopReason: "stop",
				timestamp: 2,
			} as PiSessionMessage,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "lookup",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 3,
			},
		];
		const metadata = PiSessionStore.migrateLegacyConversation({
			db: database.orm,
			conversationId: "conversation",
			sessionDir: join(root, "sessions"),
			cwd: root,
			messages,
		});
		const session = PiSessionStore.open({
			sessionDir: join(root, "sessions"),
			sessionFile: metadata.sessionFile,
			cwd: root,
		});
		const entryIds = session.readMessageEntries().map(({ id }) => id);
		expect(entryIds).toHaveLength(messages.length);
		expect(new Set(entryIds).size).toBe(entryIds.length);
		const projectedEntryIds = session
			.readMessageEntries()
			.filter(({ message }) => message.role !== "toolResult")
			.map(({ id }) => id);

		expect(session.buildContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);

		const repository = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		});
		const projection = repository.project("conversation", "Chat", "Scene");
		expect(projection.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(projection.messages.at(-1)).toMatchObject({
			role: "assistant",
			versions: [{ role: "assistant", content: "hi" }],
		});
		expect(
			repository.getCurrentPiEntryForMessage("conversation", projectedEntryIds[0]!),
		).toMatchObject({
			id: projectedEntryIds[0],
			message: { role: "user", content: "hello" },
		});
		expect(
			repository.getCurrentPiEntryForMessage("conversation", projectedEntryIds[1]!),
		).toMatchObject({
			id: projectedEntryIds[1],
			message: { role: "assistant" },
		});
		expect(projection.messages.map((message) => message.id)).toEqual(projectedEntryIds);
		const reopenedProjection = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		}).project("conversation", "Chat", "Scene");
		expect(reopenedProjection.messages.map((message) => message.id)).toEqual(projectedEntryIds);
		database.close();
	});

	it("retains canonical Host IDs and rejects unmatched Pi entries when an adopted branch exists", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-canonical-projection-"));
		roots.push(root);
		const database = new Database(join(root, "host"));
		database.migrate(MIGRATIONS);
		database.connection
			.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES ('pkg', 'Pkg', '1', 'hash')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('pkg', 'pkg', 'Pkg', '')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'pkg', 'Chat')",
			)
			.run();
		const metadata = PiSessionStore.migrateLegacyConversation({
			db: database.orm,
			conversationId: "conversation",
			sessionDir: join(root, "sessions"),
			cwd: root,
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
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
					stopReason: "stop",
					timestamp: 2,
				} as PiSessionMessage,
				{ role: "user", content: "Pi-only tail", timestamp: 3 },
			],
		});
		database.connection
			.prepare(
				"INSERT INTO branches (id, conversation_id, label, adopted) VALUES ('host-branch', 'conversation', 'main', 1)",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO messages (id, conversation_id, branch_id, role) VALUES ('host-user', 'conversation', 'host-branch', 'user'), ('host-assistant', 'conversation', 'host-branch', 'assistant')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO message_versions (id, message_id, content, adopted) VALUES ('host-user-v1', 'host-user', 'hello', 1), ('host-assistant-v1', 'host-assistant', 'hi', 1)",
			)
			.run();

		const session = PiSessionStore.open({
			sessionDir: join(root, "sessions"),
			sessionFile: metadata.sessionFile,
			cwd: root,
		});
		const piUser = session.findMessageEntry("user", "hello");
		const piAssistant = session.findMessageEntry("assistant", "hi");
		const piOnly = session.findMessageEntry("user", "Pi-only tail");
		const repository = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		});
		const projection = repository.project("conversation", "Chat", "Scene");
		expect(projection.messages.map((message) => message.id)).toEqual([
			"host-user",
			"host-assistant",
		]);
		expect(repository.getCurrentPiEntryForMessage("conversation", "host-user")).toMatchObject({
			id: piUser?.id,
			message: { role: "user", content: "hello" },
		});
		expect(repository.getCurrentPiEntryForMessage("conversation", "host-assistant")).toMatchObject({
			id: piAssistant?.id,
			message: { role: "assistant" },
		});
		expect(repository.getCurrentPiEntryForMessage("conversation", piOnly!.id)).toBeUndefined();
		database.close();
	});

	it("projects raw current_user_message text after reopening while retaining Host framing in Pi context", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-host-framed-projection-"));
		roots.push(root);
		const database = new Database(join(root, "host"));
		database.migrate(MIGRATIONS);
		database.connection
			.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES ('pkg', 'Pkg', '1', 'hash')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('pkg', 'pkg', 'Pkg', '')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'pkg', 'Chat')",
			)
			.run();

		const rawUserText = "请记住这条当前消息";
		const framedPrompt = [
			"<host_context>",
			"只用于模型上下文的内部 Host 状态",
			"</host_context>",
			"",
			"<current_user_message>",
			rawUserText,
			"</current_user_message>",
		].join("\n");
		const metadata = PiSessionStore.migrateLegacyConversation({
			db: database.orm,
			conversationId: "conversation",
			sessionDir: join(root, "sessions"),
			cwd: root,
			messages: [
				{ role: "user", content: framedPrompt, timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "已收到。" }],
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
					stopReason: "stop",
					timestamp: 2,
				} as PiSessionMessage,
			],
		});
		const reopened = PiSessionStore.open({
			sessionDir: join(root, "sessions"),
			sessionFile: metadata.sessionFile,
			cwd: root,
		});
		const userEntry = reopened.findMessageEntry("user", rawUserText);
		expect(userEntry).toMatchObject({ id: expect.any(String), message: { content: framedPrompt } });
		expect(reopened.buildContext().messages[0]).toMatchObject({
			role: "user",
			content: framedPrompt,
		});

		const repository = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		});
		const projection = repository.project("conversation", "Chat", "Scene");
		expect(projection.messages).toHaveLength(2);
		expect(projection.messages[0]).toMatchObject({
			id: userEntry?.id,
			role: "user",
			versions: [{ role: "user", content: rawUserText }],
		});
		expect(projection.messages[0]?.versions[0]?.content).not.toContain("<host_context>");
		expect(repository.getCurrentPiEntryForMessage("conversation", userEntry!.id)).toMatchObject({
			id: userEntry!.id,
			message: { role: "user", content: framedPrompt },
		});

		const reopenedProjection = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		}).project("conversation", "Chat", "Scene");
		expect(reopenedProjection.messages[0]?.versions[0]?.content).toBe(rawUserText);
		database.close();
	});

	it("migrates one legacy history once and records metadata without copying content to SQLite", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-migration-"));
		roots.push(root);
		const database = new Database(join(root, "host"));
		database.migrate(MIGRATIONS);
		database.connection
			.prepare(
				"INSERT INTO companion_packages (id, name, version, hash) VALUES ('pkg', 'Pkg', '1', 'hash')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('pkg', 'pkg', 'Pkg', '')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'pkg', 'Chat')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO branches (id, conversation_id, label, adopted) VALUES ('main', 'conversation', 'main', 1)",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO messages (id, conversation_id, branch_id, role) VALUES ('legacy-user', 'conversation', 'main', 'user')",
			)
			.run();
		database.connection
			.prepare(
				"INSERT INTO message_versions (id, message_id, content, adopted) VALUES ('legacy-version', 'legacy-user', 'legacy text', 1)",
			)
			.run();
		const messages: PiSessionMessage[] = [
			{ role: "user", content: "legacy text", timestamp: 10 },
			{
				role: "assistant",
				content: [{ type: "text", text: "migrated response" }],
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
				stopReason: "stop",
				timestamp: 11,
			} as PiSessionMessage,
		];
		const options = {
			db: database.orm,
			conversationId: "conversation",
			sessionDir: join(root, "sessions"),
			cwd: root,
			messages,
		};
		const first = PiSessionStore.migrateLegacyConversation(options);
		const second = PiSessionStore.migrateLegacyConversation({
			...options,
			messages: [{ role: "user", content: "must not append", timestamp: 11 }],
		});
		expect(second).toEqual(first);
		const secondSession = PiSessionStore.open({
			sessionDir: options.sessionDir,
			sessionFile: second.sessionFile,
			cwd: root,
		});
		expect(secondSession.metadata).toEqual(second);
		expect(secondSession.readMessages()).toEqual(messages);
		expect(
			database.connection
				.prepare("SELECT content FROM message_versions WHERE id = 'legacy-version'")
				.get(),
		).toEqual({ content: "legacy text" });
		const reopened = PiSessionStore.open({
			sessionDir: options.sessionDir,
			sessionFile: first.sessionFile,
			cwd: root,
		});
		expect(reopened.readMessages()).toEqual(messages);
		database.close();
	});
});
