#!/usr/bin/env node
/**
 * Dedicated ACP agent for a standalone Pi external-agent run.
 *
 * It is intentionally separate from the conversational Companion session and
 * starts a normal Pi coding session in the Host-provided real workspace.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentSession, ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

type PiSession = {
	agent: AgentSession;
	context: acp.AgentContext | null;
	cancelled: boolean;
	pendingUpdates: Set<Promise<void>>;
	updateError: boolean;
	streamedText: boolean;
	turn: Promise<void> | null;
};

/** Extension method used by the Host to steer a live ACP session. */
const SESSION_STEERING_METHOD = "_session/steering";
const SHUTDOWN_METHOD = "_bear/shutdown";

type SteeringParams = {
	sessionId: string;
	prompt: Array<{ type: string; text: string }>;
};

const authDir = requiredDirectory("BEAR_PI_AUTH_DIR");
const sessionDir = requiredDirectory("BEAR_PI_SESSION_DIR");

class PiAcpAgent {
	private readonly sessions = new Map<string, PiSession>();
	private readonly runtime: Promise<PiModelRuntime>;
	private readonly creating = new Set<Promise<acp.NewSessionResponse>>();
	private shutdownOperation: Promise<{ drained: true }> | null = null;

	constructor() {
		this.runtime = ModelRuntime.create({
			authPath: resolve(authDir, "auth.json"),
			modelsPath: resolve(authDir, "models.json"),
			refreshOnCreate: false,
		});
	}

