/**
 * Pi ACP executor profile.
 *
 * The conversational Companion is never reused for commissions. Each approved
 * run starts the dedicated `pi-acp-worker` ACP agent, which can reach the Host
 * only through ACP filesystem requests guarded by the commission envelope.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDatabase } from "../storage/database.js";
import { executorProfiles, runManifests } from "../storage/schema.js";
import type { AcpProcessSpec } from "./acp-client.js";
import { AcpExecutorController } from "./acp-executor.js";
import type { ExecutorLaunchRequest } from "./router.js";

export interface PiRunManifest {
	executor: "pi-acp";
	profileId: string;
	runId: string;
	commissionId: string;
	workerPath: string;
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
			capabilityJson: { transport: "acp", worker: "pi" },
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
			profileId: request.profile.id,
			runId: request.run.runId,
			commissionId: request.commission.id,
			workerPath: this.workerPath,
			authDir: resolve(this.userDataDir, "companion-runtime"),
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
		const sessionDir = resolve(this.userDataDir, "executor-runs", "pi");
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
			},
		};
	}
}

function workspaceFor(request: ExecutorLaunchRequest): string {
	const root = request.commission.reads[0] ?? request.commission.writes[0];
	if (!root) throw { kind: "validation_failed", reason: "executor_workspace_not_declared" };
	const absolute = resolve(root);
	try {
		return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
	} catch {
		throw { kind: "validation_failed", reason: "executor_workspace_not_found" };
	}
}
