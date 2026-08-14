/**
 * Codex executor adapter (M3 executor layer).
 *
 * Operational truth boundary for the Codex app-server: discovery, consent,
 * launch-intent, and status. Per plan §9.4 the harness never installs or
 * upgrades Codex for the user — a profile becomes usable only when an exact
 * pinned-version binary is discovered and explicitly consented to.
 *
 * Discovery checks, in order: (1) PATH entries for `codex`/`codex.exe`,
 * (2) the official standalone default entry `~/.local/bin/codex`
 * (macOS/Linux). Each candidate is lstat-walked through its symlink chain
 * (bounded; a chain escaping its declared install root is rejected),
 * realpath'd, probed with a hidden-argv `codex --version` (10s timeout,
 * windowsHide), and accepted ONLY at the pinned version. SHA-256 is computed
 * for every candidate that yields a parseable version, so mismatch evidence
 * is recorded too.
 *
 * The adapter does not own run lifecycle state — the CommissionService
 * creates the `runs` row and the run FSM (max 2 active) gates transitions.
 * `launch()` only verifies consent and records the run manifest (intent +
 * evidence); the actual codex app-server process management is a future
 * concern.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import type { EventBus } from "../storage/event-bus.js";

/** The only Codex app-server version the harness will run (pinned). */
const PINNED_VERSION = "0.147.0";
/** Bounded `codex --version` probe timeout. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;
/** Max symlink hops while resolving a candidate chain. */
const MAX_SYMLINK_HOPS = 8;

export type CodexCandidateStatus = "usable" | "version_mismatch" | "not_found" | "rejected";

/** One discovered candidate location and its probe result. */
export interface CodexCandidate {
	/** The entry probed (PATH join or the standalone default entry). */
	candidatePath: string;
	/** realpath of the final binary behind the symlink chain, when resolved. */
	canonicalPath: string | null;
	/** Version parsed from `codex --version`, when the probe succeeded. */
	version: string | null;
	/** SHA-256 of the binary, when a parseable version was produced. */
	sha256: string | null;
	status: CodexCandidateStatus;
}

/** Consent input; path/version/hash must match discovery output. */
export interface CodexConsentRequest {
	canonicalPath: string;
	version: string;
	sha256: string;
	codexHome: string;
}

/** The capability record stored in `executor_profiles.capability_json`. */
export interface CodexProfileCapability extends CodexConsentRequest {
	consentedAt: string;
}

/** The manifest recorded in `run_manifests.manifest_json` at launch. */
export interface CodexRunManifest {
	executor: "codex";
	profileId: string;
	runId: string;
	commissionId: string;
	version: string;
	sha256: string;
	canonicalPath: string;
	codexHome: string;
	launchedAt: string;
}

export type CodexStatus =
	| { available: true; profileId: string; version: string; hash: string }
	| { available: false; reason: "no_codex_found" }
	| { available: false; reason: "version_mismatch"; found: string };

/** Error convention: every adapter failure is thrown as `{kind, reason}`. */
function fail(kind: string, reason: string): never {
	const err = new Error(reason) as Error & { kind: string; reason: string };
	err.kind = kind;
	err.reason = reason;
	throw err;
}

/** Stream a file through SHA-256 without loading it whole into memory. */
async function sha256Of(file: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(file), hash);
	return hash.digest("hex");
}

