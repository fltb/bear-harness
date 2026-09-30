import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SharedEmbeddingRuntime } from "../src/memory/shared-embedding-runtime.js";
import { TencentDbRuntime } from "../src/memory/tencentdb-runtime.js";

function provider() {
	return {
		isReady: () => true,
		getDimensions: () => 2,
		getProviderInfo: () => ({ provider: "local", model: "fixture" }),
		startWarmup: vi.fn(),
		close: vi.fn(),
		embed: vi.fn(async (text: string) => new Float32Array(text.includes("tail") ? [0, 1] : [1, 0])),
		embedBatch: vi.fn(async () => []),
	};
}

describe("installation shared embedding runtime", () => {
	it("deduplicates loading, embeds the entire document, and closes only after active work", async () => {
		const service = provider();
		const factory = vi.fn(() => service);
		const runtime = new SharedEmbeddingRuntime(
			() => ({ enabled: true, provider: "local", dimensions: 2 }),
			factory,
		);
		const [first, second] = await Promise.all([runtime.getCanon(), runtime.getCanon()]);
		expect(first).toBe(second);
		expect(factory).toHaveBeenCalledOnce();
		const result = await first?.embed(`${"a".repeat(480)}${"tail".repeat(120)}`);
		expect(result?.[0]).toBeCloseTo(Math.SQRT1_2);
		expect(result?.[1]).toBeCloseTo(Math.SQRT1_2);
		expect(service.embed.mock.calls.every(([text]) => text.length <= 512)).toBe(true);
		let release!: () => void;
		service.embed.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve(new Float32Array([1, 0]));
				}),
		);
		const active = first?.embed("pending");
		await Promise.resolve();
		const resetting = runtime.reset();
		await Promise.resolve();
		expect(service.close).not.toHaveBeenCalled();
		release();
		await active;
		await resetting;
		expect(service.close).toHaveBeenCalledOnce();
		expect(first?.isReady()).toBe(false);
		await runtime.getCanon();
		expect(factory).toHaveBeenCalledTimes(2);
		await runtime.close();
		await expect(runtime.getCanon()).rejects.toThrow("closed");
	});

	it("keeps disabled embeddings off and retries a failed warmup", async () => {
		let enabled = false;
		const service = provider();
		let ready = false;
		service.isReady = () => ready;
		const factory = vi.fn(() => service);
		const runtime = new SharedEmbeddingRuntime(() => ({ enabled, provider: "local" }), factory);
		expect(await runtime.getCanon()).toBeUndefined();
		expect(factory).not.toHaveBeenCalled();
		enabled = true;
		await runtime.reset();
		await expect(runtime.getCanon()).rejects.toThrow("not ready");
		ready = true;
		expect((await runtime.getCanon())?.isReady()).toBe(true);
		await runtime.close();
	});
});

it("shares one provider with Canon and two real character memory stores without transferring ownership", async () => {
	const root = await mkdtemp(join(tmpdir(), "bear-shared-embedding-"));
	const service = provider();
	const factory = vi.fn(() => service);
	const shared = new SharedEmbeddingRuntime(
		() => ({ enabled: true, provider: "local", dimensions: 2 }),
		factory,
	);
	const memory = (id: string) =>
		new TencentDbRuntime({
			dataDir: join(root, id),
			companionId: id,
			installationId: "installation",
			userId: "user",
			providers: {} as never,
			models: {} as never,
			embeddingProvider: () => shared.get(),
			memoryConfig: {
				embedding: { enabled: true, provider: "local", dimensions: 2 },
				extraction: { enabled: false },
				pipeline: { enableWarmup: false },
			},
		});
	const first = memory("first");
	const second = memory("second");
	try {
		const [canon] = await Promise.all([shared.getCanon(), first.start(), second.start()]);
		expect(factory).toHaveBeenCalledOnce();
		assert(canon);
		const firstEmbedding = first.getEmbeddingService();
		const secondEmbedding = second.getEmbeddingService();
		assert(firstEmbedding && secondEmbedding);
		await firstEmbedding.embed("memory input");
		expect(service.embed).toHaveBeenLastCalledWith("memory input", undefined);
		await canon.embed("Canon question", "query");
		expect(service.embed).toHaveBeenLastCalledWith("task: search result | query: Canon question");
		expect(firstEmbedding.getProviderInfo().model).toBe("fixture");
		expect(canon.getProviderInfo().model).toContain("canon-retrieval-mean-480-v2");
		await first.close();
		expect(service.close).not.toHaveBeenCalled();
		await expect(secondEmbedding.embed("second memory")).resolves.toEqual(new Float32Array([1, 0]));
		await second.close();
		await expect(canon.embed("still available")).resolves.toEqual(new Float32Array([1, 0]));
		expect(service.close).not.toHaveBeenCalled();
		await shared.close();
		expect(service.close).toHaveBeenCalledOnce();
	} finally {
		await Promise.all([first.close(), second.close()]);
		await shared.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("serializes local single/batch calls, drains queued work, and rejects stale consumers after reset", async () => {
	const service = provider();
	let reject!: (error: Error) => void;
	service.embed.mockImplementationOnce(
		() =>
			new Promise((_, fail) => {
				reject = fail;
			}),
	);
	const factory = vi.fn(() => service);
	const shared = new SharedEmbeddingRuntime(
		() => ({ enabled: true, provider: "local", dimensions: 2 }),
		factory,
	);
	const memory = await shared.get();
	assert(memory);
	const first = memory.embed("first");
	const failed = expect(first).rejects.toThrow("request failed");
	const batch = memory.embedBatch(["second"]);
	await Promise.resolve();
	expect(service.embedBatch).not.toHaveBeenCalled();
	const reset = shared.reset();
	expect(service.close).not.toHaveBeenCalled();
	reject(new Error("request failed"));
	await failed;
	await batch;
	await reset;
	expect(service.embedBatch).toHaveBeenCalledOnce();
	expect(service.close).toHaveBeenCalledOnce();
	await expect(memory.embed("stale")).rejects.toThrow("changed");
	const [next, canon] = await Promise.all([shared.get(), shared.getCanon()]);
	expect(factory).toHaveBeenCalledTimes(2);
	assert(next && canon);
	expect(next.isReady()).toBe(true);
	expect(canon.isReady()).toBe(true);
	await shared.close();
});
