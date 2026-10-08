import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("initializes the installed Codex ACP adapter over real stdio without user credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bear-codex-contract-"));
	await mkdir(join(directory, "codex"));
	const child = spawn(
		process.execPath,
		[fileURLToPath(import.meta.resolve("@agentclientprotocol/codex-acp"))],
		{
			cwd: directory,
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: directory,
				USERPROFILE: directory,
				CODEX_HOME: join(directory, "codex"),
				NO_COLOR: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	const lines = createInterface({ input: child.stdout });
	const result = Promise.withResolvers<Record<string, unknown>>();
	const timer = setTimeout(
		() => result.reject(new Error("Codex ACP initialize timed out")),
		15_000,
	);
	child.once("error", result.reject);
	child.once("exit", (code) =>
		result.reject(new Error(`Codex ACP exited before initialize: ${code}`)),
	);
	lines.on("line", (line) => {
		try {
			const message = JSON.parse(line);
			if (message.id === 1)
				message.error
					? result.reject(new Error(JSON.stringify(message.error)))
					: result.resolve(message.result);
		} catch (error) {
			result.reject(error);
		}
	});
	child.stderr.resume();
	try {
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "bear-contract", version: "1" }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } } })}\n`,
		);
		const response = await result.promise;
		expect(response.protocolVersion).toBe(1);
		expect(response.agentInfo).toMatchObject({
			name: expect.any(String),
			version: expect.any(String),
		});
		expect(Array.isArray(response.authMethods)).toBe(true);
	} finally {
		clearTimeout(timer);
		lines.close();
		child.stdin.end();
		if (child.exitCode === null) child.kill("SIGKILL");
		await exited;
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
