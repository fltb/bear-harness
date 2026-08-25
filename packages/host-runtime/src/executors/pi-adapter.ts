/**
 * Pi ACP executor profile.
 *
 * The conversational Companion is never reused for commissions. Each approved
 * run starts the dedicated `pi-acp-worker` ACP agent, which can reach the Host
 * only through ACP filesystem requests guarded by the commission envelope.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDatabase } from "../storage/database.js";
import { executorProfiles, runManifests } from "../storage/schema.js";
import type { AcpProcessSpec } from "./acp-client.js";
import { AcpExecutorController } from "./acp-executor.js";
import type { ExecutorLaunchRequest } from "./router.js";

export interface PiRunManifest {
	executor: "pi-acp";
	distribution: "bundled";
	trustMode: "external-app";
	filesystemMode: "direct-os";
	terminalMode: "full-shell";
	profileId: string;
	runId: string;
	commissionId: string;
	workerPath: string;
	workerSha256: string;
	authDir: string;
	launchedAt: string;
}

/** Default first-party ACP profile, seeded once with no secret capability data. */
export const PI_ACP_PROFILE_ID = "pi-product-managed";

export function seedPiAcpProfile(db: AppDatabase): void {
	db.insert(executorProfiles)
		.values({
			id: PI_ACP_PROFILE_ID,
			profileType: "product-managed",
			capabilityJson: {
				distribution: "bundled",
				transport: "acp-stdio",
				trustMode: "external-app",
				filesystemMode: "direct-os",
				terminalMode: "full-shell",
			},
		})
		.onConflictDoNothing()
		.run();
}

/** Host-managed Pi worker for `product-managed` executor profiles. */
export class PiAcpAdapter extends AcpExecutorController {
	constructor(
		private readonly db: AppDatabase,
		private readonly userDataDir: string,
		private readonly workerPath = fileURLToPath(new URL("./pi-acp-worker.js", import.meta.url)),
	) {
		super();
	}

	override async launch(request: ExecutorLaunchRequest): Promise<void> {
		const manifest: PiRunManifest = {
			executor: "pi-acp",
			distribution: "bundled",
			trustMode: "external-app",
			filesystemMode: "direct-os",
			terminalMode: "full-shell",
			profileId: request.profile.id,
			runId: request.run.runId,
			commissionId: request.commission.id,
			workerPath: this.workerPath,
			workerSha256: createHash("sha256").update(readFileSync(this.workerPath)).digest("hex"),
			authDir: resolve(this.userDataDir, "executor-config", "pi"),
			launchedAt: new Date().toISOString(),
		};
		this.db
			.insert(runManifests)
			.values({ id: randomUUID(), runId: request.run.runId, manifestJson: { ...manifest } })
			.run();
		await super.launch(request);
	}

	protected processSpec(request: ExecutorLaunchRequest): AcpProcessSpec {
		const cwd = workspaceFor(request);
		const authDir = resolve(this.userDataDir, "executor-config", "pi");
		const sessionDir = resolve(this.userDataDir, "executor-runs", "pi");
		const runtimeRoot = bundledRuntimeRoot();
		const bashPath =
			process.platform === "win32"
				? resolve(runtimeRoot, "usr", "bin", "bash.exe")
				: process.env.BEAR_BASH_PATH;
		const gitPath =
			process.platform === "win32" ? resolve(runtimeRoot, "cmd", "git.exe") : undefined;
		if (
			process.platform === "win32" &&
			(!bashPath || !existsSync(bashPath) || !gitPath || !existsSync(gitPath))
		)
			throw { kind: "unavailable", reason: "bundled_git_runtime_missing" };
		return {
			command: process.execPath,
			args: [this.workerPath],
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: process.env.LANG,
				LC_ALL: process.env.LC_ALL,
				ELECTRON_RUN_AS_NODE: "1",
				BEAR_PI_AUTH_DIR: authDir,
				BEAR_PI_SESSION_DIR: sessionDir,
				BEAR_BASH_PATH: bashPath,
				BEAR_GIT_PATH: gitPath,
				BEAR_RUNTIME_ROOT: runtimeRoot,
			},
		};
	}
}

function bundledRuntimeRoot(): string {
	const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	if (resourcesPath) return resolve(resourcesPath, "runtime", "git-win-x64");
	return resolve(process.cwd(), "resources", "runtime", "git-win-x64");
}

function workspaceFor(request: ExecutorLaunchRequest): string {
	const root =
		request.commission.resources[0]?.resolvedPath ?? request.commission.outputs[0]?.resolvedPath;
	if (!root) throw { kind: "validation_failed", reason: "executor_workspace_not_declared" };
	const absolute = resolve(root);
	try {
		return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
	} catch {
		throw { kind: "validation_failed", reason: "executor_workspace_not_found" };
	}
}
