// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import type {
	TencentDbCoreRecord,
	TencentDbMemoryCoreFacade,
} from "../src/memory/tencentdb-backend.js";
import { TencentDbMemoryBackend } from "../src/memory/tencentdb-backend.js";
import type { MemoryBankScope } from "../src/memory/backend.js";
import type { AppDatabase } from "../src/storage/database.js";
import { MIGRATIONS } from "../src/storage/database.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const fixedTimestamp = "2026-08-17T00:00:00.000Z";

function onboardingState(relationshipMemoryEnabled: boolean): string {
	return JSON.stringify({
		schema_version: 1,
		flow_version: 1,
		answers: {},
		decisions: { relationship_memory_enabled: relationshipMemoryEnabled },
	});
}

function scopeFor(companionId: string): MemoryBankScope {
	return { installationId: "install-1", userId: "user-1", companionId };
}

interface FakeMemoryCore {
	core: TencentDbMemoryCoreFacade;
	recallNamespaces: string[];
}

function fakeMemoryCore(): FakeMemoryCore {
	const records = new Map<string, { namespace: string; record: TencentDbCoreRecord }>();
	const recallNamespaces: string[] = [];
	let nextId = 0;

	function getRecord(namespace: string, memoryId: string): TencentDbCoreRecord {
		const stored = records.get(`${namespace}:${memoryId}`);
		if (!stored) throw new Error(`memory not found: ${memoryId}`);
		return stored.record;
	}

	const core: TencentDbMemoryCoreFacade = {
		remember: async (request) => {
			const id = `memory-${++nextId}`;
			const record: TencentDbCoreRecord = {
				id,
				text: request.text,
				provenance: request.provenance,
				importance: request.importance ?? 1,
				status: "active",
				metadata: request.metadata ?? {},
				createdAt: fixedTimestamp,
				updatedAt: fixedTimestamp,
			};
			records.set(`${request.namespace}:${id}`, { namespace: request.namespace, record });
			return record;
		},
		recall: async (request) => {
			recallNamespaces.push(request.namespace);
			return [...records.values()]
				.filter(
					(stored) =>
						stored.namespace === request.namespace &&
						stored.record.status === "active" &&
						(request.query.length === 0 || stored.record.text.includes(request.query)),
				)
				.slice(0, request.limit ?? 12)
				.map((stored, index) => ({
					record: stored.record,
					score: 1 - index / 100,
				}));
		},
		update: async (request) => {
			const current = getRecord(request.namespace, request.memoryId);
			const updated: TencentDbCoreRecord = {
				...current,
				text: request.text ?? current.text,
				importance: request.importance ?? current.importance,
				metadata: request.metadata ?? current.metadata,
				updatedAt: fixedTimestamp,
			};
			records.set(`${request.namespace}:${request.memoryId}`, {
				namespace: request.namespace,
				record: updated,
			});
			return updated;
		},
		forget: async (request) => {
			getRecord(request.namespace, request.memoryId);
			records.delete(`${request.namespace}:${request.memoryId}`);
		},
		invalidate: async (request) => {
			const current = getRecord(request.namespace, request.memoryId);
			const updated: TencentDbCoreRecord = {
				...current,
				status: "invalidated",
				invalidatedAt: fixedTimestamp,
				updatedAt: fixedTimestamp,
			};
			records.set(`${request.namespace}:${request.memoryId}`, {
				namespace: request.namespace,
				record: updated,
			});
			return updated;
		},
		setImportance: async (request) => {
			const current = getRecord(request.namespace, request.memoryId);
			const updated: TencentDbCoreRecord = {
				...current,
				importance: request.importance,
				updatedAt: fixedTimestamp,
			};
			records.set(`${request.namespace}:${request.memoryId}`, {
				namespace: request.namespace,
				record: updated,
			});
			return updated;
		},
	};

	return { core, recallNamespaces };
}

