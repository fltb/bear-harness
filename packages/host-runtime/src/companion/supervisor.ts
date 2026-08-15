/**
 * Companion Pi runtime — an in-process Host service.
 *
 * The renderer remains Electron-sandboxed. Pi runs alongside the Host because
 * role plugins are first-party package code, not an untrusted sandbox target;
 * Host-owned tools remain the sole application-state authority.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { toJsonSchema, z } from "@bear-harness/schema";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EventBus } from "../storage/event-bus.js";
import type { CompanionHostToolCall, CompanionHostToolResult } from "./character-behavior.js";

export type CompanionState = "stopped" | "starting" | "running" | "unavailable";

/** Validated, role-owned Pi resources discovered by the Host package loader. */
export interface CompanionRuntimeConfig {
	skillPaths: string[];
	pluginPaths: string[];
	appendSystemPrompt: string;
}

type HostToolHandler = (
	call: CompanionHostToolCall,
) => CompanionHostToolResult | Promise<CompanionHostToolResult>;
type ModelSelectionHandler = (
	conversationId: string,
) => { providerId: string; modelId: string } | undefined;
type ContextHandler = (conversationId: string, includeHistory: boolean, message: string) => string;

/** Host provider boundary required by the in-process Pi session. */
export interface CompanionModelRuntimeSource {
	getModelRuntime(): Promise<ModelRuntime>;
}

/**
 * Owns one local Pi session and dispatches Host commands without a child
 * process. No built-in filesystem, shell, edit, or write tool is enabled.
 */
