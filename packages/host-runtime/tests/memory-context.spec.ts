// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterLoader } from "../src/companion/character-loader.js";
import { ContextPackCompiler } from "../src/companion/context-pack.js";
import type { PiSessionMessage } from "../src/companion/pi-session-store.js";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
import { proposeMemoryCandidate, rememberConversationEntry } from "../src/composition.js";
import { ConversationRepository } from "../src/conversations/repository.js";
import type { MemoryBankScope } from "../src/memory/backend.js";
import type {
	TencentDbCoreRecord,
	TencentDbMemoryCoreFacade,
} from "../src/memory/tencentdb-backend.js";
import { TencentDbMemoryBackend } from "../src/memory/tencentdb-backend.js";
import type { AppDatabase } from "../src/storage/database.js";
import { MIGRATIONS } from "../src/storage/database.js";
import { memoryCandidates } from "../src/storage/schema.js";

const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const fixedTimestamp = "2026-08-17T00:00:00.000Z";

function onboardingState(relationshipMemoryEnabled: boolean): string {
	return JSON.stringify({
		schema_version: 1,
		flow_version: 2,
		answers: {},
		decisions: { relationship_memory_enabled: relationshipMemoryEnabled },
	});
}

function scopeFor(companionId: string): MemoryBankScope {
	return { installationId: "install-1", userId: "user-1", companionId };
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
			const queryTokens = request.query.match(/[\p{L}\p{N}_]+/gu)?.filter(Boolean) ?? [];
			return [...records.values()]
				.filter(
					(stored) =>
						stored.namespace === request.namespace &&
						stored.record.status === "active" &&
						(queryTokens.length === 0 ||
							queryTokens.some((token) => stored.record.text.includes(token))),
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
		db.function("bear_sync_changed", () => null);
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
		const record = await backend.remember({
			scope,
			text,
			provenance: { kind: "explicit", piSessionEntryIds: ["session-entry-1"] },
		});
		return record;
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
			"memory:v1:install-1:user-1:jizhou",
			"memory:v1:install-1:user-1:companion-b",
		]);
	});
	it("captures through the activated companion namespace from its native Pi session", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-memory-context-activated-"));
		try {
			const session = PiSessionStore.create({
				sessionDir: join(root, "sessions"),
				cwd: root,
			});
			const nativeSourceId = session.appendMessage({
				role: "user",
				content: "只属于已激活角色的记忆",
				timestamp: Date.now(),
			});
			const nativeAssistantId = session.appendMessage(nativeAssistantMessage("已激活角色回答"));
			db.prepare(
				"INSERT INTO conversation_sessions (conversation_id, pi_session_id, session_file_path) VALUES (?, ?, ?)",
			).run("conversation-b", session.sessionId, session.sessionFile);
			const context = {
				orm,
				defaultCharacterId: "jizhou",
				characterLoader: {
					getActiveCharacterId: () => "companion-b",
					load: () => ({ canon: {} }),
					seed: () => undefined,
					activate: () => undefined,
				},
				eventBus: {},
				canon: { syncPackage: () => undefined },
				conversationRepository: { getSession: () => session },
				memoryBackend: backend,
				memoryScope: { installationId: "install-1", userId: "user-1" },
			} as never;

			await expect(
				rememberConversationEntry(context, "conversation-b", nativeSourceId, "user_capture"),
			).resolves.toMatchObject({ sourceEntryId: nativeSourceId, createdBy: "user_capture" });
			await backend.open({ scope: scopeFor("companion-b") });
			const activatedHits = await backend.recall({
				scope: scopeFor("companion-b"),
				query: "已激活角色",
			});
			expect(activatedHits.map(({ record }) => record.text)).toContain(
				"用户：只属于已激活角色的记忆",
			);
			expect(nativeAssistantId).toBeTruthy();
			await expect(
				rememberConversationEntry(context, "conversation-b", "legacy-message", "user_capture"),
			).rejects.toEqual({ kind: "not_found", reason: "memory_source_not_found" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates a reviewable host_memory candidate from the latest native user entry", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-memory-context-remember-"));
		try {
			const session = PiSessionStore.create({
				sessionDir: join(root, "sessions"),
				cwd: root,
			});
			const firstUser = session.appendMessage({
				role: "user",
				content: "最早的用户消息",
				timestamp: Date.now(),
			});
			session.appendMessage(nativeAssistantMessage("最早的回答"));
			const latestUser = session.appendMessage({
				role: "user",
				content: "最新的用户消息",
				timestamp: Date.now(),
			});
			session.appendMessage(nativeAssistantMessage("最新的回答"));
			const context = {
				orm,
				defaultCharacterId: "jizhou",
				characterLoader: {
					getActiveCharacterId: () => "jizhou",
					load: () => ({ canon: {} }),
					seed: () => undefined,
					activate: () => undefined,
				},
				eventBus: {},
				canon: { syncPackage: () => undefined },
				conversationRepository: { getSession: () => session },
				memoryBackend: backend,
				memoryScope: { installationId: "install-1", userId: "user-1" },
			} as never;

			await expect(proposeMemoryCandidate(context, "conversation-1")).resolves.toMatchObject({
				sourceEntryId: latestUser,
				status: "pending",
			});
			expect(latestUser).not.toBe(firstUser);
			expect(orm.select().from(memoryCandidates).all()).toEqual([
				expect.objectContaining({
					sourceNativeEntryId: latestUser,
					sourceKind: "companion_suggestion",
					normalizedText: "最新的用户消息",
					status: "pending",
				}),
			]);
			await backend.open({ scope: scopeFor("jizhou") });
			expect(await backend.recall({ scope: scopeFor("jizhou"), query: "最新的用户消息" })).toEqual(
				[],
			);

			const emptySession = PiSessionStore.create({
				sessionDir: join(root, "empty-sessions"),
				cwd: root,
			});
			await expect(
				proposeMemoryCandidate(
					{ ...context, conversationRepository: { getSession: () => emptySession } },
					"conversation-1",
				),
			).rejects.toEqual({ kind: "not_found", reason: "memory_source_not_found" });
			await expect(
				proposeMemoryCandidate(
					{ ...context, conversationRepository: { getSession: () => undefined } },
					"conversation-1",
				),
			).rejects.toEqual({ kind: "not_found", reason: "memory_source_not_found" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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

		const replacement = await remember("用户喜欢更短回答");
		await backend.open({ scope });
		const invalidated = await backend.invalidate({
			scope,
			memoryId: original.id,
			replacementMemoryId: replacement.id,
			reason: "superseded",
		});
		expect(invalidated.status).toBe("invalidated");
		const postInvalidation = await relationshipContext();
		expect(postInvalidation).not.toContain("用户喜欢简短回答");
		expect(postInvalidation).toContain("用户喜欢更短回答");
		const forgotten = await remember("即将遗忘的记忆");
		expect(await relationshipContext()).toContain("即将遗忘的记忆");
		await backend.open({ scope });
		await backend.forget({ scope, memoryId: forgotten.id });
		const postForget = await relationshipContext();
		expect(postForget).not.toContain("即将遗忘的记忆");
		expect(postForget).toContain("用户喜欢更短回答");
	});

	it("rejects memory capture from a non-current Pi branch", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-memory-context-source-"));
		try {
			const session = PiSessionStore.create({
				sessionDir: join(root, "sessions"),
				cwd: root,
			});
			const nonCurrentSourceId = session.appendMessage({
				role: "user",
				content: "只在旧分支上的来源",
				timestamp: Date.now(),
			});
			session.appendMessage(nativeAssistantMessage("旧分支回答"));
			session.branchBefore(nonCurrentSourceId);
			const currentSourceId = session.appendMessage({
				role: "user",
				content: "当前分支上的来源",
				timestamp: Date.now(),
			});
			session.appendMessage(nativeAssistantMessage("当前分支回答"));

			const context = {
				orm,
				defaultCharacterId: "jizhou",
				characterLoader: {
					getActiveCharacterId: () => "jizhou",
					load: () => ({ canon: {} }),
					seed: () => undefined,
					activate: () => undefined,
				},
				eventBus: {},
				canon: { syncPackage: () => undefined },
				conversationRepository: { getSession: () => session },
				memoryBackend: backend,
				memoryScope: { installationId: "install-1", userId: "user-1" },
			} as never;

			// Capture sources are branch-local: only entries on Pi's selected branch are valid.
			expect(session.readMessageEntries().map(({ id }) => id)).toContain(currentSourceId);
			expect(session.readMessageEntries().map(({ id }) => id)).not.toContain(nonCurrentSourceId);
			await expect(
				rememberConversationEntry(context, "conversation-1", nonCurrentSourceId, "user_capture"),
			).rejects.toMatchObject({
				kind: "conflict",
				reason: "memory_source_not_current_branch",
			});
			await expect(
				rememberConversationEntry(context, "conversation-1", currentSourceId, "user_capture"),
			).resolves.toMatchObject({
				sourceEntryId: currentSourceId,
				createdBy: "user_capture",
			});
			await expect(
				rememberConversationEntry(context, "conversation-1", "missing-source", "user_capture"),
			).rejects.toEqual({
				kind: "not_found",
				reason: "memory_source_not_found",
			});
			const foreignSession = PiSessionStore.create({
				sessionDir: join(root, "foreign-sessions"),
				cwd: root,
			});
			const foreignSourceId = foreignSession.appendMessage({
				role: "user",
				content: "另一个会话的来源",
				timestamp: Date.now(),
			});
			await expect(
				rememberConversationEntry(context, "conversation-1", foreignSourceId, "user_capture"),
			).rejects.toEqual({
				kind: "not_found",
				reason: "memory_source_not_found",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts native current Pi entries and rejects non-native IDs", async () => {
		const root = mkdtempSync(join(tmpdir(), "bear-memory-context-canonical-"));
		try {
			const session = PiSessionStore.create({
				sessionDir: join(root, "sessions"),
				cwd: root,
			});
			const staleSourceId = session.appendMessage({
				role: "user",
				content: "重复内容",
				timestamp: Date.now(),
			});
			session.appendMessage(nativeAssistantMessage("重复回答"));
			session.branchBefore(staleSourceId);
			const currentSourceId = session.appendMessage({
				role: "user",
				content: "当前分支来源",
				timestamp: Date.now(),
			});
			const currentAssistantId = session.appendMessage(nativeAssistantMessage("当前分支回答"));

			db.prepare(
				"INSERT INTO conversation_sessions (conversation_id, pi_session_id, session_file_path) VALUES (?, ?, ?)",
			).run("conversation-1", session.sessionId, session.sessionFile);

			const repository = new ConversationRepository(orm, {
				sessionDir: join(root, "sessions"),
				sessionCwd: root,
			});
			const context = {
				orm,
				defaultCharacterId: "jizhou",
				characterLoader: {
					getActiveCharacterId: () => "jizhou",
					load: () => ({ canon: {} }),
					seed: () => undefined,
					activate: () => undefined,
				},
				eventBus: {},
				canon: { syncPackage: () => undefined },
				conversationRepository: repository,
				memoryBackend: backend,
				memoryScope: { installationId: "install-1", userId: "user-1" },
			} as never;

			await expect(
				rememberConversationEntry(context, "conversation-1", currentSourceId, "user_capture"),
			).resolves.toMatchObject({
				sourceEntryId: currentSourceId,
				createdBy: "user_capture",
			});
			await expect(
				rememberConversationEntry(context, "conversation-1", currentAssistantId, "user_capture"),
			).resolves.toMatchObject({
				sourceEntryId: currentAssistantId,
				createdBy: "user_capture",
			});
			await expect(
				rememberConversationEntry(context, "conversation-1", staleSourceId, "user_capture"),
			).rejects.toEqual({
				kind: "conflict",
				reason: "memory_source_not_current_branch",
			});
			for (const foreignId of ["legacy-message", "host-message-id"]) {
				await expect(
					rememberConversationEntry(context, "conversation-1", foreignId, "user_capture"),
				).rejects.toEqual({
					kind: "not_found",
					reason: "memory_source_not_found",
				});
			}
			expect(currentSourceId).not.toBe(currentAssistantId);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an adopted legacy message when no Pi session exists", async () => {
		const context = {
			orm,
			defaultCharacterId: "jizhou",
			characterLoader: {
				getActiveCharacterId: () => "jizhou",
				load: () => ({ canon: {} }),
				seed: () => undefined,
				activate: () => undefined,
			},
			eventBus: {},
			canon: { syncPackage: () => undefined },
			conversationRepository: { getSession: () => undefined },
			memoryBackend: backend,
			memoryScope: { installationId: "install-1", userId: "user-1" },
		} as never;

		await expect(
			rememberConversationEntry(context, "conversation-1", "legacy-message", "user_capture"),
		).rejects.toEqual({
			kind: "not_found",
			reason: "memory_source_not_found",
		});
	});

	it("renders a first direct capture in the next turn for the active companion", async () => {
		await remember("E2E_DIRECT_MEMORY_A：我们约定暗号是north");

		const context = await compiler.compileForTurn("conversation-1", {
			memoryQuery: "检查记忆上下文 E2E_DIRECT_MEMORY_A：我们约定暗号是north",
		});
		const rendered = compiler.render(context);

		expect(rendered).toContain("【relationship】");
		expect(rendered).toContain("E2E_DIRECT_MEMORY_A：我们约定暗号是north");
		expect(context.charge.memoryEntries).toBe(1);
	});

	it("omits the relationship block when backend recall has no results", async () => {
		const context = await compiler.compileForTurn("conversation-1", {
			memoryQuery: "没有任何已保存的关系记忆",
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

	describe("TdaiCore persona/scene context", () => {
		function compilerWithSystemContext(
			systemContext: (query: string) => Promise<string | undefined>,
		): ContextPackCompiler {
			return new ContextPackCompiler(orm, new CharacterLoader(characterRoot), undefined, {
				backend,
				scope: { installationId: "install-1", userId: "user-1" },
				systemContext,
			});
		}

		it("injects persona and scene navigation as a low-priority block", async () => {
			const systemCompiler = compilerWithSystemContext(
				async () => "<user-persona>\n喜欢夜景\n</user-persona>",
			);
			const context = await systemCompiler.compileForTurn("conversation-1", {
				memoryQuery: "夜景",
			});
			const persona = context.blocks.find((block) => block.layer === "persona");
			expect(persona).toBeDefined();
			expect(persona?.content).toContain("喜欢夜景");
		});

		it("does not call the persona provider when memory is disabled", async () => {
			const systemContext = vi.fn(async () => "never called");
			const systemCompiler = compilerWithSystemContext(systemContext);
			await systemCompiler.compileForTurn("conversation-1", {
				includeRelationshipMemory: false,
			});
			expect(systemContext).not.toHaveBeenCalled();
		});
	});
});
