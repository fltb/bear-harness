// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import { MemoryService } from "../src/memory/service.js";
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
		const events = new EventBus(db);
		memory = new MemoryService(db, events);
		compiler = new ContextPackCompiler(db, new CharacterLoader(characterRoot));
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

	it("rejects corrupt persisted onboarding state instead of silently disabling memory", () => {
		db.prepare("UPDATE onboarding_state SET state_json = ? WHERE companion_id = ?").run(
			JSON.stringify({ decisions: { relationship_memory_enabled: true } }),
			"jizhou",
		);
		expect(() => compiler.compile("conversation-1")).toThrow();
	});
});
