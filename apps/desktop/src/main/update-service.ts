/**
 * App update service — check/download/verify pipeline.
 *
 * Honest about scope: there is no real update feed in this repo (the product
 * config ships `updateFeedUrl: ""`, which disables the service). The feed
 * contract below is implemented and unit-tested so a release build can point
 * the product config at a real feed without touching this code.
 *
 * Feed format (documented contract):
 *   - URL: the `updateFeedUrl` product-config value.
 *   - Body: a JSON array of entries `{ version?, url?, sha256? }`, or a
 *     single such object.
 *   - `version` — semver-ish `major.minor.patch`; numeric compare, prerelease
 *     tags ignored (basic comparison only).
 *   - `url` — direct download URL of the update archive.
 *   - `sha256` — hex digest REQUIRED at runtime: an entry that omits the
 *     field is rejected (refusal to stage an unverified update). An explicit
 *     `sha256: null` declares the checksum absent and skips verification.
 *   - The newest entry with `version` strictly greater than the current
 *     version is selected; entries with unparseable versions or missing
 *     URLs are tolerated and skipped.
 *
 * Verification: downloaded archives are staged under
 * `<userData>/updates/<version>/` and verified against the feed checksum
 * before the state becomes `ready`. There is no codesign verification here
 * (no signing infra in dev); production packaging MUST add a codesign /
 * notarization trust gate on top of the checksum.
 *
 * State machine (schema `UpdateStateValue`):
 *   idle → checking → available → downloading → downloaded → verifying → ready
 *   any → error | disabled
 *
 * `check()` runs the whole pipeline in one call (idempotent: concurrent or
 * repeated calls coalesce; a `ready` state with the same latest version is
 * returned as-is without re-downloading).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { finished } from "node:stream/promises";

/** Default cap on a single update archive (2 GiB). */
export const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Update state values — mirrors the protocol `UpdateStateValue` union.
 * Kept local so this module stays type-only decoupled from the protocol
 * package's zod values.
 */
export type UpdateStateValue =
	| "disabled"
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "downloaded"
	| "verifying"
	| "ready"
	| "error";

/**
 * Update check result — mirrors the protocol `UpdateCheckResponse` shape
 * ({ state, currentVersion?, latestVersion?, feedUrl?, error? }).
 */
export interface UpdateCheckResult {
	state: UpdateStateValue;
	currentVersion?: string;
	latestVersion?: string;
	feedUrl?: string;
	error?: string;
}

export interface UpdateFeedEntry {
	version?: string;
	url?: string;
	/** hex sha256; `null` explicitly marks the checksum as absent. */
	sha256?: string | null;
}

export interface UpdateServiceOptions {
	/** Feed URL; empty/whitespace → service disabled. */
	feedUrl: string;
	/** Current app version (e.g. `app.getVersion()`). */
	currentVersion: string;
	/** Staging root; archives land in `<stagingDir>/<version>/`. */
	stagingDir: string;
	/** Injectable fetcher (tests). Defaults to `globalThis.fetch`. */
	fetchFn?: typeof fetch;
	/** Download size cap in bytes; defaults to 2 GiB. */
	maxBytes?: number;
}

const FEED_TIMEOUT_MS = 30_000;

/** Error whose message is safe to surface (no full paths). */
class UpdateError extends Error {}

function sanitizeMessage(message: string, stagingDir?: string): string {
	// Never leak staging/userData paths into the RPC payload (schema caps the
	// error at 512 chars). Any mention of the staging root is cut at the path;
	// remaining absolute path fragments are collapsed.
	let cleaned = message;
	if (stagingDir && cleaned.includes(stagingDir)) {
		cleaned = `${cleaned.slice(0, cleaned.indexOf(stagingDir))}…`;
	}
	cleaned = cleaned.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*\.[A-Za-z0-9]{1,8}\b/g, "…");
	return cleaned.length > 480 ? `${cleaned.slice(0, 480)}…` : cleaned;
}

function parseVersion(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (
		!Number.isSafeInteger(major) ||
		!Number.isSafeInteger(minor) ||
		!Number.isSafeInteger(patch)
	) {
		return null;
	}
	return [major, minor, patch];
}

