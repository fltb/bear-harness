import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { BM25LocalEncoder } from "../src/core/store/bm25-local.js";
import { createEmbeddingService } from "../src/core/store/embedding.js";

it("encodes compatible real BM25 document and query sparse vectors", () => {
	const encoder = new BM25LocalEncoder("zh");
	const documents = encoder.encodeTexts(["在图书馆阅读书籍", "修理汽车发动机"]);
	const queries = encoder.encodeQueries(["图书馆书籍"]);
	expect(documents).toHaveLength(2);
	expect(queries).toHaveLength(1);
	for (const vector of [...documents, ...queries]) {
		expect(vector.length).toBeGreaterThan(0);
		expect(vector.every(([id, weight]) => Number.isInteger(id) && Number.isFinite(weight))).toBe(
			true,
		);
	}
	const query = new Map(queries[0]);
	const scores = documents.map((vector) =>
		vector.reduce((sum, [id, weight]) => sum + weight * (query.get(id) ?? 0), 0),
	);
	expect(scores[0]).toBeGreaterThan(scores[1]!);
	expect(encoder.encodeTexts([])).toEqual([]);
	expect(encoder.encodeQueries([])).toEqual([]);
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function endpoint(response: unknown, status = 200) {
	const requests: Array<{ path?: string; auth?: string; body: Record<string, unknown> }> = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push({
			path: req.url,
			auth: req.headers.authorization,
			body: JSON.parse(Buffer.concat(chunks).toString()),
		});
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(response));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}
it("AI SDK sends system and user input through its real OpenAI transport", async () => {
	const f = await endpoint({
		id: "chatcmpl-contract",
		object: "chat.completion",
		created: 1,
		model: "fixture",
		choices: [
			{ index: 0, message: { role: "assistant", content: "captured" }, finish_reason: "stop" },
		],
		usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
	});
	const runner = new StandaloneLLMRunner({
		config: { baseUrl: f.url, apiKey: "fixture-key", model: "fixture" },
	});
	expect(
		await runner.run({
			taskId: "contract",
			systemPrompt: "system fixture",
			prompt: "user fixture",
		}),
	).toBe("captured");
	expect(f.requests[0]).toMatchObject({
		path: "/v1/chat/completions",
		auth: "Bearer fixture-key",
		body: {
			model: "fixture",
			messages: [
				{ role: "system", content: "system fixture" },
				{ role: "user", content: "user fixture" },
			],
		},
	});
	expect(f.requests[0]?.body.tools).toBeUndefined();
});
it("AI SDK preserves a provider error instead of returning an empty result", async () => {
	const f = await endpoint(
		{ error: { message: "bad fixture", type: "invalid_request_error" } },
		400,
	);
	const runner = new StandaloneLLMRunner({
		config: { baseUrl: f.url, apiKey: "fixture-key", model: "fixture" },
	});
	await expect(runner.run({ taskId: "contract", prompt: "fixture" })).rejects.toThrow(
		"bad fixture",
	);
});
it("remote embedding sends model and dimensions and preserves vector values", async () => {
	const f = await endpoint({ data: [{ index: 0, embedding: [0.6, 0.8] }] });
	const service = createEmbeddingService({
		provider: "openai",
		baseUrl: f.url,
		apiKey: "fixture-key",
		model: "fixture",
		dimensions: 2,
	});
	const vector = await service.embed("reference text");
	expect(Array.from(vector)).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
	expect(f.requests[0]).toMatchObject({
		path: "/v1/embeddings",
		auth: "Bearer fixture-key",
		body: { model: "fixture", dimensions: 2 },
	});
});
it("remote embedding rejects a changed model dimension", async () => {
	const f = await endpoint({ data: [{ index: 0, embedding: [1, 0, 0] }] });
	const service = createEmbeddingService({
		provider: "openai",
		baseUrl: f.url,
		apiKey: "fixture-key",
		model: "fixture",
		dimensions: 2,
	});
	await expect(service.embed("reference text")).rejects.toThrow();
});
it("remote batch embedding restores the provider's indexed input order", async () => {
	const f = await endpoint({
		data: [
			{ index: 1, embedding: [0, 1] },
			{ index: 0, embedding: [1, 0] },
		],
	});
	const service = createEmbeddingService({
		provider: "openai",
		baseUrl: f.url,
		apiKey: "fixture-key",
		model: "fixture",
		dimensions: 2,
	});
	expect(
		(await service.embedBatch(["first", "second"])).map((vector) => Array.from(vector)),
	).toEqual([
		[1, 0],
		[0, 1],
	]);
});
it("remote embedding rejects missing outputs rather than returning undefined", async () => {
	const f = await endpoint({ data: [] });
	const service = createEmbeddingService({
		provider: "openai",
		baseUrl: f.url,
		apiKey: "fixture-key",
		model: "fixture",
		dimensions: 2,
	});
	await expect(service.embed("first")).rejects.toThrow("count");
});
it("remote embedding rejects duplicate indexes rather than assigning vectors to the wrong input", async () => {
	const f = await endpoint({
		data: [
			{ index: 0, embedding: [1, 0] },
			{ index: 0, embedding: [0, 1] },
		],
	});
	const service = createEmbeddingService({
		provider: "openai",
		baseUrl: f.url,
		apiKey: "fixture-key",
		model: "fixture",
		dimensions: 2,
	});
	await expect(service.embedBatch(["first", "second"])).rejects.toThrow("invalid");
});
it("remote embedding surfaces authentication failures", async () => {
	const f = await endpoint({ error: { message: "invalid key" } }, 401);
	const service = createEmbeddingService({
		provider: "openai",
		baseUrl: f.url,
		apiKey: "fixture-key",
		model: "fixture",
		dimensions: 2,
	});
	await expect(service.embed("reference text")).rejects.toThrow();
});
