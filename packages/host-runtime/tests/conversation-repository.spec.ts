// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/conversations/repository.js";

describe("ConversationRepository ordering", () => {
	const databases: DatabaseSync[] = [];
	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it("selects the newest inserted conversation when timestamps tie", () => {
		const database = new DatabaseSync(":memory:");
		databases.push(database);
		database.exec(`
			CREATE TABLE conversations (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL,
				title TEXT NOT NULL,
				scene_title TEXT NOT NULL,
				unread INTEGER NOT NULL DEFAULT 0,
				archived_at TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE branches (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL,
				parent_branch_id TEXT,
				fork_message_id TEXT,
				label TEXT NOT NULL DEFAULT 'main',
				adopted INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
		const repository = new ConversationRepository(drizzle({ client: database }));
		repository.create({
			id: "first",
			branchId: "first-branch",
			companionId: "companion",
			title: "First",
			sceneTitle: "Scene",
		});
		repository.create({
			id: "second",
			branchId: "second-branch",
			companionId: "companion",
			title: "Second",
			sceneTitle: "Scene",
		});

		expect(repository.list("companion").map((conversation) => conversation.id)).toEqual([
			"second",
			"first",
		]);
	});
});
