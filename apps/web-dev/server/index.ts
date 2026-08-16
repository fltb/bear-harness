import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostRuntime } from "@bear-harness/host-runtime";
import { productConfig } from "@bear-harness/product-config";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { createWebCredentialVault } from "./credential-vault.ts";
import { desktopDataDirectory } from "./data-directory.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const port = Number(process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201");
const dataDir = desktopDataDirectory(productConfig.dataDirectoryName);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const characterRoot = resolve(repoRoot, "config/characters");
const token = randomBytes(32).toString("hex");

const debugEnabled = process.env.BEAR_WEB_DEV_DEBUG === "1";
const ruleProviderEnabled = process.env.BEAR_E2E_RULE_PROVIDER === "1";

const runtime = createHostRuntime({
	dataDir,
	characterRoot,
	productConfig,
	credentialVault: createWebCredentialVault(dataDir),
	protocolViolationMode: "throw",
});

async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += value.length;
		if (bytes > 64 * 1024) throw new Error("request body too large");
		chunks.push(value);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : {};
}

function send(response: ServerResponse, status: number, payload?: unknown): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(payload === undefined ? undefined : JSON.stringify(payload));
}

async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (
		ruleProviderEnabled &&
		request.method === "POST" &&
		url.pathname === "/e2e-openai/v1/chat/completions"
	) {
		await ruleProviderReply(request, response);
		return;
	}
	if (request.method === "GET" && url.pathname === "/bootstrap") {
		send(response, 200, { product: productConfig, token, debugEnabled });
		return;
	}
	if (request.headers["x-bear-web-dev-token"] !== token) {
		send(response, 401, { error: "invalid web-dev token" });
		return;
	}
	if (debugEnabled && request.method === "GET" && url.pathname === "/debug/channels") {
		send(response, 200, { channels: Object.keys(REQUEST_SCHEMAS).sort() });
		return;
	}
	if (request.method === "POST" && url.pathname.startsWith("/rpc/")) {
		let params: unknown;
		try {
			params = await body(request);
		} catch {
			send(response, 400, {
				ok: false,
				error: { kind: "invalid_request", reason: "invalid json" },
			});
			return;
		}
		const channel = decodeURIComponent(url.pathname.slice("/rpc/".length));
		send(response, 200, await runtime.dispatch(channel, params));
		return;
	}
	if (request.method === "POST" && url.pathname === "/diagnostics/renderer-fault") {
		try {
			const fault = await body(request);
			process.stderr.write(`[web-dev renderer fault] ${JSON.stringify(fault)}\n`);
		} catch {
			// A dev diagnostic must never take down the verification server.
		}
		response.writeHead(204).end();
		return;
	}
	send(response, 404, { error: "not found" });
}