describe("relationship memory context", () => {
	let db: DatabaseSync;
	let orm: AppDatabase;
	let compiler: ContextPackCompiler;
	let backend: TencentDbMemoryBackend;
	let fakeCore: FakeMemoryCore;

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
		fakeCore = fakeMemoryCore();
		backend = new TencentDbMemoryBackend(fakeCore.core);
		compiler = new ContextPackCompiler(orm, new CharacterLoader(characterRoot), undefined, {
			backend,
			scope: { installationId: "install-1", userId: "user-1" },
		});
	});

	async function remember(text: string, companionId = "jizhou") {
		const scope = scopeFor(companionId);
		await backend.open({ scope });
		return backend.remember({
			scope,
			text,
			provenance: { kind: "explicit", piSessionEntryIds: ["session-entry-1"] },
		});
	}

	async function relationshipContext(conversationId = "conversation-1", memoryQuery = "") {
		const context = await compiler.compileForTurn(conversationId, { memoryQuery });
		return context.blocks.find((block) => block.layer === "relationship")?.content ?? "";
	}

	it("gates direct backend memory at the setting and restores it without deleting it", async () => {
		await remember("用户喜欢简短回答");
		expect(await relationshipContext()).toContain("用户喜欢简短回答");

		db.prepare("UPDATE onboarding_state SET state_json = ? WHERE companion_id = ?").run(
			onboardingState(false),
			"jizhou",
		);
		const recallCountWhileDisabled = fakeCore.recallNamespaces.length;
		expect(await relationshipContext()).toBe("");
		expect(fakeCore.recallNamespaces).toHaveLength(recallCountWhileDisabled);

		db.prepare("UPDATE onboarding_state SET state_json = ? WHERE companion_id = ?").run(
			onboardingState(true),
			"jizhou",
		);
		expect(await relationshipContext()).toContain("用户喜欢简短回答");
	});

	it("injects recall results only from the active companion bank", async () => {
		await remember("只属于季舟的记忆", "jizhou");
		await remember("只属于乙的记忆", "companion-b");

		const jizhouText = await relationshipContext("conversation-1", "记忆");
		expect(jizhouText).toContain("只属于季舟的记忆");
		expect(jizhouText).not.toContain("只属于乙的记忆");

		const companionBText = await relationshipContext("conversation-b", "记忆");
		expect(companionBText).toContain("只属于乙的记忆");
		expect(companionBText).not.toContain("只属于季舟的记忆");
		expect(fakeCore.recallNamespaces).toEqual([
			"cyber-bear:install-1:user-1:jizhou",
			"cyber-bear:install-1:user-1:companion-b",
		]);
	});

	it("projects direct update, invalidation, and forgetting into later context", async () => {
		const original = await remember("用户喜欢长回答");
		const scope = scopeFor("jizhou");

		await backend.open({ scope });
		const updated = await backend.update({
			scope,
			memoryId: original.id,
			text: "用户喜欢简短回答",
		});
		expect(updated.text).toBe("用户喜欢简短回答");
		expect(await relationshipContext()).not.toContain("用户喜欢长回答");
		expect(await relationshipContext()).toContain("用户喜欢简短回答");

		await backend.open({ scope });
		const invalidated = await backend.invalidate({
			scope,
			memoryId: original.id,
			reason: "superseded",
		});
		expect(invalidated.status).toBe("invalidated");
		expect(await relationshipContext()).toBe("");

		const forgotten = await remember("即将遗忘的记忆");
		expect(await relationshipContext()).toContain("即将遗忘的记忆");
		await backend.open({ scope });
		await backend.forget({ scope, memoryId: forgotten.id });
		expect(await relationshipContext()).toBe("");
	});

	it("omits the relationship block when backend recall has no results", async () => {
		const context = await compiler.compileForTurn("conversation-1", {
			memoryQuery: "不存在的记忆",
		});
		expect(context.blocks.some((block) => block.layer === "relationship")).toBe(false);
		expect(context.charge.memoryEntries).toBe(0);
	});

	it("rejects corrupt persisted onboarding state instead of silently disabling memory", () => {
		db.prepare("UPDATE onboarding_state SET state_json = ? WHERE companion_id = ?").run(
			JSON.stringify({ decisions: { relationship_memory_enabled: true } }),
			"jizhou",
		);
		expect(() => compiler.compile("conversation-1")).toThrow();
	});
});
