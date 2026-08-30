import { resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	AgentSession,
	createReadOnlyTools,
	DefaultResourceLoader,
	type ModelRuntime,
	type SessionInfo,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CharacterPackage } from "./character-loader.js";
import type { CompanionStateStore } from "./companion-store.js";
import { registerHostTools } from "./host-tool-register.js";

type Images = NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"];
export type PiSnapshot = ReturnType<PiRuntime["snapshot"]>;
export interface PiRuntimeOptions {
	dataDir: string;
	models: { getModels(): Promise<ModelRuntime> };
	character(): CharacterPackage;
	store: CompanionStateStore;
	delegate(params: {
		conversationId: string;
		triggerEntryId: string;
		agent: "pi" | "codex";
		inputPaths: string[];
		instruction: string;
	}): Promise<{ runId: string; status: "enqueued" | "running" }>;
	history(query: string, limit: number): Promise<unknown>;
	canon(query: string, limit: number): Promise<unknown>;
	memory(query: string, limit: number): Promise<unknown>;
	defaultModel(): { providerId: string; modelId: string } | undefined;
	context?(sessionId: string, message: string): string | Promise<string>;
	titleChanged?(sessionId: string, title: string): void;
	changed?(sessionId: string): void;
	systemPrompt?: string;
}

/** One Pi-owned active AgentSession; every operation delegates to Pi public APIs. */
export class PiRuntime {
	private session?: AgentSession;
	private modelRuntime?: ModelRuntime;
	private systemPrompt = "";

	constructor(private readonly options: PiRuntimeOptions) {
		this.systemPrompt = options.systemPrompt ?? "";
	}

	configure(systemPrompt: string): void {
		this.systemPrompt = systemPrompt;
	}

	async list() {
		const sessions = await SessionManager.list(this.cwd, this.sessionDir);
		const active = this.session?.sessionManager;
		if (!active || sessions.some(({ id }) => id === active.getSessionId())) return sessions;
		const header = active.getHeader();
		const entries = active.getEntries();
		const messages = entries.filter((entry) => entry.type === "message");
		const text = messages.map(({ message }) => messageText(message));
		const firstUser = messages.find(({ message }) => message.role === "user");
		const created = new Date(header?.timestamp ?? Date.now());
		const modified = new Date(entries.at(-1)?.timestamp ?? created);
		const current: SessionInfo = {
			path: active.getSessionFile() ?? "",
			id: active.getSessionId(),
			cwd: active.getCwd(),
			name: active.getSessionName(),
			created,
			modified,
			messageCount: messages.length,
			firstMessage: firstUser ? messageText(firstUser.message) : "",
			allMessagesText: text.join(" "),
		};
		return [current, ...sessions];
	}

	async create(name = "", beforeOpen?: (sessionId: string) => void) {
		const manager = SessionManager.create(this.cwd, this.sessionDir);
		if (name) manager.appendSessionInfo(name);
		beforeOpen?.(manager.getSessionId());
		await this.open(manager);
		return this.snapshot()!;
	}

	async select(sessionId: string) {
		if (this.session?.sessionManager.getSessionId() === sessionId) return this.snapshot()!;
		const match = (await this.list()).find((item) => item.id === sessionId);
		if (!match) throw { kind: "not_found", reason: "pi_session_not_found" };
		await this.open(SessionManager.open(match.path, this.sessionDir, this.cwd));
		return this.snapshot()!;
	}

	snapshot() {
		const session = this.session;
		if (!session) return undefined;
		return {
			sessionId: session.sessionManager.getSessionId(),
			name: session.sessionManager.getSessionName() ?? "",
			entries: session.sessionManager.buildContextEntries(),
			messages: session.messages,
			isIdle: session.isIdle,
			isStreaming: session.isStreaming,
			streamingMessage: session.state.streamingMessage,
			errorMessage: session.state.errorMessage,
			pendingMessageCount: session.pendingMessageCount,
			steeringMessages: [...session.getSteeringMessages()],
			followUpMessages: [...session.getFollowUpMessages()],
		};
	}

