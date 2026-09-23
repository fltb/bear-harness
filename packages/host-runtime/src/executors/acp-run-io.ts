/** Standard ACP client tools scoped to one Run. No main-conversation tool or state is involved. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AcpClientHandlers, AcpProcessSpec } from "./acp-client.js";
import { applyProcessConfinement } from "./confinement.js";
import { resolveRunnerExecutable } from "./profiles.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_BYTES = 1024 * 1024;
type Exit = { exitCode?: number; signal?: string };
type Terminal = {
	process: ChildProcessWithoutNullStreams;
	output: string;
	truncated: boolean;
	limit: number;
	exit?: Exit;
	done: Promise<Exit>;
};
function within(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
function fail(reason: string): never {
	throw { kind: "validation_failed", reason };
}
export class AcpRunIo {
	private readonly terminals = new Map<string, Terminal>();
	private readonly operations = new Set<Promise<unknown>>();
	private closed = false;
	constructor(
		private readonly spec: AcpProcessSpec,
		private readonly sessionId: () => string | null,
	) {}
	private check(request: { sessionId: string }) {
		if (this.closed || request.sessionId !== this.sessionId()) fail("acp_resource_scope_invalid");
	}
	private track<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject({ kind: "conflict", reason: "acp_resources_closed" });
		const work = operation();
		this.operations.add(work);
		void work.then(
			() => this.operations.delete(work),
			() => this.operations.delete(work),
		);
		return work;
	}
	private async path(input: string, write: boolean): Promise<string> {
		const target = resolve(this.spec.cwd, input);
		const roots = [
			this.spec.cwd,
			...(this.spec.writablePaths ?? []),
			...(this.spec.env.BEAR_OUTPUT_DIR ? [this.spec.env.BEAR_OUTPUT_DIR] : []),
			...(!write ? (this.spec.readOnlyPaths ?? []) : []),
		];
		const root = roots.find((root) => within(resolve(root), target));
		if (!root) return fail("acp_file_outside_run");
		const base = await realpath(root);
		if (base !== resolve(root)) return fail("acp_file_symlink");
		const segments = relative(base, target).split(sep).filter(Boolean);
		let current = base;
		for (const part of segments) {
			current = resolve(current, part);
			try {
				if ((await lstat(current)).isSymbolicLink()) return fail("acp_file_symlink");
			} catch (error) {
				if (!write || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return target;
	}
	private terminal(id: string): Terminal {
		const value = this.terminals.get(id);
		if (!value) return fail("acp_terminal_not_found");
		return value;
	}
	handlers(): Pick<
		AcpClientHandlers,
		| "readTextFile"
		| "writeTextFile"
		| "createTerminal"
		| "terminalOutput"
		| "waitForTerminalExit"
		| "killTerminal"
		| "releaseTerminal"
	> {
		return {
			readTextFile: (request) =>
				this.track(async () => {
					this.check(request);
					const path = await this.path(request.path, false);
					const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
					try {
						const stat = await fd.stat();
						if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail("acp_file_limit");
						const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
						const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
						if (bytesRead > MAX_FILE_BYTES) fail("acp_file_limit");
						const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
						const start = Math.max(0, (request.line ?? 1) - 1);
						return {
							content: lines
								.slice(start, request.limit == null ? undefined : start + request.limit)
								.join("\n"),
						};
					} finally {
						await fd.close();
					}
				}),
			writeTextFile: (request) =>
				this.track(async () => {
					this.check(request);
					if (Buffer.byteLength(request.content) > MAX_FILE_BYTES) fail("acp_file_limit");
					const path = await this.path(request.path, true);
					await mkdir(dirname(path), { recursive: true });
					await this.path(request.path, true);
					const fd = await open(
						path,
						constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
						0o600,
					);
					try {
						await fd.writeFile(request.content);
						await fd.sync();
					} finally {
						await fd.close();
					}
					return {};
				}),
			createTerminal: (request) =>
				this.track(async () => {
					this.check(request);
					if (this.terminals.size >= 16) fail("acp_terminal_limit");
					const cwd = await this.path(request.cwd ?? this.spec.cwd, true);
					const env = { ...this.spec.env };
					for (const entry of request.env ?? []) {
						if (
							!/^(HOME|USERPROFILE|TMP|TEMP|TMPDIR|BEAR_.*|NODE_OPTIONS|LD_.*|DYLD_.*)$/.test(
								entry.name,
							)
						)
							env[entry.name] = entry.value;
					}
					const confined = applyProcessConfinement({
						...this.spec,
						cwd,
						env,
						command: resolveRunnerExecutable(request.command),
						args: request.args ?? [],
					});
					if (this.closed) fail("acp_resources_closed");
					const child = spawn(confined.command, confined.args, {
						cwd,
						env,
						detached: process.platform !== "win32",
						stdio: "pipe",
					});
					const { promise, resolve: done } = Promise.withResolvers<Exit>();
					const terminal: Terminal = {
						process: child,
						output: "",
						truncated: false,
						limit: Math.max(
							1,
							Math.min(request.outputByteLimit ?? MAX_TERMINAL_BYTES, MAX_TERMINAL_BYTES),
						),
						done: promise,
					};
					const collect = (chunk: Buffer) => {
						const combined = Buffer.concat([Buffer.from(terminal.output), chunk]);
						terminal.truncated ||= combined.length > terminal.limit;
						terminal.output = combined
							.subarray(Math.max(0, combined.length - terminal.limit))
							.toString("utf8");
					};
					child.stdout.on("data", collect);
					child.stderr.on("data", collect);
					child.stdin.on("error", () => undefined);
					child.stdin.end();
					child.once("error", () => {
						terminal.exit = { exitCode: 127 };
						done(terminal.exit);
					});
					child.once("close", (code, signal) => {
						terminal.exit = {
							...(code === null ? {} : { exitCode: code }),
							...(signal ? { signal } : {}),
						};
						done(terminal.exit);
					});
					const terminalId = randomUUID();
					this.terminals.set(terminalId, terminal);
					return { terminalId };
				}),
			terminalOutput: (request) =>
				this.track(async () => {
					this.check(request);
					const terminal = this.terminal(request.terminalId);
					return {
						output: terminal.output,
						truncated: terminal.truncated,
						...(terminal.exit ? { exitStatus: terminal.exit } : {}),
					};
				}),
			waitForTerminalExit: (request) =>
				this.track(async () => {
					this.check(request);
					return this.terminal(request.terminalId).done;
				}),
			killTerminal: (request) =>
				this.track(async () => {
					this.check(request);
					await stopTerminal(this.terminal(request.terminalId));
					return {};
				}),
			releaseTerminal: (request) =>
				this.track(async () => {
					this.check(request);
					await stopTerminal(this.terminal(request.terminalId));
					this.terminals.delete(request.terminalId);
					return {};
				}),
		};
	}
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.terminals.values()].map(stopTerminal));
		await Promise.allSettled([...this.operations]);
		// A create admitted before close may only just have produced its handle.
		await Promise.all([...this.terminals.values()].map(stopTerminal));
		this.terminals.clear();
	}
}
async function stopTerminal(terminal: Terminal): Promise<void> {
	const child = terminal.process;
	if (child.pid) {
		try {
			if (process.platform === "win32") child.kill("SIGKILL");
			else process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	await terminal.done;
}
