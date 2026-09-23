/**
 * Codex ACP executor profile.
 *
 * The discovered Codex binary remains user-owned and is re-verified at every
 * launch. The maintained ACP adapter is the only transport: its stdout is
 * ACP JSONL, and its tool updates, permission requests, completion, and
 * cancellation flow through the shared Host controller.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	lstatSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { CacheKey } from "@bear-harness/protocol/schema";
import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { InvalidationHub } from "../storage/invalidation-hub.js";
import { executorProfiles, runManifests } from "../storage/schema.js";
import type { AcpProcessSpec } from "./acp-client.js";
import { codexAcpDialect } from "./acp-dialect.js";
import { AcpExecutorController } from "./acp-executor.js";
import { ensurePrivateDirectory, isolatedRunEnvironment, workspaceFor } from "./environment.js";
import type { ExecutorLaunchRequest } from "./router.js";

/** Bounded `codex --version` probe timeout. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;
/** Max symlink hops while resolving a candidate chain. */
const MAX_SYMLINK_HOPS = 8;
const CODEX_PLATFORM_PACKAGE =
	process.platform === "darwin" && process.arch === "arm64"
		? { packageName: "@openai/codex-darwin-arm64", target: "aarch64-apple-darwin" }
		: process.platform === "darwin" && process.arch === "x64"
			? { packageName: "@openai/codex-darwin-x64", target: "x86_64-apple-darwin" }
			: process.platform === "linux" && process.arch === "arm64"
				? { packageName: "@openai/codex-linux-arm64", target: "aarch64-unknown-linux-musl" }
				: process.platform === "linux" && process.arch === "x64"
					? { packageName: "@openai/codex-linux-x64", target: "x86_64-unknown-linux-musl" }
					: process.platform === "win32" && process.arch === "arm64"
						? { packageName: "@openai/codex-win32-arm64", target: "aarch64-pc-windows-msvc" }
						: process.platform === "win32" && process.arch === "x64"
							? { packageName: "@openai/codex-win32-x64", target: "x86_64-pc-windows-msvc" }
							: undefined;

export type CodexCandidateStatus = "usable" | "not_found" | "rejected";

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
}

/** Run-owned executable snapshot; installation registration stores only home and consent. */
export interface CodexProfileCapability extends CodexConsentRequest {
	codexHome: string;
	codeModeHostPath?: string;
	codeModeHostSha256?: string;
	consentedAt: string;
}

/** The manifest recorded in `run_manifests.manifest_json` at launch. */
export interface CodexRunManifest {
	canonicalPath: string;
	schemaVersion: 1;
	executor: "codex";
	profileId: string;
	runId: string;
	triggerEntryId: string;
	version: string;
	sha256: string;
	launchedAt: string;
}

export type CodexStatus =
	| { available: true; profileId: string; version: string; hash: string }
	| { available: false; reason: "no_codex_found" }
	| { available: false; reason: "not_connected" };

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
async function probeVersion(finalBin: string): Promise<string | null> {
	let stdout = "";
	let stderr = "";
	try {
		stdout = await new Promise<string>((resolve, reject) =>
			execFile(
				finalBin,
				["--version"],
				{
					encoding: "utf8",
					timeout: VERSION_PROBE_TIMEOUT_MS,
					windowsHide: true,
				},
				(error, stdout, stderr) =>
					error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout),
			),
		);
	} catch (e) {
		const err = e as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
		stdout = err.stdout !== undefined ? String(err.stdout) : "";
		stderr = err.stderr !== undefined ? String(err.stderr) : "";
	}
	const match = `${stdout}\n${stderr}`.match(/(\d+\.\d+\.\d+)/);
	return match?.[1] ?? null;
}

export class CodexAdapter extends AcpExecutorController {
	private readonly adapterPath = createRequire(import.meta.url)
		.resolve("@agentclientprotocol/codex-acp")
		.replace(/\.asar([/\\])/, ".asar.unpacked$1");

	constructor(
		private readonly systemDb: AppDatabase,
		private readonly runDb: AppDatabase | undefined,
		private readonly invalidations: InvalidationHub,
	) {
		super();
	}

