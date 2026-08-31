/**
 * ACP stdio client for one direct external-agent run.
 *
 * The client owns process transport and protocol sequencing only. Executors
 * emit events; ExternalAgentRunService remains the only writer of run state.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { applyProcessConfinement, type ConfinableProcessSpec } from "./confinement.js";

export interface AcpProcessSpec extends ConfinableProcessSpec {
	args: string[];
}

export interface AcpPermissionRequest {
	requestId: string;
	sessionId: string;
	toolCall: acp.ToolCallUpdate;
	options: acp.PermissionOption[];
}

export type AcpProcessFailureCode = "acp_process_spawn_failed" | "acp_process_stdio_failed";

export interface AcpProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	errorCode?: AcpProcessFailureCode;
}

export interface AcpClientHandlers {
	onSessionUpdate(notification: acp.SessionNotification): void;
	onPermissionRequest(request: AcpPermissionRequest): void;
	onExit(result: AcpProcessExit): void;
	readTextFile?: (request: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>;
	writeTextFile?: (request: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse>;
	createTerminal?: (request: acp.CreateTerminalRequest) => Promise<acp.CreateTerminalResponse>;
	terminalOutput?: (request: acp.TerminalOutputRequest) => Promise<acp.TerminalOutputResponse>;
	waitForTerminalExit?: (
		request: acp.WaitForTerminalExitRequest,
	) => Promise<acp.WaitForTerminalExitResponse>;
	killTerminal?: (request: acp.KillTerminalRequest) => Promise<acp.KillTerminalResponse>;
	releaseTerminal?: (request: acp.ReleaseTerminalRequest) => Promise<acp.ReleaseTerminalResponse>;
}

type PendingPermission = {
	request: AcpPermissionRequest;
	resolve: (response: acp.RequestPermissionResponse) => void;
};

/** codex-acp extension method that steers a live session (`_session/steering`). */
const SESSION_STEERING_METHOD = "_session/steering";
const PROCESS_GRACEFUL_STOP_MS = 250;
const PROCESS_STOP_TIMEOUT_MS = 2_000;

/** JSON-RPC code for "Method not found", returned for unregistered extension methods. */
function isMethodNotFound(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code: unknown }).code === -32601,
	);
}

/**
 * Starts an ACP server over strict stdio JSONL and completes the required
 * initialize → session/new → session/prompt lifecycle.
 */
export class AcpRunClient {
	private readonly spec: AcpProcessSpec;
	private readonly handlers: AcpClientHandlers;
	private process: ChildProcessWithoutNullStreams | null = null;
	private connection: acp.ClientConnection | null = null;
	private sessionId: string | null = null;
	private stopped = false;
	private permissionSequence = 0;
	private readonly pendingPermissions = new Map<string, PendingPermission>();

	constructor(spec: AcpProcessSpec, handlers: AcpClientHandlers) {
		this.spec = spec;
		this.handlers = handlers;
	}

	get activeSessionId(): string | null {
		return this.sessionId;
	}

	/**
	 * Report only transport state that this client can prove from its own
	 * process and ACP handles. A missing client/process is not evidence that a
	 * worker owned by an earlier Host instance exited.
	 */
	recoveryState(): "attached" | "confirmed_lost" | "unknown" {
		const process = this.process;
		if (!process) return "unknown";
		if (process.exitCode !== null || process.signalCode !== null) {
			return "confirmed_lost";
		}
		if (!this.stopped && !process.killed && this.connection !== null && this.sessionId !== null) {
			return "attached";
		}
		return "unknown";
	}

