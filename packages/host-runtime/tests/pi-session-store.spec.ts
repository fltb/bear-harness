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
		const originalUser = store.appendMessage({
			role: "user",
			content: "original user",
			timestamp: 1,
		});
		store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "assistant continuation" }],
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
		store.branchBefore(originalUser);
		store.appendMessage({ role: "user", content: "edited user", timestamp: 3 });
		expect(store.buildContext().messages).toEqual([
			expect.objectContaining({ role: "user", content: "edited user" }),
		]);
	});

	it("forks a new independent Pi session at a selected native entry", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-fork-"));
		roots.push(root);
		const sessionDir = join(root, "sessions");
		const source = PiSessionStore.create({ sessionDir, cwd: root });
		const user = source.appendMessage({ role: "user", content: "shared context", timestamp: 1 });
		const assistant = source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "fork here" }],
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
		source.appendMessage({ role: "user", content: "source-only tail", timestamp: 3 });

		const forked = PiSessionStore.forkAt({
			sessionDir,
			cwd: root,
			sessionFile: source.sessionFile,
			entryId: assistant,
		});
		expect(source.entryPathIds(assistant)).toEqual([user, assistant]);
		expect(forked.sessionId).not.toBe(source.sessionId);
		expect(forked.sessionFile).not.toBe(source.sessionFile);
		expect(forked.readMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
		forked.appendMessage({ role: "user", content: "fork-only tail", timestamp: 4 });
		expect(source.readMessageEntries().map((entry) => entry.id)).toContain(user);
		expect(source.readMessages().at(-1)).toMatchObject({ content: "source-only tail" });
		expect(forked.readMessages().at(-1)).toMatchObject({ content: "fork-only tail" });
	});

	it("keeps a user-only active tail runtime-only until an assistant entry is appended", () => {
		const root = mkdtempSync(join(tmpdir(), "bear-pi-pending-tail-"));
		roots.push(root);
		const sessionDir = join(root, "sessions");
		const store = PiSessionStore.create({ sessionDir, cwd: root });
		const sessionFile = store.sessionFile;
		const userId = store.appendMessage({ role: "user", content: "pending prompt", timestamp: 1 });

		expect(store.sessionManager.getEntries()).toHaveLength(1);
		expect(store.findMessageEntry("user", "pending prompt")).toMatchObject({ id: userId });
		expect(existsSync(sessionFile)).toBe(false);

		const reopenedBeforeAssistant = PiSessionStore.open({ sessionDir, sessionFile, cwd: root });
		expect(reopenedBeforeAssistant.readMessageEntries()).toEqual([]);
		expect(reopenedBeforeAssistant.findMessageEntry("user", "pending prompt")).toBeUndefined();

		const assistantId = store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "completed response" }],
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

		store.appendMessage({ role: "user", content: "opening prompt", timestamp: 1 });
		store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "opening response" }],
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
		const originalUser = store.appendMessage({
			role: "user",
			content: "original prompt",
			timestamp: 3,
		});
		const originalAssistant = store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "original response" }],
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

		// Edit branch: branch before originalUser, append edited user + assistant
		store.branchBefore(originalUser);
		store.appendMessage({ role: "user", content: "edited prompt", timestamp: 5 });
		const editedAssistant = store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "response to edited prompt" }],
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
			timestamp: 6,
		} as PiSessionMessage);

		// Regenerate branch: branch before originalAssistant, re-append new assistant under same user
		store.branchBefore(originalAssistant);
		const regeneratedAssistant = store.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "regenerated response" }],
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
			timestamp: 8,
		} as PiSessionMessage);

		// Select regenerated branch, reopen, and verify
		store.selectBranch(regeneratedAssistant);
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

		// Switch to edited branch and verify
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

		// Switch back to regenerated branch
		reopened.selectBranch(regeneratedAssistant);
		expect(
			reopened.buildContext().messages.map(({ role, content }) => ({ role, content })),
		).toEqual([
			{ role: "user", content: "opening prompt" },
			{ role: "assistant", content: [{ type: "text", text: "opening response" }] },
			{ role: "user", content: "original prompt" },
			{ role: "assistant", content: [{ type: "text", text: "regenerated response" }] },
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
		expect(store.buildPiTimeline()).toMatchObject({
			activeLeafId: compactionId,
			entries: [
				{ id: compactionId, parentId: branchAssistant, kind: "compaction" },
				{ id: branchUser, kind: "message", role: "user", text: "branch" },
				{ id: branchAssistant, kind: "message", role: "assistant", text: "branch answer" },
			],
		});
		expect(JSON.stringify(store.buildPiTimeline())).not.toContain("branch summary");

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
		expect(store.buildPiTimeline().entries.map((entry) => entry.id)).toEqual([
			rootUser,
			rootAssistant,
		]);
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
				content: [
					{ type: "text", text: "hi" },
					{
						type: "toolCall",
						id: "call-1",
						name: "lookup",
						arguments: { secret: "do-not-project" },
					},
				],
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
		const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
		for (const message of messages) store.appendMessage(message);
		const metadata = store.metadata;
		database.connection
			.prepare(
				"INSERT INTO conversation_sessions (conversation_id, pi_session_id, session_file_path) VALUES (?, ?, ?)",
			)
			.run("conversation", metadata.sessionId, metadata.sessionFile);
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
		expect(projection.piTimeline).toMatchObject({
			activeLeafId: entryIds[2],
			entries: [
				{
					id: entryIds[0],
					parentId: null,
					kind: "message",
					role: "user",
					text: "hello",
				},
				{
					id: entryIds[1],
					parentId: entryIds[0],
					kind: "message",
					role: "assistant",
					text: "hi",
					toolCalls: [{ toolName: "lookup", toolCallId: "call-1" }],
				},
				{
					id: entryIds[2],
					parentId: entryIds[1],
					kind: "message",
					role: "tool",
					toolName: "lookup",
					toolCallId: "call-1",
					status: "succeeded",
				},
			],
		});
		expect(JSON.stringify(projection.piTimeline)).not.toContain("do-not-project");
		expect(JSON.stringify(projection.piTimeline)).not.toContain('"result"');
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
		const reopenedProjection = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		}).project("conversation", "Chat", "Scene");
		expect(reopenedProjection.piTimeline?.entries.map((entry) => entry.id)).toEqual(entryIds);
		database.close();
	});

	it("projects the selected Pi branch directly without canonical Host-message matching", () => {
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
		const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
		store.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		store.appendMessage({
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
		store.appendMessage({ role: "user", content: "Pi-only tail", timestamp: 3 });
		const metadata = store.metadata;
		database.connection
			.prepare(
				"INSERT INTO conversation_sessions (conversation_id, pi_session_id, session_file_path) VALUES (?, ?, ?)",
			)
			.run("conversation", metadata.sessionId, metadata.sessionFile);

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
		expect(projection.piTimeline?.entries.map((entry) => entry.id)).toEqual([
			piUser?.id,
			piAssistant?.id,
			piOnly?.id,
		]);
		expect(repository.getCurrentPiEntryForMessage("conversation", "host-user")).toBeUndefined();
		expect(
			repository.getCurrentPiEntryForMessage("conversation", "host-assistant"),
		).toBeUndefined();
		expect(repository.getCurrentPiEntryForMessage("conversation", piOnly!.id)).toMatchObject({
			id: piOnly!.id,
			message: { role: "user", content: "Pi-only tail" },
		});
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
		const store = PiSessionStore.create({ sessionDir: join(root, "sessions"), cwd: root });
		store.appendMessage({ role: "user", content: framedPrompt, timestamp: 1 });
		store.appendMessage({
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
		} as PiSessionMessage);
		const metadata = store.metadata;
		database.connection
			.prepare(
				"INSERT INTO conversation_sessions (conversation_id, pi_session_id, session_file_path) VALUES (?, ?, ?)",
			)
			.run("conversation", metadata.sessionId, metadata.sessionFile);
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
		expect(projection.piTimeline?.entries[0]).toMatchObject({
			id: userEntry?.id,
			kind: "message",
			role: "user",
			text: rawUserText,
		});
		expect(JSON.stringify(projection.piTimeline)).not.toContain("<host_context>");
		expect(JSON.stringify(projection.piTimeline)).not.toContain("只用于模型上下文的内部 Host 状态");
		expect(repository.getCurrentPiEntryForMessage("conversation", userEntry!.id)).toMatchObject({
			id: userEntry!.id,
			message: { role: "user", content: framedPrompt },
		});

		const reopenedProjection = new ConversationRepository(database.orm, {
			sessionDir: join(root, "sessions"),
			sessionCwd: root,
		}).project("conversation", "Chat", "Scene");
		expect(reopenedProjection.piTimeline?.entries[0]).toMatchObject({ text: rawUserText });
		database.close();
	});
});