/** Hidden-argv version probe; returns the first x.y.z token, or null. */
function probeVersion(finalBin: string): string | null {
	let stdout = "";
	let stderr = "";
	try {
		stdout = execFileSync(finalBin, ["--version"], {
			encoding: "utf8",
			timeout: VERSION_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
	} catch (e) {
		const err = e as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
		stdout = err.stdout !== undefined ? String(err.stdout) : "";
		stderr = err.stderr !== undefined ? String(err.stderr) : "";
	}
	const match = `${stdout}\n${stderr}`.match(/(\d+\.\d+\.\d+)/);
	return match?.[1] ?? null;
}

export class CodexAdapter {
	private db: DatabaseSync;
	private eventBus: EventBus;

	constructor(db: DatabaseSync, eventBus: EventBus) {
		this.db = db;
		this.eventBus = eventBus;
	}

	/**
	 * Discover Codex candidates per plan §9.4. Never throws — every candidate
	 * location is reported with a status, including absences (`not_found`).
	 */
	async discover(): Promise<CodexCandidate[]> {
		const candidates: CodexCandidate[] = [];
		const seen = new Set<string>();
		const probeIfNew = async (candidatePath: string): Promise<void> => {
			if (seen.has(candidatePath)) return;
			seen.add(candidatePath);
			candidates.push(await this.probe(candidatePath));
		};

		// (1) PATH entries.
		const home = homedir();
		const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) continue;
			const entry = join(dir, binaryName);
			// Keep the walk bounded: skip node-version-manager shim dirs.
			if (entry.startsWith(join(home, ".nvm")) || entry.startsWith(join(home, ".fnm"))) {
				continue;
			}
			try {
				if (statSync(entry).isFile()) await probeIfNew(entry);
			} catch {
				/* not present — not a candidate */
			}
		}

		// (2) Official standalone default entry (macOS/Linux).
		if (process.platform !== "win32") {
			await probeIfNew(join(home, ".local", "bin", "codex"));
		}

		return candidates;
	}

	/** The declared install root for a candidate entry, used for symlink-escape rejection. */
	private installRootOf(entry: string): string {
		if (entry.startsWith("/opt/homebrew")) return "/opt/homebrew";
		if (entry.startsWith("/usr/local")) return "/usr/local";
		const home = homedir();
		if (entry.startsWith(home)) return home;
		return dirname(entry);
	}

	/** Probe a single candidate entry. */
	private async probe(candidatePath: string): Promise<CodexCandidate> {
		const base: CodexCandidate = {
			candidatePath,
			canonicalPath: null,
			version: null,
			sha256: null,
			status: "rejected",
		};

		let st;
		try {
			st = lstatSync(candidatePath);
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
				return { ...base, status: "not_found" };
			}
			return base;
		}

		// Walk the symlink chain with a hop bound; reject loops/dangling links.
		let finalBin = candidatePath;
		let hops = 0;
		while (st.isSymbolicLink() && hops < MAX_SYMLINK_HOPS) {
			let target: string;
			try {
				target = readlinkSync(finalBin);
			} catch {
				return base; // dangling symlink
			}
			finalBin = isAbsolute(target) ? target : resolve(dirname(finalBin), target);
			hops += 1;
			try {
				st = lstatSync(finalBin);
			} catch {
				return base; // target missing
			}
		}
		if (st.isSymbolicLink() || !st.isFile()) return base; // loop / not a binary

		// Reject a chain that escapes its declared install root.
		if (!finalBin.startsWith(this.installRootOf(candidatePath) + sep)) return base;

		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(finalBin);
		} catch {
			return base;
		}

		const version = probeVersion(finalBin);
		if (version === null) return base; // probe failed — no parseable version

		let sha256: string;
		try {
			sha256 = await sha256Of(finalBin);
		} catch {
			return base;
		}

		return {
			candidatePath,
			canonicalPath,
			version,
			sha256,
			status: version === PINNED_VERSION ? "usable" : "version_mismatch",
		};
	}

	/**
	 * Consent to a discovered Codex binary. The path/version/hash must match
	 * the discovery output exactly, otherwise the consent is refused.
	 */
	async consent(profileConfig: CodexConsentRequest): Promise<CodexProfileCapability & { profileId: string }> {
		if (typeof profileConfig.codexHome !== "string" || profileConfig.codexHome.length === 0) {
			fail("validation_failed", "codexHome must be a non-empty string");
		}

		const candidates = await this.discover();
		const match = candidates.find(
			(c) =>
				c.status === "usable" &&
				c.canonicalPath === profileConfig.canonicalPath &&
				c.version === profileConfig.version &&
				c.sha256 === profileConfig.sha256,
		);
		if (!match) {
			fail(
				"validation_failed",
				`no discovered ${PINNED_VERSION} candidate matches {canonicalPath, version, sha256}`,
			);
		}

		const capability: CodexProfileCapability = {
			canonicalPath: profileConfig.canonicalPath,
			version: profileConfig.version,
			sha256: profileConfig.sha256,
			codexHome: profileConfig.codexHome,
			consentedAt: new Date().toISOString(),
		};
		// Deterministic id so re-consent upserts instead of duplicating.
		const profileId =
			"codex-" +
			createHash("sha256")
				.update(`${profileConfig.canonicalPath}\u0000${profileConfig.version}\u0000${profileConfig.sha256}`)
				.digest("hex")
				.slice(0, 16);

		this.db
			.prepare(
				"INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, 'codex', ?) ON CONFLICT(id) DO UPDATE SET capability_json = excluded.capability_json",
			)
			.run(profileId, JSON.stringify(capability));

		this.eventBus.publish("codex.consented", { profileId, ...capability });
		return { profileId, ...capability };
	}

	/**
	 * Record launch intent for a consented profile. The CommissionService
	 * creates the `runs` row before calling this; the adapter only writes the
	 * manifest (FK on run_id is satisfied by the caller) and publishes
	 * `codex.launched`. Actual app-server process management is future work.
	 */
	async launch(profileId: string, runId: string, commissionId: string): Promise<CodexRunManifest> {
		const row = this.db
			.prepare("SELECT capability_json FROM executor_profiles WHERE id = ? AND profile_type = 'codex'")
			.get(profileId) as { capability_json: string } | undefined;
		if (!row) fail("profile_not_found", `no codex executor profile '${profileId}'`);

		let capability: CodexProfileCapability;
		try {
			capability = JSON.parse(row.capability_json) as CodexProfileCapability;
		} catch {
			fail("profile_invalid", `codex profile '${profileId}' has unreadable capability_json`);
		}
		if (typeof capability.consentedAt !== "string") {
			fail("not_consented", `codex profile '${profileId}' has no consent record`);
		}

		const manifest: CodexRunManifest = {
			executor: "codex",
			profileId,
			runId,
			commissionId,
			version: capability.version,
			sha256: capability.sha256,
			canonicalPath: capability.canonicalPath,
			codexHome: capability.codexHome,
			launchedAt: new Date().toISOString(),
		};
		this.db
			.prepare("INSERT INTO run_manifests (id, run_id, manifest_json) VALUES (?, ?, ?)")
			.run(randomUUID(), runId, JSON.stringify(manifest));

		this.eventBus.publish("codex.launched", manifest);
		return manifest;
	}

	/** Current Codex availability. */
	async status(): Promise<CodexStatus> {
		const row = this.db
			.prepare("SELECT id, capability_json FROM executor_profiles WHERE profile_type = 'codex' ORDER BY created_at DESC LIMIT 1")
			.get() as { id: string; capability_json: string } | undefined;
		if (row) {
			let capability: Partial<CodexProfileCapability> | null = null;
			try {
				capability = JSON.parse(row.capability_json) as Partial<CodexProfileCapability>;
			} catch {
				capability = null;
			}
			if (
				capability &&
				typeof capability.consentedAt === "string" &&
				typeof capability.version === "string" &&
				typeof capability.sha256 === "string"
			) {
				return {
					available: true,
					profileId: row.id,
					version: capability.version,
					hash: capability.sha256,
				};
			}
		}

		const candidates = await this.discover();
		for (const candidate of candidates) {
			if (candidate.status === "version_mismatch" && candidate.version !== null) {
				return { available: false, reason: "version_mismatch", found: candidate.version };
			}
		}
		return { available: false, reason: "no_codex_found" };
	}
}
