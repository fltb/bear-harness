// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceStackManager } from "../src/companion/voice-stack.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

describe("VoiceStackManager", () => {
	let root: string;
	let database: Database;
	let voice: VoiceStackManager;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bear-voice-stack-"));
		database = new Database(root);
		database.migrate(MIGRATIONS);
		const db = database.connection;
		db.prepare(
			"INSERT INTO companion_packages (id, name, version, hash) VALUES ('character', 'Character', '1', 'hash')",
		).run();
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('character', 'character', 'Character', '')",
		).run();
		voice = new VoiceStackManager(db, new EventBus(db));
	});

	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("pins revisioned stacks and rolls the active stack back for the next scene", () => {
		expect(voice.current("character")).toBeNull();
		expect(voice.rollbackAvailable("character")).toBe(false);
		const first = voice.pin("character", "openai", "gpt-primary", "主声音");
		const second = voice.pin("character", "relay", "gpt-fallback");
		expect(first).toMatchObject({ revision: 0, active: true, label: "主声音" });
		expect(second).toMatchObject({ revision: 1, active: true, label: "" });
		expect(voice.current("character")?.id).toBe(second.id);
		expect(voice.rollbackAvailable("character")).toBe(true);
		expect(voice.list("character").map((stack) => stack.id)).toEqual([second.id, first.id]);

		const switched = voice.switchScope("character", first.id, "next_scene");
		expect(switched.active).toBe(true);
		expect(voice.current("character")?.id).toBe(first.id);
	});

	it("keeps the global selection during a branch-only switch and auditions without writes", () => {
		const first = voice.pin("character", "openai", "gpt-primary");
		const second = voice.pin("character", "relay", "gpt-fallback");
		const branchChoice = voice.switchScope("character", first.id, "branch_only");
		expect(branchChoice.active).toBe(false);
		expect(voice.current("character")?.id).toBe(second.id);
		const before = voice.list("character");
		const audition = voice.audition(
			"character",
			{ providerId: "custom", modelId: "candidate" },
			{ prompts: ["共同经历"] },
		);
		expect(audition).toMatchObject({
			prompts: ["共同经历"],
			note: expect.stringContaining("non-canonical"),
		});
		expect(voice.list("character")).toEqual(before);
	});

	it("rejects unknown companions and stack ids", () => {
		expect(() => voice.pin("missing", "openai", "model")).toThrow(
			expect.objectContaining({ kind: "not_found", reason: "companion_not_found" }),
		);
		expect(() => voice.switchScope("character", "missing", "next_scene")).toThrow(
			expect.objectContaining({ kind: "not_found", reason: "stack_not_found" }),
		);
	});
});
