// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
	protocol: {
		registerSchemesAsPrivileged: vi.fn(),
		handle: vi.fn(),
	},
}));

vi.mock("electron", () => electron);

import type { ConversationAttachmentProtocolOptions } from "../src/main/conversation-attachment-protocol.js";
import {
	ATTACHMENT_CAPABILITY_TTL_MS,
	CONVERSATION_ATTACHMENT_SCHEME,
	ConversationAttachmentProtocol,
	registerConversationAttachmentProtocol,
	registerConversationAttachmentSchemePrivileges,
} from "../src/main/conversation-attachment-protocol.js";

const RENDERER_URL = "file:///dist/renderer/index.html";
const TOKEN = "a".repeat(43);
const binding = {
	conversationId: "conversation-1",
	attachmentId: "attachment-1",
	relativePath: "reports/result.txt",
	operation: "download" as const,
	mime: "text/plain",
	name: "result.txt",
	bytes: 3,
};

function request(url: string, referrer = RENDERER_URL, webContentsId = 7): Request {
	const value = new Request(url, { referrer });
	Object.defineProperty(value, "webContentsId", { value: webContentsId });
	return value;
}

function setup(
	options: {
		clock?: () => number;
		readFile?: ConversationAttachmentProtocolOptions["readFile"];
		registry?: Map<number, { allowedUrl: string }>;
	} = {},
) {
	const readFile =
		options.readFile ??
		vi.fn().mockReturnValue({
			relativePath: binding.relativePath,
			mime: binding.mime,
			name: binding.name,
			buffer: Buffer.from([1, 2, 3]),
		});
	const registry = options.registry ?? new Map([[7, { allowedUrl: RENDERER_URL }]]);
	const authority = new ConversationAttachmentProtocol({
		windowRegistry: registry,
		readFile,
		clock: options.clock,
		tokenFactory: () => TOKEN,
	});
	const mint = (overrides: Partial<typeof binding> = {}, rendererId = 7) =>
		authority.runForRenderer(rendererId, () => authority.mint({ ...binding, ...overrides }));
	return { authority, mint, readFile, registry };
}

beforeEach(() => {
	electron.protocol.registerSchemesAsPrivileged.mockReset();
	electron.protocol.handle.mockReset();
});

