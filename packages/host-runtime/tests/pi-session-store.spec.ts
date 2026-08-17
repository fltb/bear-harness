// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { PiSessionMessage } from "../src/companion/pi-session-store.js";
import { ConversationRepository } from "../src/conversations/repository.js";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
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
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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

		expect(store.metadata).toMatchObject({ sessionId: expect.any(String), sessionFile: expect.stringContaining(sessionDir), leafId: expect.any(String) });
		expect(store.readMessages()).toHaveLength(3);
		store.selectBranch(user);
		const alternate = store.appendMessage({ role: "user", content: "alternate", timestamp: 4 });
		expect(store.leafId).toBe(alternate);
		expect(store.readMessages().map((message) => message.role)).toEqual(["user", "user"]);

		const reopened = PiSessionStore.open({ sessionDir, sessionFile: store.sessionFile, cwd: root });
		expect(reopened.sessionId).toBe(store.sessionId);
		expect(reopened.leafId).toBe(alternate);
		expect(reopened.buildContext().messages.map((message) => message.role)).toEqual(["user", "user"]);
		reopened.selectBranch(assistant);
		expect(reopened.buildContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("projects Pi standard messages with stable SessionManager entry IDs", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-projection-"));
		roots.push(root);
		const database = new Database(join(root, "host"));
		database.migrate(MIGRATIONS);
		database.connection.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES ('pkg', 'Pkg', '1', 'hash')").run();
		database.connection.prepare("INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('pkg', 'pkg', 'Pkg', '')").run();
		database.connection.prepare("INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'pkg', 'Chat')").run();

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
		const session = PiSessionStore.open({ sessionDir: join(root, "sessions"), sessionFile: metadata.sessionFile, cwd: root });
		const entryIds = session.readMessageEntries().map(({ id }) => id);
		expect(entryIds).toHaveLength(messages.length);
		expect(new Set(entryIds).size).toBe(entryIds.length);

		expect(session.buildContext().messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);

		const projection = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		}).project("conversation", "Chat", "Scene");
		expect(projection.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
		expect(projection.messages.at(-1)).toMatchObject({
			role: "assistant",
			versions: [{ role: "assistant", content: "result" }],
		});
		expect(projection.messages.map((message) => message.id)).toEqual(entryIds);
		const reopenedProjection = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		}).project("conversation", "Chat", "Scene");
		expect(reopenedProjection.messages.map((message) => message.id)).toEqual(entryIds);
		database.close();
	});

	it("migrates one legacy history once and records metadata without copying content to SQLite", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-migration-"));
		roots.push(root);
		const database = new Database(join(root, "host"));
		database.migrate(MIGRATIONS);
		database.connection.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES ('pkg', 'Pkg', '1', 'hash')").run();
		database.connection.prepare("INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('pkg', 'pkg', 'Pkg', '')").run();
		database.connection.prepare("INSERT INTO conversations (id, companion_id, title) VALUES ('conversation', 'pkg', 'Chat')").run();
		database.connection.prepare("INSERT INTO branches (id, conversation_id, label, adopted) VALUES ('main', 'conversation', 'main', 1)").run();
		database.connection.prepare("INSERT INTO messages (id, conversation_id, branch_id, role) VALUES ('legacy-user', 'conversation', 'main', 'user')").run();
		database.connection.prepare("INSERT INTO message_versions (id, message_id, content, adopted) VALUES ('legacy-version', 'legacy-user', 'legacy text', 1)").run();
		const messages: PiSessionMessage[] = [
			{ role: "user", content: "legacy text", timestamp: 10 },
			{
				role: "assistant",
				content: [{ type: "text", text: "migrated response" }],
				api: "openai-completions",
				provider: "test",
				model: "test-model",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 11,
			} as PiSessionMessage,
		];
		const options = { db: database.orm, conversationId: "conversation", sessionDir: join(root, "sessions"), cwd: root, messages };
		const first = PiSessionStore.migrateLegacyConversation(options);
		const second = PiSessionStore.migrateLegacyConversation({ ...options, messages: [{ role: "user", content: "must not append", timestamp: 11 }] });
		expect(second).toEqual(first);
		const secondSession = PiSessionStore.open({ sessionDir: options.sessionDir, sessionFile: second.sessionFile, cwd: root });
		expect(secondSession.metadata).toEqual(second);
		expect(secondSession.readMessages()).toEqual(messages);
		expect(database.connection.prepare("SELECT content FROM message_versions WHERE id = 'legacy-version'").get()).toEqual({ content: "legacy text" });
		const reopened = PiSessionStore.open({ sessionDir: options.sessionDir, sessionFile: first.sessionFile, cwd: root });
		expect(reopened.readMessages()).toEqual(messages);
		database.close();
	});
});
