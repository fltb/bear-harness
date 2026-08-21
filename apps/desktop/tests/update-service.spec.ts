// @vitest-environment node

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { UpdatePublisherPolicy } from "@bear-harness/product-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compareVersions,
	encodeSignedFeedPayload,
	parseFeed,
	UpdateService,
	verifySha256,
	verifySignedFeed,
} from "../src/main/update-service.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bear-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256Of(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

// --- signed-feed helpers ---------------------------------------------------

const TEST_KEYS = generateKeyPairSync("ed25519");
const OTHER_KEYS = generateKeyPairSync("ed25519");

function pemPublicKey(keys: typeof TEST_KEYS): string {
	return keys.publicKey.export({ type: "spki", format: "pem" }).toString();
}

const TEST_POLICY: UpdatePublisherPolicy = {
	algorithm: "ed25519",
	publicKey: pemPublicKey(TEST_KEYS),
};

/** Wrap feed metadata in a signed envelope (signature over canonical bytes). */
function signedEnvelope(
	feed: unknown,
	keys: typeof TEST_KEYS = TEST_KEYS,
): {
	payload: string;
	signature: string;
} {
	const payload = encodeSignedFeedPayload(feed).toString("base64url");
	const signature = sign(null, Buffer.from(payload, "base64url"), keys.privateKey).toString(
		"base64url",
	);
	return { payload, signature };
}

function isEnvelope(value: unknown): value is { payload: string; signature: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).payload === "string" &&
		typeof (value as Record<string, unknown>).signature === "string"
	);
}

