import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "@bear-harness/tdai-core";
import { describe, expect, it, vi } from "vitest";
import { CharacterTrace } from "../src/diagnostics/character-trace.js";
import { createMemoryDiagnosticsLogger } from "../src/memory/diagnostics.js";
import { BearHarnessHostAdapter } from "../src/memory/tencentdb-host-adapter.js";
import { TencentDbRuntime } from "../src/memory/tencentdb-runtime.js";

function runtime(root: string, companionId: string) {
	return new TencentDbRuntime({
		dataDir: join(root, companionId),
		providers: {} as never,
		models: {} as never,
		companionId,
		installationId: "installation-a",
		userId: "user-a",
		memoryConfig: {
			extraction: { enabled: false },
			embedding: { enabled: false, provider: "none" },
			pipeline: { enableWarmup: false },
		},
	});
}

describe("TencentDbRuntime standard TDAI path", () => {
	it("keeps memory content and role paths out of console logging by default", () => {
		const calls = [
			vi.spyOn(console, "debug").mockImplementation(() => undefined),
			vi.spyOn(console, "info").mockImplementation(() => undefined),
			vi.spyOn(console, "warn").mockImplementation(() => undefined),
			vi.spyOn(console, "error").mockImplementation(() => undefined),
		];
		const adapter = new BearHarnessHostAdapter({
			dataDir: "/private/role-a/memory/tdai",
			providers: {} as never,
			models: {} as never,
			companionId: "role-a",
			userId: "user-a",
		});
		const logger = adapter.getLogger();
		logger.debug?.("private conversation text /private/role-a/memory/tdai");
		logger.info("private conversation text");
		logger.warn("private role path");
		logger.error("private memory content");
		for (const call of calls) expect(call).not.toHaveBeenCalled();
		for (const call of calls) call.mockRestore();
	});

	it("rejects concurrent startup after a store opens then fails, releases it, and retries", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const memory = runtime(root, "role-a");
		const other = runtime(root, "role-b");
		const initialize = VectorStore.prototype.init;
		let failedStore: VectorStore | undefined;
		const failure = vi.spyOn(VectorStore.prototype, "init").mockImplementationOnce(function (
			this: VectorStore,
			...args
		) {
			initialize.apply(this, args);
			failedStore = this;
			throw new Error("store initialization interrupted");
		});
		try {
			const attempts = await Promise.allSettled([memory.start(), memory.start()]);
			expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
			expect(memory.isStarted()).toBe(false);
			expect(() => failedStore!.searchL0Fts("midnight")).toThrow(
				expect.objectContaining({ code: "memory_search_unavailable" }),
			);
			failure.mockRestore();
			await Promise.all([memory.start(), other.start()]);
			expect(memory.isStarted()).toBe(true);
			expect((await memory.searchConversations("midnight", "conversation-a")).total).toBe(0);
			expect((await other.searchConversations("midnight", "conversation-a")).total).toBe(0);
		} finally {
			failure.mockRestore();
			await Promise.all([memory.close(), other.close()]);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects degraded initialization rather than declaring an empty memory store ready", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const memory = runtime(root, "role-a");
		const degraded = vi.spyOn(VectorStore.prototype, "isDegraded").mockReturnValueOnce(true);
		try {
			await expect(memory.start()).rejects.toMatchObject({ code: "memory_search_unavailable" });
			expect(memory.isStarted()).toBe(false);
			degraded.mockRestore();
			await memory.start();
			expect((await memory.searchMemories("midnight")).total).toBe(0);
		} finally {
			degraded.mockRestore();
			await memory.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not become ready after an incomplete reindex and releases resources for retry", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const memory = new TencentDbRuntime({
			dataDir: join(root, "role-a"),
			providers: {} as never,
			models: {} as never,
			companionId: "role-a",
			installationId: "installation-a",
			userId: "user-a",
			memoryConfig: {
				extraction: { enabled: false },
				embedding: {
					enabled: true,
					provider: "openai",
					baseUrl: "http://127.0.0.1:1/v1",
					model: "test",
					dimensions: 3,
				},
				pipeline: { enableWarmup: false },
			},
		});
		const initialize = VectorStore.prototype.init;
		let failedStore: VectorStore | undefined;
		const needsReindex = vi.spyOn(VectorStore.prototype, "init").mockImplementationOnce(function (
			this: VectorStore,
			...args
		) {
			initialize.apply(this, args);
			failedStore = this;
			return { needsReindex: true, reason: "incomplete vectors" };
		});
		const reindex = vi.spyOn(VectorStore.prototype, "reindexAll").mockResolvedValueOnce({
			l1Count: 0,
			l0Count: 0,
			complete: false,
			error: "embedding service unavailable",
		});
		try {
			await expect(memory.start()).rejects.toThrow("embedding service unavailable");
			expect(memory.isStarted()).toBe(false);
			expect(() => failedStore!.searchL0Fts("midnight")).toThrow(
				expect.objectContaining({ code: "memory_search_unavailable" }),
			);
			needsReindex.mockRestore();
			reindex.mockRestore();
			await memory.start();
			expect(memory.isStarted()).toBe(true);
		} finally {
			needsReindex.mockRestore();
			reindex.mockRestore();
			await memory.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retains upstream diagnostic messages in the owning character directory without credentials", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-diagnostics-"));
		const directory = join(root, "role-a", "diagnostics");
		const otherDirectory = join(root, "role-b", "diagnostics");
		const trace = new CharacterTrace(directory, "role-a");
		const otherTrace = new CharacterTrace(otherDirectory, "role-b");
		const logger = createMemoryDiagnosticsLogger(trace);
		const other = createMemoryDiagnosticsLogger(otherTrace);
		try {
			for (let index = 0; index < 4; index += 1) {
				logger.warn(
					"[memory-tdai][sqlite] reindex failed SQLITE_BUSY query=private-midnight token=secret-token /private/role-a",
				);
			}
			other.warn("[memory-tdai][recall] recall timeout private-other-role");
			for (const item of await trace.list()) {
				const text = await trace.exportTrace(item.traceId);
				expect(text).toContain("query=private-midnight");
				expect(text).toContain("/private/role-a");
				expect(text).not.toMatch(/secret-token|private-other-role/);
				expect(JSON.parse(text).events).toHaveLength(4);
			}
			const [item] = await otherTrace.list();
			if (!item) throw new Error("missing upstream trace");
			const otherText = await otherTrace.exportTrace(item.traceId);
			expect(otherText).not.toMatch(/SQLITE_BUSY|private-midnight/);
			expect(otherText).toContain("private-other-role");
		} finally {
			await trace.close();
			await otherTrace.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("captures Pi agent_end messages into L0 and keeps companions isolated", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const first = runtime(root, "role-a");
		const second = runtime(root, "role-b");
		try {
			await Promise.all([first.start(), second.start()]);
			const sessionKey = "conversation-a";
			const timestamp = Date.now();
			await first.captureTurn({
				userText: "I always write stories at midnight.",
				assistantText: "I will remember that.",
				messages: [
					{
						id: "user-a",
						role: "user",
						content: "I always write stories at midnight.",
						timestamp,
					},
					{
						id: "assistant-a",
						role: "assistant",
						content: "I will remember that.",
						timestamp: timestamp + 1,
					},
				],
				sessionKey,
				sessionId: "pi-session-a",
				startedAt: timestamp - 1,
			});

			const own = await first.searchConversations("midnight", sessionKey, 5);
			const other = await second.searchConversations("midnight", sessionKey, 5);
			expect(own.total).toBeGreaterThan(0);
			expect(own.text).toContain("midnight");
			expect(other.total).toBe(0);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("captures the first lazily-started Pi turn without requiring a Host turn timestamp", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const memory = runtime(root, "role-a");
		try {
			await memory.start();
			const timestamp = Date.now() - 1_000;
			await memory.captureTurn({
				userText: "The blue marble is called Little Tide.",
				assistantText: "I heard you.",
				messages: [
					{
						id: "user-first",
						role: "user",
						content: "The blue marble is called Little Tide.",
						timestamp,
					},
					{
						id: "assistant-first",
						role: "assistant",
						content: "I heard you.",
						timestamp: timestamp + 1,
					},
				],
				sessionKey: "conversation-first",
				sessionId: "pi-session-first",
			});

			const captured = await memory.searchConversations("Little Tide", "conversation-first", 5);
			expect(captured.total).toBeGreaterThan(0);
			expect(captured.text).toContain("Little Tide");
		} finally {
			await memory.close();
		}
	});

	it("captures two settled full-history snapshots without duplicating the first turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const memory = runtime(root, "role-a");
		try {
			await memory.start();
			const timestamp = Date.now() - 2_000;
			const first = [
				{
					id: "user-one",
					role: "user",
					content: "The first private preference is writing beside the eastern window.",
					timestamp,
				},
				{
					id: "assistant-one",
					role: "assistant",
					content: "I will remember the eastern window writing preference.",
					timestamp: timestamp + 1,
				},
			];
			await memory.captureTurn({
				userText: first[0].content,
				assistantText: first[1].content,
				messages: first,
				sessionKey: "conversation-two-turns",
				sessionId: "pi-session-two-turns",
			});
			const second = [
				...first,
				{
					id: "user-two",
					role: "user",
					content: "The second private preference is tea after finishing a chapter.",
					timestamp: timestamp + 1_000,
				},
				{
					id: "assistant-two",
					role: "assistant",
					content: "I will remember the tea after finishing a chapter preference.",
					timestamp: timestamp + 1_001,
				},
			];
			await memory.captureTurn({
				userText: second[2].content,
				assistantText: second[3].content,
				messages: second,
				sessionKey: "conversation-two-turns",
				sessionId: "pi-session-two-turns",
			});

			const conversationDir = join(root, "role-a", "conversations");
			const files = await readdir(conversationDir);
			const lines = (
				await Promise.all(files.map((file) => readFile(join(conversationDir, file), "utf8")))
			)
				.join("")
				.trim()
				.split("\n");
			expect(lines).toHaveLength(4);
			expect(lines.map((line) => JSON.parse(line).id)).toEqual([
				"user-one",
				"assistant-one",
				"user-two",
				"assistant-two",
			]);
		} finally {
			await memory.close();
		}
	});
});
