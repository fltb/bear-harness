import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export const EXECUTOR_CONFINEMENT_UNAVAILABLE = {
	kind: "unavailable",
	reason: "executor_confinement_unavailable",
} as const;

export interface ConfinableProcessSpec {
	command: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	readOnlyPaths?: readonly string[];
	writablePaths?: readonly string[];
}

export interface ConfinedProcessCommand {
	command: string;
	args: string[];
}

export interface ConfinementOptions {
	platform?: NodeJS.Platform;
	bubblewrapCandidates?: readonly string[];
	verifyBubblewrap?: (path: string) => boolean;
}

type AllowedPath = { path: string; directory: boolean };

const MACOS_SYSTEM_READ_PATHS = [
	"/System",
	"/System/Volumes/Preboot/Cryptexes/OS",
	"/usr/bin",
	"/usr/sbin",
	"/usr/lib",
	"/usr/libexec",
	"/usr/share",
	"/bin",
	"/sbin",
	"/Library/Apple",
	"/Library/Frameworks",
	"/private/etc",
	"/private/var/db/dyld",
	"/private/var/db/timezone",
	"/private/var/run/resolv.conf",
	"/opt/homebrew/Cellar",
	"/opt/homebrew/etc/openssl@3",
	"/usr/local/Cellar",
	"/usr/local/etc/openssl@3",
	"/dev",
] as const;
const MACOS_SYSTEM_EXECUTABLE_PATHS = [
	"/System",
	"/usr/bin",
	"/usr/sbin",
	"/usr/libexec",
	"/bin",
	"/sbin",
] as const;
const LINUX_SYSTEM_READ_PATHS = [
	"/usr/bin",
	"/usr/sbin",
	"/usr/lib",
	"/usr/lib64",
	"/usr/libexec",
	"/usr/share",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/etc",
	"/run/systemd/resolve",
] as const;
const DEFAULT_BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;
const WRITABLE_ENVIRONMENT_PATHS = [
	"BEAR_OUTPUT_DIR",
	"BEAR_PI_SESSION_DIR",
	"CODEX_HOME",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
] as const;
const READ_ONLY_ENVIRONMENT_PATHS = ["BEAR_PI_AUTH_DIR"] as const;
const EXECUTABLE_ENVIRONMENT_PATHS = [
	"CODEX_PATH",
	"BEAR_CODEX_CODE_MODE_HOST_PATH",
	"BEAR_PI_SHELL_PATH",
] as const;

function failInvalidPath(): never {
	throw { kind: "validation_failed", reason: "executor_confinement_path_invalid" };
}

function lexicalPath(path: string): string {
	if (!path || path.includes("\0") || !isAbsolute(path)) failInvalidPath();
	const normalized = resolve(path);
	const withoutTrailingSeparators = path.replace(/[\\/]+$/, "") || parse(path).root;
	if (withoutTrailingSeparators !== normalized) failInvalidPath();
	return normalized;
}

/** Validate every existing path component before it becomes a sandbox rule. */
function validatePath(path: string, allowMissing: boolean): string {
	const normalized = lexicalPath(path);
	const root = parse(normalized).root;
	let current = root;
	for (const component of normalized.slice(root.length).split(sep).filter(Boolean)) {
		current = resolve(current, component);
		if (!existsSync(current)) {
			if (allowMissing) return normalized;
			failInvalidPath();
		}
		if (lstatSync(current).isSymbolicLink()) failInvalidPath();
	}
	if (realpathSync.native(normalized) !== normalized) failInvalidPath();
	return normalized;
}

function prepareWritablePath(path: string): string {
	const normalized = validatePath(path, true);
	mkdirSync(normalized, { recursive: true, mode: 0o700 });
	return validatePath(normalized, false);
}

function allowedPath(path: string): AllowedPath {
	return { path, directory: statSync(path).isDirectory() };
}

function uniquePaths(paths: readonly string[]): string[] {
	return [...new Set(paths)];
}

function envPaths(env: NodeJS.ProcessEnv, keys: readonly string[]): string[] {
	return keys.flatMap((key) => {
		const value = env[key];
		return value ? [value] : [];
	});
}

function runtimeRoot(path: string): string {
	const appBoundary = path.indexOf(".app/");
	if (appBoundary >= 0) return path.slice(0, appBoundary + 4);
	const cellarBoundary = path.match(/^(.*\/Cellar\/[^/]+\/[^/]+)(?:\/|$)/);
	return cellarBoundary?.[1] ?? dirname(path);
}

function runtimeExecutablePaths(path: string): string[] {
	const root = runtimeRoot(path);
	return root === dirname(path) ? [path] : [path, root];
}

function runtimeArgumentPaths(args: readonly string[]): string[] {
	const entrypoint = args[0];
	if (!entrypoint || !isAbsolute(entrypoint)) return [];
	const canonical = validatePath(entrypoint, false);
	return [statSync(canonical).isDirectory() ? canonical : dirname(canonical)];
}

