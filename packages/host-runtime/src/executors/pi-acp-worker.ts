#!/usr/bin/env node
/**
 * Dedicated ACP agent for approved Pi commission runs.
 *
 * This is intentionally separate from the conversational Companion session.
 * It receives only ACP prompts and can access files only through the Host ACP
 * client methods; it never receives Companion conversation or memory state.
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
import { Type } from "typebox";

type PiSession = {
	agent: AgentSession;
	context: acp.AgentContext | null;
	cancelled: boolean;
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
			agentInfo: { name: "bear-pi-worker", title: "Bear Pi worker", version: "0.0.0" },
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

	private async createPiSession(cwd: string, id: string): Promise<AgentSession> {
		const runDir = resolve(sessionDir, id);
		mkdirSync(runDir, { recursive: true });
		const settings = SettingsManager.inMemory(
			{ enableAnalytics: false, enableInstallTelemetry: false, defaultProjectTrust: "never" },
			{ projectTrusted: false },
		);
		const resources = new DefaultResourceLoader({
			cwd,
			agentDir: runDir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt:
				"You are an approved, bounded execution worker. Use only the injected read and write tools. " +
				"Never claim a change unless the relevant Host tool succeeds. Do not request or use relationship memory, product UI state, credentials, or network access.",
		});
		await resources.reload();
		const runtime = await this.runtime;
		const { session } = await createAgentSession({
			cwd,
			agentDir: runDir,
			modelRuntime: runtime,
			settingsManager: settings,
			resourceLoader: resources,
			noTools: "builtin",
			customTools: [this.readTool(id), this.writeTool(id)],
			sessionManager: SessionManager.create(runDir),
		});
		session.setActiveToolsByName(session.getActiveToolNames());
		if (!session.model && !(await selectConfiguredModel(runtime, session))) {
			session.dispose();
			throw new Error("pi_provider_auth_required");
		}
		return session;
	}

	private readTool(sessionId: string) {
		return {
			name: "read",
			label: "Read approved file",
			description: "Read a text file that the approved action explicitly allows.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				line: Type.Optional(Type.Integer({ minimum: 1 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
			}),
			execute: async (
				_toolCallId: string,
				params: { path: string; line?: number; limit?: number },
			) => {
				const context = this.requireContext(sessionId);
				const response = await context.request(acp.methods.client.fs.readTextFile, {
					sessionId,
					path: params.path,
					line: params.line,
					limit: params.limit,
				});
				return {
					content: [{ type: "text" as const, text: response.content }],
					details: { path: params.path },
				};
			},
		};
	}

	private writeTool(sessionId: string) {
		return {
			name: "write",
			label: "Write approved file",
			description:
				"Create or replace a text file only when the approved action explicitly allows it.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				content: Type.String(),
			}),
			execute: async (_toolCallId: string, params: { path: string; content: string }) => {
				const context = this.requireContext(sessionId);
				await context.request(acp.methods.client.fs.writeTextFile, {
					sessionId,
					path: params.path,
					content: params.content,
				});
				return {
					content: [{ type: "text" as const, text: `Wrote ${params.path}` }],
					details: { path: params.path },
				};
			},
		};
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

	private requireContext(sessionId: string): acp.AgentContext {
		const context = this.requireSession(sessionId).context;
		if (!context) throw new Error("Pi tool call outside an ACP prompt");
		return context;
	}
}

async function selectConfiguredModel(
	runtime: PiModelRuntime,
	session: AgentSession,
): Promise<boolean> {
	for (const provider of runtime.getProviders()) {
		if (!runtime.hasConfiguredAuth(provider.id)) continue;
		const model = runtime.getModels(provider.id)[0];
		if (!model) continue;
		await session.setModel(model);
		return true;
	}
	return false;
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
	.connect(acp.ndJsonStream(input, output));
