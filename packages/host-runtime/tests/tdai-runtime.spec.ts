import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

	it("joins concurrent initialization and permits a retry after failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const memory = runtime(root, "role-a");
		const core = Reflect.get(memory, "core") as { initialize(): Promise<void> };
		const original = core.initialize.bind(core);
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		core.initialize = async () => {
			calls += 1;
			await gate.promise;
			await original();
		};
		const first = memory.start();
		const second = memory.start();
		await vi.waitFor(() => expect(calls).toBe(1));
		gate.resolve();
		await Promise.all([first, second]);
		expect(calls).toBe(1);
		await memory.close();

		const retry = runtime(root, "role-b");
		const retryCore = Reflect.get(retry, "core") as { initialize(): Promise<void> };
		const retryOriginal = retryCore.initialize.bind(retryCore);
		let attempts = 0;
		retryCore.initialize = async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("first initialization failed");
			await retryOriginal();
		};
		await expect(retry.start()).rejects.toThrow("first initialization failed");
		await expect(retry.start()).resolves.toBeUndefined();
		expect(attempts).toBe(2);
		await retry.close();
	});

	it("captures Pi agent_end messages into L0 and keeps companions isolated", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-tdai-runtime-"));
		const first = runtime(root, "role-a");
		const second = runtime(root, "role-b");
		await Promise.all([first.start(), second.start()]);
		try {
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
		await memory.start();
		try {
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
		await memory.start();
		try {
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