	/**
	 * Discover Codex candidates per plan §9.4. Never throws — every candidate
	 * location is reported with a status, including absences (`not_found`).
	 */
	async discover(): Promise<CodexCandidate[]> {
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
				if (statSync(entry).isFile()) return [await this.probe(entry)];
			} catch {
				/* not present — not a candidate */
			}
		}

		// (2) Official standalone default entry (macOS/Linux).
		if (process.platform !== "win32") {
			const fallback = join(home, ".local", "bin", "codex");
			return [await this.probe(fallback)];
		}

		return [];
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

		let st: Stats;
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
		const launchExecutable = managedCodexExecutable(finalBin);
		if (!launchExecutable) return base;

		let canonicalPath: string;
		try {
			canonicalPath = realpathSync(launchExecutable);
		} catch {
			return base;
		}
		if (!canonicalPath.startsWith(this.installRootOf(candidatePath) + sep)) return base;

		const version = await probeVersion(canonicalPath);
		if (version === null) return base; // probe failed — no parseable version

		let sha256: string;
		try {
			sha256 = await sha256Of(canonicalPath);
		} catch {
			return base;
		}

		return {
			candidatePath,
			canonicalPath,
			version,
			sha256,
			status: "usable",
		};
	}

	/**
	 * Consent to a discovered Codex binary. The path/version/hash must match
	 * the discovery output exactly, otherwise the consent is refused.
	 */
	async consent(
		profileConfig: CodexConsentRequest,
	): Promise<CodexProfileCapability & { profileId: string }> {
		const candidates = await this.discover();
		const match = candidates.find(
			(c) =>
				c.status === "usable" &&
				c.canonicalPath === profileConfig.canonicalPath &&
				c.version === profileConfig.version &&
				c.sha256 === profileConfig.sha256,
		);
		if (!match) {
			fail("validation_failed", "no discovered candidate matches {canonicalPath, version, sha256}");
		}

		const capability: CodexProfileCapability = {
			canonicalPath: profileConfig.canonicalPath,
			version: profileConfig.version,
			sha256: profileConfig.sha256,
			codexHome: resolve(process.env.CODEX_HOME || join(homedir(), ".codex")),
			consentedAt: new Date().toISOString(),
		};
		const codeModeHostPath = codexCodeModeHost(profileConfig.canonicalPath);
		if (codeModeHostPath) {
			capability.codeModeHostPath = codeModeHostPath;
			capability.codeModeHostSha256 = await sha256Of(codeModeHostPath);
		}
		// Installation registration survives binary upgrades; existing IDs remain stable.
		const previous = this.systemDb
			.select()
			.from(executorProfiles)
			.where(eq(executorProfiles.profileType, "codex"))
			.orderBy(desc(executorProfiles.createdAt), executorProfiles.id)
			.limit(1)
			.get();
		const profileId = previous?.id ?? "codex-default";
		const registration = {
			...previous?.configJson,
			codexHome: capability.codexHome,
			consentedAt: capability.consentedAt,
		};

		this.systemDb
			.insert(executorProfiles)
			.values({ id: profileId, profileType: "codex", configJson: registration })
			.onConflictDoUpdate({
				target: executorProfiles.id,
				set: { configJson: registration },
			})
			.run();

		return { profileId, ...capability };
	}

	/**
	 * Re-verify the Run-resolved Codex binary, record a secret-free manifest,
	 * then start its maintained ACP adapter. Completion and evidence are
	 * delivered through the shared external-agent controller.
	 */
	protected override async prepareLaunch(request: ExecutorLaunchRequest): Promise<void> {
		const capability = codexCapability(request.profile.capabilities);
		if (managedCodexExecutable(capability.canonicalPath) !== capability.canonicalPath) {
			fail("profile_invalid", "codex profile must consent the exact native executable");
		}
		if ((await probeVersion(capability.canonicalPath)) !== capability.version) {
			fail("executor_binary_changed", "resolved Codex version no longer matches");
		}
		if ((await sha256Of(capability.canonicalPath)) !== capability.sha256) {
			fail("executor_binary_changed", "resolved Codex hash no longer matches");
		}
		const codeModeHostPath = codexCodeModeHost(capability.canonicalPath);
		if (
			codeModeHostPath !== (capability.codeModeHostPath ?? null) ||
			(codeModeHostPath !== null &&
				(await sha256Of(codeModeHostPath)) !== capability.codeModeHostSha256)
		) {
			fail("executor_binary_changed", "resolved Codex tool host no longer matches");
		}
	}

	/** Resolve only NEW executions. Restore uses the immutable recovery profile. */
	private async resolveLaunch(request: ExecutorLaunchRequest): Promise<ExecutorLaunchRequest> {
		const registration = request.profile.capabilities;
		if (
			typeof registration.codexHome !== "string" ||
			!isAbsolute(registration.codexHome) ||
			typeof registration.consentedAt !== "string"
		)
			fail("profile_invalid", "Codex registration is invalid");
		const candidate = (await this.discover()).find((item) => item.status === "usable");
		if (!candidate?.canonicalPath || !candidate.version || !candidate.sha256)
			fail("unavailable", "no_codex_found");
		const codeModeHostPath = codexCodeModeHost(candidate.canonicalPath);
		const capabilities = {
			codexHome: registration.codexHome,
			consentedAt: registration.consentedAt,
			canonicalPath: candidate.canonicalPath,
			version: candidate.version,
			sha256: candidate.sha256,
			...(codeModeHostPath
				? { codeModeHostPath, codeModeHostSha256: await sha256Of(codeModeHostPath) }
				: {}),
		};
		return { ...request, profile: { ...request.profile, capabilities } };
	}

	override async test(request: ExecutorLaunchRequest, signal?: AbortSignal) {
		return super.test(await this.resolveLaunch(request), signal);
	}

	override async launch(request: ExecutorLaunchRequest): Promise<void> {
		request = await this.resolveLaunch(request);
		const capability = codexCapability(request.profile.capabilities);
		const manifest: CodexRunManifest = {
			schemaVersion: 1,
			executor: "codex",
			profileId: request.profile.id,
			runId: request.run.runId,
			triggerEntryId: request.run.triggerEntryId,
			version: capability.version,
			sha256: capability.sha256,
			canonicalPath: capability.canonicalPath,
			launchedAt: new Date().toISOString(),
		};
		this.runDb
			?.insert(runManifests)
			.values({ id: randomUUID(), runId: request.run.runId, manifestJson: { ...manifest } })
			.run();
		this.invalidations.invalidate(CacheKey.audit());
		await super.launch(request);
	}

	protected processSpec(request: ExecutorLaunchRequest): AcpProcessSpec {
		const capability = codexCapability(request.profile.capabilities);
		const cwd = workspaceFor(request);
		const runRoot = dirname(resolve(request.task.outputDirectory));
		const codexHome = materializeCodexHomeSnapshot(
			capability.codexHome,
			resolve(runRoot, "home", ".codex"),
		);
		const env = isolatedRunEnvironment(runRoot, {
			ELECTRON_RUN_AS_NODE: "1",
			NO_BROWSER: "1",
			BEAR_OUTPUT_DIR: request.task.outputDirectory,
			CODEX_PATH: capability.canonicalPath,
			...(capability.codeModeHostPath
				? { BEAR_CODEX_CODE_MODE_HOST_PATH: capability.codeModeHostPath }
				: {}),
			CODEX_HOME: codexHome,
		});
		return {
			dialect: codexAcpDialect,
			command: process.execPath,
			args: [this.adapterPath],
			cwd,
			writablePaths: [codexHome],
			executablePaths: [
				capability.canonicalPath,
				...(capability.codeModeHostPath ? [capability.codeModeHostPath] : []),
			],
			readOnlyPaths: request.task.readOnlyPaths,
			env,
		};
	}

	/** Current Codex availability. */
	async status(): Promise<CodexStatus> {
		const row = this.systemDb
			.select({ id: executorProfiles.id, capability: executorProfiles.configJson })
			.from(executorProfiles)
			.where(eq(executorProfiles.profileType, "codex"))
			.orderBy(desc(executorProfiles.createdAt), executorProfiles.id)
			.limit(1)
			.get();
		const candidates = await this.discover();
		const candidate = candidates.find((item) => item.status === "usable");
		if (
			row &&
			typeof row.capability.codexHome === "string" &&
			typeof row.capability.consentedAt === "string" &&
			candidate?.version &&
			candidate.sha256
		) {
			return {
				available: true,
				profileId: row.id,
				version: candidate.version,
				hash: candidate.sha256,
			};
		}

		return candidates.some((candidate) => candidate.status === "usable")
			? { available: false, reason: "not_connected" }
			: { available: false, reason: "no_codex_found" };
	}
}

