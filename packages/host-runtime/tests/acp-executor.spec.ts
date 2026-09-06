// @vitest-environment node

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type AcpProcessSpec, AcpRunClient } from "../src/executors/acp-client.js";
import { AcpExecutorController } from "../src/executors/acp-executor.js";
import type { ExecutorLaunchRequest } from "../src/executors/router.js";

const fixturePath = realpathSync.native(
	fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)),
);
const executablePath = realpathSync.native(process.execPath);
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTemp(purpose: "workspace" | "home"): string {
	const directory = mkdtempSync(join(realpathSync.native(tmpdir()), `bear-acp-${purpose}-`));
	temporaryDirectories.push(directory);
	return directory;
}

function fixtureSpec(
	cwd: string,
	permission = false,
	environment: NodeJS.ProcessEnv = {},
): AcpProcessSpec {
	return {
		command: executablePath,
		args: [fixturePath],
		cwd: realpathSync.native(cwd),
		env: {
			PATH: process.env.PATH,
			HOME: createTemp("home"),
			FIXTURE_PERMISSION: permission ? "1" : "0",
			...environment,
		},
	};
}

class FixtureController extends AcpExecutorController {
	constructor(
		private readonly permission = false,
		private readonly environment: NodeJS.ProcessEnv = {},
	) {
		super();
	}

	protected processSpec(request: ExecutorLaunchRequest): AcpProcessSpec {
		return fixtureSpec(request.task.workspace, this.permission, this.environment);
	}
}

function controlFixture(stopReason: "cancelled" | "end_turn" = "cancelled") {
	const cwd = createTemp("workspace");
	const script = join(createTemp("home"), "controlled-agent.mjs");
	const releasePath = join(cwd, "release-pause");
	const turnsPath = join(cwd, "turns.jsonl");
	const pidPath = join(cwd, "worker.pid");
	// A real stdio ACP peer holds cancellation acknowledgement behind an
	// explicit filesystem barrier, so no elapsed-time assertion proves pause.
	writeFileSync(
		script,
		`
		import { appendFileSync, existsSync, writeFileSync } from "node:fs";
		import { createInterface } from "node:readline";
		let promptId = null;
		let turn = 0;
		let sessionCount = 0;
		const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
		const update = (text) => send({
			method: "session/update",
			params: { sessionId: "control-session", update: {
				sessionUpdate: "agent_message_chunk", content: { type: "text", text },
			} },
		});
		writeFileSync(process.env.PID_PATH, String(process.pid));
		createInterface({ input: process.stdin }).on("line", (line) => {
			const message = JSON.parse(line);
			if (message.method === "initialize") {
				send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
			} else if (message.method === "session/new") {
				sessionCount++;
				send({ id: message.id, result: { sessionId: "control-session" } });
			} else if (message.method === "session/prompt") {
				promptId = message.id;
				turn++;
				appendFileSync(process.env.TURNS_PATH, JSON.stringify({
					sessionCount, sessionId: message.params.sessionId,
					text: message.params.prompt.map((part) => part.text ?? "").join(""),
				}) + "\\n");
				update("turn:" + turn);
			} else if (message.method === "session/cancel") {
				update("pause-requested");
				const barrier = setInterval(() => {
					if (!existsSync(process.env.RELEASE_PATH)) return;
					clearInterval(barrier);
					if (promptId !== null) {
						send({ id: promptId, result: { stopReason: process.env.STOP_REASON } });
						promptId = null;
					}
				}, 5);
			} else if (message.method === "_session/steering") {
				send({ id: message.id, error: { code: -32601, message: "Method not found" } });
			}
		});
	`,
	);
	class ControlController extends AcpExecutorController {
		protected processSpec(): AcpProcessSpec {
			return {
				...fixtureSpec(cwd),
				args: [script],
				env: {
					HOME: createTemp("home"),
					RELEASE_PATH: releasePath,
					TURNS_PATH: turnsPath,
					PID_PATH: pidPath,
					STOP_REASON: stopReason,
				},
			};
		}
	}
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const firstTurn = Promise.withResolvers<void>();
	const resumedTurn = Promise.withResolvers<void>();
	const pauseRequested = Promise.withResolvers<void>();
	const controller = new ControlController();
	const request: ExecutorLaunchRequest = {
		run: { runId: "controlled-run", triggerEntryId: "native-entry", executorProfile: "pi-default" },
		task: { instruction: "Inspect the approved inputs.", workspace: cwd },
		profile: { id: "pi-default", type: "pi", capabilities: {} },
		emit: (event) => {
			events.push(event);
			if (event.type !== "evidence" || event.kind !== "acp.message") return;
			if (!event.data || typeof event.data !== "object" || !("text" in event.data)) return;
			const text = event.data.text;
			if (text === "turn:1") firstTurn.resolve();
			if (text === "turn:2") resumedTurn.resolve();
			if (text === "pause-requested") pauseRequested.resolve();
		},
	};
	return {
		controller,
		request,
		events,
		firstTurn,
		resumedTurn,
		pauseRequested,
		releasePath,
		turnsPath,
		pidPath,
	};
}

