// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { productConfig } from "@bear-harness/product-config";
import { afterEach, describe, expect, it } from "vitest";
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

function appendCompletedPiTurn(dataDir: string, conversationId: string, text: string): string {
	const session = PiSessionStore.open({
		sessionDir: join(dataDir, "sessions"),
		sessionFile: sessionFileFor(dataDir, conversationId),
	});
	session.appendUserMessage(text);
	session.appendSyntheticAssistant(`已完成：${text}`);
	const source = session.findMessageEntry("user", text);
	if (!source) throw new Error("expected persisted Pi user entry");
	return source.id;
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
	return createHostRuntime({ dataDir, characterRoot, productConfig, credentialVault: vault });
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

	it("applies explicit story changes, ignores hypotheticals, and undoes the latest change", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", { title: "故事" })) as {
			id: string;
		};

		await data(runtime, "message.send:v1", {
			conversationId: conversation.id,
			text: "故事设定：极光站今晚已经重新通电",
		});
		await expect(data(runtime, "story.listChanges:v1", {})).resolves.toMatchObject({
			changes: [{ text: "极光站今晚已经重新通电" }],
		});

		await data(runtime, "message.abort:v1", { conversationId: conversation.id });
		await data(runtime, "message.send:v1", {
			conversationId: conversation.id,
			text: "如果极光站重新通电会怎样？",
		});
		await expect(data(runtime, "story.listChanges:v1", {})).resolves.toMatchObject({
			changes: [{ text: "极光站今晚已经重新通电" }],
		});

		await data(runtime, "message.abort:v1", { conversationId: conversation.id });
		await data(runtime, "message.send:v1", {
			conversationId: conversation.id,
			text: "刚才那条不算",
		});
		await expect(data(runtime, "story.listChanges:v1", {})).resolves.toEqual({ changes: [] });
		await runtime.close();
	});

	it("captures only explicitly selected Pi entries and keeps ordinary turns out of memory", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-capture-"));
		roots.push(dataDir);
		let runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		await expect(data(runtime, "settings.get:v1", {})).resolves.toMatchObject({
			settings: { relationshipMemoryEnabled: false },
		});
		await data(runtime, "message.send:v1", {
			conversationId: conversation.id,
			text: "关闭关系记忆时也不会保存普通消息",
		});
		await data(runtime, "message.abort:v1", { conversationId: conversation.id });
		await expect(data(runtime, "memory.list:v1", {})).resolves.toEqual({ entries: [] });

		await data(runtime, "settings.set:v1", { settings: { relationshipMemoryEnabled: true } });
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
					createdBy: "user_capture",
					sourceEntryId: sourceEntryId,
				},
			],
		});
		await runtime.close();
	});

	it("projects replacement-backed direct memories as invalidated in memory.list", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-invalidation-"));
		roots.push(dataDir);
		let runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		await data(runtime, "settings.set:v1", { settings: { relationshipMemoryEnabled: true } });
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		await runtime.close();

		const originalSourceEntryId = appendCompletedPiTurn(
			dataDir,
			conversation.id,
			"原始记忆会被替换",
		);
		const replacementSourceEntryId = appendCompletedPiTurn(
			dataDir,
			conversation.id,
			"替换后的记忆",
		);
		runtime = makeRuntimeAt(dataDir);
		await runtime.start();

		const original = (await data(runtime, "memory.capture:v1", {
			conversationId: conversation.id,
			entryId: originalSourceEntryId,
		})) as { memoryId: string };
		const replacement = (await data(runtime, "memory.capture:v1", {
			conversationId: conversation.id,
			entryId: replacementSourceEntryId,
		})) as { memoryId: string };

		await data(runtime, "memory.invalidate:v1", {
			memoryId: original.memoryId,
			replacementMemoryId: replacement.memoryId,
		});

		await expect(data(runtime, "memory.list:v1", {})).resolves.toMatchObject({
			entries: expect.arrayContaining([
				expect.objectContaining({ id: original.memoryId, status: "invalidated" }),
				expect.objectContaining({ id: replacement.memoryId, status: "active" }),
			]),
		});
		await runtime.close();
	});

	it("restores the relationship-memory setting and Host presentation metadata after restart", async () => {
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
		// The restarted Host joins its persisted presentation row to the backend
		// record by ID; these are not assertions about provider-owned metadata.
		await expect(data(restored, "memory.list:v1", {})).resolves.toMatchObject({
			entries: [
				{
					id: captured.memoryId,
					text: "我喜欢重启后仍然连续的记忆",
					createdBy: "user_capture",
					sourceEntryId: sourceEntryId,
				},
			],
		});
		await restored.close();
	});

	it("persists ambiguous story statements until the user accepts or dismisses them", async () => {
		const runtime = makeRuntime();
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };

		await data(runtime, "message.send:v1", {
			conversationId: conversation.id,
			text: "其实极光站的旧塔已经倒了",
		});
		const pending = (await data(runtime, "story.listProposals:v1", {
			conversationId: conversation.id,
		})) as { proposals: Array<{ id: string; text: string }> };
		expect(pending.proposals).toMatchObject([{ text: "其实极光站的旧塔已经倒了" }]);
		const proposal = pending.proposals[0];
		if (!proposal) throw new Error("expected story proposal");

		await data(runtime, "story.resolveProposal:v1", {
			proposalId: proposal.id,
			accept: true,
		});
		await expect(
			data(runtime, "story.listProposals:v1", { conversationId: conversation.id }),
		).resolves.toEqual({ proposals: [] });
		await expect(data(runtime, "story.listChanges:v1", {})).resolves.toMatchObject({
			changes: [{ text: "其实极光站的旧塔已经倒了", source: "user_confirmed" }],
		});
		await data(runtime, "message.abort:v1", { conversationId: conversation.id });
		await runtime.close();
	});

	it("projects edited content and branch ancestors after reloading the Pi conversation", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "bear-continuity-projection-"));
		roots.push(dataDir);
		let runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		const conversation = (await data(runtime, "conversation.create:v1", {})) as { id: string };
		const sent = (await data(runtime, "message.send:v1", {
			conversationId: conversation.id,
			text: "旧问题",
		})) as { messageId: string };
		await runtime.close();

		const oldPiEntryId = appendCompletedPiTurn(dataDir, conversation.id, "旧问题");
		runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		await data(runtime, "message.edit:v1", {
			conversationId: conversation.id,
			messageId: sent.messageId,
			text: "新问题",
			isUserMessage: true,
		});
		await runtime.close();

		const session = PiSessionStore.open({
			sessionDir: join(dataDir, "sessions"),
			sessionFile: sessionFileFor(dataDir, conversation.id),
		});
		session.branchBefore(oldPiEntryId);
		session.appendUserMessage("新问题");
		session.appendSyntheticAssistant("已完成：新问题");

		runtime = makeRuntimeAt(dataDir);
		await runtime.start();
		const edited = (await data(runtime, "conversation.select:v1", {
			id: conversation.id,
		})) as {
			messages: Array<{
				versions: Array<{ content: string; adopted: boolean }>;
			}>;
		};
		expect(edited.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					versions: expect.arrayContaining([
						expect.objectContaining({ content: "新问题", adopted: true }),
					]),
				}),
			]),
		);
		await data(runtime, "message.branch:v1", {
			conversationId: conversation.id,
			messageId: sent.messageId,
		});
		const branched = (await data(runtime, "conversation.select:v1", {
			id: conversation.id,
		})) as {
			messages: Array<{
				versions: Array<{ content: string; adopted: boolean }>;
			}>;
		};
		expect(branched.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					versions: expect.arrayContaining([
						expect.objectContaining({ content: "新问题", adopted: true }),
					]),
				}),
			]),
		);
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