/** Resolve the npm launcher to the exact native binary the confined ACP child executes. */
export function managedCodexExecutable(finalBin: string): string | null {
	if (basename(finalBin) !== "codex.js" || basename(dirname(finalBin)) !== "bin") return finalBin;
	const packageRoot = dirname(dirname(finalBin));
	try {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			name?: unknown;
		};
		if (manifest.name !== "@openai/codex") return finalBin;
		if (!CODEX_PLATFORM_PACKAGE) return null;
		const resolver = createRequire(finalBin);
		const platformManifest = realpathSync(
			resolver.resolve(`${CODEX_PLATFORM_PACKAGE.packageName}/package.json`),
		);
		const platformRoot = dirname(platformManifest);
		const executable = realpathSync(
			join(
				platformRoot,
				"vendor",
				CODEX_PLATFORM_PACKAGE.target,
				"bin",
				process.platform === "win32" ? "codex.exe" : "codex",
			),
		);
		const child = relative(platformRoot, executable);
		if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
			return null;
		const stat = lstatSync(executable);
		return stat.isFile() && !stat.isSymbolicLink() ? executable : null;
	} catch {
		return null;
	}
}

/** Resolve the exact optional native helper used by Codex code-mode tools. */
export function codexCodeModeHost(codexExecutable: string): string | null {
	try {
		const candidate = realpathSync(
			join(
				dirname(codexExecutable),
				process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host",
			),
		);
		const child = relative(dirname(codexExecutable), candidate);
		if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
			return null;
		const stat = lstatSync(candidate);
		return stat.isFile() && !stat.isSymbolicLink() ? candidate : null;
	} catch {
		return null;
	}
}