	async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false, embeddedContext: false },
				_meta: { bearNativeShutdown: true },
			},
			agentInfo: { name: "bear-pi-worker", title: "Bear Pi worker", version: "1.0.0" },
		};
	}

	newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		if (this.shutdownOperation) return Promise.reject(new Error("pi_worker_shutting_down"));
		const pending = this.openSession(params).finally(() => this.creating.delete(pending));
		this.creating.add(pending);
		return pending;
	}

	private async openSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		if (!isAbsolute(params.cwd)) throw new Error("ACP session cwd must be absolute");
		const id = crypto.randomUUID();
		const agent = await this.createPiSession(params.cwd, id);
		const session: PiSession = {
			agent,
			context: null,
			cancelled: false,
			pendingUpdates: new Set(),
			updateError: false,
			streamedText: false,
			turn: null,
		};
		agent.subscribe((event) => {
			// Cancellation can arrive during prompt preflight, before Pi has a
			// native run to abort. Abort that actual run as soon as it is created.
			if (event.type === "agent_start" && session.cancelled) agent.agent.abort();
			// Pi emits this event just before installing its retry controller.
			if (event.type === "auto_retry_start" && session.cancelled)
				queueMicrotask(() => agent.abortRetry());
			if (session.pendingUpdates.size >= 256) {
				session.updateError = true;
				return;
			}
			const pending = this.forwardPiEvent(id, event)
				.catch(() => {
					session.updateError = true;
				})
				.finally(() => session.pendingUpdates.delete(pending));
			session.pendingUpdates.add(pending);
		});
		this.sessions.set(id, session);
		return { sessionId: id };
	}

	async prompt(params: acp.PromptRequest, context: acp.AgentContext): Promise<acp.PromptResponse> {
		if (this.shutdownOperation) throw new Error("pi_worker_shutting_down");
		const session = this.requireSession(params.sessionId);
		const text = params.prompt
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n");
		if (!text) return { stopReason: "end_turn" };

		if (session.context) throw new Error("pi_worker_turn_already_active");
		session.context = context;
		session.cancelled = false;
		session.updateError = false;
		try {
			session.turn = session.agent.prompt(text);
			await session.turn;
			await Promise.all(session.pendingUpdates);
			const last = session.agent.state.messages.findLast((message) => message.role === "assistant");
			if (
				last?.role === "assistant" &&
				(last.stopReason === "error" || (last.stopReason === "aborted" && !session.cancelled))
			)
				throw new Error("pi_worker_turn_failed");
			if (session.updateError) throw new Error("pi_worker_evidence_delivery_failed");
			return {
				stopReason: session.cancelled && last?.stopReason !== "stop" ? "cancelled" : "end_turn",
			};
		} catch (error) {
			await Promise.all(session.pendingUpdates);
			throw error;
		} finally {
			session.context = null;
			session.turn = null;
		}
	}

	async cancel(params: acp.CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session?.context) return;
		session.cancelled = true;
		await this.drainSession(session);
	}

	private async drainSession(session: PiSession): Promise<void> {
		session.cancelled = true;
		session.agent.abortBash();
		await session.agent.abort();
		// abort() waits for native idle, while the owned prompt also includes
		// preflight, retry/continuation and settled hooks. Do not release early.
		await session.turn?.catch(() => undefined);
		await Promise.all(session.pendingUpdates);
	}

	shutdown(): Promise<{ drained: true }> {
		this.shutdownOperation ??= this.drain();
		return this.shutdownOperation;
	}

	private async drain(): Promise<{ drained: true }> {
		await Promise.allSettled(this.creating);
		await Promise.all([...this.sessions.values()].map((session) => this.drainSession(session)));
		for (const session of this.sessions.values()) session.agent.dispose();
		this.sessions.clear();
		return { drained: true };
	}

	/** Native steering queues into the owned live turn, never silently starts another turn. */
	async steer(
		params: SteeringParams,
		_context: acp.AgentContext,
	): Promise<{ outcome: "injected" }> {
		const session = this.requireSession(params.sessionId);
		const text = (params.prompt ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n");
		if (!text) throw new Error("pi_worker_steering_instruction_required");
		if (!session.context || session.cancelled || !session.agent.isStreaming)
			throw new Error("pi_worker_turn_not_running");
		await session.agent.steer(text);
		return { outcome: "injected" };
	}

	private async createPiSession(cwd: string, id: string): Promise<AgentSession> {
		const runDir = resolve(sessionDir, id);
		mkdirSync(runDir, { recursive: true });
		const shellPath = process.env.BEAR_PI_SHELL_PATH;
		const settings = SettingsManager.inMemory(
			{
				enableAnalytics: false,
				enableInstallTelemetry: false,
				...(shellPath ? { shellPath } : {}),
			},
			{ projectTrusted: true },
		);
		const resources = new DefaultResourceLoader({
			cwd,
			agentDir: runDir,
			settingsManager: settings,
		});
		await resources.reload();
		settings.applyOverrides({
			enableAnalytics: false,
			enableInstallTelemetry: false,
			...(shellPath ? { shellPath } : {}),
		});
		const runtime = await this.runtime;
		const { session } = await createAgentSession({
			cwd,
			agentDir: runDir,
			modelRuntime: runtime,
			settingsManager: settings,
			resourceLoader: resources,
			sessionManager: SessionManager.create(cwd, runDir),
		});
		if (!(await selectConfiguredModel(runtime, session))) {
			session.dispose();
			throw new Error("pi_model_unavailable");
		}
		return session;
	}

	private async forwardPiEvent(
		sessionId: string,
		event: { type: string; [key: string]: unknown },
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		const context = session?.context;
		if (!session || !context) return;
		let update: acp.SessionNotification["update"] | undefined;
		if (event.type === "message_start") session.streamedText = false;
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
			if (delta?.type === "text_delta" && typeof delta.delta === "string") {
				session.streamedText = true;
				update = {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: delta.delta.slice(0, 12_000),
					},
				};
			}
		}
		if (event.type === "message_end") {
			const message = event.message as
				| { role?: string; stopReason?: string; errorMessage?: string }
				| undefined;
			if (message?.role === "assistant") {
				if (
					message.stopReason === "error" ||
					(message.stopReason === "aborted" && !session.cancelled)
				) {
					update = {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "" },
						_meta: {
							bearError: (message.errorMessage || `pi_stop_reason:${message.stopReason}`).slice(
								0,
								2_000,
							),
						},
					};
				}
				if (!session.streamedText) {
					const text = extractText(message);
					if (text)
						await context.notify(acp.methods.client.session.update, {
							sessionId,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: text.slice(0, 12_000) },
							},
						});
				}
			}
		}
		if (event.type === "tool_execution_start") {
			update = {
				sessionUpdate: "tool_call",
				toolCallId: String(event.toolCallId),
				title: String(event.toolName),
				kind:
					event.toolName === "read"
						? "read"
						: event.toolName === "bash"
							? "execute"
							: event.toolName === "write" || event.toolName === "edit"
								? "edit"
								: "other",
				status: "in_progress",
				rawInput: publicPayload(event.args),
			};
		}
		if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			update = {
				sessionUpdate: "tool_call_update",
				toolCallId: String(event.toolCallId),
				status:
					event.type === "tool_execution_update"
						? "in_progress"
						: event.isError === true
							? "failed"
							: "completed",
				rawOutput: publicPayload(
					event.type === "tool_execution_update" ? event.partialResult : event.result,
				),
			};
		}
		if (update) await context.notify(acp.methods.client.session.update, { sessionId, update });
	}

	private requireSession(sessionId: string): PiSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`unknown ACP session '${sessionId}'`);
		return session;
	}
}

