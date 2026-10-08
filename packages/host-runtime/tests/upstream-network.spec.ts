import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent, EnvHttpProxyAgent, request } from "undici";
import { afterEach, describe, expect, it } from "vitest";

const close: Array<() => Promise<void>> = [];
async function server(handle: (req: IncomingMessage, res: ServerResponse) => void) {
	const value = createServer(handle);
	value.listen(0, "127.0.0.1");
	await once(value, "listening");
	close.push(async () => {
		value.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			value.close((error) => (error ? reject(error) : resolve())),
		);
	});
	const address = value.address();
	if (!address || typeof address === "string") throw new Error("Missing server address");
	return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
	for (const cleanup of close.splice(0).reverse()) await cleanup();
});

describe("upstream: undici wire contract", () => {
	it("sends JSON and authorization and decodes the response", async () => {
		const url = await server(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					method: req.method,
					auth: req.headers.authorization,
					data: JSON.parse(Buffer.concat(chunks).toString()),
				}),
			);
		});
		const response = await request(url, {
			method: "POST",
			headers: { authorization: "Bearer fixture", "content-type": "application/json" },
			body: JSON.stringify({ input: "中文" }),
		});
		expect(await response.body.json()).toEqual({
			method: "POST",
			auth: "Bearer fixture",
			data: { input: "中文" },
		});
	});
	it("delivers a stream before the response finishes", async () => {
		const finish = Promise.withResolvers<void>();
		const url = await server((_req, res) => {
			res.write("data: first\n\n");
			void finish.promise.then(() => res.end("data: last\n\n"));
		});
		const response = await request(url);
		const iterator = response.body[Symbol.asyncIterator]();
		try {
			expect((await iterator.next()).value.toString()).toBe("data: first\n\n");
		} finally {
			finish.resolve();
		}
		let rest = "";
		for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) rest += chunk.toString();
		expect(rest).toBe("data: last\n\n");
	});
	it("aborts a response body already streaming", async () => {
		const url = await server((_req, res) => res.write("first"));
		const controller = new AbortController();
		const response = await request(url, { signal: controller.signal });
		const body = response.body.text();
		controller.abort();
		await expect(body).rejects.toThrow();
	});
	it("preserves HTTP error status and structured error body", async () => {
		const url = await server((_req, res) => {
			res.writeHead(429, { "retry-after": "1" });
			res.end('{"error":"limited"}');
		});
		const response = await request(url);
		expect(response.statusCode).toBe(429);
		expect(response.headers["retry-after"]).toBe("1");
		expect(await response.body.json()).toEqual({ error: "limited" });
	});
	it("rejects malformed JSON without changing the response to success", async () => {
		const url = await server((_req, res) => res.end("{broken"));
		await expect((await request(url)).body.json()).rejects.toThrow();
	});
	it("enforces a header timeout", async () => {
		const url = await server(() => undefined);
		await expect(request(url, { headersTimeout: 20 })).rejects.toMatchObject({
			code: "UND_ERR_HEADERS_TIMEOUT",
		});
	});
	it("bypasses an unavailable proxy for configured local hosts", async () => {
		const url = await server((_req, res) => res.end("direct"));
		const agent = new EnvHttpProxyAgent({
			httpProxy: "http://127.0.0.1:1",
			httpsProxy: "http://127.0.0.1:1",
			noProxy: "127.0.0.1",
		});
		try {
			expect(await (await request(url, { dispatcher: agent })).body.text()).toBe("direct");
		} finally {
			await agent.close();
		}
	});
	it("releases a dedicated dispatcher and rejects further requests", async () => {
		const url = await server((_req, res) => res.end("ok"));
		const agent = new Agent();
		expect(await (await request(url, { dispatcher: agent })).body.text()).toBe("ok");
		await agent.close();
		await expect(request(url, { dispatcher: agent })).rejects.toMatchObject({
			code: "UND_ERR_DESTROYED",
		});
	});
});