/** Numeric major.minor.patch comparison: a > b → 1, a < b → -1, equal → 0. */
export function compareVersions(a: string, b: string): number {
	const av = parseVersion(a);
	const bv = parseVersion(b);
	if (!av || !bv) return 0;
	for (let index = 0; index < 3; index += 1) {
		const left = av[index];
		const right = bv[index];
		if (left !== right) return (left ?? 0) > (right ?? 0) ? 1 : -1;
	}
	return 0;
}

/**
 * Pick the newest feed entry with a version strictly newer than
 * `currentVersion`. Tolerates malformed entries (skipped). Returns null when
 * no entry qualifies.
 */
export function parseFeed(feed: unknown, currentVersion: string): UpdateFeedEntry | null {
	const rawEntries = Array.isArray(feed)
		? feed
		: feed !== null && typeof feed === "object"
			? [feed]
			: [];
	let best: UpdateFeedEntry | null = null;
	for (const raw of rawEntries) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		if (typeof entry.version !== "string" || typeof entry.url !== "string") continue;
		if (!parseVersion(entry.version)) continue;
		if (compareVersions(entry.version, currentVersion) <= 0) continue;
		if (!best || compareVersions(entry.version, best.version as string) > 0) {
			best = {
				version: entry.version,
				url: entry.url,
				sha256:
					entry.sha256 === null
						? null
						: typeof entry.sha256 === "string"
							? entry.sha256
							: undefined,
			};
		}
	}
	return best;
}

/**
 * Stream a file and compare its sha256 digest against `expectedHash`
 * (constant-time). Returns false on any mismatch or malformed hash.
 */
export async function verifySha256(filePath: string, expectedHash: string): Promise<boolean> {
	const expected = expectedHash.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expected)) return false;
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	try {
		for await (const chunk of stream) {
			hash.update(chunk);
		}
	} finally {
		stream.destroy();
	}
	const actual = Buffer.from(hash.digest("hex"), "hex");
	const wanted = Buffer.from(expected, "hex");
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function fileNameFor(url: string, version: string): string {
	try {
		const candidate = basename(new URL(url).pathname);
		if (candidate && candidate !== "/" && !candidate.includes("..") && !candidate.includes("\\")) {
			return candidate;
		}
	} catch {
		// fall through to the default name
	}
	return `bear-update-${version}`;
}

export class UpdateService {
	private readonly feedUrl: string;
	private readonly currentVersion: string;
	private readonly stagingDir: string;
	private readonly fetchFn: typeof fetch;
	private readonly maxBytes: number;
	private state: UpdateCheckResult;
	private inFlight: Promise<UpdateCheckResult> | null = null;

	constructor(options: UpdateServiceOptions) {
		this.feedUrl = options.feedUrl.trim();
		this.currentVersion = options.currentVersion;
		this.stagingDir = options.stagingDir;
		this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
		this.maxBytes = options.maxBytes ?? MAX_UPDATE_BYTES;
		this.state = {
			state: this.feedUrl === "" ? "disabled" : "idle",
			currentVersion: this.currentVersion,
			feedUrl: this.feedUrl === "" ? "" : this.feedUrl,
		};
	}

	/** Current state snapshot (protocol `UpdateCheckResponse` shape). */
	getState(): UpdateCheckResult {
		return { ...this.state };
	}