async function selectConfiguredModel(
	runtime: PiModelRuntime,
	session: AgentSession,
): Promise<boolean> {
	const providerId = process.env.BEAR_PI_PROVIDER_ID;
	const modelId = process.env.BEAR_PI_MODEL_ID;
	if (!providerId || !modelId) return false;
	const apiKey = process.env.BEAR_PI_API_KEY;
	if (apiKey) await runtime.setRuntimeApiKey(providerId, apiKey);
	if (!runtime.hasConfiguredAuth(providerId)) return false;
	const model = runtime.getModels(providerId).find((candidate) => candidate.id === modelId);
	if (!model) return false;
	await session.setModel(model);
	return true;
}

function extractText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	if ("content" in value && Array.isArray(value.content)) {
		return value.content
			.filter((part): part is { type: string; text: string } =>
				Boolean(
					part &&
						typeof part === "object" &&
						"type" in part &&
						"text" in part &&
						typeof part.text === "string",
				),
			)
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

function publicPayload(value: unknown, depth = 0, budget = { left: 12_000 }): unknown {
	if (budget.left <= 0 || depth >= 6) return "[truncated]";
	if (typeof value === "string") {
		const text = value.slice(0, budget.left);
		budget.left -= text.length;
		return text;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value))
		return value.slice(0, 64).map((item) => publicPayload(item, depth + 1, budget));
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).slice(0, 64)) {
			if (/signature|thinking|token|secret|password|authorization|api.?key|^data$/i.test(key))
				continue;
			if (budget.left <= 0) break;
			budget.left -= key.length;
			result[key] = publicPayload(item, depth + 1, budget);
		}
		return result;
	}
	return null;
}

function requiredDirectory(name: string): string {
	const value = process.env[name];
	if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
	mkdirSync(value, { recursive: true });
	return resolve(value);
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const agent = new PiAcpAgent();
// POSIX native bash tools own detached groups. A signal must reach Pi's
// native abort listeners and await their tool/prompt drain before we exit.
const shutdownFromSignal = () => {
	void agent.shutdown().then(
		() => process.exit(0),
		() => {
			// Keep the process owned and visibly unsuccessful; forced transport
			// death is not proof that detached native tools have been released.
			process.exitCode = 1;
		},
	);
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
	process.on(signal, shutdownFromSignal);
process.stdin.on("end", shutdownFromSignal);
acp
	.agent({ name: "bear-pi-worker" })
	.onRequest(acp.methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
	.onRequest(acp.methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
	.onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
	.onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
	.onRequest(
		SHUTDOWN_METHOD,
		(params: unknown) => params,
		() => agent.shutdown(),
	)
	.onRequest(
		SESSION_STEERING_METHOD,
		(params: unknown) => params as SteeringParams,
		(ctx) => agent.steer(ctx.params, ctx.client),
	)
	.connect(acp.ndJsonStream(input, output));
