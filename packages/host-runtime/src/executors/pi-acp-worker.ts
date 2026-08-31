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
};

/** Extension method used by the Host to steer a live ACP session. */
const SESSION_STEERING_METHOD = "_session/steering";

type SteeringParams = {
	sessionId: string;
	prompt: Array<{ type: string; text: string }>;
};

const authDir = requiredDirectory("BEAR_PI_AUTH_DIR");
const sessionDir = requiredDirectory("BEAR_PI_SESSION_DIR");

class PiAcpAgent {
	private readonly sessions = new Map<string, PiSession>();
	private readonly runtime: Promise<PiModelRuntime>;

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
			},
			agentInfo: { name: "bear-pi-worker", title: "Bear Pi worker", version: "1.0.0" },
		};
	}

	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		if (!isAbsolute(params.cwd)) throw new Error("ACP session cwd must be absolute");
		const id = crypto.randomUUID();
		const agent = await this.createPiSession(params.cwd, id);
		const session: PiSession = { agent, context: null, cancelled: false };
		agent.subscribe((event) => {
			void this.forwardPiEvent(id, event);
		});
		this.sessions.set(id, session);
		return { sessionId: id };
	}

	async prompt(params: acp.PromptRequest, context: acp.AgentContext): Promise<acp.PromptResponse> {
		const session = this.requireSession(params.sessionId);
		const text = params.prompt
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n");
		if (!text) return { stopReason: "end_turn" };

		session.context = context;
		session.cancelled = false;
		try {
			await session.agent.prompt(text, { streamingBehavior: "followUp" });
			const lastText = extractText(session.agent.state.messages.at(-1));
			if (lastText) {
				await context.notify(acp.methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: lastText },
					},
				});
			}
			return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
		} catch (error) {
			if (session.cancelled) return { stopReason: "cancelled" };
			throw error;
		} finally {
			session.context = null;
		}
	}

	async cancel(params: acp.CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session) return;
		session.cancelled = true;
		await session.agent.abort();
	}

	/**
	 * Steer the live session: enqueue the instruction as a synthetic user
	 * message. While the agent is streaming, `prompt(..., {streamingBehavior:
	 * "steer"})` queues the message and it is delivered before the next LLM
	 * call (the prompt handler's context stays valid for the turn); when idle
	 * it starts a new turn on the same session, which keeps the full
	 * conversation history as context and borrows this request's client
	 * context for any tool calls.
	 */
	async steer(params: SteeringParams, context: acp.AgentContext): Promise<{ outcome: string }> {
		const session = this.requireSession(params.sessionId);
		const text = (params.prompt ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n\n");
		if (!text) return { outcome: "failed" };
		const streaming = session.agent.isStreaming;
		if (streaming) {
			await session.agent.prompt(text, { streamingBehavior: "steer" });
		} else {
			session.context = context;
			try {
				await session.agent.prompt(text, { streamingBehavior: "steer" });
			} finally {
				session.context = null;
			}
			// A brand-new turn ran to completion here; surface its final text so
			// the Host summary captures it, mirroring the prompt handler.
			const lastText = extractText(session.agent.state.messages.at(-1));
			if (lastText) {
				await context.notify(acp.methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: lastText },
					},
				});
			}
		}
		return { outcome: streaming ? "injected" : "startedNewTurn" };
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
		const context = this.sessions.get(sessionId)?.context;
		if (!context) return;
		if (event.type === "tool_execution_start") {
			await context.notify(acp.methods.client.session.update, {
				sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: String(event.toolCallId),
					title: String(event.toolName),
					kind: event.toolName === "read" ? "read" : "edit",
					status: "in_progress",
				},
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			await context.notify(acp.methods.client.session.update, {
				sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: String(event.toolCallId),
					status: event.isError === true ? "failed" : "completed",
				},
			});
		}
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

function requiredDirectory(name: string): string {
	const value = process.env[name];
	if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
	mkdirSync(value, { recursive: true });
	return resolve(value);
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const agent = new PiAcpAgent();
acp
	.agent({ name: "bear-pi-worker" })
	.onRequest(acp.methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
	.onRequest(acp.methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
	.onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
	.onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
	.onRequest(
		SESSION_STEERING_METHOD,
		(params: unknown) => params as SteeringParams,
		(ctx) => agent.steer(ctx.params, ctx.client),
	)
	.connect(acp.ndJsonStream(input, output));
