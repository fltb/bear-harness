/**
 * ACP stdio client for one direct external-agent run.
 *
 * The client owns process transport and protocol sequencing only. Executors
 * emit events; ExternalAgentRunService remains the only writer of run state.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { RunSteerResponse } from "@bear-harness/protocol";
import { type AcpDialect, type AcpExtensions, standardAcpDialect } from "./acp-dialect.js";
import { applyProcessConfinement, type ConfinableProcessSpec } from "./confinement.js";

export interface AcpProcessSpec extends ConfinableProcessSpec {
	args: string[];
	dialect?: AcpDialect;
	authMethodId?: string;
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

const PROCESS_STOP_TIMEOUT_MS = 2_000;
const NATIVE_SHUTDOWN_TIMEOUT_MS = 10_000;

function steeringReceipt(value: unknown): RunSteerResponse {
	if (
		value &&
		typeof value === "object" &&
		"outcome" in value &&
		(value.outcome === "injected" || value.outcome === "startedNewTurn" || value.outcome === "sent")
	) {
		return { outcome: value.outcome };
	}
	throw { kind: "unavailable", reason: "executor_steering_receipt_invalid" };
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
	private stopping: Promise<void> | null = null;
	private extensions: AcpExtensions = {};
	private initialized?: acp.InitializeResponse;
	private nativeShutdown: Promise<unknown> | null = null;
	private processExitObserved = false;
	private readonly pendingPermissions = new Map<string, PendingPermission>();

	constructor(spec: AcpProcessSpec, handlers: AcpClientHandlers) {
		this.spec = spec;
		this.handlers = handlers;
	}

	get activeSessionId(): string | null {
		return this.sessionId;
	}

	get shutdownRequested(): boolean {
		return this.stopped;
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
		if (!process.killed && this.connection !== null && this.sessionId !== null) {
			return "attached";
		}
		return "unknown";
	}

	get capabilities() {
		return {
			loadSession: this.initialized?.agentCapabilities?.loadSession === true,
			resume: Boolean(this.initialized?.agentCapabilities?.sessionCapabilities?.resume),
			steer: Boolean(this.extensions.steeringMethod),
		};
	}
	get connectionInfo() {
		return {
			protocolVersion: this.initialized?.protocolVersion ?? acp.PROTOCOL_VERSION,
			name: this.initialized?.agentInfo?.name ?? "ACP worker",
			version: this.initialized?.agentInfo?.version ?? "",
			authenticated: this.sessionId !== null,
			authMethods: (this.initialized?.authMethods ?? []).map((method) => ({
				id: method.id,
				name: method.name,
			})),
			capabilities: this.capabilities,
		};
	}
	async start(options: { sessionId?: string } = {}): Promise<void> {
		if (this.connection) throw new Error("ACP run client already started");
		if (this.stopped) throw { kind: "conflict", reason: "executor_not_running" };

		const confined = applyProcessConfinement(this.spec);
		let process: ChildProcessWithoutNullStreams;
		try {
			process = spawn(confined.command, confined.args, {
				cwd: this.spec.cwd,
				env: this.spec.env,
				detached: globalThis.process.platform !== "win32",
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
			this.processExitObserved = true;
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

		let startupTimedOut = false;
		const startupTimer = setTimeout(() => {
			startupTimedOut = true;
			void this.stop().catch(() => undefined);
		}, 30_000);
		try {
			const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: this.clientCapabilities(),
				clientInfo: { name: "bear-harness", title: "Bear Harness", version: "1.0.0" },
			});
			this.initialized = initialized;
			this.extensions = (this.spec.dialect ?? standardAcpDialect).extensions(initialized);
			if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
				throw new Error(`ACP version mismatch: agent selected ${initialized.protocolVersion}`);
			}
			if (this.stopped || !this.connection) throw new Error("ACP startup cancelled");
			if (this.spec.authMethodId) {
				if (!(initialized.authMethods ?? []).some((method) => method.id === this.spec.authMethodId))
					throw { kind: "unavailable", reason: "runner_auth_method_unavailable" };
				await this.connection.agent.request(acp.methods.agent.authenticate, {
					methodId: this.spec.authMethodId,
				});
			}
			if (options.sessionId) {
				const params = { sessionId: options.sessionId, cwd: this.spec.cwd, mcpServers: [] };
				this.sessionId = options.sessionId;
				if (this.capabilities.resume)
					await this.connection.agent.request(acp.methods.agent.session.resume, params);
				else if (this.capabilities.loadSession)
					await this.connection.agent.request(acp.methods.agent.session.load, params);
				else throw { kind: "unavailable", reason: "runner_recovery_unsupported" };
				this.sessionId = options.sessionId;
			} else {
				const session = await this.connection.agent.request(acp.methods.agent.session.new, {
					cwd: this.spec.cwd,
					mcpServers: [],
				});
				this.sessionId = session.sessionId;
			}
			if (this.stopped) throw new Error("ACP startup cancelled");
		} catch (error) {
			try {
				await this.stop();
			} catch {
				throw { kind: "unavailable", reason: "acp_process_release_failed" };
			}
			if (startupTimedOut) throw { kind: "unavailable", reason: "runner_startup_timeout" };
			if (
				error &&
				typeof error === "object" &&
				"reason" in error &&
				typeof error.reason === "string" &&
				error.reason.startsWith("runner_")
			)
				throw error;
			if (error && typeof error === "object" && "code" in error && error.code === -32000)
				throw { kind: "unavailable", reason: "runner_authentication_required" };
			throw { kind: "unavailable", reason: "acp_start_failed" };
		} finally {
			clearTimeout(startupTimer);
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

	/** Return the adapter's actual receipt; unsupported steering is not a follow-up turn. */
	async steerTurn(instruction: string): Promise<RunSteerResponse> {
		const connection = this.requireConnection();
		const sessionId = this.requireSessionId();
		if (!this.extensions.steeringMethod)
			throw { kind: "unavailable", reason: "executor_steering_unsupported" };
		try {
			return steeringReceipt(
				await connection.agent.request(this.extensions.steeringMethod, {
					sessionId,
					prompt: [{ type: "text", text: instruction }],
				}),
			);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === -32601) {
				throw { kind: "unavailable", reason: "executor_steering_unsupported" };
			}
			throw error;
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

	stop(): Promise<void> {
		this.stopping ??= this.stopProcess().catch((error) => {
			this.stopping = null;
			throw error;
		});
		return this.stopping;
	}

	private async stopProcess(): Promise<void> {
		this.stopped = true;
		this.resolvePendingPermissionsAsCancelled();
		const process = this.process;
		if (!process) {
			this.connection = null;
			this.sessionId = null;
			return;
		}
		if (this.extensions.shutdownMethod) {
			// Native bash shells have their own detached POSIX process groups:
			// killing this transport cannot prove those tools stopped.
			if (!this.nativeShutdown) {
				if (!this.connection || process.exitCode !== null || process.signalCode !== null)
					throw new Error("acp_native_shutdown_not_confirmed");
				this.nativeShutdown = this.connection.agent.request(this.extensions.shutdownMethod, {});
			}
			const receipt = await waitForNativeShutdown(this.nativeShutdown);
			if (
				!receipt ||
				typeof receipt !== "object" ||
				!("drained" in receipt) ||
				receipt.drained !== true
			)
				throw new Error("acp_native_shutdown_not_confirmed");
		}
		this.connection = null;
		this.sessionId = null;
		if (this.processExitObserved || process.exitCode !== null || process.signalCode !== null)
			return;
		// A peer may close stdio immediately before Node delivers its exit event.
		// Give that already-terminating process one event-loop grace period so a
		// recycled or inaccessible process group is never signalled by mistake.
		if (await waitForProcessExit(process, 100)) return;
		// A pre-initialize worker has no session/tools. An initialized native
		// worker reaches here only after its real abort/drain acknowledgement.
		// Kill the owned group once while its leader is still live. Sending a
		// second signal after leader exit can target a recycled group identity.
		terminateProcessGroup(process, "SIGKILL");
		if (!(await waitForProcessExit(process, PROCESS_STOP_TIMEOUT_MS)))
			throw new Error("acp_process_stop_timeout");
	}

	private createClientApp(): acp.ClientApp {
		const app = acp
			.client({ name: "bear-harness" })
			.onNotification(acp.methods.client.session.update, (ctx) => {
				if (ctx.params.sessionId === this.sessionId) this.handlers.onSessionUpdate(ctx.params);
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
		if (this.stopped || params.sessionId !== this.sessionId)
			return Promise.resolve({ outcome: { outcome: "cancelled" } });
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
		if (this.stopped || !this.connection)
			throw { kind: "conflict", reason: "executor_not_running" };
		return this.connection;
	}

	private requireSessionId(): string {
		if (!this.sessionId) throw { kind: "conflict", reason: "executor_session_not_ready" };
		return this.sessionId;
	}
}

function terminateProcessGroup(
	child: ChildProcessWithoutNullStreams,
	signal: NodeJS.Signals,
): void {
	if (process.platform === "win32" || !child.pid) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH"))
			throw error;
	}
}

async function waitForNativeShutdown(operation: Promise<unknown>): Promise<unknown> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("acp_native_shutdown_timeout")),
					NATIVE_SHUTDOWN_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
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