	async send(text: string, images?: Images) {
		const session = this.requireSession();
		const shouldName =
			!session.sessionManager.getSessionName() &&
			!session.messages.some((message) => message.role === "user");
		let accepted!: () => void;
		let rejected!: (reason: unknown) => void;
		let preflightSettled = false;
		const preflight = new Promise<void>((resolve, reject) => {
			accepted = () => {
				preflightSettled = true;
				resolve();
			};
			rejected = (reason) => {
				preflightSettled = true;
				reject(reason);
			};
		});
		const turn = session.prompt(text, {
			...(images?.length ? { images } : {}),
			streamingBehavior: "followUp",
			preflightResult: (ok) => {
				if (ok) accepted();
				else
					rejected({
						kind: "unavailable",
						reason: "pi_prompt_rejected",
					});
			},
		});
		void turn
			.then(() => (shouldName ? this.nameFirstTurn(session, text) : undefined))
			.catch((cause) => {
				if (!preflightSettled) rejected(cause);
			});
		await preflight;
	}

	async fork(entryId: string) {
		const path = this.requireSession().sessionManager.createBranchedSession(entryId);
		if (!path) throw { kind: "unavailable", reason: "pi_session_not_persisted" };
		await this.open(SessionManager.open(path, this.sessionDir, this.cwd));
		return this.snapshot()!;
	}

	abort() {
		return this.requireSession().abort();
	}

	async navigate(entryId: string) {
		return this.requireSession().navigateTree(entryId, { summarize: false });
	}

	async edit(entryId: string, text: string) {
		const session = this.requireSession();
		const result = await session.navigateTree(entryId, { summarize: false });
		if (result.cancelled) return result;
		await session.sendUserMessage(text, { deliverAs: "followUp" });
		return result;
	}

	async regenerate(entryId: string) {
		const session = this.requireSession();
		const entry = session.sessionManager.getEntry(entryId);
		const user = entry?.parentId ? session.sessionManager.getEntry(entry.parentId) : undefined;
		if (!user || user.type !== "message" || user.message.role !== "user")
			throw { kind: "not_found", reason: "pi_user_message_not_found" };
		const result = await session.navigateTree(user.id, { summarize: false });
		if (result.cancelled) return result;
		if (!result.editorText) throw new Error("Pi navigation returned no user message to regenerate");
		await session.prompt(result.editorText);
		return result;
	}

	continue() {
		return this.requireSession().agent.continue();
	}

	setName(name: string) {
		this.requireSession().setSessionName(name);
	}

	async setModel(providerId: string, modelId: string) {
		let runtime = this.modelRuntime ?? (await this.options.models.getModels());
		let model = runtime.getModel(providerId, modelId);
		if (!model) {
			runtime = await this.options.models.getModels();
			this.modelRuntime = runtime;
			model = runtime.getModel(providerId, modelId);
		}
		if (!model) throw { kind: "not_found", reason: "configured_model_not_found" };
		await this.requireSession().setModel(model);
		return { providerId: model.provider, modelId: model.id };
	}

	async modelFor(sessionId: string) {
		const active = this.session;
		if (active?.sessionManager.getSessionId() === sessionId) {
			const model = active.model;
			return model
				? { providerId: model.provider, modelId: model.id }
				: this.options.defaultModel();
		}
		const match = (await this.list()).find((item) => item.id === sessionId);
		if (!match?.path) throw { kind: "not_found", reason: "pi_session_not_found" };
		const remembered = SessionManager.open(
			match.path,
			this.sessionDir,
			this.cwd,
		).buildSessionContext().model;
		return remembered
			? { providerId: remembered.provider, modelId: remembered.modelId }
			: this.options.defaultModel();
	}