/** Feed + download stub: serves a signed envelope for the feed URL and `archive` for any other URL. */
function stubFetch(feed: unknown, archive = "payload") {
	return vi.fn(async (url: string | URL | Request) => {
		const target = String(url);
		if (target.includes("feed")) {
			const body = isEnvelope(feed) ? JSON.stringify(feed) : JSON.stringify(signedEnvelope(feed));
			return new Response(body, {
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(archive, {
			headers: { "content-length": String(archive.length) },
		});
	});
}

/** Feed stub serving a raw (possibly unsigned/tampered) response body. */
function stubFetchRaw(body: string, archive = "payload") {
	return vi.fn(async (url: string | URL | Request) => {
		const target = String(url);
		if (target.includes("feed")) {
			return new Response(body, {
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(archive, {
			headers: { "content-length": String(archive.length) },
		});
	});
}

describe("verifySha256", () => {
	it("accepts a matching digest", async () => {
		const dir = tempDir();
		const file = join(dir, "blob.bin");
		writeFileSync(file, "hello update");
		await expect(verifySha256(file, sha256Of("hello update"))).resolves.toBe(true);
	});

	it("rejects a mismatching digest", async () => {
		const dir = tempDir();
		const file = join(dir, "blob.bin");
		writeFileSync(file, "hello update");
		await expect(verifySha256(file, sha256Of("tampered"))).resolves.toBe(false);
	});

	it("rejects malformed hashes instead of throwing", async () => {
		const dir = tempDir();
		const file = join(dir, "blob.bin");
		writeFileSync(file, "x");
		await expect(verifySha256(file, "not-a-hash")).resolves.toBe(false);
		await expect(verifySha256(file, "abc")).resolves.toBe(false);
	});
});

describe("compareVersions", () => {
	it("compares numerically on major.minor.patch", () => {
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
		expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
		expect(compareVersions("1.2.4", "1.2.5")).toBe(-1);
	});

	it("ignores prerelease/build suffixes (basic comparison)", () => {
		expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
	});
});

describe("parseFeed", () => {
	it("picks the newest entry newer than current", () => {
		const feed = [
			{ version: "1.0.0", url: "https://x/1" },
			{ version: "1.2.0", url: "https://x/1.2", sha256: sha256Of("a") },
			{ version: "2.0.0", url: "https://x/2", sha256: sha256Of("b") },
		];
		expect(parseFeed(feed, "1.1.0")).toEqual({
			version: "2.0.0",
			url: "https://x/2",
			sha256: sha256Of("b"),
		});
	});

	it("returns null when nothing is newer", () => {
		expect(parseFeed([{ version: "1.0.0", url: "https://x/1" }], "1.0.0")).toBeNull();
		expect(parseFeed([{ version: "0.9.0", url: "https://x/0.9" }], "1.0.0")).toBeNull();
		expect(parseFeed([], "1.0.0")).toBeNull();
	});

	it("accepts a single object instead of an array", () => {
		expect(parseFeed({ version: "2.0.0", url: "https://x/2", sha256: null }, "1.0.0")).toEqual({
			version: "2.0.0",
			url: "https://x/2",
			sha256: null,
		});
	});

	it("tolerates bad entries and skips them", () => {
		const feed = [
			null,
			42,
			{ version: "nope", url: "https://x/bad" },
			{ url: "https://x/no-version" },
			{ version: "3.0.0" },
			{ version: "2.0.0", url: "https://x/2", sha256: sha256Of("c") },
		];
		expect(parseFeed(feed, "1.0.0")).toEqual({
			version: "2.0.0",
			url: "https://x/2",
			sha256: sha256Of("c"),
		});
	});

	it("preserves the sha256 absence semantics", () => {
		expect(parseFeed([{ version: "2.0.0", url: "https://x/2" }], "1.0.0")?.sha256).toBeUndefined();
		expect(
			parseFeed([{ version: "2.0.0", url: "https://x/2", sha256: null }], "1.0.0")?.sha256,
		).toBeNull();
	});

	it("rejects non-object feeds", () => {
		expect(parseFeed("garbage", "1.0.0")).toBeNull();
		expect(parseFeed(undefined, "1.0.0")).toBeNull();
	});
});

describe("verifySignedFeed", () => {
	it("returns the decoded payload for a valid envelope", () => {
		const feed = [{ version: "2.0.0", url: "https://x/2", sha256: sha256Of("a") }];
		expect(verifySignedFeed(signedEnvelope(feed), TEST_POLICY)).toEqual(feed);
	});

	it("rejects an unsigned envelope shape", () => {
		expect(() => verifySignedFeed([{ version: "2.0.0" }], TEST_POLICY)).toThrow(/signed|envelope/i);
		expect(() => verifySignedFeed("garbage", TEST_POLICY)).toThrow(/signed|envelope/i);
		expect(() => verifySignedFeed({ payload: "eyJ2ZXJzaW9uIjoiMi4wLjAifQ" }, TEST_POLICY)).toThrow(
			/signed|envelope/i,
		);
	});

	it("rejects when no publisher policy is configured", () => {
		expect(() => verifySignedFeed(signedEnvelope([{ version: "2.0.0" }]), undefined)).toThrow(
			/publisher|authentication|configured/i,
		);
	});

	it("rejects a payload signed with a different key", () => {
		const envelope = signedEnvelope(
			[{ version: "2.0.0", url: "https://x/2", sha256: sha256Of("a") }],
			OTHER_KEYS,
		);
		expect(() => verifySignedFeed(envelope, TEST_POLICY)).toThrow(/signature/i);
	});

	it("rejects a tampered payload whose signature no longer matches", () => {
		const envelope = signedEnvelope([
			{ version: "2.0.0", url: "https://x/2", sha256: sha256Of("a") },
		]);
		envelope.payload = Buffer.from(
			'[{"sha256":"0000000000000000000000000000000000000000000000000000000000000000","url":"https://x/9","version":"9.9.9"}]',
			"utf8",
		).toString("base64url");
		expect(() => verifySignedFeed(envelope, TEST_POLICY)).toThrow(/signature/i);
	});

	it("rejects a non-canonical payload even when the signature is over those bytes", () => {
		const raw = '{"b":1,"a":2}';
		const envelope = {
			payload: Buffer.from(raw, "utf8").toString("base64url"),
			signature: sign(null, Buffer.from(raw, "utf8"), TEST_KEYS.privateKey).toString("base64url"),
		};
		expect(() => verifySignedFeed(envelope, TEST_POLICY)).toThrow(/canonical/i);
	});

	it("rejects a malformed signature", () => {
		const envelope = {
			payload: encodeSignedFeedPayload([
				{ version: "2.0.0", url: "https://x/2", sha256: sha256Of("a") },
			]).toString("base64url"),
			signature: "AA",
		};
		expect(() => verifySignedFeed(envelope, TEST_POLICY)).toThrow(/signature|algorithm/i);
	});
});

describe("UpdateService", () => {
	it("is disabled when the feed URL is empty (no publisher policy required)", async () => {
		const service = new UpdateService({
			feedUrl: "",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
		});
		await expect(service.check()).resolves.toEqual({
			state: "disabled",
			currentVersion: "1.0.0",
			feedUrl: "",
		});
	});

	it("stages and verifies a newer version end to end", async () => {
		const stagingDir = tempDir();
		const archive = "update-archive-bytes";
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(
				[
					{
						version: "2.1.0",
						url: "https://updates.example/bear-2.1.0.zip",
						sha256: sha256Of(archive),
					},
				],
				archive,
			),
		});

		const state = await service.check();

		expect(state.state).toBe("ready");
		expect(state.latestVersion).toBe("2.1.0");
		expect(state.currentVersion).toBe("1.0.0");
		expect(state.feedUrl).toBe("https://updates.example/feed.json");
		const staged = readFileSync(join(stagingDir, "2.1.0", "bear-2.1.0.zip"));
		expect(staged.toString()).toBe(archive);
		expect(service.getState().state).toBe("ready");
	});

	it("purges stale partials and superseded versions before finalizing", async () => {
		const stagingDir = tempDir();
		writeFileSync(join(stagingDir, "2.0.0.partial"), "unsafe");
		mkdirSync(join(stagingDir, "1.5.0"), { recursive: true });
		mkdirSync(join(stagingDir, "3.0.0"), { recursive: true });
		writeFileSync(join(stagingDir, "1.5.0", "old.zip"), "superseded", { flag: "w" });
		writeFileSync(join(stagingDir, "3.0.0", "bear.zip.partial"), "interrupted", { flag: "w" });
		const archive = "new-archive";
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(
				[{ version: "3.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of(archive) }],
				archive,
			),
		});

		await expect(service.check()).resolves.toMatchObject({
			state: "ready",
			latestVersion: "3.0.0",
		});
		expect(existsSync(join(stagingDir, "2.0.0.partial"))).toBe(false);
		expect(existsSync(join(stagingDir, "1.5.0"))).toBe(false);
		expect(readdirSync(join(stagingDir, "3.0.0"))).toEqual(["bear.zip"]);
	});

	it("remaps a feed basename ending in the reserved .partial suffix", async () => {
		const stagingDir = tempDir();
		const archive = "archive-bytes";
		const fetchFn = stubFetch(
			[
				{
					version: "2.1.0",
					url: "https://updates.example/bear-2.1.0.zip.partial",
					sha256: sha256Of(archive),
				},
			],
			archive,
		);
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn,
		});

		await expect(service.check()).resolves.toMatchObject({
			state: "ready",
			latestVersion: "2.1.0",
		});
		// The finalized archive must never carry the reserved temporary suffix.
		expect(readdirSync(join(stagingDir, "2.1.0"))).toEqual(["bear-2.1.0.zip"]);
		expect(readFileSync(join(stagingDir, "2.1.0", "bear-2.1.0.zip")).toString()).toBe(archive);
		// A later stale-partial purge must preserve the finalized archive: if
		// cleanup had mistaken it for a temporary, the ready check would
		// re-download instead of returning the staged state.
		await expect(service.check()).resolves.toMatchObject({ state: "ready" });
		expect(fetchFn).toHaveBeenCalledTimes(2); // feed + download, no re-download
		expect(readFileSync(join(stagingDir, "2.1.0", "bear-2.1.0.zip")).toString()).toBe(archive);
	});

	it("strips repeated .partial suffixes from the finalized name", async () => {
		const stagingDir = tempDir();
		const archive = "archive-bytes";
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(
				[
					{
						version: "2.0.0",
						url: "https://updates.example/bear.zip.partial.partial",
						sha256: sha256Of(archive),
					},
				],
				archive,
			),
		});

		await expect(service.check()).resolves.toMatchObject({ state: "ready" });
		expect(readdirSync(join(stagingDir, "2.0.0"))).toEqual(["bear.zip"]);
	});

	it("purges stale partials while preserving finalized archives", async () => {
		const stagingDir = tempDir();
		mkdirSync(join(stagingDir, "2.0.0"), { recursive: true });
		writeFileSync(join(stagingDir, "2.0.0", "bear-2.0.0.zip"), "finalized");
		writeFileSync(join(stagingDir, "2.0.0", "bear-2.0.0.zip.partial"), "interrupted");
		writeFileSync(join(stagingDir, "2.0.0", "old.zip.partial"), "stale");
		writeFileSync(join(stagingDir, "2.0.0", "notes.txt"), "unrelated");
		writeFileSync(join(stagingDir, "root.partial"), "abandoned");

		// Constructor cleanup runs immediately; only temporaries may go.
		new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(
				[
					{
						version: "2.0.0",
						url: "https://updates.example/bear-2.0.0.zip",
						sha256: sha256Of("finalized"),
					},
				],
				"finalized",
			),
		});
		expect(existsSync(join(stagingDir, "root.partial"))).toBe(false);
		expect(readdirSync(join(stagingDir, "2.0.0")).sort()).toEqual(["bear-2.0.0.zip", "notes.txt"]);
		expect(readFileSync(join(stagingDir, "2.0.0", "bear-2.0.0.zip")).toString()).toBe("finalized");

		// A restart runs cleanup again; the finalized archive still survives.
		const restarted = new UpdateService({
			feedUrl: "",
			currentVersion: "1.0.0",
			stagingDir,
		});
		expect(restarted.getState().state).toBe("disabled");
		expect(readdirSync(join(stagingDir, "2.0.0")).sort()).toEqual(["bear-2.0.0.zip", "notes.txt"]);
		expect(readFileSync(join(stagingDir, "2.0.0", "bear-2.0.0.zip")).toString()).toBe("finalized");
	});

	it("exposes an honest unsupported apply boundary and deterministic discard", async () => {
		const stagingDir = tempDir();
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(
				[{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("x") }],
				"x",
			),
		});
		await service.check();
		expect(service.apply()).toMatchObject({
			state: "ready",
			applyUnsupported: true,
		});
		expect(service.discard()).toMatchObject({ state: "idle" });
		expect(readdirSync(stagingDir)).toEqual([]);
		expect(service.getState().state).not.toBe("ready");
	});
	it("cancels and cleans up an active download reader", async () => {
		const stagingDir = tempDir();
		let resolveDownloadStarted!: () => void;
		const downloadStarted = new Promise<void>((resolve) => {
			resolveDownloadStarted = resolve;
		});
		let resolveRead!: () => void;
		const readGate = new Promise<void>((resolve) => {
			resolveRead = resolve;
		});
		const reader = {
			read: vi.fn(async () => {
				await readGate;
				return { done: false, value: new Uint8Array([0x70]) };
			}),
			cancel: vi.fn(async () => {}),
			releaseLock: vi.fn(),
		} as unknown as ReadableStreamDefaultReader<Uint8Array>;
		const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).includes("feed")) {
				return new Response(
					JSON.stringify(
						signedEnvelope([
							{
								version: "2.0.0",
								url: "https://updates.example/bear.zip",
								sha256: sha256Of("x"),
							},
						]),
					),
					{ headers: { "content-type": "application/json" } },
				);
			}
			init?.signal?.addEventListener("abort", resolveRead, { once: true });
			resolveDownloadStarted();
			return {
				ok: true,
				status: 200,
				headers: new Headers({ "content-length": "1" }),
				body: { getReader: () => reader },
			} as unknown as Response;
		});
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn,
		});

		const pending = service.check();
		await downloadStarted;
		expect(service.cancel()).toMatchObject({ state: "idle" });
		await expect(pending).resolves.toMatchObject({ state: "idle" });
		expect(reader.cancel).toHaveBeenCalledTimes(1);
		expect(readdirSync(stagingDir)).toEqual([]);
		// Exercise the tick after temporary-directory cleanup: a late stream
		// open/error event here would be reported as an unhandled rejection.
		rmSync(stagingDir, { recursive: true, force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("cancels a feed fetch that never resolves, without waiting the timeout", async () => {
		const stagingDir = tempDir();
		mkdirSync(join(stagingDir, "1.5.0"), { recursive: true });
		writeFileSync(join(stagingDir, "1.5.0", "bear-1.5.0.zip"), "finalized");
		const feedAbort = vi.fn();
		const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
			void url;
			return new Promise<Response>((_, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				const onAbort = (): void => {
					feedAbort();
					reject(new DOMException("aborted", "AbortError"));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		});
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn,
		});

		const pending = service.check();
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
		expect(service.cancel()).toMatchObject({ state: "idle" });
		await expect(pending).resolves.toMatchObject({ state: "idle" });
		expect(feedAbort).toHaveBeenCalledTimes(1);
		expect(readdirSync(stagingDir)).toEqual([]);
	});

	it("cancels a download stuck on backpressure and leaves an empty staging dir", async () => {
		const stagingDir = tempDir();
		let resolveWriteBlocked!: () => void;
		const writeBlocked = new Promise<void>((resolve) => {
			resolveWriteBlocked = resolve;
		});
		// Every write reports backpressure (false) and never drains, so the
		// pipeline parks in the drain wait exactly like a permanently blocked
		// disk write would. Restored in finally so later tests use the real one.
		const writeSpy = vi.spyOn(Writable.prototype, "write").mockImplementation(() => {
			resolveWriteBlocked();
			return false;
		});
		const removeAbortListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");
		try {
			const reader = {
				read: vi.fn(async () => ({ done: false, value: new Uint8Array([0x70]) })),
				cancel: vi.fn(async () => {}),
				releaseLock: vi.fn(),
			} as unknown as ReadableStreamDefaultReader<Uint8Array>;
			const fetchFn = vi.fn(async (url: string | URL | Request) => {
				if (String(url).includes("feed")) {
					return new Response(
						JSON.stringify(
							signedEnvelope([
								{
									version: "2.0.0",
									url: "https://updates.example/bear.zip",
									sha256: sha256Of("x"),
								},
							]),
						),
						{ headers: { "content-type": "application/json" } },
					);
				}
				return {
					ok: true,
					status: 200,
					headers: new Headers({ "content-length": "1" }),
					body: { getReader: () => reader },
				} as unknown as Response;
			});
			const service = new UpdateService({
				feedUrl: "https://updates.example/feed.json",
				currentVersion: "1.0.0",
				stagingDir,
				publisherPolicy: TEST_POLICY,
				fetchFn,
			});

			const pending = service.check();
			await writeBlocked;
			expect(service.cancel()).toMatchObject({ state: "idle" });
			await expect(pending).resolves.toMatchObject({ state: "idle" });
			expect(reader.cancel).toHaveBeenCalledTimes(1);
			expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
			expect(readdirSync(stagingDir)).toEqual([]);
		} finally {
			removeAbortListener.mockRestore();
			writeSpy.mockRestore();
		}
	});

	it("returns the staged state without re-downloading when already ready", async () => {
		const stagingDir = tempDir();
		const fetchFn = stubFetch(
			[{ version: "2.0.0", url: "https://updates.example/bear-2.0.0.zip", sha256: sha256Of("x") }],
			"x",
		);
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn,
		});
		await service.check();
		expect(fetchFn).toHaveBeenCalledTimes(2); // feed + download

		await expect(service.check()).resolves.toMatchObject({
			state: "ready",
			latestVersion: "2.0.0",
		});
		expect(fetchFn).toHaveBeenCalledTimes(2); // no re-fetch, no re-download
	});

	it("goes idle when no update is available", async () => {
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch([{ version: "1.0.0", url: "https://updates.example/same.zip" }]),
		});
		await expect(service.check()).resolves.toMatchObject({ state: "idle" });
	});

	it("rejects an entry that omits sha256", async () => {
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch([{ version: "2.0.0", url: "https://updates.example/bear.zip" }]),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/sha256/i);
	});

	it("rejects an update whose checksum is explicitly marked absent (sha256: null)", async () => {
		const stagingDir = tempDir();
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch([
				{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: null },
			]),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/sha256/i);
		// No archive may be staged without a checksum.
		expect(() => readFileSync(join(stagingDir, "2.0.0", "bear.zip"))).toThrow();
	});

	it("fails verification on a checksum mismatch and cleans the staging file", async () => {
		const stagingDir = tempDir();
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(
				[{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("other") }],
				"actual-bytes",
			),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/checksum/i);
		// The unverified staging file must be cleaned up.
		expect(() => readFileSync(join(stagingDir, "2.0.0", "bear.zip"))).toThrow();
	});

	it("rejects downloads over the size cap", async () => {
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			publisherPolicy: TEST_POLICY,
			maxBytes: 4,
			fetchFn: stubFetch(
				[{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("big") }],
				"way-too-big",
			),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/size/i);
	});

	it("rejects a non-HTTPS download URL", async () => {
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch([
				{ version: "2.0.0", url: "http://updates.example/bear.zip", sha256: sha256Of("x") },
			]),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/https/i);
	});

	it("coalesces concurrent checks onto one pipeline run", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const feedBody = JSON.stringify(
			signedEnvelope([
				{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("x") },
			]),
		);
		const fetchFn = vi.fn(async (url: string | URL | Request) => {
			await gate;
			const target = String(url);
			if (target.includes("feed")) {
				return new Response(feedBody, { headers: { "content-type": "application/json" } });
			}
			return new Response("x", { headers: { "content-length": "1" } });
		});
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			publisherPolicy: TEST_POLICY,
			fetchFn,
		});

		const first = service.check();
		const second = service.check();
		release();
		const [a, b] = await Promise.all([first, second]);

		expect(a.state).toBe("ready");
		expect(b.state).toBe("ready");
		expect(fetchFn).toHaveBeenCalledTimes(2); // one feed fetch + one download, no duplicate pipeline
	});

	it("sanitizes errors so staging paths never leak", async () => {
		const stagingDir = tempDir();
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			fetchFn: vi.fn(async () => {
				throw new Error(`disk full writing ${stagingDir}/2.0.0/bear.zip`);
			}),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).not.toContain(stagingDir);
	});

	it("recovers from an error on the next check", async () => {
		const stagingDir = tempDir();
		const fetchFn = vi
			.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockImplementation(
				stubFetch(
					[{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("x") }],
					"x",
				),
			);
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn,
		});

		const failed = await service.check();
		expect(failed.state).toBe("error");
		expect(failed.error).toMatch(/network/);

		await expect(service.check()).resolves.toMatchObject({
			state: "ready",
			latestVersion: "2.0.0",
		});
	});

	it("rejects an unsigned feed before any entry can be trusted", async () => {
		const stagingDir = tempDir();
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetchRaw(
				JSON.stringify([
					{
						version: "2.0.0",
						url: "https://updates.example/bear.zip",
						sha256: sha256Of("checksum-valid-archive"),
					},
				]),
			),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/signed|envelope|publisher/i);
		// The unauthenticated feed must never reach available/downloading.
		expect(state.latestVersion).toBeUndefined();
		expect(() => readFileSync(join(stagingDir, "2.0.0", "bear.zip"))).toThrow();
	});

	it("rejects a feed signed by a different publisher key", async () => {
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(
				signedEnvelope(
					[{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("x") }],
					OTHER_KEYS,
				),
			),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/signature/i);
		expect(state.latestVersion).toBeUndefined();
	});

	it("rejects a tampered signed feed", async () => {
		const envelope = signedEnvelope([
			{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("x") },
		]);
		envelope.payload = Buffer.from(
			'[{"sha256":"0000000000000000000000000000000000000000000000000000000000000000","url":"https://updates.example/evil.zip","version":"9.9.9"}]',
			"utf8",
		).toString("base64url");
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			publisherPolicy: TEST_POLICY,
			fetchFn: stubFetch(envelope),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/signature/i);
		expect(state.latestVersion).toBeUndefined();
	});

	it("rejects a signed feed when no publisher policy is configured", async () => {
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			fetchFn: stubFetch([
				{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("x") },
			]),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/publisher|authentication|configured/i);
		expect(state.latestVersion).toBeUndefined();
	});
});
