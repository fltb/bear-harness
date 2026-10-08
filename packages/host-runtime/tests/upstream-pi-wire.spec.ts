import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { PiRuntime, type PiRuntimeOptions } from "../src/companion/pi-runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(mode: "text" | "error" | "wait" = "text") {
	const directory = await mkdtemp(join(tmpdir(), "bear-pi-wire-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const requests: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
	const received = Promise.withResolvers<void>();
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push({
			auth: req.headers.authorization,
			body: JSON.parse(Buffer.concat(chunks).toString()),
		});
		received.resolve();
		if (mode === "error") {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: { message: "fixture rejected input", type: "invalid_request_error" },
				}),
			);
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (delta: Record<string, unknown>, reason: string | null = null) =>
			res.write(
				`data: ${JSON.stringify({ id: "chatcmpl-contract", object: "chat.completion.chunk", created: 1, model: "contract", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
			);
		send({ role: "assistant", content: "接口" });
		if (mode === "wait") return;
		send({ content: "可用" });
		send({}, "stop");
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	const models = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	models.registerProvider("contract", {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		api: "openai-completions",
		apiKey: "contract-secret",
		models: [
			{
				id: "contract",
				name: "Contract",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 128,
			},
		],
	});
	const events: AgentSessionEvent[] = [];
	const runtime = new PiRuntime({
		paths: { runtime: join(directory, "runtime"), sessions: join(directory, "sessions") },
		models: { getModels: async () => models },
		character: () => ({ id: "contract" }),
		defaultModel: () => ({ providerId: "contract", modelId: "contract" }),
		multimodalFallback: () => undefined,
		context: () => "temporary recall fixture",
		memory: {
			enabled: () => false,
			recall: async () => ({}),
			capture: async () => undefined,
			drain: async () => undefined,
			explicit: { read: async () => "", edit: async () => "" },
		},
		sessionEvent: (_id: string, event: AgentSessionEvent) => events.push(event),
	} as unknown as PiRuntimeOptions);
	cleanups.push(() => runtime.shutdown());
	const opened = await runtime.create("Upstream wire");
	return { runtime, id: opened.sessionId, models, requests, events, received };
}

it("runs the actual Pi provider transport and projects incremental native events", async () => {
	const f = await fixture();
	const session = await f.runtime.open(f.id);
	await session.prompt("transport fixture");
	expect(f.requests).toHaveLength(1);
	expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain(
		"temporary recall fixture",
	);
	expect(session.getActiveToolNames()).not.toContain("codemode");
	expect(session.getActiveToolNames().some((name) => name.startsWith("mcp__"))).toBe(false);
	expect(f.requests[0]?.auth).toBe("Bearer contract-secret");
	expect(f.requests[0]?.body).toMatchObject({ model: "contract", stream: true });
	expect(JSON.stringify(f.requests[0]?.body.messages)).toContain("temporary recall fixture");
	expect(f.events.some((event) => event.type === "message_update")).toBe(true);
	expect(session.messages.at(-1)).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "接口可用" }],
	});
});

it("persists and reopens the transcript produced by a real transport", async () => {
	const f = await fixture();
	const session = await f.runtime.open(f.id);
	await session.prompt("persist fixture");
	await f.runtime.close(f.id);
	const reopened = await f.runtime.open(f.id);
	expect(reopened.messages.some((message) => message.role === "user")).toBe(true);
	expect(reopened.messages.at(-1)).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "接口可用" }],
	});
});

it("settles a real provider HTTP failure through Pi's error message", async () => {
	const f = await fixture("error");
	const session = await f.runtime.open(f.id);
	await session.prompt("error fixture");
	expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	expect(JSON.stringify(session.messages.at(-1))).toContain("fixture rejected input");
	expect(session.isStreaming).toBe(false);
});

it("aborts an actual pending HTTP stream and returns to native idle", async () => {
	const f = await fixture("wait");
	const session = await f.runtime.open(f.id);
	const pending = session.prompt("abort fixture");
	await f.received.promise;
	await session.abort();
	await pending;
	expect(session.isStreaming).toBe(false);
	expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
});