	async start(): Promise<void> {
		if (this.connection) throw new Error("ACP run client already started");

		const confined = applyProcessConfinement(this.spec);
		let process: ChildProcessWithoutNullStreams;
		try {
			process = spawn(confined.command, confined.args, {
				cwd: this.spec.cwd,
				env: this.spec.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			throw { kind: "unavailable", reason: "acp_process_spawn_failed" };
		}
		this.process = process;
		let processFailure: AcpProcessFailureCode | undefined;
		process.once("error", () => {
			processFailure = "acp_process_spawn_failed";
		});
		process.stdout.on("error", () => {
			if (!this.stopped) processFailure ??= "acp_process_stdio_failed";
		});
		process.stdin.on("error", () => {
			if (!this.stopped) processFailure ??= "acp_process_stdio_failed";
		});
		// Keep the pipe drained so a noisy worker cannot block, but never retain
		// stderr: it can contain provider credentials or arbitrary user data.
		process.stderr.on("data", () => undefined);
		process.stderr.on("error", () => {
			if (!this.stopped) processFailure ??= "acp_process_stdio_failed";
		});
		process.once("exit", (code, signal) => {
			this.resolvePendingPermissionsAsCancelled();
			this.connection = null;
			this.sessionId = null;
			if (!this.stopped) {
				this.handlers.onExit({
					code,
					signal,
					...(processFailure ? { errorCode: processFailure } : {}),
				});
			}
		});

		const input = Writable.toWeb(process.stdin);
		const output = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;
		const app = this.createClientApp();
		this.connection = app.connect(acp.ndJsonStream(input, output));

		try {
			const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: this.clientCapabilities(),
				clientInfo: { name: "bear-harness", title: "Bear Harness", version: "1.0.0" },
			});
			if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
				throw new Error(`ACP version mismatch: agent selected ${initialized.protocolVersion}`);
			}
			const session = await this.connection.agent.request(acp.methods.agent.session.new, {
				cwd: this.spec.cwd,
				mcpServers: [],
			});
			this.sessionId = session.sessionId;
		} catch {
			try {
				await this.stop();
			} catch {
				// Startup failure is reported with one stable code below.
			}
			throw { kind: "unavailable", reason: "acp_start_failed" };
		}
	}

	async prompt(text: string): Promise<acp.PromptResponse> {
		const connection = this.requireConnection();
		const sessionId = this.requireSessionId();
		return connection.agent.request(acp.methods.agent.session.prompt, {
			sessionId,
			prompt: [{ type: "text", text }],
		});
	}

	/**
	 * Deliver a steering instruction to the live agent session.
	 *
	 * Prefers the codex-acp `_session/steering` extension, which injects the
	 * instruction into the running turn (or starts a new one when idle). Our
	 * own pi worker implements the same extension. Agents that reject it as
	 * method-not-found fall back to a plain follow-up `session/prompt` on the
	 * same session, which enqueues a synthetic user message.
	 */
	async steerTurn(instruction: string): Promise<void> {
		const connection = this.requireConnection();
		const sessionId = this.requireSessionId();
		const prompt: acp.ContentBlock[] = [{ type: "text", text: instruction }];
		try {
			await connection.agent.request(SESSION_STEERING_METHOD, { sessionId, prompt });
		} catch (error) {
			if (!isMethodNotFound(error)) throw error;
			await connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
		}
	}

	async cancel(): Promise<void> {
		const connection = this.requireConnection();
		const sessionId = this.requireSessionId();
		await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
	}

	respondToPermission(requestId: string, optionId: string): void {
		const pending = this.pendingPermissions.get(requestId);
		if (!pending) throw { kind: "not_found", reason: "executor_permission_not_found" };
		if (!pending.request.options.some((option) => option.optionId === optionId)) {
			throw { kind: "validation_failed", reason: "executor_permission_option_invalid" };
		}
		this.pendingPermissions.delete(requestId);
		pending.resolve({ outcome: { outcome: "selected", optionId } });
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.resolvePendingPermissionsAsCancelled();
		this.connection = null;
		this.sessionId = null;
		const process = this.process;
		if (!process || process.exitCode !== null || process.signalCode !== null) return;
		process.stdin.end();
		if (await waitForProcessExit(process, PROCESS_GRACEFUL_STOP_MS)) return;
		if (!process.killed) process.kill();
		if (await waitForProcessExit(process, PROCESS_STOP_TIMEOUT_MS)) return;
		process.kill("SIGKILL");
		if (!(await waitForProcessExit(process, PROCESS_STOP_TIMEOUT_MS))) {
			throw new Error("acp_process_stop_timeout");
		}
	}

	private createClientApp(): acp.ClientApp {
		const app = acp
			.client({ name: "bear-harness" })
			.onNotification(acp.methods.client.session.update, (ctx) => {
				this.handlers.onSessionUpdate(ctx.params);
			})
			.onRequest(acp.methods.client.session.requestPermission, (ctx) =>
				this.requestPermission(ctx.params),
			);

		if (this.handlers.readTextFile) {
			app.onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
				this.handlers.readTextFile!(ctx.params),
			);
		}
		if (this.handlers.writeTextFile) {
			app.onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
				this.handlers.writeTextFile!(ctx.params),
			);
		}
		if (this.handlers.createTerminal) {
			app.onRequest(acp.methods.client.terminal.create, (ctx) =>
				this.handlers.createTerminal!(ctx.params),
			);
		}
		if (this.handlers.terminalOutput) {
			app.onRequest(acp.methods.client.terminal.output, (ctx) =>
				this.handlers.terminalOutput!(ctx.params),
			);
		}
		if (this.handlers.waitForTerminalExit) {
			app.onRequest(acp.methods.client.terminal.waitForExit, (ctx) =>
				this.handlers.waitForTerminalExit!(ctx.params),
			);
		}
		if (this.handlers.killTerminal) {
			app.onRequest(acp.methods.client.terminal.kill, (ctx) =>
				this.handlers.killTerminal!(ctx.params),
			);
		}
		if (this.handlers.releaseTerminal) {
			app.onRequest(acp.methods.client.terminal.release, (ctx) =>
				this.handlers.releaseTerminal!(ctx.params),
			);
		}
		return app;
	}

	private clientCapabilities(): acp.ClientCapabilities {
		return {
			fs: {
				readTextFile: Boolean(this.handlers.readTextFile),
				writeTextFile: Boolean(this.handlers.writeTextFile),
			},
			terminal: Boolean(this.handlers.createTerminal),
		};
	}

	private requestPermission(
		params: acp.RequestPermissionRequest,
	): Promise<acp.RequestPermissionResponse> {
		const requestId = `permission-${++this.permissionSequence}`;
		const { promise, resolve } = Promise.withResolvers<acp.RequestPermissionResponse>();
		const request: AcpPermissionRequest = {
			requestId,
			sessionId: params.sessionId,
			toolCall: params.toolCall,
			options: params.options,
		};
		this.pendingPermissions.set(requestId, { request, resolve });
		this.handlers.onPermissionRequest(request);
		return promise;
	}

	private resolvePendingPermissionsAsCancelled(): void {
		for (const pending of this.pendingPermissions.values()) {
			pending.resolve({ outcome: { outcome: "cancelled" } });
		}
		this.pendingPermissions.clear();
	}

	private requireConnection(): acp.ClientConnection {
		if (!this.connection) throw { kind: "conflict", reason: "executor_not_running" };
		return this.connection;
	}

	private requireSessionId(): string {
		if (!this.sessionId) throw { kind: "conflict", reason: "executor_session_not_ready" };
		return this.sessionId;
	}
}

function waitForProcessExit(
	process: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<boolean> {
	if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const exited = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			process.off("exit", exited);
			resolve(process.exitCode !== null || process.signalCode !== null);
		}, timeoutMs);
		process.once("exit", exited);
	});
}
