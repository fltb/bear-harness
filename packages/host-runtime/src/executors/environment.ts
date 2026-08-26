import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExecutorLaunchRequest } from "./router.js";

/**
 * Ambient values that are safe and necessary for portable process startup.
 * Everything else must be supplied explicitly by the trusted adapter.
 */
const AMBIENT_ALLOWLIST = [
	"PATH",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_ADDRESS",
	"LC_COLLATE",
	"LC_CTYPE",
	"LC_IDENTIFICATION",
	"LC_MEASUREMENT",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NAME",
	"LC_NUMERIC",
	"LC_PAPER",
	"LC_TELEPHONE",
	"LC_TIME",
	"TZ",
	"TMPDIR",
	"TMP",
	"TEMP",
	...(process.platform === "win32"
		? (["SystemDrive", "SystemRoot", "windir", "ComSpec", "PATHEXT", "OS"] as const)
		: []),
] as const;

/**
 * Build an external-agent environment from an explicit ambient allowlist and
 * the trusted caller's values. HOME and USERPROFILE are never ambient inputs.
 */
export function externalAgentEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of AMBIENT_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return { ...environment, ...extra };
}

/** Create an app-owned directory and keep it private on POSIX systems. */
export function ensurePrivateDirectory(directory: string): string {
	const absolute = resolve(directory);
	mkdirSync(absolute, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(absolute, 0o700);
	return realpathSync(absolute);
}

/**
 * Give one external-agent run an isolated user and temporary filesystem
 * identity. Adapter-specific values remain explicit and cannot replace it.
 */
export function isolatedRunEnvironment(
	runRoot: string,
	extra: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const root = ensurePrivateDirectory(runRoot);
	const home = ensurePrivateDirectory(join(root, "home"));
	const temporary = ensurePrivateDirectory(join(root, "tmp"));
	return externalAgentEnvironment({
		...extra,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
	});
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
