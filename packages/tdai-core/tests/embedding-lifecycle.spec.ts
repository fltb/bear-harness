import { expect, it, vi } from "vitest";
import { LocalEmbeddingService } from "../src/core/store/embedding.js";

it("waits for native context disposal before releasing the model", async () => {
	let release!: () => void;
	const context = {
		getEmbeddingFor: async () => ({ vector: [1, 0] }),
		dispose: vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		),
	};
	const model = {
		createEmbeddingContext: async () => context,
		dispose: vi.fn(async () => undefined),
	};
	const service = new LocalEmbeddingService(
		{ provider: "local", dimensions: 2 },
		undefined,
		async () => ({
			getLlama: async () => ({ loadModel: async () => model }),
			resolveModelFile: async () => "model.gguf",
			LlamaLogLevel: { error: 0 },
		}),
	);
	service.startWarmup();
	await service.waitForReady();
	await expect(service.embed("probe")).resolves.toEqual(new Float32Array([1, 0]));
	const closing = service.close();
	expect(service.close()).toBe(closing);
	await Promise.resolve();
	expect(context.dispose).toHaveBeenCalledOnce();
	expect(model.dispose).not.toHaveBeenCalled();
	release();
	await closing;
	expect(model.dispose).toHaveBeenCalledOnce();
	expect(service.isReady()).toBe(false);
	await service.close();
	expect(model.dispose).toHaveBeenCalledOnce();
});
