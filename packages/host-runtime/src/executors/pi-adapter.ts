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
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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

export function seedPiAcpProfile(db: DatabaseSync): void {
	db.prepare(
		"INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, 'product-managed', ?) ON CONFLICT(id) DO NOTHING",
	).run(PI_ACP_PROFILE_ID, JSON.stringify({ transport: "acp", worker: "pi" }));
}

/** Host-managed Pi worker for `product-managed` executor profiles. */
export class PiAcpAdapter extends AcpExecutorController {
	constructor(
		private readonly db: DatabaseSync,
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
			.prepare("INSERT INTO run_manifests (id, run_id, manifest_json) VALUES (?, ?, ?)")
			.run(randomUUID(), request.run.runId, JSON.stringify(manifest));
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
