import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostRuntime } from "@bear-harness/host-runtime";
import { assertProductConfig, OFFICIAL_BRAND, productConfig } from "@bear-harness/product-config";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { createWebCredentialVault } from "./credential-vault.ts";
import { webDevDataDirectory } from "./data-directory.ts";

// Fail fast on an invalid product identity before serving it: the shared
// shape/fork-identity contract is enforced here (filesystem checks are the
// desktop packaging validator's job).
assertProductConfig(productConfig, OFFICIAL_BRAND);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const requestedHost =
	process.env.BEAR_WEB_DEV_LISTEN ?? process.env.BEAR_WEB_DEV_HOST ?? "127.0.0.1";
const publicIntent = ["1", "true", "yes"].includes(
	(process.env.BEAR_WEB_DEV_PUBLIC ?? "").trim().toLowerCase(),
);
const productionIntent =
	(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production" ||
	["1", "true", "yes"].includes((process.env.BEAR_WEB_DEV_PRODUCTION ?? "").trim().toLowerCase());
if (requestedHost !== "127.0.0.1" || publicIntent || productionIntent) {
	throw new Error(
		"WebDev Host is a loopback-only development harness; public or production listening is not supported",
	);
}
const port = Number(process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201");
const dataDir = webDevDataDirectory(productConfig.dataDirectoryName);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("hex");
const debugEnabled = process.env.BEAR_WEB_DEV_DEBUG === "1";

type HttpErrorKind =
	| "unauthorized"
	| "body_too_large"
	| "malformed_json"
	| "invalid_request"
	| "unknown_route"
	| "unknown_channel"
	| "internal_error";

class HttpError extends Error {
	readonly status: number;
	readonly kind: HttpErrorKind;
	readonly reason: string;

	constructor(status: number, kind: HttpErrorKind, reason: string) {
		super(reason);
		this.status = status;
		this.kind = kind;
		this.reason = reason;
		this.name = "WebDevHttpError";
	}
}

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
		if (bytes > maxBytes) {
			throw new HttpError(413, "body_too_large", "request_body_too_large");
		}
		chunks.push(value);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "malformed_json", "malformed_json");
	}
}

function send(response: ServerResponse, status: number, payload?: unknown): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(payload === undefined ? undefined : JSON.stringify(payload));
}

function sendError(
	response: ServerResponse,
	status: number,
	kind: HttpErrorKind,
	reason: string,
): void {
	send(response, status, { ok: false, error: { kind, reason } });
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (request.method === "GET" && url.pathname === "/bootstrap") {
		send(response, 200, { product: productConfig, token, debugEnabled });
		return;
	}
	const suppliedToken = request.headers["x-bear-web-dev-token"];
	if (typeof suppliedToken !== "string" || suppliedToken !== token) {
		sendError(response, 401, "unauthorized", "invalid_token");
		return;
	}
	if (debugEnabled && request.method === "GET" && url.pathname === "/debug/channels") {
		send(response, 200, { channels: Object.keys(REQUEST_SCHEMAS).sort() });
		return;
	}
	if (request.method === "POST" && url.pathname.startsWith("/rpc/")) {
		let channel: string;
		try {
			channel = decodeURIComponent(url.pathname.slice("/rpc/".length));
		} catch {
			sendError(response, 400, "invalid_request", "invalid_channel");
			return;
		}
		if (!Object.hasOwn(REQUEST_SCHEMAS, channel)) {
			sendError(response, 404, "unknown_channel", "unknown_channel");
			return;
		}
		try {
			const params = await readBody(
				request,
				channel === "character.import:v1" ? 36 * 1024 * 1024 : undefined,
			);
			// Dispatch outcomes — success and domain failure alike — resolve as
			// HTTP 200 with the original validated envelope so the companion
			// client can distinguish an RPC failure from a transport rejection
			// and preserve the exact error reason.
			const result = await runtime.dispatch(channel, params);
			send(response, 200, result);
		} catch (error) {
			if (error instanceof HttpError) {
				sendError(response, error.status, error.kind, error.reason);
			} else {
				sendError(response, 500, "internal_error", "internal_dispatch_failure");
			}
		}
		return;
	}
	if (request.method === "POST" && url.pathname === "/diagnostics/renderer-fault") {
		try {
			const body = await readBody(request);
			process.stderr.write(`[web-dev renderer fault] ${JSON.stringify(body)}\n`);
			response.writeHead(204).end();
		} catch (error) {
			if (error instanceof HttpError) {
				sendError(response, error.status, error.kind, error.reason);
			} else {
				sendError(response, 400, "malformed_json", "malformed_json");
			}
		}
		return;
	}
	sendError(response, 404, "unknown_route", "unknown_route");
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

server.listen(port, requestedHost);
