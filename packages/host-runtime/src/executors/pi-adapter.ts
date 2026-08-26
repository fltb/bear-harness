/**
 * Dedicated standalone Pi ACP external agent.
 *
 * This never reuses the conversational Companion session. Each run receives
 * its own Pi session and uses Pi's native local tools in a real workspace.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDatabase } from "../storage/database.js";
import { executorProfiles, runManifests } from "../storage/schema.js";
import type { AcpProcessSpec } from "./acp-client.js";
import { AcpExecutorController } from "./acp-executor.js";
import { externalAgentEnvironment, workspaceFor } from "./environment.js";
import type { ExecutorLaunchRequest } from "./router.js";

export interface PiRunManifest {
	executor: "pi-acp";
	profileId: string;
	runId: string;
	triggerEntryId: string;
	workerPath: string;
	launchedAt: string;
}

/** Default first-party Pi external-agent profile. */
export const PI_ACP_PROFILE_ID = "pi-default";

export function seedPiAcpProfile(db: AppDatabase): void {
	db.insert(executorProfiles)
		.values({
			id: PI_ACP_PROFILE_ID,
			profileType: "pi",
			capabilityJson: { transport: "acp", worker: "pi" },
		})
		.onConflictDoNothing()
		.run();
}

/** Packaged Pi external agent. */
export class PiAcpAdapter extends AcpExecutorController {
	constructor(
		private readonly db: AppDatabase,
		private readonly userDataDir: string,
		private readonly workerPath = fileURLToPath(new URL("./pi-acp-worker.js", import.meta.url)),
		private readonly bundledGit?: { shellPath: string; pathEntries: string[] },
	) {
		super();
	}

	override async launch(request: ExecutorLaunchRequest): Promise<void> {
		const manifest: PiRunManifest = {
			executor: "pi-acp",
			profileId: request.profile.id,
			runId: request.run.runId,
			triggerEntryId: request.run.triggerEntryId,
			workerPath: this.workerPath,
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
		const authDir = resolve(this.userDataDir, "companion-runtime");
		const sessionDir = resolve(this.userDataDir, "external-agent-runs", "pi");
		return {
			command: process.execPath,
			args: [this.workerPath],
			cwd,
			env: externalAgentEnvironment({
				ELECTRON_RUN_AS_NODE: "1",
				BEAR_PI_AUTH_DIR: authDir,
				BEAR_PI_SESSION_DIR: sessionDir,
				BEAR_OUTPUT_DIR: request.task.outputDirectory,
				...(request.task.modelRoute
					? piModelEnvironment(
							request.task.modelRoute.providerId,
							request.task.modelRoute.modelId,
							request.task.modelRoute.apiKey,
						)
					: {}),
				...(this.bundledGit
					? {
							BEAR_PI_SHELL_PATH: this.bundledGit.shellPath,
							PATH: [...this.bundledGit.pathEntries, process.env.PATH]
								.filter(Boolean)
								.join(process.platform === "win32" ? ";" : ":"),
						}
					: {}),
			}),
		};
	}
}

/**
 * Model route values are injected by the run service immediately before
 * launch. They remain process-only, never a run manifest or database field.
 */
export function piModelEnvironment(
	providerId: string,
	modelId: string,
	apiKey?: string,
): NodeJS.ProcessEnv {
	return {
		BEAR_PI_PROVIDER_ID: providerId,
		BEAR_PI_MODEL_ID: modelId,
		...(apiKey ? { BEAR_PI_API_KEY: apiKey } : {}),
	};
}
