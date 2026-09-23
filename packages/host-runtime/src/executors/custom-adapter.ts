import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { AppDatabase } from "../storage/database.js";
import { runManifests } from "../storage/schema.js";
import type { AcpProcessSpec } from "./acp-client.js";
import { AcpExecutorController } from "./acp-executor.js";
import { isolatedRunEnvironment, workspaceFor } from "./environment.js";
import type { RunnerProfiles } from "./profiles.js";
import type { ExecutorLaunchRequest } from "./router.js";

/** Configured standard ACP peer. It does not require a provider-specific message parser. */
export class CustomAcpAdapter extends AcpExecutorController {
	constructor(
		private readonly profiles: RunnerProfiles,
		private readonly runDb?: AppDatabase,
	) {
		super();
	}
	override async launch(request: ExecutorLaunchRequest): Promise<void> {
		this.runDb
			?.insert(runManifests)
			.values({
				id: randomUUID(),
				runId: request.run.runId,
				manifestJson: {
					schemaVersion: 1,
					executor: "custom",
					profileId: request.profile.id,
					runId: request.run.runId,
					launchedAt: new Date().toISOString(),
				},
			})
			.run();
		await super.launch(request);
	}
	protected processSpec(request: ExecutorLaunchRequest): AcpProcessSpec {
		const configuration = this.profiles.configuration(request.profile);
		const runRoot = dirname(resolve(request.task.outputDirectory));
		return {
			command: configuration.command,
			args: configuration.args,
			cwd: workspaceFor(request),
			authMethodId: configuration.authMethodId,
			env: isolatedRunEnvironment(runRoot, {
				...Object.fromEntries(configuration.environment.map((item) => [item.name, item.value])),
				BEAR_OUTPUT_DIR: request.task.outputDirectory,
			}),
			readOnlyPaths: [...(request.task.readOnlyPaths ?? []), ...configuration.dependencyPaths],
			executablePaths: configuration.dependencyPaths,
		};
	}
}
