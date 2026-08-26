import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createDiagnostics,
	createHostRuntime,
	type Diagnostics,
	isErrorType,
	parseTraceparent,
	RENDERER_FAULT_KINDS,
} from "@bear-harness/host-runtime";
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
const configuredPiWorkerPath = process.env.BEAR_WEB_DEV_PI_WORKER_PATH;
if (configuredPiWorkerPath && !isAbsolute(configuredPiWorkerPath)) {
	throw new Error("BEAR_WEB_DEV_PI_WORKER_PATH must be absolute");
}
const piWorkerPath = configuredPiWorkerPath
	? realpathSync.native(configuredPiWorkerPath)
	: undefined;
const diagnostics: Diagnostics = createDiagnostics({
	app: {
		setAppLogsPath: () => undefined,
		setPath: () => undefined,
	},
	root: join(dataDir, "diagnostics"),
	launchId: randomUUID(),
	packaged: false,
});

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
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => own.includes(key));
}

function validRendererFault(value: Record<string, unknown>): boolean {
	for (const key of Object.keys(value)) {
		if (key !== "kind" && key !== "errorType" && key !== "line" && key !== "column") return false;
	}
	if (!(RENDERER_FAULT_KINDS as readonly string[]).includes(String(value.kind))) return false;
	if (!isErrorType(value.errorType)) return false;
	for (const key of ["line", "column"]) {
		if (key in value) {
			const candidate = value[key];
			if (
				typeof candidate !== "number" ||
				!Number.isSafeInteger(candidate) ||
				candidate < 0 ||
				candidate > 2_147_483_647
			) {
				return false;
			}
		}
	}
	return true;
}

function rendererFaultAttributes(
	fault: Record<string, unknown>,
): Record<string, boolean | number | string> {
	const attributes: Record<string, boolean | number | string> = {
		kind: String(fault.kind),
		errorType: String(fault.errorType),
	};
	if (typeof fault.line === "number") attributes.line = fault.line;
	if (typeof fault.column === "number") attributes.column = fault.column;
	return attributes;
}

function parseRendererFault(
	value: unknown,
): { fault: Record<string, unknown>; traceparent?: unknown } | null {
	if (!isPlainObject(value)) return null;
	if (Object.hasOwn(value, "traceparent") || Object.hasOwn(value, "fault")) {
		if (!hasExactKeys(value, ["traceparent", "fault"])) return null;
		if (!isPlainObject(value.fault) || !validRendererFault(value.fault)) return null;
		return { fault: value.fault, traceparent: value.traceparent };
	}
	if (!validRendererFault(value)) return null;
	return { fault: value };
}

function rpcDiagnosticChannel(pathname: string): string {
	try {
		const channel = decodeURIComponent(pathname.slice("/rpc/".length));
		return Object.hasOwn(REQUEST_SCHEMAS, channel) ? channel : "unknown";
	} catch {
		return "invalid";
	}
}

function diagnosticErrorType(
	error: unknown,
):
	| (typeof RENDERER_FAULT_KINDS)[number]
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "AggregateError"
	| "DOMException"
	| "non-error"
	| "unknown" {
	if (!(error instanceof Error)) return "non-error";
	return [
		"Error",
		"TypeError",
		"RangeError",
		"ReferenceError",
		"SyntaxError",
		"AggregateError",
		"DOMException",
	].includes(error.name)
		? (error.name as
				| "Error"
				| "TypeError"
				| "RangeError"
				| "ReferenceError"
				| "SyntaxError"
				| "AggregateError"
				| "DOMException")
		: "unknown";
}

type WebAttachmentCapability = {
	conversationId: string;
	attachmentId: string;
	relativePath: string;
	operation: "preview" | "download";
	expiresAt: number;
};
const attachmentCapabilities = new Map<string, WebAttachmentCapability>();

