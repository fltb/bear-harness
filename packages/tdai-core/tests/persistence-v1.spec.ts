import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	readConversationRecords,
	recordConversation,
} from "../src/core/conversation/l0-recorder.js";
import { readAllMemoryRecords } from "../src/core/record/l1-reader.js";
import { writeMemory } from "../src/core/record/l1-writer.js";
import { readSceneIndex, writeSceneIndex } from "../src/core/scene/scene-index.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import { CheckpointManager } from "../src/utils/checkpoint.js";
import { readManifest, writeManifest } from "../src/utils/manifest.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bear-tdai-v1-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("TDAI v1 persistence", () => {
	it("writes and requires a v1 manifest", async () => {
		const root = await temporaryRoot();
		writeManifest(root, {
			version: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
			store: { type: "sqlite", sqlite: { path: "vectors.db" } },
			seed: null,
		});
		expect(readManifest(root)?.version).toBe(1);
		await writeFile(
			join(root, ".metadata", "manifest.json"),
			JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", store: { type: "sqlite" } }),
		);
		expect(() => readManifest(root)).toThrow("TDAI manifest must use format version 1");
	});

	it("writes and requires a v1 checkpoint", async () => {
		const root = await temporaryRoot();
		const checkpoint = new CheckpointManager(root);
		await checkpoint.incrementScenesProcessed();
		const stored = JSON.parse(
			await readFile(join(root, ".metadata", "recall_checkpoint.json"), "utf8"),
		) as Record<string, unknown>;
		expect(stored.schemaVersion).toBe(1);
		await writeFile(
			join(root, ".metadata", "recall_checkpoint.json"),
			JSON.stringify({ scenes_processed: 10 }),
		);
		await expect(checkpoint.read()).rejects.toThrow("TDAI checkpoint must use schema version 1");
	});

	it("wraps the scene index in a v1 record and rejects an unversioned array", async () => {
		const root = await temporaryRoot();
		const entries = [
			{
				filename: "scene.md",
				summary: "A scene",
				heat: 1,
				created: "2026-01-01T00:00:00.000Z",
				updated: "2026-01-01T00:00:00.000Z",
			},
		];
		await writeSceneIndex(root, entries);
		const stored = JSON.parse(
			await readFile(join(root, ".metadata", "scene_index.json"), "utf8"),
		) as Record<string, unknown>;
		expect(stored).toMatchObject({ schemaVersion: 1, entries });
		expect(await readSceneIndex(root)).toEqual(entries);
		await writeFile(join(root, ".metadata", "scene_index.json"), JSON.stringify(entries));
		await expect(readSceneIndex(root)).rejects.toThrow(
			"TDAI scene index must use schema version 1",
		);
	});

	it("marks every L0 and L1 JSONL record as schema v1", async () => {
		const root = await temporaryRoot();
		await recordConversation({
			sessionKey: "conversation-a",
			sessionId: "session-a",
			baseDir: root,
			rawMessages: [
				{
					id: "message-a",
					role: "user",
					content: "Please remember that the blue marble is called Little Tide.",
					timestamp: 1,
				},
			],
		});
		const l0Name = (await readdir(join(root, "conversations")))[0];
		if (!l0Name) throw new Error("L0 shard was not written");
		const l0 = JSON.parse(await readFile(join(root, "conversations", l0Name), "utf8"));
		expect(l0.schemaVersion).toBe(1);
		expect(await readConversationRecords("conversation-a", root)).toHaveLength(1);

		await writeMemory({
			baseDir: root,
			sessionKey: "conversation-a",
			sessionId: "session-a",
			memory: {
				content: "The blue marble is called Little Tide.",
				type: "persona",
				priority: 50,
				source_message_ids: ["message-a"],
				metadata: {},
				scene_name: "",
			},
			decision: { record_id: "memory-a", action: "store", target_ids: [] },
		});
		const l1Name = (await readdir(join(root, "records")))[0];
		if (!l1Name) throw new Error("L1 shard was not written");
		const l1 = JSON.parse(await readFile(join(root, "records", l1Name), "utf8"));
		expect(l1.schemaVersion).toBe(1);
		expect(await readAllMemoryRecords(root)).toHaveLength(1);
	});

	it("sets SQLite user_version 1 and refuses unversioned pre-release databases", async () => {
		const root = await temporaryRoot();
		const freshPath = join(root, "fresh.db");
		const fresh = new VectorStore(freshPath, 0);
		expect(fresh.init()).toMatchObject({ needsReindex: false });
		fresh.close();
		const freshDb = new DatabaseSync(freshPath);
		expect(freshDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
		freshDb.close();

		const oldPath = join(root, "old.db");
		const oldDb = new DatabaseSync(oldPath);
		oldDb.exec("CREATE TABLE old_data (id TEXT PRIMARY KEY)");
		oldDb.close();
		const old = new VectorStore(oldPath, 0);
		const result = old.init();
		expect(old.isDegraded()).toBe(true);
		expect(result.reason).toContain("TDAI SQLite database must use schema version 1");
		old.close();
	});
});