const CODEX_HOME_SNAPSHOT_FILES = ["auth.json", "config.toml"] as const;

/**
 * Copy only the consented credentials and configuration needed to launch.
 * Codex writes sessions and other runtime state into this per-run snapshot,
 * never into the canonical user-owned home.
 */
function materializeCodexHomeSnapshot(sourceHome: string, snapshotHome: string): string {
	const source = resolve(sourceHome);
	const snapshot = resolve(snapshotHome);
	if (source === snapshot) {
		fail("profile_invalid", "canonical Codex home cannot be the per-run snapshot");
	}
	// Preserve per-Run session history across transport reconnection.
	// Credentials are refreshed below; worker-owned session files remain intact.
	ensurePrivateDirectory(snapshot);

	for (const fileName of CODEX_HOME_SNAPSHOT_FILES) {
		const sourceFile = join(source, fileName);
		let sourceStat: Stats;
		try {
			sourceStat = lstatSync(sourceFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			fail("profile_invalid", `cannot read Codex home ${fileName}`);
		}
		if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
			fail("profile_invalid", `Codex home ${fileName} must be a regular file`);
		}
		const snapshotFile = join(snapshot, fileName);
		copyFileSync(sourceFile, snapshotFile);
		if (process.platform !== "win32") chmodSync(snapshotFile, sourceStat.mode & 0o777);
	}
	return realpathSync(snapshot);
}

function codexCapability(value: Record<string, unknown>): CodexProfileCapability {
	if (
		typeof value.canonicalPath !== "string" ||
		!isAbsolute(value.canonicalPath) ||
		typeof value.version !== "string" ||
		typeof value.sha256 !== "string" ||
		typeof value.codexHome !== "string" ||
		!isAbsolute(value.codexHome) ||
		typeof value.consentedAt !== "string"
	) {
		fail("profile_invalid", "Codex executor profile has invalid capability data");
	}
	return {
		canonicalPath: value.canonicalPath,
		version: value.version,
		sha256: value.sha256,
		codexHome: value.codexHome,
		consentedAt: value.consentedAt,
		...(typeof value.codeModeHostPath === "string" && typeof value.codeModeHostSha256 === "string"
			? {
					codeModeHostPath: value.codeModeHostPath,
					codeModeHostSha256: value.codeModeHostSha256,
				}
			: {}),
	};
}
