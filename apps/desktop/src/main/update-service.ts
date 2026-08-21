/**
 * App update service — check/download/verify staging pipeline.
 *
 * This service deliberately stops at a verified, staged archive. It never
 * claims to install or apply an update: callers must use an external
 * installer after the typed `apply()` boundary reports `applyUnsupported`.
 *
 * The feed is an Ed25519-signed envelope whose canonical payload contains
 * HTTPS archive URLs and mandatory SHA-256 digests. Archives are downloaded
 * to a `.partial` file, verified there, and atomically renamed into place.
 * Partial files and superseded version directories are removed
 * deterministically on startup, retry, failure, cancellation, or discard.
 *
 * The `.partial` suffix is reserved for service-created temporary files.
 * Finalized archive names are deterministically remapped so they can never
 * carry it (see `PARTIAL_SUFFIX` / `fileNameFor`), which is what keeps stale
 * cleanup from ever mistaking a finalized archive for a temporary file.
 *
 * State machine (schema `UpdateStateValue`):
 *   idle → checking → available → downloading → downloaded → verifying → ready
 *   any → error | disabled
 */

import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { once } from "node:events";
import type { WriteStream } from "node:fs";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import type { UpdatePublisherPolicy } from "@bear-harness/product-config";

/** Default cap on a single update archive (2 GiB). */
export const MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Reserved suffix for service-created temporary files. A download in flight
 * lives at `<final-name>.partial` and is atomically renamed into place only
 * after checksum verification. Cleanup identifies stale temporaries purely by
 * this suffix, so a finalized archive must never end with it: `fileNameFor`
 * deterministically strips it from feed basenames.
 */
export const PARTIAL_SUFFIX = ".partial";

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

/** Result of the explicit apply boundary; installation is not implemented. */
export interface UpdateApplyResult {
	state: UpdateStateValue;
	applyUnsupported: true;
	latestVersion?: string;
	error?: string;
}

export interface UpdateFeedEntry {
	version?: string;
	url?: string;
	/** hex sha256; REQUIRED — omitting it or `null` rejects the entry. */
	sha256?: string | null;
}

export interface UpdateServiceOptions {
	/** Feed URL; empty/whitespace → service disabled. */
	feedUrl: string;
	/** Current app version (e.g. `app.getVersion()`). */
	currentVersion: string;
	/** Staging root; archives land in `<stagingDir>/<version>/`. */
	stagingDir: string;
	/** Publisher policy used to authenticate a non-empty feed. */
	publisherPolicy?: UpdatePublisherPolicy;
	/** Injectable fetcher (tests). Defaults to `globalThis.fetch`. */
	fetchFn?: typeof fetch;
	/** Download size cap in bytes; defaults to 2 GiB. */
	maxBytes?: number;
}

const FEED_TIMEOUT_MS = 30_000;

/** Signed-feed JSON envelope. Payload and signature are unpadded base64url. */
export interface SignedUpdateFeedEnvelope {
	payload: string;
	signature: string;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new UpdateError("Signed update payload contains an invalid number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	throw new UpdateError("Signed update payload contains an unsupported value");
}

/** Encode feed metadata into the exact bytes publishers must sign. */
export function encodeSignedFeedPayload(feed: unknown): Buffer {
	return Buffer.from(canonicalJson(feed), "utf8");
}

function decodeBase64Url(value: unknown, label: string): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new UpdateError(`Signed update ${label} is not valid base64url`);
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length === 0 || decoded.toString("base64url") !== value) {
		throw new UpdateError(`Signed update ${label} is not valid base64url`);
	}
	return decoded;
}

