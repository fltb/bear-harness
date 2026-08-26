import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExecutorLaunchRequest } from "./router.js";

/**
 * Build a child environment without leaking Host-only BEAR_* state. The caller
 * supplies the small, explicit set required by its external agent.
 */
export function externalAgentEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("BEAR_")),
	);
	if (!inherited.HOME && inherited.USERPROFILE) inherited.HOME = inherited.USERPROFILE;
	return { ...inherited, ...extra };
}

/** Resolve a Host-materialized workspace to a process cwd. */
export function workspaceFor(request: ExecutorLaunchRequest): string {
	const workspace = resolve(request.task.workspace);
	try {
		return lstatSync(workspace).isDirectory() ? workspace : dirname(workspace);
	} catch {
		throw { kind: "validation_failed", reason: "executor_workspace_not_found" };
	}
}