type NativeReply =
	| { error: string }
	| { tool: "write" | "bash"; args: Record<string, unknown> }
	| { text: string };

async function nativeWorkerFixture(replies: NativeReply[]) {
	const cwd = createTemp("workspace");
	const authDir = createTemp("home");
	let requestCount = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const reply = replies[requestCount++] ?? { error: "Unexpected model request" };
			if ("error" in reply) {
				// 400 avoids the OpenAI SDK's HTTP retry. "overloaded" is retried
				// by the real AgentSession, after it emits an error message_end.
				response.writeHead(400, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({ error: { message: reply.error, type: "invalid_request_error" } }),
				);
				return;
			}
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			const tool = "tool" in reply;
			const delta = tool
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call_${requestCount}`,
								type: "function",
								function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
							},
						],
					}
				: { role: "assistant", content: reply.text };
			for (const choice of [
				{ index: 0, delta, finish_reason: null },
				{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
			]) {
				response.write(
					`data: ${JSON.stringify({
						id: `completion_${requestCount}`,
						object: "chat.completion.chunk",
						created: 1,
						model: "native-test-model",
						choices: [choice],
					})}\n\n`,
				);
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server address");
	writeFileSync(
		join(authDir, "models.json"),
		JSON.stringify({
			providers: {
				"native-test": {
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					api: "openai-completions",
					models: [
						{
							id: "native-test-model",
							name: "Native regression model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	const spec: AcpProcessSpec = {
		command: executablePath,
		args: [fileURLToPath(new URL("../src/executors/pi-acp-worker.ts", import.meta.url))],
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: createTemp("home"),
			BEAR_PI_AUTH_DIR: authDir,
			BEAR_PI_SESSION_DIR: createTemp("home"),
			BEAR_PI_PROVIDER_ID: "native-test",
			BEAR_PI_MODEL_ID: "native-test-model",
			BEAR_PI_API_KEY: "local-test-only",
			BEAR_PI_SHELL_PATH: realpathSync.native("/bin/bash"),
		},
		readOnlyPaths: [realpathSync.native(fileURLToPath(new URL("../../..", import.meta.url)))],
	};
	return {
		cwd,
		spec,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}

function nativeController(spec: AcpProcessSpec) {
	class NativeController extends AcpExecutorController {
		protected processSpec(): AcpProcessSpec {
			return spec;
		}
	}
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	const terminal = Promise.withResolvers<void>();
	const request: ExecutorLaunchRequest = {
		run: { runId: "native-run", triggerEntryId: "native-entry", executorProfile: "pi-default" },
		task: {
			instruction: "Execute the requested native tool and report its result.",
			workspace: spec.cwd,
		},
		profile: { id: "pi-default", type: "pi", capabilities: {} },
		emit: (event) => {
			events.push(event);
			if (["completed", "failed", "cancelled"].includes(event.type)) terminal.resolve();
		},
	};
	return { controller: new NativeController(), request, events, terminal };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("Native worker fixture timed out")), 15_000);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

function shellBarrier(cwd: string) {
	const heartbeat = join(cwd, "heartbeat");
	const release = join(cwd, "release-write");
	const forbidden = join(cwd, "write-after-stop");
	const shellPid = join(cwd, "native-shell.pid");
	const script = join(cwd, "pending-write.mjs");
	writeFileSync(
		script,
		`
		import { existsSync, writeFileSync } from "node:fs";
		let sequence = 0;
		setInterval(() => {
			writeFileSync(${JSON.stringify(heartbeat)}, String(++sequence));
			if (existsSync(${JSON.stringify(release)})) {
				writeFileSync(${JSON.stringify(forbidden)}, "escaped native cancellation");
			}
		}, 10);
	`,
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	return {
		shellPid,
		// Native bash is itself detached from the worker process group. Keep
		// bash alive while its child has an explicit, still-blocked file write.
		command: `echo $$ > ${quote(shellPid)}; ${quote(executablePath)} ${quote(script)} & wait`,
		ready: async () => {
			const deadline = Date.now() + 10_000;
			while (!existsSync(heartbeat) || readFileSync(heartbeat, "utf8") === "") {
				if (Date.now() >= deadline) throw new Error("Native bash heartbeat never started");
				await delay(10);
			}
		},
		assertStopped: async () => {
			const lastHeartbeat = readFileSync(heartbeat, "utf8");
			writeFileSync(release, "allow pending child write only after stop acknowledgement");
			// Give an escaped child multiple opportunities to observe the
			// barrier; checking only a PID or immediate file absence misses it.
			await delay(200);
			expect(existsSync(forbidden)).toBe(false);
			expect(readFileSync(heartbeat, "utf8")).toBe(lastHeartbeat);
		},
	};
}

async function directNativeWorker(spec: AcpProcessSpec) {
	// Deliberately no confinement: Linux PID-namespace teardown would hide
	// the detached native-tool leak that also affects macOS process groups.
	const child = spawn(spec.command, spec.args, {
		cwd: spec.cwd,
		env: spec.env,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.on("data", () => undefined);
	const exited = new Promise<void>((resolve, reject) => {
		child.once("exit", () => resolve());
		child.once("error", reject);
	});
	const connection = acp
		.client({ name: "native-regression" })
		.onNotification(acp.methods.client.session.update, () => undefined)
		.connect(
			acp.ndJsonStream(
				Writable.toWeb(child.stdin),
				Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
			),
		);
	return {
		child,
		exited,
		connection,
		start: async () => {
			await bounded(
				connection.agent.request(acp.methods.agent.initialize, {
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: {},
				}),
			);
			return bounded(
				connection.agent.request(acp.methods.agent.session.new, {
					cwd: spec.cwd,
					mcpServers: [],
				}),
			);
		},
		close: async () => {
			if (child.exitCode === null && child.signalCode === null && child.pid) {
				process.kill(-child.pid, "SIGKILL");
			}
			await bounded(exited);
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		},
	};
}

describe("ACP external-agent transport", () => {
	it("performs initialize, session creation, prompt, and a user-resolved permission request", async () => {
		const cwd = createTemp("workspace");
		const permission = Promise.withResolvers<{ requestId: string; optionId: string }>();
		const updates: string[] = [];
		const client = new AcpRunClient(fixtureSpec(cwd, true), {
			onSessionUpdate: (notification) => updates.push(notification.update.sessionUpdate),
			onPermissionRequest: (request) =>
				permission.resolve({ requestId: request.requestId, optionId: "allow" }),
			onExit: () => undefined,
		});

		expect(client.recoveryState()).toBe("unknown");
		await client.start();
		expect(client.recoveryState()).toBe("attached");
		const prompt = client.prompt("Inspect the file.");
		const approval = await permission.promise;
		client.respondToPermission(approval.requestId, approval.optionId);
		await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
		await client.stop();

		expect(client.activeSessionId).toBeNull();
		expect(client.recoveryState()).toBe("confirmed_lost");
		expect(updates).toEqual(["tool_call", "tool_call_update"]);
	});

	it("converts ACP updates into Host lifecycle and evidence events", async () => {
		const cwd = createTemp("workspace");
		const events: Array<{ type: string; [key: string]: unknown }> = [];
		const completed = Promise.withResolvers<void>();
		const controller = new FixtureController();
		const request: ExecutorLaunchRequest = {
			run: { runId: "run-1", triggerEntryId: "entry-1", executorProfile: "pi-default" },
			task: { instruction: "Inspect the workspace.", workspace: cwd },
			profile: { id: "pi-default", type: "pi", capabilities: {} },
			emit: (event) => {
				events.push(event);
				if (event.type === "completed") completed.resolve();
			},
		};

		await controller.launch(request);
		await completed.promise;

		expect(events).toEqual(
			expect.arrayContaining([
				{ type: "started" },
				expect.objectContaining({ type: "evidence", kind: "acp.tool_call" }),
				{ type: "completed", summary: undefined },
			]),
		);
	});

	it("drains worker stderr without exposing credentials in exit results or failure events", async () => {
		const cwd = createTemp("workspace");
		const secret = "pi-secret-must-not-persist";
		const exit = Promise.withResolvers<{
			code: number | null;
			signal: NodeJS.Signals | null;
			errorCode?: string;
		}>();
		const client = new AcpRunClient(
			fixtureSpec(cwd, false, {
				BEAR_PI_API_KEY: secret,
				FIXTURE_STDERR_EXIT_CODE: "23",
			}),
			{
				onSessionUpdate: () => undefined,
				onPermissionRequest: () => undefined,
				onExit: exit.resolve,
			},
		);

		await client.start();
		let promptFailure: unknown;
		try {
			await client.prompt("Fail after writing stderr.");
		} catch (error) {
			promptFailure = error;
		}
		const exitResult = await exit.promise;
		await client.stop();

		expect(exitResult).toEqual({ code: 23, signal: null });
		expect(JSON.stringify({ exitResult, promptFailure })).not.toContain(secret);

		const events: Array<{ type: string; [key: string]: unknown }> = [];
		const failed = Promise.withResolvers<void>();
		const controller = new FixtureController(false, {
			BEAR_PI_API_KEY: secret,
			FIXTURE_STDERR_EXIT_CODE: "23",
		});
		await controller.launch({
			run: { runId: "run-secret", triggerEntryId: "entry-secret", executorProfile: "pi-default" },
			task: { instruction: "Fail safely.", workspace: cwd },
			profile: { id: "pi-default", type: "pi", capabilities: {} },
			emit: (event) => {
				events.push(event);
				if (event.type === "failed") failed.resolve();
			},
		});
		await failed.promise;
		await controller.close();
		const failure = events.find((event) => event.type === "failed");
		expect(failure?.reason).toMatch(/^(?:acp_agent_exit_code:23|acp_executor_failed)$/);
		expect(JSON.stringify(events)).not.toContain(secret);
	});

	it("reports only a real live handle as attached and fails closed after restart", async () => {
		const cwd = createTemp("workspace");
		const controller = new FixtureController(true);
		const permissionRequested = Promise.withResolvers<void>();
		const request: ExecutorLaunchRequest = {
			run: { runId: "run-close", triggerEntryId: "entry-close", executorProfile: "pi-default" },
			task: { instruction: "Wait for permission.", workspace: cwd },
			profile: { id: "pi-default", type: "pi", capabilities: {} },
			emit: (event) => {
				if (event.type === "needs_user") permissionRequested.resolve();
			},
		};
		await controller.launch(request);
		await permissionRequested.promise;
		expect(await controller.recover(request.run)).toBe("attached");
		expect(controller.runtime(request.run)).toEqual({
			controller: "attached",
			actions: ["cancel", "respondPermission"],
		});

		// A newly constructed controller models Host restart. It cannot inherit
		// this anonymous stdio handle, but that absence is not proof of process
		// loss and must never become confirmed_lost.
		const restartedController = new FixtureController(true);
		expect(await restartedController.recover(request.run)).toBe("unknown");
		expect(restartedController.runtime(request.run)).toEqual({
			controller: "unknown",
			actions: [],
		});
		await controller.close();
		expect(await controller.recover(request.run)).toBe("unknown");
		await restartedController.close();
	});

	it("waits for native pause confirmation, resumes the same session, and releases on cancel", async () => {
		const fixture = controlFixture();
		const { controller, request, events } = fixture;
		try {
			await controller.launch(request);
			await fixture.firstTurn.promise;
			expect(controller.runtime(request.run)).toEqual({
				controller: "attached",
				actions: ["cancel", "steer", "interrupt"],
			});
			// An unsupported live control must not secretly start another turn.
			await expect(controller.steer(request.run, "Narrow the scope.")).rejects.toMatchObject({
				kind: "unavailable",
				reason: "executor_steering_unsupported",
			});
			expect(readFileSync(fixture.turnsPath, "utf8").trim().split("\n")).toHaveLength(1);
			const pause = controller.interrupt(request.run);
			await fixture.pauseRequested.promise;
			expect(controller.runtime(request.run)).toEqual({
				controller: "attached",
				actions: ["cancel"],
			});
			await expect(controller.resume(request.run)).rejects.toMatchObject({
				reason: "executor_not_paused",
			});
			expect(events.some((event) => event.kind === "run.paused")).toBe(false);
			writeFileSync(fixture.releasePath, "acknowledge");
			await pause;
			expect(controller.runtime(request.run)).toEqual({
				controller: "attached",
				actions: ["cancel", "resume"],
			});
			expect(events.some((event) => event.kind === "run.paused")).toBe(true);
			await controller.resume(request.run, undefined, "Continue only the verified file.");
			await fixture.resumedTurn.promise;
			const turns = readFileSync(fixture.turnsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(turns).toEqual([
				{
					sessionCount: 1,
					sessionId: "control-session",
					text: expect.stringContaining("Inspect the approved inputs."),
				},
				{ sessionCount: 1, sessionId: "control-session", text: "Continue only the verified file." },
			]);
			const pid = Number(readFileSync(fixture.pidPath, "utf8"));
			await controller.cancel(request.run);
			expect(() => process.kill(pid, 0)).toThrow();
			expect(controller.runtime(request.run)).toEqual({ controller: "unknown", actions: [] });
			expect(
				events.filter((event) => ["completed", "failed", "cancelled"].includes(event.type)),
			).toEqual([{ type: "cancelled" }]);
		} finally {
			await controller.close();
		}
	});

	it("does not turn a naturally completed turn into an acknowledged pause", async () => {
		const fixture = controlFixture("end_turn");
		const { controller, request, events } = fixture;
		try {
			await controller.launch(request);
			await fixture.firstTurn.promise;
			const pause = controller.interrupt(request.run);
			const rejectedPause = expect(pause).rejects.toMatchObject({
				reason: "executor_pause_not_confirmed",
			});
			await fixture.pauseRequested.promise;
			writeFileSync(fixture.releasePath, "finish-naturally");
			await rejectedPause;
			expect(events.some((event) => event.kind === "run.paused")).toBe(false);
			expect(
				events.filter((event) => ["completed", "failed", "cancelled"].includes(event.type)),
			).toEqual([expect.objectContaining({ type: "completed" })]);
			expect(controller.runtime(request.run)).toEqual({ controller: "unknown", actions: [] });
			await expect(controller.resume(request.run)).rejects.toMatchObject({
				reason: "executor_not_running",
			});
		} finally {
			await controller.close();
		}
	});
});

describe("native Pi ACP worker", () => {
	it("completes a native retry and write while retaining the transient error as evidence", async () => {
		const fixture = await nativeWorkerFixture([
			{ error: "overloaded" },
			{ tool: "write", args: { path: "verified.txt", content: "native retry completed\n" } },
			{ text: "The native write completed." },
		]);
		const { controller, request, events, terminal } = nativeController(fixture.spec);
		try {
			await bounded(controller.launch(request));
			await bounded(terminal.promise);
			expect(readFileSync(join(fixture.cwd, "verified.txt"), "utf8")).toBe(
				"native retry completed\n",
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "evidence",
					kind: "acp.error",
					data: { message: expect.stringContaining("overloaded") },
				}),
			);
			expect(
				events.filter((event) => ["completed", "failed", "cancelled"].includes(event.type)),
			).toEqual([expect.objectContaining({ type: "completed" })]);
		} finally {
			try {
				await controller.close();
			} finally {
				await fixture.close();
			}
		}
	}, 30_000);

	it("fails a genuinely unsuccessful final native response", async () => {
		const fixture = await nativeWorkerFixture([{ error: "Invalid model input" }]);
		const { controller, request, events, terminal } = nativeController(fixture.spec);
		try {
			await bounded(controller.launch(request));
			await bounded(terminal.promise);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "evidence",
					kind: "acp.error",
					data: { message: expect.stringContaining("Invalid model input") },
				}),
			);
			expect(
				events.filter((event) => ["completed", "failed", "cancelled"].includes(event.type)),
			).toEqual([expect.objectContaining({ type: "failed" })]);
		} finally {
			try {
				await controller.close();
			} finally {
				await fixture.close();
			}
		}
	}, 30_000);

	it("acknowledges Host cancellation only after native bash descendants stop writing", async () => {
		const replies: NativeReply[] = [];
		const fixture = await nativeWorkerFixture(replies);
		const barrier = shellBarrier(fixture.cwd);
		replies.push({ tool: "bash", args: { command: barrier.command } });
		const { controller, request, events } = nativeController(fixture.spec);
		try {
			await bounded(controller.launch(request));
			await barrier.ready();
			await bounded(controller.cancel(request.run));
			await barrier.assertStopped();
			expect(
				events.filter((event) => ["completed", "failed", "cancelled"].includes(event.type)),
			).toEqual([{ type: "cancelled" }]);
		} finally {
			try {
				await controller.close();
			} finally {
				await fixture.close();
			}
		}
	}, 30_000);

	it.each(["shutdown", "SIGTERM"] as const)(
		"drains detached native bash descendants on direct worker %s without namespace teardown",
		async (stop) => {
			const replies: NativeReply[] = [];
			const fixture = await nativeWorkerFixture(replies);
			const barrier = shellBarrier(fixture.cwd);
			replies.push({ tool: "bash", args: { command: barrier.command } });
			const worker = await directNativeWorker(fixture.spec);
			let cleanupError: unknown;
			try {
				const { sessionId } = await worker.start();
				// Signal shutdown may close transport before prompt delivery;
				// this regression proves child effects, not an invented receipt.
				const prompt = worker.connection.agent
					.request(acp.methods.agent.session.prompt, {
						sessionId,
						prompt: [{ type: "text", text: "Run the pending native bash command." }],
					})
					.catch(() => undefined);
				await barrier.ready();
				if (stop === "shutdown") {
					await expect(
						bounded(worker.connection.agent.request("_bear/shutdown", {})),
					).resolves.toEqual({ drained: true });
				} else {
					worker.child.kill("SIGTERM");
					await bounded(worker.exited);
				}
				await barrier.assertStopped();
				await bounded(prompt);
			} finally {
				// Cleanup must also work against the pre-fix leaking worker.
				// This PID was written by our actual native bash, not guessed.
				try {
					if (existsSync(barrier.shellPid)) {
						const pid = Number(readFileSync(barrier.shellPid, "utf8").trim());
						if (Number.isSafeInteger(pid) && pid > 1) {
							try {
								process.kill(-pid, "SIGKILL");
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = error;
							}
						}
					}
				} finally {
					try {
						await worker.close();
					} finally {
						await fixture.close();
					}
				}
			}
			if (cleanupError) throw cleanupError;
		},
		30_000,
	);
});
