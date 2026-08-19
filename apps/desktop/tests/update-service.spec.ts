// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compareVersions,
	parseFeed,
	UpdateService,
	verifySha256,
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

/** Feed + download stub: serves `feed` for the feed URL and `archive` for any other URL. */
function stubFetch(feed: unknown, archive = "payload") {
	return vi.fn(async (url: string | URL | Request) => {
		const target = String(url);
		if (target.includes("feed")) {
			return new Response(JSON.stringify(feed), {
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

describe("UpdateService", () => {
	it("is disabled when the feed URL is empty", async () => {
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
			fetchFn: stubFetch([{ version: "1.0.0", url: "https://updates.example/same.zip" }]),
		});
		await expect(service.check()).resolves.toMatchObject({ state: "idle" });
	});

	it("rejects an entry that omits sha256", async () => {
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
			fetchFn: stubFetch([{ version: "2.0.0", url: "https://updates.example/bear.zip" }]),
		});
		const state = await service.check();
		expect(state.state).toBe("error");
		expect(state.error).toMatch(/sha256/);
	});

	it("stages an update whose checksum is explicitly marked absent (sha256: null)", async () => {
		const stagingDir = tempDir();
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
			fetchFn: stubFetch([
				{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: null },
			]),
		});
		const state = await service.check();
		expect(state.state).toBe("ready");
		expect(readFileSync(join(stagingDir, "2.0.0", "bear.zip")).length).toBeGreaterThan(0);
	});

	it("fails verification on a checksum mismatch and cleans the staging file", async () => {
		const stagingDir = tempDir();
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir,
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

	it("coalesces concurrent checks onto one pipeline run", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchFn = vi.fn(async (url: string | URL | Request) => {
			await gate;
			const target = String(url);
			if (target.includes("feed")) {
				return new Response(
					JSON.stringify([
						{ version: "2.0.0", url: "https://updates.example/bear.zip", sha256: sha256Of("x") },
					]),
					{ headers: { "content-type": "application/json" } },
				);
			}
			return new Response("x", { headers: { "content-length": "1" } });
		});
		const service = new UpdateService({
			feedUrl: "https://updates.example/feed.json",
			currentVersion: "1.0.0",
			stagingDir: tempDir(),
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
});
