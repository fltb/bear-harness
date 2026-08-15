import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CredentialVault, createHostRuntime } from "@bear-harness/host-runtime";
import { productConfig } from "@bear-harness/product-config";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const port = Number(process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201");
const dataDir = process.env.BEAR_WEB_DEV_DATA_DIR
	? resolve(process.env.BEAR_WEB_DEV_DATA_DIR)
	: mkdtempSync(resolve(tmpdir(), "bear-web-dev-"));
const characterRoot = resolve(repoRoot, "config/characters");
const token = randomBytes(32).toString("hex");

const sessionOnlyVault: CredentialVault = {
	isEncryptionAvailable: () => false,
	encryptString: () => {
		throw new Error("web-dev credential vault does not persist secrets");
	},
	decryptString: () => {
		throw new Error("web-dev credential vault does not persist secrets");
	},
};

const runtime = createHostRuntime({
	dataDir,
	characterRoot,
	productConfig,
	credentialVault: sessionOnlyVault,
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
	if (request.method === "GET" && url.pathname === "/bootstrap") {
		send(response, 200, { product: productConfig, token });
		return;
	}
	if (request.headers["x-bear-web-dev-token"] !== token) {
		send(response, 401, { error: "invalid web-dev token" });
		return;
	}
	if (request.method === "GET" && url.pathname === "/debug/channels") {
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

await runtime.start();
const server = createServer((request, response) => {
	void requestHandler(request, response).catch((error: unknown) => {
		process.stderr.write(
			`web-dev request failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		if (!response.headersSent) send(response, 500, { error: "internal server error" });
		else response.end();
	});
});

server.listen(port, "127.0.0.1", () => {
	process.stdout.write(`web-dev host ready: http://127.0.0.1:${port}\n`);
});

let closing = false;
async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	await new Promise<void>((done) => server.close(() => done()));
	await runtime.close();
}

process.on("SIGINT", () => void close().finally(() => process.exit(0)));
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