async function ruleProviderReply(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const payload = (await body(request)) as {
		stream?: boolean;
		messages?: Array<{ content?: unknown }>;
	};
	const readText = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (Array.isArray(value)) return value.map(readText).join("\n");
		if (value && typeof value === "object") {
			const part = value as { text?: unknown; content?: unknown };
			return readText(part.text ?? part.content);
		}
		return "";
	};
	const containsImage = (value: unknown): boolean => {
		if (Array.isArray(value)) return value.some(containsImage);
		if (!value || typeof value !== "object") return false;
		const record = value as Record<string, unknown>;
		if (record.type === "image" || record.type === "image_url" || "image_url" in record)
			return true;
		return Object.values(record).some(containsImage);
	};
	const prompt = payload.messages?.map((message) => readText(message.content)).join("\n") ?? "";
	const hasImage = containsImage(payload.messages);
	const latestHostContext = [...prompt.matchAll(/<host_context>\n([\s\S]*?)<\/host_context>/g)].at(
		-1,
	)?.[1];
	const relationshipContext =
		latestHostContext?.match(/【relationship】\n([\s\S]*?)(?:\n\n【|$)/)?.[1] ?? "";
	const memoryReply = relationshipContext.includes("暗号是南星")
		? "MEMORY_CONTEXT:我们约定暗号是南星\n"
		: relationshipContext.includes("暗号是北辰")
			? "MEMORY_CONTEXT:我们约定暗号是北辰\n"
			: "MEMORY_CONTEXT:ABSENT\n";
	const content =
		hasImage && prompt.includes("Describe only the visible content")
			? "VISUAL_OBSERVATION: a red square\n"
			: prompt.includes("VISUAL_OBSERVATION: a red square")
				? "MAIN_USED_VISUAL_OBSERVATION\n"
				: prompt.includes("检查记忆上下文")
					? memoryReply
					: prompt.includes("EDITED_OK")
						? "EDITED_OK\n"
						: prompt.includes("STREAM_CHECK")
							? "STREAM_ONE STREAM_TWO\n"
							: prompt.includes("你是谁")
								? "我是 E2E Rule Provider。\n"
								: prompt.includes("E2E_OK")
									? "E2E_OK\n"
									: "RULE_OK\n";
	const id = "chatcmpl-e2e-rule";
	if (!payload.stream) {
		send(response, 200, {
			id,
			object: "chat.completion",
			created: 0,
			model: "rule-model",
			choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
		return;
	}
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
	});
	const splitAt = Math.max(1, Math.floor(content.length / 2));
	response.write(
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created: 0,
			model: "rule-model",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: content.slice(0, splitAt) },
					finish_reason: null,
				},
			],
		})}\n\n`,
	);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
	response.write(
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created: 0,
			model: "rule-model",
			choices: [{ index: 0, delta: { content: content.slice(splitAt) }, finish_reason: null }],
		})}\n\n`,
	);
	response.write(
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created: 0,
			model: "rule-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}

await runtime.start();
if (process.env.BEAR_PROVIDER_OVERRIDE_ID && process.env.BEAR_PROVIDER_OVERRIDE_BASE_URL) {
	const overridden = await runtime.dispatch("provider.overrideBaseUrl:v1", {
		providerId: process.env.BEAR_PROVIDER_OVERRIDE_ID,
		baseUrl: process.env.BEAR_PROVIDER_OVERRIDE_BASE_URL,
	});
	if (!overridden.ok)
		throw new Error(`provider endpoint override failed: ${overridden.error.reason}`);
}
if (process.env.BEAR_PROVIDER_CREDENTIAL_ID && process.env.BEAR_PROVIDER_API_KEY) {
	const credential = await runtime.dispatch("provider.setApiKey:v1", {
		providerId: process.env.BEAR_PROVIDER_CREDENTIAL_ID,
		apiKey: process.env.BEAR_PROVIDER_API_KEY,
	});
	if (!credential.ok)
		throw new Error(`provider credential setup failed: ${credential.error.reason}`);
}
if (ruleProviderEnabled) {
	const custom = await runtime.dispatch("provider.customUpsert:v1", {
		providerId: "e2e-rule",
		name: "E2E Rule Provider",
		baseUrl: `http://127.0.0.1:${port}/e2e-openai/v1`,
		modelId: "rule-model",
		apiKey: "e2e-rule-key",
	});
	if (!custom.ok) throw new Error(`rule provider setup failed: ${custom.error.reason}`);
} else if (
	process.env.BEAR_CUSTOM_PROVIDER_ID &&
	process.env.BEAR_CUSTOM_BASE_URL &&
	process.env.BEAR_CUSTOM_MODEL_ID
) {
	const providerId = process.env.BEAR_CUSTOM_PROVIDER_ID;
	const modelId = process.env.BEAR_CUSTOM_MODEL_ID;
	const configured = await runtime.dispatch("provider.customUpsert:v1", {
		providerId,
		name: process.env.BEAR_CUSTOM_PROVIDER_NAME ?? providerId,
		baseUrl: process.env.BEAR_CUSTOM_BASE_URL,
		modelId,
		...(process.env.BEAR_CUSTOM_API_KEY ? { apiKey: process.env.BEAR_CUSTOM_API_KEY } : {}),
	});
	if (!configured.ok) throw new Error(`custom provider setup failed: ${configured.error.reason}`);
	const enabled = await runtime.dispatch("model.enable:v1", {
		providerId,
		modelId,
		label: process.env.BEAR_CUSTOM_PROVIDER_NAME ?? providerId,
	});
	if (!enabled.ok) throw new Error(`custom model setup failed: ${enabled.error.reason}`);
}
const server = createServer((request, response) => {
	void requestHandler(request, response).catch((error: unknown) => {
		process.stderr.write(
			`web-dev request failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		if (!response.headersSent) send(response, 500, { error: "internal server error" });
		else response.end();
	});
});

let closing = false;
async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	await new Promise<void>((done) => server.close(() => done()));
	await runtime.close();
}

server.once("error", (error) => {
	process.stderr.write(
		`web-dev host failed to bind 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	void close().finally(() => {
		process.exitCode = 1;
	});
});
server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`web-dev host ready: http://127.0.0.1:${port}\n`);
});

process.on("SIGINT", () => void close().finally(() => process.exit(0)));
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
