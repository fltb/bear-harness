// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
import type { PiSessionMessage } from "../src/companion/pi-session-store.js";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
import { type CredentialVault, createHostRuntime } from "../src/index.js";

function sessionFileFor(dataDir: string, conversationId: string): string {
	const db = new DatabaseSync(join(dataDir, "storage", "canon.db"), { readOnly: true });
	try {
		const row = db
			.prepare("SELECT session_file_path FROM conversation_sessions WHERE conversation_id = ?")
			.get(conversationId) as { session_file_path?: string } | undefined;
		if (!row?.session_file_path) throw new Error("expected persisted Pi session metadata");
		return row.session_file_path;
	} finally {
		db.close();
	}
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

function appendCompletedPiTurn(dataDir: string, conversationId: string, text: string): string {
	const session = PiSessionStore.open({
		sessionDir: join(dataDir, "sessions"),
		sessionFile: sessionFileFor(dataDir, conversationId),
	});
	const source = session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	session.appendMessage(nativeAssistantMessage(`已完成：${text}`));
	return source;
}

const roots: string[] = [];
const characterRoot = fileURLToPath(new URL("../../../config/characters", import.meta.url));
const vault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: (value) => Buffer.from(value),
	decryptString: (value) => value.toString("utf8"),
};

function makeRuntime() {
	const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-"));
	roots.push(dataDir);
	return makeRuntimeAt(dataDir);
}

function makeRuntimeAt(dataDir: string) {
	return createHostRuntime({ dataDir, characterSeedRoot: characterRoot, productConfig, credentialVault: vault });
}

async function data(
	runtime: ReturnType<typeof createHostRuntime>,
	channel: string,
	params: unknown,
) {
	const response = await runtime.dispatch(channel, params);
	if (!response.ok) throw new Error(response.error.reason);
	return response.data;
}