	async deliverExternalResult(runId: string, content: string) {
		const session = this.requireSession();
		await session.sendCustomMessage(
			{
				customType: "host_external_agent_result",
				content,
				display: true,
				details: { runId },
			},
			{ triggerTurn: false },
		);
		return { entryId: session.sessionManager.getLeafId() ?? runId };
	}

	async close() {
		if (!this.session) return;
		await this.session.abort();
		this.session.dispose();
		this.session = undefined;
	}

	private async open(manager: SessionManager) {
		if (this.session) {
			await this.session.abort();
			this.session.dispose();
		}
		const runtime = await this.options.models.getModels();
		this.modelRuntime = runtime;
		const settings = SettingsManager.create(this.cwd, this.agentDir);
		const loader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: this.systemPrompt,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						const context = await this.options.context?.(manager.getSessionId(), event.prompt);
						return context ? { systemPrompt: `${event.systemPrompt}\n\n${context}` } : undefined;
					});
				},
			],
		});
		await loader.reload();
		let session!: AgentSession;
		const tools = {
			...Object.fromEntries(createReadOnlyTools(this.cwd).map((tool) => [tool.name, tool])),
			...registerHostTools({
				sessionId: () => manager.getSessionId(),
				entryId: () => manager.getLeafId() ?? manager.getSessionId(),
				character: this.options.character,
				store: this.options.store,
				delegate: this.options.delegate,
				history: this.options.history,
				canon: this.options.canon,
				memory: this.options.memory,
			}),
		};
		const remembered = manager.buildSessionContext().model;
		const route = remembered
			? { providerId: remembered.provider, modelId: remembered.modelId }
			: this.options.defaultModel();
		const model = route && runtime.getModel(route.providerId, route.modelId);
		if (!model) throw { kind: "unavailable", reason: "provider_auth_required" };
		const agent = new Agent({
			streamFn: runtime.streamSimple.bind(runtime),
			initialState: {
				systemPrompt: "",
				tools: [],
				messages: manager.buildSessionContext().messages,
				...(remembered ? { model } : {}),
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: settings,
			cwd: this.cwd,
			resourceLoader: loader,
			modelRuntime: runtime,
			baseToolsOverride: tools,
			initialActiveToolNames: Object.keys(tools),
		});
		session.subscribe((event) => {
			if (event.type !== "message_update") this.options.changed?.(manager.getSessionId());
		});
		if (!remembered) await session.setModel(model);
		this.session = session;
	}

	private requireSession() {
		if (!this.session) throw { kind: "unavailable", reason: "pi_session_missing" };
		return this.session;
	}

	private async nameFirstTurn(session: AgentSession, userText: string) {
		if (session.sessionManager.getSessionName()) return;
		const model = session.model;
		if (!model || !this.modelRuntime) return;
		try {
			const result = await this.modelRuntime.completeSimple(
				model,
				{
					systemPrompt:
						"Write a concise ChatGPT-style title for this conversation in the user's language. Return only the title, without quotes or punctuation commentary.",
					messages: [{ role: "user", content: userText, timestamp: Date.now() }],
				},
				{ maxTokens: 40, reasoning: "minimal" },
			);
			const title = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("")
				.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
				.replace(/[\r\n]+/g, " ")
				.trim()
				.slice(0, 80);
			if (title && !session.sessionManager.getSessionName()) {
				session.setSessionName(title);
				this.options.titleChanged?.(session.sessionManager.getSessionId(), title);
			}
		} catch {
			// Pi's firstMessage remains the visible title until a later explicit rename.
		}
	}

	private get cwd() {
		return resolve(this.options.dataDir, "companion-runtime");
	}
	private get agentDir() {
		return resolve(this.options.dataDir, "companion-runtime");
	}
	private get sessionDir() {
		return resolve(this.options.dataDir, "sessions");
	}
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
				? String(part.text)
				: "",
		)
		.join("\n");
}
