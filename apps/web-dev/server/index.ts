import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostRuntime } from "@bear-harness/host-runtime";
import { productConfig } from "@bear-harness/product-config";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { createWebCredentialVault } from "./credential-vault.ts";
import { webDevDataDirectory } from "./data-directory.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const port = Number(process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201");
const dataDir = webDevDataDirectory(productConfig.dataDirectoryName);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("hex");
const debugEnabled = process.env.BEAR_WEB_DEV_DEBUG === "1";

const runtime = createHostRuntime({
	dataDir,
	characterRoot: resolve(repoRoot, "config/characters"),
	productConfig,
	credentialVault: createWebCredentialVault(dataDir),
	protocolViolationMode: "throw",
});

async function readBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += value.length;
		if (bytes > maxBytes) throw new Error("request body too large");
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

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
		const channel = decodeURIComponent(url.pathname.slice("/rpc/".length));
		try {
			const params = await readBody(
				request,
				channel === "character.import:v1" ? 36 * 1024 * 1024 : undefined,
			);
			send(response, 200, await runtime.dispatch(channel, params));
		} catch {
			send(response, 400, {
				ok: false,
				error: { kind: "invalid_request", reason: "invalid json" },
			});
		}
		return;
	}
	if (request.method === "POST" && url.pathname === "/diagnostics/renderer-fault") {
		try {
			process.stderr.write(`[web-dev renderer fault] ${JSON.stringify(await readBody(request))}\n`);
		} catch {}
		response.writeHead(204).end();
		return;
	}
	send(response, 404, { error: "not found" });
});

await runtime.start();
if (process.env.BEAR_PROVIDER_OVERRIDE_ID && process.env.BEAR_PROVIDER_OVERRIDE_BASE_URL) {
	await runtime.dispatch("provider.overrideBaseUrl:v1", {
		providerId: process.env.BEAR_PROVIDER_OVERRIDE_ID,
		baseUrl: process.env.BEAR_PROVIDER_OVERRIDE_BASE_URL,
	});
}
if (process.env.BEAR_PROVIDER_CREDENTIAL_ID && process.env.BEAR_PROVIDER_API_KEY) {
	await runtime.dispatch("provider.setApiKey:v1", {
		providerId: process.env.BEAR_PROVIDER_CREDENTIAL_ID,
		apiKey: process.env.BEAR_PROVIDER_API_KEY,
	});
}
if (
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

server.listen(port, "127.0.0.1");
