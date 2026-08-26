import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { ConversationAttachmentUrlFactoryRequest } from "@bear-harness/host-runtime";
import { protocol } from "electron";
import { rendererReferrerUrl, type WindowRegistration } from "./diagnostics/electron.js";

export const CONVERSATION_ATTACHMENT_SCHEME = "bear-attachment";
const CAPABILITY_HOST = "cap";
export const ATTACHMENT_CAPABILITY_TTL_MS = 5 * 60 * 1000;

const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'",
	"X-Content-Type-Options": "nosniff",
} as const;

const PREVIEW_MIME_TYPES: Record<string, true> = {
	"application/pdf": true,
	"image/avif": true,
	"image/gif": true,
	"image/jpeg": true,
	"image/png": true,
	"image/webp": true,
	"text/plain": true,
};

type AttachmentOperation = "preview" | "download";

export interface ConversationAttachmentProtocolFile {
	relativePath: string;
	mime: string;
	name: string;
	buffer: Buffer;
}

interface Capability extends ConversationAttachmentUrlFactoryRequest {
	rendererWebContentsId: number;
	expiresAt: number;
}

export interface ConversationAttachmentProtocolOptions {
	windowRegistry: ReadonlyMap<number, Pick<WindowRegistration, "allowedUrl">>;
	readFile(
		conversationId: string,
		attachmentId: string,
		relativePath: string,
	): ConversationAttachmentProtocolFile;
	clock?: () => number;
	tokenFactory?: () => string;
}

interface RendererProtocolRequest extends Request {
	/** Present on Electron request variants that expose the requesting renderer. */
	webContentsId?: number;
}

function normalizedMime(mime: string): string {
	return mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function previewAllowed(mime: string): boolean {
	return PREVIEW_MIME_TYPES[normalizedMime(mime)] === true;
}

function lockedResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: {
			...SECURITY_HEADERS,
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

function encodedFilename(name: string): string {
	const cleaned = [...name.normalize("NFC")]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.replace(/["\\/]/g, "_")
		.trim();
	const value = cleaned || "download";
	const fallback = value.replace(/[^\x20-\x7e]/g, "_").slice(0, 180) || "download";
	const encoded = encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseCapabilityUrl(
	rawUrl: string,
): { operation: AttachmentOperation; token: string } | null {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (
		url.protocol !== `${CONVERSATION_ATTACHMENT_SCHEME}:` ||
		url.host !== CAPABILITY_HOST ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash
	) {
		return null;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length !== 2) return null;
	const [operation, token] = segments;
	if (
		(operation !== "preview" && operation !== "download") ||
		!token ||
		!/^[A-Za-z0-9_-]{32,128}$/.test(token)
	) {
		return null;
	}
	return { operation, token };
}

/** Five-minute capability authority scoped to the invoking renderer main frame. */
export class ConversationAttachmentProtocol {
	private readonly capabilities = new Map<string, Capability>();
	private readonly rendererTokens = new Map<number, Set<string>>();
	private readonly rendererContext = new AsyncLocalStorage<number>();
	private readonly clock: () => number;
	private readonly tokenFactory: () => string;

	constructor(private readonly options: ConversationAttachmentProtocolOptions) {
		this.clock = options.clock ?? Date.now;
		this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
	}

	runForRenderer<T>(rendererWebContentsId: number, callback: () => T): T {
		return this.rendererContext.run(rendererWebContentsId, callback);
	}

	mint(request: ConversationAttachmentUrlFactoryRequest): string {
		const rendererWebContentsId = this.rendererContext.getStore();
		if (
			rendererWebContentsId === undefined ||
			!this.options.windowRegistry.has(rendererWebContentsId)
		) {
			throw { kind: "unavailable", reason: "attachment_renderer_unavailable" };
		}
		if (request.operation === "preview" && !previewAllowed(request.mime)) {
			throw { kind: "conflict", reason: "attachment_preview_unsupported" };
		}
		let token = this.tokenFactory();
		while (this.capabilities.has(token)) token = this.tokenFactory();
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
			throw new Error("attachment capability token factory returned an invalid token");
		}
		this.capabilities.set(token, {
			...request,
			rendererWebContentsId,
			expiresAt: this.clock() + ATTACHMENT_CAPABILITY_TTL_MS,
		});
		const tokens = this.rendererTokens.get(rendererWebContentsId) ?? new Set<string>();
		tokens.add(token);
		this.rendererTokens.set(rendererWebContentsId, tokens);
		return `${CONVERSATION_ATTACHMENT_SCHEME}://${CAPABILITY_HOST}/${request.operation}/${token}`;
	}

	revokeRenderer(rendererWebContentsId: number): void {
		const tokens = this.rendererTokens.get(rendererWebContentsId);
		if (!tokens) return;
		for (const token of tokens) this.capabilities.delete(token);
		this.rendererTokens.delete(rendererWebContentsId);
	}

	readonly handle = async (request: RendererProtocolRequest): Promise<Response> => {
		const parsed = parseCapabilityUrl(request.url);
		if (!parsed) return lockedResponse(403, "forbidden");
		const capability = this.capabilities.get(parsed.token);
		if (!capability) return lockedResponse(404, "not found");
		if (capability.expiresAt <= this.clock()) {
			this.capabilities.delete(parsed.token);
			this.rendererTokens.get(capability.rendererWebContentsId)?.delete(parsed.token);
			return lockedResponse(404, "not found");
		}
		const registration = this.options.windowRegistry.get(capability.rendererWebContentsId);
		const referrer = rendererReferrerUrl(request.referrer);
		if (
			!registration ||
			referrer !== registration.allowedUrl ||
			(request.webContentsId !== undefined &&
				request.webContentsId !== capability.rendererWebContentsId) ||
			parsed.operation !== capability.operation
		) {
			return lockedResponse(403, "forbidden");
		}
		let file: ConversationAttachmentProtocolFile;
		try {
			file = this.options.readFile(
				capability.conversationId,
				capability.attachmentId,
				capability.relativePath,
			);
		} catch {
			return lockedResponse(404, "not found");
		}
		if (
			file.relativePath !== capability.relativePath ||
			(capability.operation === "preview" && !previewAllowed(file.mime))
		) {
			return lockedResponse(403, "forbidden");
		}
		const contentDisposition =
			capability.operation === "download" ? encodedFilename(file.name) : "inline";
		return new Response(file.buffer, {
			status: 200,
			headers: {
				...SECURITY_HEADERS,
				"Content-Disposition": contentDisposition,
				"Content-Length": String(file.buffer.byteLength),
				"Content-Type": normalizedMime(file.mime),
			},
		});
	};
}

/** Must run before app readiness (Electron custom-scheme requirement). */
export function registerConversationAttachmentSchemePrivileges(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: CONVERSATION_ATTACHMENT_SCHEME,
			privileges: {
				standard: false,
				secure: true,
				supportFetchAPI: true,
				stream: true,
			},
		},
	]);
}

/** Registers the capability handler after app readiness. */
export function registerConversationAttachmentProtocol(
	authority: ConversationAttachmentProtocol,
): void {
	protocol.handle(CONVERSATION_ATTACHMENT_SCHEME, authority.handle);
}