const runtime = createHostRuntime({
	dataDir,
	characterSeedRoot: resolve(repoRoot, "config/characters"),
	productConfig,
	credentialVault: createWebCredentialVault(dataDir),
	protocolViolationMode: "throw",
	...(piWorkerPath ? { piWorkerPath } : {}),
	conversationAttachmentUrlFactory: (request) => {
		const capability = randomUUID();
		attachmentCapabilities.set(capability, {
			conversationId: request.conversationId,
			attachmentId: request.attachmentId,
			relativePath: request.relativePath,
			operation: request.operation,
			expiresAt: Date.now() + 5 * 60 * 1000,
		});
		return `/attachment/${capability}`;
	},
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

function send(response: ServerResponse, status: number, payload?: unknown, traceId?: string): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...(traceId ? { "x-bear-trace-id": traceId } : {}),
	});
	response.end(payload === undefined ? undefined : JSON.stringify(payload));
}

function sendError(
	response: ServerResponse,
	status: number,
	kind: HttpErrorKind,
	reason: string,
	traceId?: string,
): void {
	send(response, status, { ok: false, error: { kind, reason } }, traceId);
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const isRpcRequest = request.method === "POST" && url.pathname.startsWith("/rpc/");
	const rpcSpan = isRpcRequest
		? diagnostics.startSpan("rpc.request", { channel: rpcDiagnosticChannel(url.pathname) })
		: null;
	const rpcTraceId = rpcSpan?.context.traceId;
	let rpcStatus: "ok" | "error" = "ok";
	let rpcErrorCategory: string | undefined;
	const finishRpc = (): void => {
		if (!rpcSpan) return;
		rpcSpan.end(
			rpcStatus,
			rpcErrorCategory === undefined ? {} : { errorCategory: rpcErrorCategory },
		);
	};

	if (request.method === "GET" && url.pathname === "/bootstrap") {
		send(response, 200, { product: productConfig, token, debugEnabled });
		return;
	}
	if (request.method === "GET" && url.pathname.startsWith("/attachment/")) {
		const capability = url.pathname.slice("/attachment/".length);
		const grant = attachmentCapabilities.get(capability);
		if (!grant || grant.expiresAt < Date.now()) {
			attachmentCapabilities.delete(capability);
			response.writeHead(404).end("not found");
			return;
		}
		try {
			const file = runtime.attachments.readFile(
				grant.conversationId,
				grant.attachmentId,
				grant.relativePath,
			);
			const previewAllowed =
				grant.operation === "preview" &&
				/^(image\/(?:png|jpeg|gif|webp)|audio\/|video\/|application\/pdf$)/i.test(file.mime);
			if (grant.operation === "preview" && !previewAllowed) {
				response
					.writeHead(415, {
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
						"Content-Security-Policy": "default-src 'none'",
					})
					.end("preview unavailable");
				return;
			}
			const safeName = [...file.name]
				.map((character) => {
					const code = character.codePointAt(0) ?? 0;
					return code <= 0x1f ||
						code === 0x7f ||
						character === '"' ||
						character === "\\" ||
						character === "/"
						? "_"
						: character;
				})
				.join("");
			response.writeHead(200, {
				"Content-Type": file.mime,
				"Content-Length": String(file.buffer.byteLength),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'",
				...(grant.operation === "download"
					? {
							"Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
						}
					: {}),
			});
			response.end(file.buffer);
		} catch {
			response.writeHead(404).end("not found");
		}
		return;
	}
	const suppliedToken = request.headers["x-bear-web-dev-token"];
	if (typeof suppliedToken !== "string" || suppliedToken !== token) {
		if (rpcSpan) {
			rpcStatus = "error";
			rpcErrorCategory = "unauthorized";
			finishRpc();
		}
		sendError(response, 401, "unauthorized", "invalid_token");
		return;
	}
	if (debugEnabled && request.method === "GET" && url.pathname === "/debug/channels") {
		send(response, 200, { channels: Object.keys(REQUEST_SCHEMAS).sort() });
		return;
	}
	if (isRpcRequest) {
		let channel: string;
		try {
			channel = decodeURIComponent(url.pathname.slice("/rpc/".length));
		} catch {
			rpcStatus = "error";
			rpcErrorCategory = "invalid_request";
			sendError(response, 400, "invalid_request", "invalid_channel");
			finishRpc();
			return;
		}
		if (!Object.hasOwn(REQUEST_SCHEMAS, channel)) {
			rpcStatus = "error";
			rpcErrorCategory = "unknown_channel";
			sendError(response, 404, "unknown_channel", "unknown_channel");
			finishRpc();
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
			if (!result.ok) {
				rpcStatus = "error";
				rpcErrorCategory = "rpc_error";
			}
			send(response, 200, result, rpcTraceId);
		} catch (error) {
			rpcStatus = "error";
			if (error instanceof HttpError) {
				rpcErrorCategory = error.kind;
				sendError(response, error.status, error.kind, error.reason, rpcTraceId);
			} else {
				rpcErrorCategory = "internal_error";
				diagnostics.emitRemote(
					"webdev.rpc_dispatch_failure",
					{
						channel: channel ?? rpcDiagnosticChannel(url.pathname),
						phase: "dispatch",
						errorType: diagnosticErrorType(error),
					},
					{
						traceId: rpcTraceId ?? randomUUID().replaceAll("-", "").slice(0, 32),
						parentSpanId: rpcSpan?.context.spanId,
					},
				);
				if (debugEnabled)
					console.error("[web-dev rpc failure]", {
						traceId: rpcTraceId,
						channel,
						error,
					});
				sendError(response, 500, "internal_error", "internal_dispatch_failure", rpcTraceId);
			}
		}
		finishRpc();
		return;
	}
	if (request.method === "POST" && url.pathname === "/diagnostics/renderer-fault") {
		try {
			const body = await readBody(request);
			const parsed = parseRendererFault(body);
			if (!parsed) {
				diagnostics.emit("diagnostics.input_rejected", { reason: "shape" });
				response.writeHead(204).end();
				return;
			}
			const attributes = rendererFaultAttributes(parsed.fault);
			const remote =
				typeof parsed.traceparent === "string" ? parseTraceparent(parsed.traceparent) : null;
			if (remote) {
				diagnostics.emitRemote("renderer.fault", attributes, {
					traceId: remote.traceId,
					parentSpanId: remote.spanId,
				});
			} else {
				diagnostics.emit("diagnostics.trace_restarted", {});
				diagnostics.emit("renderer.fault", attributes);
			}
			response.writeHead(204).end();
		} catch (error) {
			if (error instanceof HttpError) {
				diagnostics.emit("diagnostics.input_rejected", {
					reason: error.kind === "body_too_large" ? "oversized" : "shape",
				});
				sendError(response, error.status, error.kind, error.reason);
			} else {
				diagnostics.emit("diagnostics.input_rejected", { reason: "shape" });
				sendError(response, 400, "malformed_json", "malformed_json");
			}
		}
		return;
	}
	sendError(response, 404, "unknown_route", "unknown_route");
});

let shutdownPromise: Promise<void> | null = null;
const shutdown = (exitCode: number): Promise<void> => {
	if (shutdownPromise) return shutdownPromise;
	process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode);
	shutdownPromise = (async () => {
		try {
			await new Promise<void>((resolve) => {
				if (!server.listening) {
					resolve();
					return;
				}
				server.close(() => resolve());
			});
			await runtime.close();
		} catch {
			process.exitCode = 1;
		} finally {
			await diagnostics.shutdown();
		}
	})();
	return shutdownPromise;
};

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", () => {
	diagnostics.emit("main.uncaught_exception", {});
	void shutdown(1);
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
		...(process.env.BEAR_CUSTOM_API_KEY ? { apiKey: process.env.BEAR_CUSTOM_API_KEY } : {}),
		models: [{ id: modelId }],
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