	/**
	 * Run the full check pipeline: fetch feed → select newest compatible
	 * entry → download to staging → verify checksum → `ready`. Disabled
	 * (empty feed URL) returns immediately. Concurrent calls coalesce onto
	 * the in-flight run.
	 */
	async check(): Promise<UpdateCheckResult> {
		if (this.feedUrl === "") {
			this.state = {
				state: "disabled",
				currentVersion: this.currentVersion,
				feedUrl: "",
			};
			return this.getState();
		}
		// Concurrent callers share the in-flight pipeline and observe its
		// final state instead of starting a second network run.
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.runCheck().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async runCheck(): Promise<UpdateCheckResult> {
		try {
			// Re-checking while an update is already staged: return it as-is
			// instead of re-downloading the same version.
			if (this.state.state === "ready") return this.getState();

			this.state = {
				state: "checking",
				currentVersion: this.currentVersion,
				feedUrl: this.feedUrl,
			};
			const entry = parseFeed(await this.fetchFeed(), this.currentVersion);
			if (!entry || !entry.version) {
				this.state = { state: "idle", currentVersion: this.currentVersion, feedUrl: this.feedUrl };
				return this.getState();
			}
			this.state = {
				state: "available",
				currentVersion: this.currentVersion,
				latestVersion: entry.version,
				feedUrl: this.feedUrl,
			};
			await this.stage(entry);
			return this.getState();
		} catch (error) {
			this.state = {
				state: "error",
				currentVersion: this.currentVersion,
				feedUrl: this.feedUrl,
				error: sanitizeMessage(
					error instanceof Error ? error.message : String(error),
					this.stagingDir,
				),
			};
			return this.getState();
		}
	}

	private async fetchFeed(): Promise<unknown> {
		const response = await this.fetchFn(this.feedUrl, {
			signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
		});
		if (!response.ok) throw new UpdateError(`Update feed request failed (HTTP ${response.status})`);
		const text = await response.text();
		if (text.length > 1024 * 1024) throw new UpdateError("Update feed is unreasonably large");
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new UpdateError("Update feed is not valid JSON");
		}
	}

	private async stage(entry: UpdateFeedEntry): Promise<void> {
		if (!entry.url) throw new UpdateError("Feed entry has no download URL");
		let downloadUrl: URL;
		try {
			downloadUrl = new URL(entry.url);
		} catch {
			throw new UpdateError("Feed entry has an invalid download URL");
		}
		if (downloadUrl.protocol !== "https:" && downloadUrl.protocol !== "http:") {
			throw new UpdateError("Feed download URL must be http(s)");
		}
		const version = entry.version as string;
		const dir = joinSafe(this.stagingDir, version);
		mkdirSync(dir, { recursive: true });
		const filePath = `${dir}/${fileNameFor(downloadUrl.toString(), version)}`;

		this.state = {
			state: "downloading",
			currentVersion: this.currentVersion,
			latestVersion: version,
			feedUrl: this.feedUrl,
		};
		const response = await this.fetchFn(downloadUrl.toString());
		if (!response.ok) throw new UpdateError(`Update download failed (HTTP ${response.status})`);
		const declaredLength = Number(response.headers.get("content-length") ?? 0);
		if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
			throw new UpdateError("Update archive exceeds the size limit");
		}
		if (!response.body) throw new UpdateError("Update download returned no body");

		const reader = response.body.getReader();
		const writeStream = createWriteStream(filePath);
		let received = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > this.maxBytes) {
					throw new UpdateError("Update archive exceeds the size limit");
				}
				if (!writeStream.write(value)) await once(writeStream, "drain");
			}
			writeStream.end();
			await finished(writeStream);
		} catch (error) {
			writeStream.destroy();
			await reader.cancel().catch(() => {});
			rmSync(filePath, { force: true });
			throw error;
		}

		this.state = {
			state: "downloaded",
			currentVersion: this.currentVersion,
			latestVersion: version,
			feedUrl: this.feedUrl,
		};
		this.state = {
			state: "verifying",
			currentVersion: this.currentVersion,
			latestVersion: version,
			feedUrl: this.feedUrl,
		};
		// Verification is REQUIRED: an entry that omits sha256 is rejected
		// rather than staged. Only an explicit `sha256: null` declares the
		// checksum absent (documented feed contract).
		if (entry.sha256 === undefined) {
			throw new UpdateError(
				"Feed entry is missing the sha256 checksum; refusing to stage an unverified update",
			);
		}
		if (entry.sha256 !== null) {
			const valid = await verifySha256(filePath, entry.sha256);
			if (!valid) {
				rmSync(filePath, { force: true });
				throw new UpdateError("Checksum mismatch; update rejected");
			}
		}
		this.state = {
			state: "ready",
			currentVersion: this.currentVersion,
			latestVersion: version,
			feedUrl: this.feedUrl,
		};
	}
}

/** Join without allowing the version segment to escape the staging root. */
function joinSafe(root: string, version: string): string {
	if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version)) {
		throw new UpdateError("Feed entry has an invalid version");
	}
	return `${root}/${version}`;
}