/** Verify and decode a signed-feed envelope before feed parsing. */
export function verifySignedFeed(
	envelope: unknown,
	publisherPolicy: UpdatePublisherPolicy | undefined,
): unknown {
	if (publisherPolicy?.algorithm !== "ed25519") {
		throw new UpdateError("Update feed publisher authentication is not configured");
	}
	if (
		envelope === null ||
		typeof envelope !== "object" ||
		Array.isArray(envelope) ||
		typeof (envelope as Record<string, unknown>).payload !== "string" ||
		typeof (envelope as Record<string, unknown>).signature !== "string"
	) {
		throw new UpdateError("Update feed has no signed metadata envelope");
	}
	const rawEnvelope = envelope as Record<string, unknown>;
	const payloadBytes = decodeBase64Url(rawEnvelope.payload, "payload");
	const signature = decodeBase64Url(rawEnvelope.signature, "signature");
	let payload: unknown;
	try {
		payload = JSON.parse(payloadBytes.toString("utf8")) as unknown;
	} catch {
		throw new UpdateError("Signed update payload is not valid JSON");
	}
	const canonicalBytes = encodeSignedFeedPayload(payload);
	if (!canonicalBytes.equals(payloadBytes)) {
		throw new UpdateError("Signed update payload is not canonical");
	}
	let publicKey: ReturnType<typeof createPublicKey>;
	try {
		publicKey = createPublicKey(publisherPolicy.publicKey);
	} catch {
		throw new UpdateError("Update feed publisher public key is invalid");
	}
	if (publicKey.asymmetricKeyType !== "ed25519" || signature.length !== 64) {
		throw new UpdateError("Update feed signature algorithm or key is invalid");
	}
	if (!verify(null, payloadBytes, publicKey, signature)) {
		throw new UpdateError("Update feed signature is invalid");
	}
	return payload;
}
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
		let candidate = basename(new URL(url).pathname);
		if (candidate && candidate !== "/" && !candidate.includes("..") && !candidate.includes("\\")) {
			// The `.partial` suffix is reserved for service-created temporary
			// files (cleanup removes stale temporaries purely by that suffix).
			// Strip it repeatedly (e.g. `a.partial.partial`) so a finalized
			// archive can never carry a name cleanup would delete.
			while (candidate.endsWith(PARTIAL_SUFFIX)) {
				candidate = candidate.slice(0, -PARTIAL_SUFFIX.length);
			}
			if (candidate) return candidate;
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
	private readonly publisherPolicy: UpdatePublisherPolicy | undefined;
	private readonly maxBytes: number;
	private state: UpdateCheckResult;
	private inFlight: Promise<UpdateCheckResult> | null = null;
	private activeAbort: AbortController | null = null;
	private activeWriteStream: WriteStream | null = null;
	private cancelRequested = false;
	private stagedPath: string | null = null;

	constructor(options: UpdateServiceOptions) {
		this.feedUrl = options.feedUrl.trim();
		this.currentVersion = options.currentVersion;
		this.stagingDir = options.stagingDir;
		this.publisherPolicy = options.publisherPolicy;
		this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
		this.maxBytes = options.maxBytes ?? MAX_UPDATE_BYTES;
		this.state = {
			state: this.feedUrl === "" ? "disabled" : "idle",
			currentVersion: this.currentVersion,
			feedUrl: this.feedUrl === "" ? "" : this.feedUrl,
		};
		this.cleanupStalePartials();
	}

	/** Current state snapshot (protocol `UpdateCheckResponse` shape). */
	getState(): UpdateCheckResult {
		return { ...this.state };
	}

	/**
	 * Discard the staged archive and all partial/superseded update data.
	 * This is also the cancellation boundary for an in-flight download.
	 */
	discard(): UpdateCheckResult {
		this.cancelRequested = true;
		this.activeAbort?.abort();
		// Destroy the active write stream so a download stalled on backpressure
		// (awaiting a drain that will never arrive) exits instead of hanging.
		this.activeWriteStream?.destroy();
		// An in-flight stage owns the partial stream and removes its directory
		// after the stream's error/close lifecycle has settled. Removing it here
		// races createWriteStream's deferred open callback.
		if (!this.inFlight) this.cleanupAllStaging();
		this.stagedPath = null;
		this.state = {
			state: this.feedUrl === "" ? "disabled" : "idle",
			currentVersion: this.currentVersion,
			feedUrl: this.feedUrl === "" ? "" : this.feedUrl,
		};
		return this.getState();
	}

	/**
	 * Installation is intentionally outside this service. The archive remains
	 * staged and callers must hand it to an external, platform-specific
	 * installer after receiving this typed unsupported result.
	 */
	apply(): UpdateApplyResult {
		return {
			state: this.state.state,
			applyUnsupported: true,
			latestVersion: this.state.latestVersion,
			error:
				this.state.state === "ready"
					? "Update is staged; installation requires an external installer"
					: "No staged update is available for installation",
		};
	}

	/** Cancel an in-flight check and remove unsafe partial data. */
	cancel(): UpdateCheckResult {
		return this.discard();
	}

	/**
	 * Run the full check pipeline. Concurrent calls coalesce onto the
	 * in-flight run, and a verified archive is the only path to `ready`.
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
		if (this.inFlight) return this.inFlight;
		this.cancelRequested = false;
		// One owned controller per run: it aborts the feed fetch, the download
		// fetch, and the drain wait, so a single cancel() cuts every wait.
		const abort = new AbortController();
		this.activeAbort = abort;
		this.inFlight = this.runCheck(abort).finally(() => {
			this.inFlight = null;
			this.activeAbort = null;
			// A cancellation during feed fetch has no stage-level cleanup hook.
			// Remove any finalized or superseded data only after the run has
			// settled, while preserving an archive that completed normally.
			if (this.cancelRequested && this.state.state !== "ready") this.cleanupAllStaging();
		});
		return this.inFlight;
	}

	private async runCheck(abort: AbortController): Promise<UpdateCheckResult> {
		try {
			this.cleanupStalePartials();
			if (this.state.state === "ready" && this.stagedPath) {
				if (existsSync(this.stagedPath)) return this.getState();
				this.stagedPath = null;
				this.state = {
					state: "idle",
					currentVersion: this.currentVersion,
					feedUrl: this.feedUrl,
				};
			}
			this.state = {
				state: "checking",
				currentVersion: this.currentVersion,
				feedUrl: this.feedUrl,
			};
			const entry = parseFeed(await this.fetchFeed(abort.signal), this.currentVersion);
			if (this.cancelRequested) {
				this.cleanupAllStaging();
				return this.getState();
			}
			if (!entry?.version) {
				this.cleanupAllStaging();
				this.state = { state: "idle", currentVersion: this.currentVersion, feedUrl: this.feedUrl };
				return this.getState();
			}
			this.state = {
				state: "available",
				currentVersion: this.currentVersion,
				latestVersion: entry.version,
				feedUrl: this.feedUrl,
			};
			await this.stage(entry, abort);
			return this.getState();
		} catch (error) {
			this.cleanupStalePartials();
			if (this.cancelRequested) return this.getState();
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

	private async fetchFeed(signal: AbortSignal): Promise<unknown> {
		let feedUrl: URL;
		try {
			feedUrl = new URL(this.feedUrl);
		} catch {
			throw new UpdateError("Update feed URL is invalid");
		}
		if (feedUrl.protocol !== "https:") throw new UpdateError("Update feed URL must use HTTPS");
		// The owned run signal combined with the timeout: cancel() aborts the
		// fetch immediately, while the timeout still bounds a stuck network.
		const response = await this.fetchFn(this.feedUrl, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(FEED_TIMEOUT_MS)]),
		});
		if (!response.ok) throw new UpdateError(`Update feed request failed (HTTP ${response.status})`);
		const text = await response.text();
		if (text.length > 1024 * 1024) throw new UpdateError("Update feed is unreasonably large");
		let envelope: unknown;
		try {
			envelope = JSON.parse(text) as unknown;
		} catch {
			throw new UpdateError("Update feed is not valid JSON");
		}
		return verifySignedFeed(envelope, this.publisherPolicy);
	}

	private async stage(entry: UpdateFeedEntry, abort: AbortController): Promise<void> {
		if (!entry.url) throw new UpdateError("Feed entry has no download URL");
		let downloadUrl: URL;
		try {
			downloadUrl = new URL(entry.url);
		} catch {
			throw new UpdateError("Feed entry has an invalid download URL");
		}
		if (downloadUrl.protocol !== "https:")
			throw new UpdateError("Feed download URL must use HTTPS");
		if (entry.sha256 === undefined || entry.sha256 === null) {
			throw new UpdateError("Feed entry requires a sha256 checksum");
		}
		if (!/^[0-9a-f]{64}$/i.test(entry.sha256.trim())) {
			throw new UpdateError("Feed entry has an invalid sha256 checksum");
		}
		if (this.cancelRequested) return;

		const version = entry.version as string;
		const dir = joinSafe(this.stagingDir, version);
		this.cleanupSuperseded(version);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, fileNameFor(downloadUrl.toString(), version));
		const partialPath = `${filePath}${PARTIAL_SUFFIX}`;
		let writeStream: WriteStream | null = null;
		let streamFinished: Promise<{ ok: true } | { ok: false; error: unknown }> = Promise.resolve({
			ok: true as const,
		});
		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
		try {
			this.state = {
				state: "downloading",
				currentVersion: this.currentVersion,
				latestVersion: version,
				feedUrl: this.feedUrl,
			};
			const response = await this.fetchFn(downloadUrl.toString(), {
				signal: abort.signal,
			});
			if (!response.ok) throw new UpdateError(`Update download failed (HTTP ${response.status})`);
			const declaredLength = Number(response.headers.get("content-length") ?? 0);
			if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
				throw new UpdateError("Update archive exceeds the size limit");
			}
			if (!response.body) throw new UpdateError("Update download returned no body");

			reader = response.body.getReader();
			const stream = createWriteStream(partialPath, { flags: "wx" });
			writeStream = stream;
			this.activeWriteStream = stream;
			// Observe the stream immediately: createWriteStream opens lazily and
			// may emit an error while the reader is still being consumed.
			streamFinished = finished(stream).then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			let received = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (this.cancelRequested) throw new UpdateError("Update download cancelled");
				received += value.byteLength;
				if (received > this.maxBytes)
					throw new UpdateError("Update archive exceeds the size limit");
				if (!stream.write(value)) {
					// Race the backpressure wait against the stream settling (a
					// cancel destroys it, closing the stream) and against the abort
					// signal itself, so a permanently blocked drain cannot hang the
					// run past cancellation.
					await this.awaitDrain(stream, abort.signal, streamFinished);
				}
			}
			stream.end();
			const settlement = await streamFinished;
			if (!settlement.ok) throw settlement.error;

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
			if (!(await verifySha256(partialPath, entry.sha256))) {
				throw new UpdateError("Checksum mismatch; update rejected");
			}
			if (this.cancelRequested) throw new UpdateError("Update download cancelled");
			renameSync(partialPath, filePath);
			this.stagedPath = filePath;
			this.state = {
				state: "ready",
				currentVersion: this.currentVersion,
				latestVersion: version,
				feedUrl: this.feedUrl,
			};
		} catch (error) {
			writeStream?.destroy();
			await streamFinished;
			await reader?.cancel().catch(() => {});
			// createWriteStream opens asynchronously. Await its rejection/close
			// settlement before deleting the directory it is trying to open.
			rmSync(dir, { recursive: true, force: true });
			throw error;
		} finally {
			// The run owns the abort controller; this stage only tracks its own
			// write stream so discard() can destroy it during backpressure.
			if (this.activeWriteStream === writeStream) this.activeWriteStream = null;
		}
	}

	/**
	 * Wait for a write stream to drain, exiting early if the stream settles
	 * (error, or destroyed by cancel) or the run's abort signal fires.
	 */
	private async awaitDrain(
		stream: WriteStream,
		signal: AbortSignal,
		streamFinished: Promise<{ ok: true } | { ok: false; error: unknown }>,
	): Promise<void> {
		let rejectAborted!: (reason?: unknown) => void;
		const onAbort = (): void => rejectAborted(new UpdateError("Update download cancelled"));
		const aborted = new Promise<never>((_, reject) => {
			rejectAborted = reject;
		});
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		try {
			await Promise.race([
				once(stream, "drain"),
				streamFinished.then((settlement) => {
					if (settlement.ok) {
						throw new UpdateError("Update download stream closed while writing");
					}
					throw settlement.error;
				}),
				aborted,
			]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	private cleanupStalePartials(): void {
		mkdirSync(this.stagingDir, { recursive: true });
		for (const rootEntry of readdirSync(this.stagingDir, { withFileTypes: true })) {
			const rootPath = join(this.stagingDir, rootEntry.name);
			if (!rootEntry.isDirectory()) {
				// The suffix is reserved for service temporaries; `fileNameFor`
				// guarantees finalized archives never carry it, so this can only
				// remove in-flight/abandoned downloads, never a valid archive.
				if (rootEntry.name.endsWith(PARTIAL_SUFFIX)) rmSync(rootPath, { force: true });
				continue;
			}
			for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
				if (entry.name.endsWith(PARTIAL_SUFFIX))
					rmSync(join(rootPath, entry.name), { force: true });
			}
			if (readdirSync(rootPath).length === 0) rmSync(rootPath, { recursive: true, force: true });
		}
	}

	private cleanupSuperseded(keepVersion: string): void {
		mkdirSync(this.stagingDir, { recursive: true });
		for (const entry of readdirSync(this.stagingDir, { withFileTypes: true })) {
			if (entry.name !== keepVersion || !entry.isDirectory()) {
				rmSync(join(this.stagingDir, entry.name), { recursive: true, force: true });
			}
		}
	}

	private cleanupAllStaging(): void {
		mkdirSync(this.stagingDir, { recursive: true });
		for (const entry of readdirSync(this.stagingDir, { withFileTypes: true })) {
			rmSync(join(this.stagingDir, entry.name), { recursive: true, force: true });
		}
	}
}

/** Join without allowing the version segment to escape the staging root. */
function joinSafe(root: string, version: string): string {
	if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version)) {
		throw new UpdateError("Feed entry has an invalid version");
	}
	return `${root}/${version}`;
}
