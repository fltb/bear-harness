// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PiSessionMessage } from "../src/companion/pi-session-store.js";
import { ConversationRepository } from "../src/conversations/repository.js";

describe("ConversationRepository active conversation", () => {
	const databases: DatabaseSync[] = [];
	const roots: string[] = [];
	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function setup(): { database: DatabaseSync; repository: ConversationRepository; root: string } {
		const database = new DatabaseSync(":memory:");
		databases.push(database);
		database.exec(`
			CREATE TABLE conversations (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL,
				title TEXT NOT NULL,
				unread INTEGER NOT NULL DEFAULT 0,
				archived_at TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE conversation_sessions (
				conversation_id TEXT PRIMARY KEY,
				pi_session_id TEXT NOT NULL,
				session_file_path TEXT NOT NULL,
				active_leaf_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE active_conversations (
				companion_id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE conversation_attachments (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL,
				origin_entry_id TEXT,
				send_nonce TEXT,
				kind TEXT NOT NULL,
				name TEXT NOT NULL,
				total_bytes INTEGER NOT NULL,
				file_count INTEGER NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE relationship_memory_entries (
				id TEXT PRIMARY KEY, source_message_version_id TEXT,
				source_branch_id TEXT, source_conversation_id TEXT
			);
			CREATE TABLE memory_candidates (
				id TEXT PRIMARY KEY, source_message_version_id TEXT,
				source_branch_id TEXT, source_conversation_id TEXT
			);
			CREATE TABLE scene_state (id TEXT PRIMARY KEY, conversation_id TEXT);
			CREATE TABLE conversation_directives (id TEXT PRIMARY KEY, conversation_id TEXT);
		`);
		const root = mkdtempSync(join(tmpdir(), "conversation-repository-"));
		roots.push(root);
		return {
			database,
			repository: new ConversationRepository(drizzle({ client: database }), {
				sessionDir: root,
				sessionCwd: root,
			}),
			root,
		};
	}

	function create(repository: ConversationRepository, id: string, title = id) {
		return repository.createAndSelect({
			id,
			companionId: "companion",
			title,
		});
	}

	/** Native Pi assistant message fixture appended through SessionManager. */
	function nativeAssistantMessage(text: string): PiSessionMessage {
		return {
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
			stopReason: "stop",
			timestamp: Date.now(),
		} as PiSessionMessage;
	}

	it("persists the active conversation across repository instances", () => {
		const { database, repository, root } = setup();
		const created = create(repository, "first");
		const second = new ConversationRepository(drizzle({ client: database }), {
			sessionDir: root,
			sessionCwd: root,
		});

		expect(second.active("companion")?.id).toBe(created.id);
	});

	it("selects only an owned unarchived conversation", () => {
		const { repository } = setup();
		create(repository, "first");
		create(repository, "second");

		expect(repository.select("first", "companion")?.id).toBe("first");
		expect(repository.active("companion")?.id).toBe("first");
		expect(repository.select("missing", "companion")).toBeUndefined();
		expect(repository.active("companion")?.id).toBe("first");
	});

	it("replaces an archived active conversation with the newest remaining one", () => {
		const { repository } = setup();
		create(repository, "first");
		create(repository, "second");
		repository.select("first", "companion");

		const result = repository.archiveAndResolve("first", "companion", true);
		expect(result.found).toBe(true);
		expect(result.active?.id).toBe("second");
		expect(repository.active("companion")?.id).toBe("second");
	});

	it("removes the active selection when archiving the last conversation", () => {
		const { repository } = setup();
		create(repository, "only");

		const result = repository.archiveAndResolve("only", "companion", true);
		expect(result).toEqual({ found: true });
		expect(repository.active("companion")).toBeUndefined();
	});

	it("replaces an active conversation deleted in a lifecycle transaction", () => {
		const { repository } = setup();
		create(repository, "first");
		create(repository, "second");
		repository.select("first", "companion");
		const session = repository.getSession("first");
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendMessage(nativeAssistantMessage("hi"));
		const sessionFile = session.sessionFile;
		expect(existsSync(sessionFile)).toBe(true);

		const result = repository.deleteAndResolve("first", "companion");
		expect(result.found).toBe(true);
		expect(result.active?.id).toBe("second");
		expect(repository.active("companion")?.id).toBe("second");
		expect(existsSync(sessionFile)).toBe(false);
		expect(() => repository.getSession("first")).toThrow(
			expect.objectContaining({ reason: "conversation_pi_session_missing" }),
		);
	});

	it("removes the Pi session locator and file for the deleted conversation", () => {
		const { repository } = setup();
		create(repository, "only");
		const session = repository.getSession("only");
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendMessage(nativeAssistantMessage("hi"));
		const sessionFile = session.sessionFile;
		expect(existsSync(sessionFile)).toBe(true);

		const result = repository.deleteAndResolve("only", "companion");
		expect(result.found).toBe(true);
		expect(existsSync(sessionFile)).toBe(false);
		expect(() => repository.getSession("only")).toThrow(
			expect.objectContaining({ reason: "conversation_pi_session_missing" }),
		);
	});

	it("keeps the active conversation stable for non-active lifecycle mutations", () => {
		const { repository } = setup();
		create(repository, "first");
		create(repository, "second");

		expect(repository.archiveAndResolve("first", "companion", true).active?.id).toBe("second");
		expect(repository.archiveAndResolve("first", "companion", false).active?.id).toBe("second");
		expect(repository.deleteAndResolve("first", "companion").active?.id).toBe("second");
	});

	it("projects durable attachment summaries on their native Pi entry", () => {
		const { database, repository } = setup();
		create(repository, "only");
		const session = repository.getSession("only");
		const entryId = session.appendMessage({
			role: "user",
			content: "Read this",
			timestamp: Date.now(),
		});
		database
			.prepare(
				`INSERT INTO conversation_attachments
				(id, conversation_id, origin_entry_id, kind, name, total_bytes, file_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run("attachment-1", "only", entryId, "file", "notes.txt", 5, 1);

		const projected = repository.get("only", "companion");
		const entry = projected?.piTimeline.entries.find((candidate) => candidate.id === entryId);
		expect(entry).toMatchObject({
			kind: "message",
			attachments: [
				{
					id: "attachment-1",
					name: "notes.txt",
					kind: "file",
					bytes: 5,
					fileCount: 1,
					originEntryId: entryId,
				},
			],
		});
	});

	it("keeps oversized native timelines readable through bounded pages", () => {
		const { repository } = setup();
		create(repository, "only");
		const session = repository.getSession("only");
		for (let index = 0; index < 125; index += 1) {
			session.appendMessage({ role: "user", content: `message-${index}`, timestamp: Date.now() });
		}

		const newest = repository.get("only", "companion")?.piTimeline;
		expect(newest).toMatchObject({
			startOffset: 25,
			totalEntries: 125,
			hasMoreBefore: true,
		});
		expect(newest?.entries).toHaveLength(100);
		expect(newest?.entries[0]).toMatchObject({ text: "message-25" });

		const older = repository.timelinePage("only", "companion", newest?.startOffset);
		expect(older).toMatchObject({
			startOffset: 0,
			totalEntries: 125,
			hasMoreBefore: false,
		});
		expect(older?.entries).toHaveLength(25);
		expect(older?.entries[0]).toMatchObject({ text: "message-0" });
		expect(repository.timelinePage("only", "other-companion", 25)).toBeUndefined();
	});

	it("selects a restored conversation when no active selection exists", () => {
		const { repository } = setup();
		create(repository, "only");
		repository.archiveAndResolve("only", "companion", true);

		const result = repository.archiveAndResolve("only", "companion", false);
		expect(result.active?.id).toBe("only");
	});
});