describe("ConversationAttachmentProtocol", () => {
	it("mints an opaque renderer-bound URL that serves the bound file", async () => {
		const { authority, mint, readFile } = setup();
		const url = mint();

		expect(url).toBe(`${CONVERSATION_ATTACHMENT_SCHEME}://cap/download/${TOKEN}`);
		expect(url).not.toContain(binding.conversationId);
		expect(url).not.toContain(binding.attachmentId);
		const response = await authority.handle(request(url));

		expect(response.status).toBe(200);
		expect(readFile).toHaveBeenCalledWith(
			binding.conversationId,
			binding.attachmentId,
			binding.relativePath,
		);
		await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
	});

	it("expires capabilities after five minutes", async () => {
		let now = 1_000;
		const { authority, mint } = setup({ clock: () => now });
		const url = mint();
		now += ATTACHMENT_CAPABILITY_TTL_MS;

		const response = await authority.handle(request(url));

		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("rejects a different renderer even when it knows the capability", async () => {
		const registry = new Map([
			[7, { allowedUrl: RENDERER_URL }],
			[8, { allowedUrl: RENDERER_URL }],
		]);
		const { authority, mint, readFile } = setup({ registry });
		const response = await authority.handle(request(mint(), RENDERER_URL, 8));

		expect(response.status).toBe(403);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("rejects a missing, wrong, or merely same-origin referrer", async () => {
		const { authority, mint } = setup();
		const url = mint();

		await expect(
			authority.handle(request(url, "https://attacker.example/")),
		).resolves.toMatchObject({ status: 403 });
		await expect(
			authority.handle(request(url, "file:///dist/renderer/other.html")),
		).resolves.toMatchObject({ status: 403 });
		await expect(authority.handle(request(url, ""))).resolves.toMatchObject({ status: 403 });
	});

	it("rejects changing the operation encoded by the capability URL", async () => {
		const { authority, mint, readFile } = setup();
		const url = mint().replace("/download/", "/preview/");

		const response = await authority.handle(request(url));

		expect(response.status).toBe(403);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("rechecks conversation ownership and CAS availability on every load", async () => {
		let owned = true;
		const readFile = vi.fn((conversationId: string) => {
			if (!owned || conversationId !== binding.conversationId) {
				throw { kind: "not_found", reason: "attachment_not_found" };
			}
			return {
				relativePath: binding.relativePath,
				mime: binding.mime,
				name: binding.name,
				buffer: Buffer.from("ok"),
			};
		});
		const { authority, mint } = setup({ readFile });
		const url = mint();
		owned = false;

		const response = await authority.handle(request(url));

		expect(response.status).toBe(404);
		expect(readFile).toHaveBeenCalledWith(
			binding.conversationId,
			binding.attachmentId,
			binding.relativePath,
		);
	});

	it("refuses a capability whose bound conversation does not own the attachment", async () => {
		const readFile = vi.fn((conversationId: string) => {
			if (conversationId !== binding.conversationId) {
				throw { kind: "not_found", reason: "attachment_not_found" };
			}
			return {
				relativePath: binding.relativePath,
				mime: binding.mime,
				name: binding.name,
				buffer: Buffer.from("ok"),
			};
		});
		const { authority, mint } = setup({ readFile });
		const url = mint({ conversationId: "conversation-2" });

		const response = await authority.handle(request(url));

		expect(response.status).toBe(404);
		expect(readFile).toHaveBeenCalledWith(
			"conversation-2",
			binding.attachmentId,
			binding.relativePath,
		);
	});

	it("rejects a file that no longer resolves to the capability-bound path", async () => {
		const readFile = vi.fn().mockReturnValue({
			relativePath: "reports/replaced.txt",
			mime: binding.mime,
			name: "replaced.txt",
			buffer: Buffer.from("wrong"),
		});
		const { authority, mint } = setup({ readFile });

		const response = await authority.handle(request(mint()));

		expect(response.status).toBe(403);
	});

	it("revokes every capability when its renderer closes", async () => {
		const { authority, mint, readFile } = setup();
		const url = mint();
		authority.revokeRenderer(7);

		const response = await authority.handle(request(url));

		expect(response.status).toBe(404);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("allows only safe preview MIME types and rechecks MIME at use", async () => {
		const html = setup();
		expect(() => html.mint({ operation: "preview", mime: "text/html" })).toThrow();

		const readFile = vi.fn().mockReturnValue({
			relativePath: binding.relativePath,
			mime: "image/svg+xml",
			name: "result.svg",
			buffer: Buffer.from("<svg/>"),
		});
		const preview = setup({ readFile });
		const url = preview.mint({ operation: "preview", mime: "image/png" });
		await expect(preview.authority.handle(request(url))).resolves.toMatchObject({ status: 403 });
	});

	it("locks response headers and forces a sanitized download disposition", async () => {
		const readFile = vi.fn().mockReturnValue({
			relativePath: binding.relativePath,
			mime: "text/plain; charset=utf-8",
			name: "report\r\nInjected: yes.txt",
			buffer: Buffer.from("abc"),
		});
		const { authority, mint } = setup({ readFile });
		const response = await authority.handle(request(mint()));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain");
		expect(response.headers.get("content-length")).toBe("3");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
		const disposition = response.headers.get("content-disposition");
		expect(disposition).toMatch(/^attachment; filename=/);
		expect(disposition).not.toMatch(/[\r\n]/);
	});

	it("requires an admitted renderer context before minting", () => {
		const { authority } = setup();
		expect(() => authority.mint(binding)).toThrow();
		expect(() => authority.runForRenderer(99, () => authority.mint(binding))).toThrow();
	});
});

describe("registration", () => {
	it("registers the scheme with minimal privileges before ready", () => {
		registerConversationAttachmentSchemePrivileges();
		expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
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
	});

	it("registers the capability handler after ready", () => {
		const { authority } = setup();
		registerConversationAttachmentProtocol(authority);
		expect(electron.protocol.handle).toHaveBeenCalledWith(
			CONVERSATION_ATTACHMENT_SCHEME,
			expect.any(Function),
		);
	});
});