function isWithin(candidate: string, parent: string): boolean {
	const child = relative(parent, candidate);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function confinementPaths(spec: ConfinableProcessSpec): {
	readOnly: AllowedPath[];
	writable: AllowedPath[];
	executables: AllowedPath[];
} {
	const declaredHome = spec.env.HOME;
	const declaredCodexHome = spec.env.CODEX_HOME;
	if (
		declaredCodexHome &&
		(!declaredHome ||
			!isWithin(validatePath(declaredCodexHome, false), validatePath(declaredHome, false)))
	) {
		failInvalidPath();
	}
	const writableCandidates = uniquePaths([
		...envPaths(spec.env, WRITABLE_ENVIRONMENT_PATHS),
		...(spec.writablePaths ?? []),
	]).map((path) => validatePath(path, true));
	const command = validatePath(spec.command, false);
	const executableCandidates = uniquePaths([
		command,
		...envPaths(spec.env, EXECUTABLE_ENVIRONMENT_PATHS),
	]).map((path) => validatePath(path, false));
	const executables = uniquePaths(executableCandidates.flatMap(runtimeExecutablePaths)).map(
		(path) => allowedPath(validatePath(path, false)),
	);
	const readOnly = uniquePaths([
		spec.cwd,
		...runtimeArgumentPaths(spec.args),
		...envPaths(spec.env, READ_ONLY_ENVIRONMENT_PATHS),
		...(spec.readOnlyPaths ?? []),
		...executables.map(({ path }) => path),
	]).map((path) => allowedPath(validatePath(path, false)));

	for (const writablePath of writableCandidates) {
		for (const readOnlyPath of readOnly) {
			if (isWithin(writablePath, readOnlyPath.path) || isWithin(readOnlyPath.path, writablePath))
				failInvalidPath();
		}
	}
	const writable = writableCandidates.map((path) => allowedPath(prepareWritablePath(path)));
	return { readOnly, writable, executables };
}

function sandboxFilter(path: AllowedPath): string {
	return `(${path.directory ? "subpath" : "literal"} ${JSON.stringify(path.path)})`;
}

/** Generate a deny-by-default Seatbelt profile for one ACP child process. */
export function createMacOSSandboxProfile(spec: ConfinableProcessSpec): string {
	const { readOnly, writable, executables } = confinementPaths(spec);
	const systemReadFilters = MACOS_SYSTEM_READ_PATHS.filter(existsSync).map((path) =>
		sandboxFilter(allowedPath(path)),
	);
	const systemExecutableFilters = MACOS_SYSTEM_EXECUTABLE_PATHS.filter(existsSync).map((path) =>
		sandboxFilter(allowedPath(path)),
	);
	const readFilters = [
		...systemReadFilters,
		...readOnly.map(sandboxFilter),
		...writable.map(sandboxFilter),
	];
	const executableFilters = [...systemExecutableFilters, ...executables.map(sandboxFilter)];
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-info*)",
		"(allow dynamic-code-generation)",
		"(allow process-exec",
		...executableFilters.map((filter) => `  ${filter}`),
		")",
		"(allow signal (target self))",
		"(allow mach*)",
		"(allow mach-bootstrap)",
		"(allow ipc*)",
		"(allow sysctl*)",
		"(allow system*)",
		"(allow network*)",
		"(allow file-read-metadata)",
		"(allow file-read*",
		'  (literal "/")',
		...readFilters.map((filter) => `  ${filter}`),
		")",
		"(allow file-write*",
		'  (literal "/dev/null")',
		'  (literal "/dev/zero")',
		...writable.map((path) => `  ${sandboxFilter(path)}`),
		")",
	].join("\n");
}

function trustedBubblewrapBinary(path: string): boolean {
	try {
		const canonical = validatePath(path, false);
		const stats = statSync(canonical);
		if (!stats.isFile() || (stats.mode & 0o111) === 0) return false;
		if (stats.uid !== 0 || (stats.mode & 0o022) !== 0) return false;
		const probe = spawnSync(
			canonical,
			[
				"--die-with-parent",
				"--new-session",
				"--unshare-all",
				"--share-net",
				"--ro-bind",
				"/",
				"/",
				"--",
				"/bin/true",
			],
			{ stdio: "ignore", timeout: 5_000 },
		);
		return probe.status === 0 && probe.error === undefined;
	} catch {
		return false;
	}
}

function parentDirectories(path: string): string[] {
	const root = parse(path).root;
	const parents: string[] = [];
	let current = dirname(path);
	while (current !== root) {
		parents.push(current);
		current = dirname(current);
	}
	return parents.reverse();
}

function createBubblewrapArguments(spec: ConfinableProcessSpec): string[] {
	const { readOnly, writable } = confinementPaths(spec);
	const mounts = [
		...LINUX_SYSTEM_READ_PATHS.filter(existsSync).map((path) => ({ mode: "--ro-bind", path })),
		...readOnly.map(({ path }) => ({ mode: "--ro-bind", path })),
		...writable.map(({ path }) => ({ mode: "--bind", path })),
	];
	const destinationParents = uniquePaths(
		mounts.flatMap(({ path }) => parentDirectories(path)),
	).filter((path) => !mounts.some((mount) => mount.path === path));
	return [
		"--die-with-parent",
		"--new-session",
		"--unshare-all",
		"--share-net",
		"--tmpfs",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		...destinationParents.flatMap((path) => ["--dir", path]),
		...mounts.flatMap(({ mode, path }) => [mode, path, path]),
		"--chdir",
		spec.cwd,
		"--",
		spec.command,
		...spec.args,
	];
}

/** Wrap an ACP process without a shell; unsupported platforms fail closed. */
export function applyProcessConfinement(
	spec: ConfinableProcessSpec,
	options: ConfinementOptions = {},
): ConfinedProcessCommand {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		return {
			command: "/usr/bin/sandbox-exec",
			args: ["-p", createMacOSSandboxProfile(spec), spec.command, ...spec.args],
		};
	}
	if (platform === "linux") {
		const verify = options.verifyBubblewrap ?? trustedBubblewrapBinary;
		const bubblewrap = (options.bubblewrapCandidates ?? DEFAULT_BWRAP_CANDIDATES).find((path) =>
			verify(path),
		);
		if (!bubblewrap) throw EXECUTOR_CONFINEMENT_UNAVAILABLE;
		return { command: bubblewrap, args: createBubblewrapArguments(spec) };
	}
	throw EXECUTOR_CONFINEMENT_UNAVAILABLE;
}
