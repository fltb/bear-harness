// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import { MemoryService } from "../src/memory/service.js";
import type { AppDatabase } from "../src/storage/database.js";
import { MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));

function onboardingState(relationshipMemoryEnabled: boolean): string {
	return JSON.stringify({
		schema_version: 1,
		flow_version: 1,
		answers: {},
		decisions: { relationship_memory_enabled: relationshipMemoryEnabled },
	});
}

describe("relationship memory context", () => {
	let db: DatabaseSync;
	let memory: MemoryService;
	let orm: AppDatabase;
	let compiler: ContextPackCompiler;

	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		for (const migration of MIGRATIONS) db.exec(migration.up);
		db.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)").run(
			"jizhou",
			"季舟",
			"1",
			"test",
		);
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
		).run("jizhou", "jizhou", "季舟", "角色自我设定");
		db.prepare("INSERT INTO conversations (id, companion_id, title) VALUES (?, ?, ?)").run(
			"conversation-1",
			"jizhou",
			"第一段",
		);
		db.prepare(
			"INSERT INTO onboarding_state (companion_id, state, state_json) VALUES (?, ?, ?)",
		).run("jizhou", "complete", onboardingState(true));
		db.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
		).run("companion-b", "jizhou", "角色乙", "角色乙自我设定");
		db.prepare("INSERT INTO conversations (id, companion_id, title) VALUES (?, ?, ?)").run(
			"conversation-b",
			"companion-b",
			"第二段",
		);
		db.prepare(
			"INSERT INTO onboarding_state (companion_id, state, state_json) VALUES (?, ?, ?)",
		).run("companion-b", "complete", onboardingState(true));
		orm = drizzle({ client: db });
		const events = new EventBus(orm);
		memory = new MemoryService(orm, events);
		compiler = new ContextPackCompiler(orm, new CharacterLoader(characterRoot));
	});

	function approve(text: string): string {
		const candidateId = memory.proposeCandidate({
			companionId: "jizhou",
			kind: "preference",
			sourceKind: "user_request",
			text,
			suggestedScope: "relationship",
		});
		memory.decideCandidate({ candidateId, decision: "approve" });
		const entry = memory.recall({ companionId: "jizhou", query: text, enabled: true })[0];
		if (!entry) throw new Error("approved memory was not recalled");
		expect(entry.normalizedText).toBe(text.normalize("NFKC"));
		return entry.id;
	}

	function relationshipContext(): string {
		return (
			compiler.compile("conversation-1").blocks.find((block) => block.layer === "relationship")
				?.content ?? ""
		);
	}

	it("gates approved memory at the setting and restores it without deleting it", () => {
		approve("用户喜欢简短回答");
		expect(relationshipContext()).toContain("用户喜欢简短回答");

		db.prepare("UPDATE onboarding_state SET state_json = ? WHERE companion_id = ?").run(
			onboardingState(false),
			"jizhou",
		);
		expect(relationshipContext()).toBe("");

		db.prepare("UPDATE onboarding_state SET state_json = ? WHERE companion_id = ?").run(
			onboardingState(true),
			"jizhou",
		);
		expect(relationshipContext()).toContain("用户喜欢简短回答");
	});

	it("projects edits, exclusion, restoration and forgetting into the next context", () => {
		const originalId = approve("用户喜欢长回答");
		const editedId = memory.edit(originalId, "用户喜欢简短回答");
		expect(relationshipContext()).not.toContain("用户喜欢长回答");
		expect(relationshipContext()).toContain("用户喜欢简短回答");

		memory.exclude(editedId, true);
		expect(relationshipContext()).toBe("");
		memory.exclude(editedId, false);
		expect(relationshipContext()).toContain("用户喜欢简短回答");

		memory.forget(editedId);
		expect(relationshipContext()).toBe("");
	});

	it("never injects rejected or still-pending sensitive candidates", () => {
		const pendingId = memory.proposeCandidate({
			companionId: "jizhou",
			kind: "fact",
			sourceKind: "extractor",
			text: "用户的私人敏感事实",
			suggestedScope: "relationship",
		});
		expect(relationshipContext()).not.toContain("私人敏感事实");
		memory.decideCandidate({ candidateId: pendingId, decision: "reject" });
		expect(relationshipContext()).not.toContain("私人敏感事实");
	});
	it("recalls only the active companion scope and omits an empty backend result", async () => {
		const calls: MemoryBankScope[] = [];
		const hitFor = (scope: MemoryBankScope, text: string): MemoryHit => ({
			record: {
				id: "backend-memory-id",
				scope,
				text,
				provenance: { kind: "explicit", piSessionEntryIds: ["session-entry-1"] },
				importance: 1,
				status: "active",
				metadata: {},
				createdAt: "2026-08-17T00:00:00.000Z",
				updatedAt: "2026-08-17T00:00:00.000Z",
			},
			score: 0.99,
			rank: 1,
		});
		const backend = {
			open: async ({ scope }: { scope: MemoryBankScope }) => {
				calls.push(scope);
			},
			recall: async ({ scope }: { scope: MemoryBankScope }) =>
				scope.companionId === "jizhou" ? [hitFor(scope, "只属于季舟的记忆")] : [],
		} as unknown as MemoryBackend;
		const scopedCompiler = new ContextPackCompiler(orm, new CharacterLoader(characterRoot), undefined, {
			backend,
			scope: { installationId: "install-1", userId: "user-1" },
		});

		const jizhou = await scopedCompiler.compileForTurn("conversation-1", {
			memoryQuery: "记忆",
		});
		const jizhouText = jizhou.blocks.find((block) => block.layer === "relationship")?.content ?? "";
		expect(jizhouText).toContain("只属于季舟的记忆");
		expect(jizhouText).not.toContain("backend-memory-id");
		expect(jizhouText).not.toContain("0.99");

		const companionB = await scopedCompiler.compileForTurn("conversation-b", {
			memoryQuery: "记忆",
		});
		expect(companionB.blocks.some((block) => block.layer === "relationship")).toBe(false);
		expect(calls).toEqual([
			{ installationId: "install-1", userId: "user-1", companionId: "jizhou" },
			{ installationId: "install-1", userId: "user-1", companionId: "companion-b" },
		]);
	});


	it("rejects corrupt persisted onboarding state instead of silently disabling memory", () => {
		db.prepare("UPDATE onboarding_state SET state_json = ? WHERE companion_id = ?").run(
			JSON.stringify({ decisions: { relationship_memory_enabled: true } }),
			"jizhou",
		);
		expect(() => compiler.compile("conversation-1")).toThrow();
	});
});
