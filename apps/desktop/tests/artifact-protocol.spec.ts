// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
	protocol: {
		registerSchemesAsPrivileged: vi.fn(),
		handle: vi.fn(),
	},
}));

vi.mock("electron", () => electron);

import {
	ARTIFACT_SCHEME,
	bearArtifactHandler,
	parseArtifactUrl,
	registerArtifactProtocol,
	registerArtifactSchemePrivileges,
} from "../src/main/artifact-protocol.js";

const DEV_URL = "http://127.0.0.1:3100/";
const FILE_URL = "file:///dist/renderer/index.html";

interface FakeArtifact {
	mime: string;
	logicalName: string;
	bytes: number;
	blob: Buffer | null;
}

interface FakeLookup {
	get(id: string): { mime: string; logicalName: string; bytes: number } | null;
	readBlob(id: string): Buffer | null;
}

function fakeLookup(artifacts: Record<string, FakeArtifact>): FakeLookup {
	return {
		get: (id: string) => {
			const artifact = artifacts[id];
			return artifact
				? { mime: artifact.mime, logicalName: artifact.logicalName, bytes: artifact.bytes }
				: null;
		},
		readBlob: (id: string) => artifacts[id]?.blob ?? null,
	};
}

function makeRequest(url: string, referrer: string): Request {
	return new Request(url, { referrer });
}
function protocolOptions(lookup: FakeLookup, allowedUrl: string) {
	return {
		...lookup,
		windowRegistry: new Map([[1, { allowedUrl }]]),
	};
}

beforeEach(() => {
	electron.protocol.registerSchemesAsPrivileged.mockReset();
	electron.protocol.handle.mockReset();
});

describe("parseArtifactUrl", () => {
	it("parses bear-artifact://artifact/<id>", () => {
		expect(parseArtifactUrl("bear-artifact://artifact/abc-123")).toEqual({
			kind: "ok",
			id: "abc-123",
		});
	});

	it("decodes percent-encoded ids", () => {
		expect(parseArtifactUrl("bear-artifact://artifact/a%20b")).toEqual({ kind: "ok", id: "a b" });
	});

	it("ignores query/fragment on the id segment", () => {
		expect(parseArtifactUrl("bear-artifact://artifact/abc-123?x=1#frag")).toEqual({
			kind: "ok",
			id: "abc-123",
		});
	});

	it("classifies malformed ids as invalid (404)", () => {
		expect(parseArtifactUrl("bear-artifact://artifact/%zz")).toEqual({ kind: "invalid" });
	});

	it("classifies non-endpoint scheme content as unknown (403)", () => {
		expect(parseArtifactUrl("bear-artifact://other/abc")).toEqual({ kind: "unknown" });
		expect(parseArtifactUrl("bear-artifact://artifact/")).toEqual({ kind: "unknown" });
		expect(parseArtifactUrl("bear-artifact://artifact/a/b")).toEqual({ kind: "unknown" });
		expect(parseArtifactUrl("https://artifact/abc")).toEqual({ kind: "unknown" });
	});
});

describe("bearArtifactHandler", () => {
	const artifact = {
		mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		logicalName: "report.xlsx",
		bytes: 3,
		blob: Buffer.from([1, 2, 3]),
	};

	it("serves a known artifact with locked-down headers", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(makeRequest(`bear-artifact://artifact/id-1`, DEV_URL));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(artifact.mime);
		expect(response.headers.get("content-length")).toBe("3");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
	});

	it("404s an unknown artifact id", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(makeRequest("bear-artifact://artifact/missing", DEV_URL));
		expect(response.status).toBe(404);
	});

	it("404s when the record exists but the CAS blob is gone", async () => {
		const handler = bearArtifactHandler(
			protocolOptions(fakeLookup({ "id-1": { ...artifact, blob: null } }), DEV_URL),
		);
		const response = await handler(makeRequest("bear-artifact://artifact/id-1", DEV_URL));
		expect(response.status).toBe(404);
	});

	it("404s a malformed id", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(makeRequest("bear-artifact://artifact/%zz", DEV_URL));
		expect(response.status).toBe(404);
	});

	it("403s unknown scheme content", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(makeRequest("bear-artifact://evil/leak", DEV_URL));
		expect(response.status).toBe(403);
	});

	it("403s a sender from a different origin", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(
			makeRequest("bear-artifact://artifact/id-1", "https://attacker.example/"),
		);
		expect(response.status).toBe(403);
	});

	it("requires the exact renderer URL rather than the same origin", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(
			makeRequest("bear-artifact://artifact/id-1", "http://127.0.0.1:3100/elsewhere"),
		);
		expect(response.status).toBe(403);
	});

	it("accepts Electron's URL-bearing referrer representation", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler({
			url: "bear-artifact://artifact/id-1",
			referrer: { url: DEV_URL },
		} as unknown as Request);
		expect(response.status).toBe(200);
	});

	it("rejects a referrer after its renderer registration is removed", async () => {
		const options = protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL);
		const handler = bearArtifactHandler(options);
		options.windowRegistry.clear();
		const response = await handler(makeRequest("bear-artifact://artifact/id-1", DEV_URL));
		expect(response.status).toBe(403);
	});

	it("403s an empty referrer for http(s) windows", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(makeRequest("bear-artifact://artifact/id-1", ""));
		expect(response.status).toBe(403);
	});

	it("403s an empty referrer for file:// windows", async () => {
		const handler = bearArtifactHandler(
			protocolOptions(fakeLookup({ "id-1": artifact }), FILE_URL),
		);
		const response = await handler(makeRequest("bear-artifact://artifact/id-1", ""));
		expect(response.status).toBe(403);
	});

	it("serves file:// windows whose referrer is also file:", async () => {
		const handler = bearArtifactHandler(
			protocolOptions(fakeLookup({ "id-1": artifact }), FILE_URL),
		);
		const response = await handler(
			makeRequest("bear-artifact://artifact/id-1", "file:///dist/renderer/index.html"),
		);
		expect(response.status).toBe(200);
	});

	it("403s a file:// referrer when the window is http", async () => {
		const handler = bearArtifactHandler(protocolOptions(fakeLookup({ "id-1": artifact }), DEV_URL));
		const response = await handler(
			makeRequest("bear-artifact://artifact/id-1", "file:///dist/renderer/index.html"),
		);
		expect(response.status).toBe(403);
	});
});

describe("registration", () => {
	it("registers the scheme with minimal privileges before ready", () => {
		registerArtifactSchemePrivileges();

		expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
			{
				scheme: ARTIFACT_SCHEME,
				privileges: {
					standard: false,
					secure: true,
					supportFetchAPI: true,
					stream: true,
				},
			},
		]);
	});

	it("registers the handler after ready", () => {
		const handler = vi.fn();
		electron.protocol.handle.mockImplementationOnce((_scheme, fn) => {
			expect(fn).toBeTypeOf("function");
		});
		registerArtifactProtocol(protocolOptions(fakeLookup({}), DEV_URL));

		expect(electron.protocol.handle).toHaveBeenCalledWith(ARTIFACT_SCHEME, expect.any(Function));
	});
});