export class CompanionSupervisor {
	private state: CompanionState = "stopped";
	private runtimeConfig: CompanionRuntimeConfig = {
		skillPaths: [],
		pluginPaths: [],
		appendSystemPrompt: "",
	};
	private hostToolHandler: HostToolHandler | null = null;
	private modelSelectionHandler: ModelSelectionHandler | null = null;
	private contextHandler: ContextHandler | null = null;
	private session: AgentSession | null = null;
	private readonly sessions = new Map<string, AgentSession>();
	private modelRuntime: ModelRuntime | null = null;
	private readonly initializations = new Map<string, Promise<AgentSession>>();
	private activeConversationId: string | null = null;
	private promptQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly userDataDir: string,
		private readonly eventBus: EventBus,
		private readonly providers: CompanionModelRuntimeSource,
	) {}

	get currentState(): CompanionState {
		return this.state;
	}
	/** Set the active role's already-validated Pi resources. */
	configureRuntime(config: CompanionRuntimeConfig): void {
		this.runtimeConfig = {
			skillPaths: [...config.skillPaths],
			pluginPaths: [...config.pluginPaths],
			appendSystemPrompt: config.appendSystemPrompt,
		};
	}

	/** Host-owned UI controls are the only product capability Pi can invoke. */
	setHostToolHandler(handler: HostToolHandler): void {
		this.hostToolHandler = handler;
	}

	setModelSelectionHandler(handler: ModelSelectionHandler): void {
		this.modelSelectionHandler = handler;
	}

	setContextHandler(handler: ContextHandler): void {
		this.contextHandler = handler;
	}

	/** Mark the Host runtime available; the Pi session is loaded on first turn. */
	async start(): Promise<void> {
		if (this.state === "running") return;
		Object.assign(globalThis, {
			bearHostCall: (tool: string, args: unknown) => this.callHost(tool, args),
		});
		this.state = "running";
		this.eventBus.publish("companion.state_changed", { state: "running" });
	}

	private async initializeSession(conversationId: string): Promise<AgentSession> {
		const existing = this.sessions.get(conversationId);
		if (existing) return existing;
		const pending = this.initializations.get(conversationId);
		if (pending) return pending;
		const initialization = this.createSession(conversationId);
		this.initializations.set(conversationId, initialization);
		try {
			return await initialization;
		} finally {
			if (this.initializations.get(conversationId) === initialization) {
				this.initializations.delete(conversationId);
			}
		}
	}

	private async createSession(conversationId: string): Promise<AgentSession> {
		const settings = SettingsManager.inMemory(
			{ enableAnalytics: false, enableInstallTelemetry: false, defaultProjectTrust: "never" },
			{ projectTrusted: false },
		);
		const modelRuntime = await this.providers.getModelRuntime();
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.agentDir,
			agentDir: this.conversationAgentDir(conversationId),
			settingsManager: settings,
			additionalSkillPaths: this.runtimeConfig.skillPaths,
			additionalExtensionPaths: this.runtimeConfig.pluginPaths,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt:
				"You are the local Companion runtime. Use only injected Host tools for application state. " +
				"Use the read tool to load an applicable role Skill before following it. " +
				"When the user asks for real-world work, call host_propose_work with a precise plain-language scope; never claim the work started before user approval. " +
				"Never claim a state change unless its Host tool succeeded.",
			appendSystemPrompt: this.runtimeConfig.appendSystemPrompt
				? [this.runtimeConfig.appendSystemPrompt]
				: [],
		});
		await resourceLoader.reload();
		const extensionErrors = resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			this.eventBus.publish("companion.runtime_error", {
				code: "role_plugin_load_failed",
				errors: extensionErrors.map((error) => error.error),
			});
		}
		const { session } = await createAgentSession({
			cwd: this.agentDir,
			agentDir: this.conversationAgentDir(conversationId),
			modelRuntime,
			settingsManager: settings,
			resourceLoader,
			noTools: "builtin",
			customTools: [this.skillReadTool(), ...this.hostTools()],
			sessionManager: SessionManager.create(
				this.agentDir,
				this.conversationAgentDir(conversationId),
			),
		});
		// Pi builds custom-prompt skill indexes from active tool names. Rebuild
		// after custom tools register so `read` and role Skills are discoverable.
		session.setActiveToolsByName(session.getActiveToolNames());
		if (this.state !== "running") {
			session.dispose();
			throw new Error("companion stopped while initializing");
		}
		this.session = session;
		this.sessions.set(conversationId, session);
		this.modelRuntime = modelRuntime;
		this.eventBus.publish("companion.runtime_ready", {
			skills: resourceLoader.getSkills().skills.map((skill) => skill.name),
			plugins: resourceLoader.getExtensions().extensions.map((extension) => extension.path),
		});
		return session;
	}

	async stop(): Promise<void> {
		this.state = "stopped";
		for (const session of this.sessions.values()) await session.abort();
		await Promise.allSettled(this.initializations.values());
		await this.promptQueue.catch(() => undefined);
		this.session = null;
		this.modelRuntime = null;
		this.activeConversationId = null;
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.sessions.clear();
		this.initializations.clear();
		this.eventBus.publish("companion.state_changed", { state: "stopped" });
	}

	/** Dispatch Host commands to the local Pi session. */
	sendCommand(command: unknown): void {
		if (
			typeof command !== "object" ||
			command === null ||
			Array.isArray(command) ||
			!("type" in command)
		) {
			return;
		}
		if (
			command.type === "prompt" &&
			"conversationId" in command &&
			typeof command.conversationId === "string" &&
			"message" in command &&
			typeof command.message === "string"
		) {
			const conversationId = command.conversationId;
			const message = command.message;
			this.promptQueue = this.promptQueue
				.then(() => this.prompt(conversationId, message))
				.catch((error: unknown) => {
					if (this.state === "stopped") return;
					this.eventBus.publish("companion.runtime_error", {
						code: "turn_dispatch_failed",
						message: error instanceof Error ? error.message : String(error),
					});
				});
			return;
		}
		if (command.type === "abort") {
			void this.session?.abort();
			return;
		}
		this.eventBus.publish("companion.runtime_error", {
			code: "unsupported_runtime_command",
			command: command.type,
		});
	}

	get isRunning(): boolean {
		return this.state === "running";
	}

	get agentDir(): string {
		return resolve(this.userDataDir, "companion-runtime");
	}

	private conversationAgentDir(conversationId: string): string {
		return resolve(this.agentDir, "conversations", conversationId);
	}

	private async prompt(conversationId: string, message: string): Promise<void> {
		this.activeConversationId = conversationId;
		const includeHistory = !this.sessions.has(conversationId);
		let session: AgentSession;
		try {
			session = await this.initializeSession(conversationId);
		} catch (error) {
			if (this.state === "stopped") return;
			this.state = "unavailable";
			this.eventBus.publish("companion.state_changed", {
				state: "unavailable",
				error: error instanceof Error ? error.message : String(error),
			});
			this.eventBus.publish("message_end", { conversationId, failed: true });
			return;
		}
		const modelRuntime = this.modelRuntime;
		if (!modelRuntime) {
			this.eventBus.publish("companion.runtime_error", {
				conversationId,
				code: "companion_unavailable",
			});
			this.eventBus.publish("message_end", { conversationId, failed: true });
			return;
		}
		if (!(await this.selectConfiguredModel(modelRuntime, session, conversationId))) {
			this.eventBus.publish("companion.runtime_error", {
				conversationId,
				code: "provider_auth_required",
			});
			this.eventBus.publish("message_end", { conversationId, failed: true });
			return;
		}
		this.eventBus.publish("message_start", { conversationId });
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_update") return;
			const text = extractMessageText(event.message);
			if (text) this.eventBus.publish("message_update", { conversationId, text });
		});
		try {
			const context = this.contextHandler?.(conversationId, includeHistory, message).trim();
			const prompt = context
				? `<host_context>\n${context}\n</host_context>\n\n<current_user_message>\n${message}\n</current_user_message>`
				: message;
			await session.prompt(prompt, { streamingBehavior: "followUp" });
			const text = extractMessageText(session.agent.state.messages.at(-1));
			this.eventBus.publish("message_end", { conversationId, text });
		} catch (error) {
			this.eventBus.publish("companion.runtime_error", {
				conversationId,
				code: "turn_failed",
				message: error instanceof Error ? error.message : String(error),
			});
			this.eventBus.publish("message_end", { conversationId, failed: true });
		} finally {
			unsubscribe();
		}
	}

	private async selectConfiguredModel(
		modelRuntime: ModelRuntime,
		session: AgentSession,
		conversationId: string,
	): Promise<boolean> {
		const selected = this.modelSelectionHandler?.(conversationId);
		if (selected && modelRuntime.hasConfiguredAuth(selected.providerId)) {
			const model = modelRuntime
				.getModels(selected.providerId)
				.find((candidate) => candidate.id === selected.modelId);
			if (model) {
				if (session.model?.provider !== model.provider || session.model?.id !== model.id) {
					await session.setModel(model);
				}
				return true;
			}
		}
		if (session.model) return true;
		for (const provider of modelRuntime.getProviders()) {
			if (!modelRuntime.hasConfiguredAuth(provider.id)) continue;
			const model = modelRuntime.getModels(provider.id)[0];
			if (!model) continue;
			await session.setModel(model);
			return true;
		}
		return false;
	}

	private hostTools() {
		return [
			this.hostTool(
				"host_get_state",
				"Read character UI state",
				"Read the active role's permitted scenes, expressions, and current UI state.",
				toolParameters(z.strictObject({})),
			),
			this.hostTool(
				"host_set_scene",
				"Set character scene",
				"Change the active scene only after confirming a permitted scene ID with host_get_state.",
				toolParameters(z.strictObject({ sceneId: z.string().min(1).max(64) })),
			),
			this.hostTool(
				"host_set_expression",
				"Set character expression",
				"Change the active expression only after confirming a permitted visual state with host_get_state.",
				toolParameters(z.strictObject({ visualState: z.string().min(1).max(64) })),
			),
			this.hostTool(
				"host_propose_work",
				"Propose real-world work for user approval",
				"Create a plain-language action proposal when the user asks for real work. This never starts work; the user must approve the exact read, write, network and tool scope in the system UI.",
				toolParameters(
					z.strictObject({
						title: z.string().min(1).max(200),
						description: z.string().min(1).max(4000),
						reads: z.array(z.string().min(1).max(1024)).max(20).default([]),
						writes: z.array(z.string().min(1).max(1024)).max(20).default([]),
						networkAllowed: z.boolean().default(false),
						toolNames: z.array(z.string().min(1).max(64)).max(20).default([]),
					}),
				),
			),
		];
	}

	private hostTool(name: string, label: string, description: string, parameters: never) {
		return {
			name,
			label,
			description,
			promptSnippet: description,
			parameters,
			execute: async (_toolCallId: string, params: unknown) =>
				this.toolResult(await this.callHost(name, params)),
		};
	}

	private skillReadTool() {
		return {
			name: "read",
			label: "Read role Skill",
			description:
				"Read a role-specific Skill Markdown file when the skill index says it is needed.",
			parameters: toolParameters(
				z.strictObject({
					path: z.string().min(1),
					offset: z.number().int().min(1).optional(),
					limit: z.number().int().min(1).max(500).optional(),
				}),
			),
			execute: async (
				_toolCallId: string,
				params: { path: string; offset?: number; limit?: number },
			) => this.readRoleSkill(params),
		};
	}

	private async callHost(tool: string, args: unknown): Promise<CompanionHostToolResult> {
		if (!this.activeConversationId) {
			return {
				ok: false,
				code: "no_active_conversation",
				message: "Host controls are unavailable outside an active conversation.",
			};
		}
		if (!this.hostToolHandler) {
			return {
				ok: false,
				code: "host_tool_unavailable",
				message: "Host controls are unavailable.",
			};
		}
		return this.hostToolHandler({ conversationId: this.activeConversationId, tool, args });
	}

	private readRoleSkill(params: { path: string; offset?: number; limit?: number }) {
		const requested = params.path;
		const absolute = resolve(this.agentDir, requested);
		if (
			!requested ||
			!this.runtimeConfig.skillPaths.some((root) => pathInside(root, absolute)) ||
			!existsSync(absolute)
		) {
			return this.toolResult({
				ok: false,
				code: "skill_read_denied",
				message: "Only role Skill Markdown is readable.",
			});
		}
		const resolved = realpathSync(absolute);
		if (
			!this.runtimeConfig.skillPaths.some((root) => pathInside(root, resolved)) ||
			!statSync(resolved).isFile()
		) {
			return this.toolResult({
				ok: false,
				code: "skill_read_denied",
				message: "Only role Skill Markdown is readable.",
			});
		}
		const offset =
			typeof params.offset === "number" && Number.isSafeInteger(params.offset) && params.offset > 0
				? params.offset
				: 1;
		const limit =
			typeof params.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0
				? Math.min(params.limit, 500)
				: 200;
		const lines = readFileSync(resolved, "utf8").split(/\r?\n/);
		return {
			content: [
				{
					type: "text" as const,
					text: lines
						.slice(offset - 1, offset - 1 + limit)
						.map((line, index) => `${offset + index}:${line}`)
						.join("\n"),
				},
			],
			details: { path: resolved, offset },
		};
	}

	private toolResult(result: CompanionHostToolResult) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			details: result,
			...(result.ok ? {} : { isError: true }),
		};
	}
}

function toolParameters(schema: z.ZodType): never {
	return toJsonSchema(schema) as never;
}

function extractMessageText(value: unknown): string {
	if (
		!value ||
		typeof value !== "object" ||
		!("content" in value) ||
		!Array.isArray(value.content)
	) {
		return "";
	}
	return value.content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			),
		)
		.map((part) => part.text)
		.join("");
}

function pathInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath !== "" &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(relativePath)
	);
}