describe("automatic continuity", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("captures only explicitly selected Pi entries and keeps ordinary turns out of memory", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-capture-"));
		roots.push(dataDir);
		let runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { relationshipMemoryEnabled: true },
		});
		const sourceEntryId = appendCompletedPiTurn(
			dataDir,
			conversation.id,
			"这条普通消息不会自动成为记忆",
		);
		await runtime.close();
		runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		await expect(data(runtime, "memory.list:v1", {})).resolves.toEqual({ entries: [] });

		const captured = (await data(runtime, "memory.capture:v1", {
			conversationId: conversation.id,
			entryId: sourceEntryId,
		})) as { memoryId: string; sourceEntryId: string; createdBy: string };
		expect(captured).toMatchObject({
			memoryId: expect.any(String),
			sourceEntryId: sourceEntryId,
			createdBy: "user_capture",
		});
		// Assert the Host-facing projection: provenance is keyed by the backend ID,
		// not read from or coupled to the provider's raw metadata payload.
		await expect(data(runtime, "memory.list:v1", {})).resolves.toMatchObject({
			entries: [
				{
					id: captured.memoryId,
					text: "这条普通消息不会自动成为记忆",
				},
			],
		});
		await runtime.close();
	});
	it("commits candidate scope consistently and rejects only one owned pending row", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-candidates-"));
		roots.push(dataDir);
		let runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		const storage = new DatabaseSync(join(dataDir, "storage", "canon.db"));
		try {
			storage
				.prepare(
					`INSERT INTO memory_candidates
						(id, companion_id, kind, source_kind, normalized_text, why, suggested_scope)
						VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"candidate-approved",
					productConfig.defaultCharacterId,
					"fact",
					"companion_suggestion",
					"用户偏好夜景",
					"由助手建议",
					"self",
				);
			await expect(
				data(runtime, "memory.candidate.approve:v1", {
					candidateId: "candidate-approved",
					decidedScope: "scene",
				}),
			).resolves.toEqual({});
			expect(
				storage
					.prepare("SELECT status, decided_at FROM memory_candidates WHERE id = ?")
					.get("candidate-approved"),
			).toMatchObject({ status: "approved" });
			expect(
				storage
					.prepare("SELECT decision, decided_scope FROM memory_decisions WHERE candidate_id = ?")
					.get("candidate-approved"),
			).toMatchObject({ decision: "approve", decided_scope: "scene" });
			expect(
				storage
					.prepare(
						"SELECT scope FROM relationship_memory_entries WHERE companion_id = ? AND text = ?",
					)
					.get(productConfig.defaultCharacterId, "用户偏好夜景"),
			).toMatchObject({ scope: "scene" });
			await expect(data(runtime, "memory.list:v1", {})).resolves.toMatchObject({
				entries: [expect.objectContaining({ text: "用户偏好夜景", scope: "scene" })],
			});

			// The approved scope must survive a restart: memory.list projects it
			// from metadata persisted through Tdai storage, not from the in-memory
			// approval response.
			await runtime.close();
			runtime = makeRuntimeAt(dataDir);
			await runtime.start();
			await expect(data(runtime, "memory.list:v1", {})).resolves.toMatchObject({
				entries: [expect.objectContaining({ text: "用户偏好夜景", scope: "scene" })],
			});

			storage
				.prepare(
					`INSERT INTO memory_candidates
						(id, companion_id, kind, source_kind, normalized_text, why, suggested_scope)
						VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"candidate-rejected",
					productConfig.defaultCharacterId,
					"fact",
					"companion_suggestion",
					"不会进入记忆",
					"由助手建议",
					"relationship",
				);
			await expect(
				data(runtime, "memory.candidate.reject:v1", { candidateId: "candidate-rejected" }),
			).resolves.toEqual({});
			const secondReject = await runtime.dispatch("memory.candidate.reject:v1", {
				candidateId: "candidate-rejected",
			});
			expect(secondReject).toMatchObject({ ok: false, error: { kind: "conflict" } });
			expect(
				storage
					.prepare("SELECT COUNT(*) AS count FROM memory_decisions WHERE candidate_id = ?")
					.get("candidate-rejected"),
			).toMatchObject({ count: 1 });

			storage
				.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)")
				.run("foreign-package", "Foreign", "1", "foreign");
			storage
				.prepare(
					"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
				)
				.run("foreign-companion", "foreign-package", "Foreign", "Foreign");
			storage
				.prepare(
					`INSERT INTO memory_candidates
						(id, companion_id, kind, source_kind, normalized_text, why, suggested_scope)
						VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"candidate-foreign",
					"foreign-companion",
					"fact",
					"companion_suggestion",
					"foreign",
					"由助手建议",
					"self",
				);
			const foreignReject = await runtime.dispatch("memory.candidate.reject:v1", {
				candidateId: "candidate-foreign",
			});
			expect(foreignReject).toMatchObject({ ok: false, error: { kind: "not_found" } });
			expect(
				storage
					.prepare("SELECT status FROM memory_candidates WHERE id = ?")
					.get("candidate-foreign"),
			).toMatchObject({ status: "pending" });
			expect(
				storage
					.prepare("SELECT COUNT(*) AS count FROM memory_decisions WHERE candidate_id = ?")
					.get("candidate-foreign"),
			).toMatchObject({ count: 0 });
		} finally {
			storage.close();
			await runtime.close();
		}
	});

	it("removes forgotten memories from memory.list permanently", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-forget-"));
		roots.push(dataDir);
		let runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		await data(runtime, "settings.set:v1", { settings: { relationshipMemoryEnabled: true } });
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		await runtime.close();

		const originalSourceEntryId = appendCompletedPiTurn(
			dataDir,
			conversation.id,
			"原始记忆会被删除",
		);
		const keptSourceEntryId = appendCompletedPiTurn(dataDir, conversation.id, "保留的记忆");
		runtime = makeRuntimeAt(dataDir);
		await runtime.start();

		const original = (await data(runtime, "memory.capture:v1", {
			conversationId: conversation.id,
			entryId: originalSourceEntryId,
		})) as { memoryId: string };
		await data(runtime, "memory.capture:v1", {
			conversationId: conversation.id,
			entryId: keptSourceEntryId,
		});

		await data(runtime, "memory.forget:v1", { entryId: original.memoryId });

		await expect(data(runtime, "memory.list:v1", {})).resolves.toMatchObject({
			entries: [expect.objectContaining({ text: "保留的记忆" })],
		});
		await expect(data(runtime, "memory.list:v1", {})).resolves.not.toMatchObject({
			entries: expect.arrayContaining([expect.objectContaining({ id: original.memoryId })]),
		});
		await runtime.close();
	});

	it("restores the relationship-memory setting and captured memories after restart", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-restart-"));
		roots.push(dataDir);
		const first = makeRuntimeAt(dataDir);
		await first.start();
		await data(first, "settings.set:v1", { settings: { relationshipMemoryEnabled: true } });
		const conversation = (await data(first, "conversation.create:v1", {})) as { id: string };
		await first.close();
		const sourceEntryId = appendCompletedPiTurn(
			dataDir,
			conversation.id,
			"我喜欢重启后仍然连续的记忆",
		);
		const restarted = makeRuntimeAt(dataDir);
		await restarted.start();
		await expect(data(restarted, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { relationshipMemoryEnabled: true },
		});
		const captured = (await data(restarted, "memory.capture:v1", {
			conversationId: conversation.id,
			entryId: sourceEntryId,
		})) as { memoryId: string; sourceEntryId: string; createdBy: string };
		expect(captured).toMatchObject({
			memoryId: expect.any(String),
			sourceEntryId: sourceEntryId,
			createdBy: "user_capture",
		});
		await restarted.close();

		const restored = makeRuntimeAt(dataDir);
		await restored.start();
		await expect(data(restored, "memory.list:v1", {})).resolves.toMatchObject({
			entries: [
				{
					id: captured.memoryId,
					text: "我喜欢重启后仍然连续的记忆",
				},
			],
		});
		await restored.close();
	});

	it("rejects conversations without Pi session metadata instead of projecting legacy messages", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-unknown-format-"));
		roots.push(dataDir);
		const runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		const storage = new DatabaseSync(join(dataDir, "storage", "canon.db"));
		try {
			storage
				.prepare("DELETE FROM conversation_sessions WHERE conversation_id = ?")
				.run(conversation.id);
		} finally {
			storage.close();
		}
		const response = await runtime.dispatch("conversation.select:v1", { id: conversation.id });
		expect(response).toMatchObject({
			ok: false,
			error: { kind: "conflict" },
		});
		await runtime.close();
	});

	it("stores searchable canon sources and enforces a valid module hierarchy", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const source = (await data(runtime, "canon.addSource:v1", {
			logicalName: "第一卷",
			content: "极光站的旧塔由守望者维护。\n\n风暴发生后，旧塔成为避难所。",
		})) as { source: { id: string } };
		expect(source.source.id).toBeTruthy();
		const search = (await data(runtime, "canon.search:v1", { query: "旧塔" })) as {
			chunks: Array<{ id: string; content: string }>;
		};
		expect(search.chunks[0]?.content).toContain("旧塔");
		const evidence = search.chunks[0];
		if (!evidence) throw new Error("expected canon evidence");

		const root = (await data(runtime, "canon.upsertModule:v1", {
			kind: "root",
			title: "回忆原作",
			instructions: "涉及过去时先检索原作依据。",
			sourceChunkIds: [],
		})) as { module: { id: string } };
		const child = (await data(runtime, "canon.upsertModule:v1", {
			parentId: root.module.id,
			kind: "arc",
			title: "旧塔篇",
			instructions: "回忆旧塔相关剧情。",
			sourceChunkIds: [evidence.id],
		})) as { module: { id: string; parentId: string } };
		expect(child.module.parentId).toBe(root.module.id);

		const cycle = await runtime.dispatch("canon.upsertModule:v1", {
			id: root.module.id,
			parentId: child.module.id,
			kind: "root",
			title: "回忆原作",
			instructions: "入口",
			sourceChunkIds: [],
		});
		expect(cycle).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
		await runtime.close();
	});
});
