import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RecallResult } from "@bear-harness/tdai-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createReadOnlyTools,
	DefaultResourceLoader,
	type ModelRuntime,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import PQueue from "p-queue";
import type { CharacterPackage } from "./character-loader.js";
import type { CompanionStateStore } from "./companion-store.js";
import { type HostToolInput, registerHostTools } from "./host-tool-register.js";
import { loadRolePluginTools } from "./role-resources.js";

type Images = NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"];
type ModelRoute = { providerId: string; modelId: string };
export interface PiRoleResources {
	appendSystemPrompt: string;
	pluginPaths: string[];
}
export type PiSnapshot = AgentSession | undefined;

export interface PiSessionEvent {
	sessionId: string;
	event: AgentSessionEvent;
}

export interface PiRuntimeOptions {
	paths: { runtime: string; sessions: string };
	models: { getModels(): Promise<ModelRuntime> };
	character(): CharacterPackage;
	store: CompanionStateStore;
	delegate: HostToolInput["delegate"];
	canon(companionId: string, query: string, limit: number): Promise<unknown>;
	memory: {
		recall(companionId: string, sessionId: string, text: string): Promise<RecallResult>;
		capture(companionId: string, sessionId: string, messages: AgentMessage[]): Promise<void>;
		search(companionId: string, query: string, limit: number): Promise<unknown>;
		searchConversations(
			companionId: string,
			sessionId: string,
			query: string,
			limit: number,
		): Promise<unknown>;
		explicit: {
			read(companionId: string): Promise<string>;
			edit(companionId: string, oldText: string | undefined, newText: string): Promise<string>;
		};
	};
	defaultModel(companionId: string): ModelRoute | undefined;
	context?(sessionId: string, message: string): string | Promise<string>;
	sessionContext?(sessionId: string): string | Promise<string>;
	titleChanged?(sessionId: string, title: string): void;
	sessionDiscarded?(sessionId: string): void;
	sessionEvent?(event: PiSessionEvent): void;
	systemPrompt?: string;
}

type OpenSession = { session: AgentSession; unsubscribe: () => void };

/** Resource registry around Pi-owned sessions. It never mirrors Pi conversation state. */
export class PiRuntime {
	private readonly sessions = new Map<string, OpenSession>();
	private readonly opening = new Map<string, Promise<AgentSession>>();
	private readonly deleting = new Map<string, Promise<void>>();
	private readonly sessionEvents = new Map<string, PQueue>();
	private readonly cwd: string;
	private readonly sessionDir: string;
	private roleResources: PiRoleResources;

	constructor(private readonly options: PiRuntimeOptions) {
		this.cwd = resolve(options.paths.runtime);
		this.sessionDir = resolve(options.paths.sessions);
		this.roleResources = { appendSystemPrompt: options.systemPrompt ?? "", pluginPaths: [] };
	}

	configure(resources: PiRoleResources): void {
		this.roleResources = {
			appendSystemPrompt: resources.appendSystemPrompt,
			pluginPaths: [...resources.pluginPaths],
		};
	}

	async list(): Promise<SessionInfo[]> {
		const found = new Map(
			(await SessionManager.list(this.cwd, this.sessionDir)).map((item) => [item.id, item]),
		);
		for (const { session } of this.sessions.values()) {
			if (found.has(session.sessionId)) continue;
			const manager = session.sessionManager;
			const created = new Date(manager.getHeader()?.timestamp ?? Date.now());
			found.set(session.sessionId, {
				path: manager.getSessionFile() ?? "",
				id: session.sessionId,
				cwd: manager.getCwd(),
				name: session.sessionName,
				created,
				modified: created,
				messageCount: 0,
				firstMessage: "",
				allMessagesText: "",
			});
		}
		return [...found.values()].sort((left, right) => +right.modified - +left.modified);
	}

	async create(name = "", beforeOpen?: (sessionId: string) => void): Promise<AgentSession> {
		const manager = SessionManager.create(this.cwd, this.sessionDir);
		if (name) manager.appendSessionInfo(name);
		beforeOpen?.(manager.getSessionId());
		return this.openManager(manager);
	}

	async open(sessionId: string): Promise<AgentSession> {
		return this.inSessionSequence(sessionId, () => this.openNow(sessionId));
	}

	snapshot(sessionId: string): PiSnapshot {
		return this.sessions.get(sessionId)?.session;
	}

	async send(sessionId: string, text: string, images?: Images): Promise<void> {
		return this.inSessionSequence(sessionId, async () => {
			const session = await this.requireSessionNow(sessionId);
			const shouldName =
				!session.sessionName && !session.messages.some(({ role }) => role === "user");
			let turn!: Promise<void>;
			await new Promise<void>((accepted, rejected) => {
				turn = session.prompt(text, {
					...(images?.length ? { images } : {}),
					streamingBehavior: "followUp",
					preflightResult: (ok) =>
						ok ? accepted() : rejected({ kind: "unavailable", reason: "pi_prompt_rejected" }),
				});
				void turn.catch(rejected);
			});
			if (shouldName)
				void turn.then(() => this.nameFirstTurn(session, text)).catch(() => undefined);
		});
	}

	async fork(sessionId: string, entryId: string): Promise<AgentSession> {
		return this.inSessionSequence(sessionId, async () => {
			const source = await this.requireSessionNow(sessionId);
			const path = source.sessionManager.createBranchedSession(entryId);
			if (!path) throw { kind: "unavailable", reason: "pi_session_not_persisted" };
			return this.openManager(SessionManager.open(path, this.sessionDir, this.cwd));
		});
	}

	async abort(sessionId: string) {
		return this.inSessionSequence(sessionId, async () =>
			(await this.requireSessionNow(sessionId)).abort(),
		);
	}

	async navigate(sessionId: string, entryId: string) {
		return this.inSessionSequence(sessionId, async () =>
			(await this.requireSessionNow(sessionId)).navigateTree(entryId, { summarize: false }),
		);
	}

	async edit(sessionId: string, entryId: string, text: string) {
		return this.inSessionSequence(sessionId, async () => {
			const session = await this.requireSessionNow(sessionId);
			const result = await session.navigateTree(entryId, { summarize: false });
			if (!result.cancelled) await session.sendUserMessage(text, { deliverAs: "followUp" });
			return result;
		});
	}

	async regenerate(sessionId: string, entryId: string, feedback?: string) {
		return this.inSessionSequence(sessionId, async () => {
			const session = await this.requireSessionNow(sessionId);
			const entry = session.sessionManager.getEntry(entryId);
			const user = entry?.parentId ? session.sessionManager.getEntry(entry.parentId) : undefined;
			if (user?.type !== "message" || user.message.role !== "user") {
				throw { kind: "not_found", reason: "pi_user_message_not_found" };
			}
			const result = await session.navigateTree(user.id, { summarize: false });
			if (result.cancelled) return result;
			if (!result.editorText) throw new Error("Pi navigation returned no user message");
			const prompt = feedback?.trim()
				? `${result.editorText}\n\n重新生成反馈：${feedback.trim()}`
				: result.editorText;
			await this.promptAccepted(session, prompt);
			return result;
		});
	}

	async continue(sessionId: string) {
		return this.inSessionSequence(sessionId, async () => {
			const turn = (await this.requireSessionNow(sessionId)).agent.continue();
			void turn.catch(() => undefined);
		});
	}

	async rename(sessionId: string, name: string): Promise<void> {
		return this.inSessionSequence(sessionId, async () => {
			const open = await this.current(sessionId);
			if (open) open.setSessionName(name);
			else (await this.loadManager(sessionId)).appendSessionInfo(name);
		});
	}

	async setModel(sessionId: string, providerId: string, modelId: string): Promise<ModelRoute> {
		return this.inSessionSequence(sessionId, async () => {
			const model = (await this.options.models.getModels()).getModel(providerId, modelId);
			if (!model) throw { kind: "not_found", reason: "configured_model_not_found" };
			await (await this.requireSessionNow(sessionId)).setModel(model);
			return { providerId: model.provider, modelId: model.id };
		});
	}

	async modelFor(sessionId: string): Promise<ModelRoute | undefined> {
		return this.inSessionSequence(sessionId, async () => {
			const open = await this.current(sessionId);
			if (open?.model) return { providerId: open.model.provider, modelId: open.model.id };
			const remembered = (await this.loadManager(sessionId)).buildSessionContext().model;
			return remembered
				? { providerId: remembered.provider, modelId: remembered.modelId }
				: this.options.defaultModel(this.options.character().id);
		});
	}

	async deliverExternalResult(sessionId: string, runId: string, content: string) {
		return this.inSessionSequence(sessionId, async () => {
			const session = await this.requireSessionNow(sessionId);
			const existing = session.sessionManager
				.getEntries()
				.find((entry) => isExternalResult(entry, runId));
			if (existing) return { entryId: existing.id };
			await session.sendCustomMessage(
				{
					customType: "host_external_agent_result",
					content,
					display: true,
					details: { runId },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return { entryId: session.sessionManager.getLeafId() ?? runId };
		});
	}

	async close(sessionId: string): Promise<void> {
		return this.inSessionSequence(sessionId, () => this.closeNow(sessionId));
	}

	private async closeNow(sessionId: string): Promise<void> {
		const session = await this.current(sessionId).catch(() => undefined);
		if (!session) return;
		const discarded = Boolean(session.sessionFile && !existsSync(session.sessionFile));
		const handle = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		try {
			await session.abort();
		} finally {
			handle?.unsubscribe();
			session.dispose();
			if (discarded) this.options.sessionDiscarded?.(sessionId);
		}
	}

	async closeAll(): Promise<void> {
		const ids = new Set([...this.sessions.keys(), ...this.opening.keys()]);
		await Promise.all([
			...this.deleting.values(),
			...[...ids].filter((id) => !this.deleting.has(id)).map((id) => this.close(id)),
		]);
	}

	async delete(sessionId: string, remove: () => void | Promise<void>): Promise<void> {
		const pending = this.deleting.get(sessionId);
		if (pending) return pending;
		const deletion = (async () => {
			await this.inSessionSequence(
				sessionId,
				async () => {
					await this.closeNow(sessionId);
					await remove();
				},
				true,
			);
		})().finally(() => this.deleting.delete(sessionId));
		this.deleting.set(sessionId, deletion);
		return deletion;
	}

	requireAvailable(sessionId: string): void {
		if (this.deleting.has(sessionId)) {
			throw { kind: "unavailable", reason: "pi_session_deleting" };
		}
	}

	private async loadManager(sessionId: string): Promise<SessionManager> {
		const match = (await SessionManager.list(this.cwd, this.sessionDir)).find(
			(item) => item.id === sessionId,
		);
		if (!match?.path) throw { kind: "not_found", reason: "pi_session_not_found" };
		return SessionManager.open(match.path, this.sessionDir, this.cwd);
	}

	private async requireSessionNow(sessionId: string): Promise<AgentSession> {
		const open = await this.current(sessionId);
		if (open) return open;
		return this.openNow(sessionId);
	}

	private async openNow(sessionId: string): Promise<AgentSession> {
		const current = await this.current(sessionId);
		return current ?? this.openManager(await this.loadManager(sessionId));
	}

	private async promptAccepted(session: AgentSession, text: string): Promise<void> {
		let turn!: Promise<void>;
		await new Promise<void>((accepted, rejected) => {
			turn = session.prompt(text, {
				streamingBehavior: "followUp",
				preflightResult: (ok) =>
					ok ? accepted() : rejected({ kind: "unavailable", reason: "pi_prompt_rejected" }),
			});
			void turn.catch(rejected);
		});
	}

	private async inSessionSequence<T>(
		sessionId: string,
		run: () => T | Promise<T>,
		allowDeleting = false,
	): Promise<T> {
		if (!allowDeleting) this.requireAvailable(sessionId);
		const queue = this.sessionEvents.get(sessionId) ?? new PQueue({ concurrency: 1 });
		this.sessionEvents.set(sessionId, queue);
		try {
			const result = await queue.add(async () => {
				if (!allowDeleting) this.requireAvailable(sessionId);
				return run();
			});
			return result as T;
		} finally {
			if (queue.pending === 0 && queue.size === 0) this.sessionEvents.delete(sessionId);
		}
	}

	private current(sessionId: string): Promise<AgentSession | undefined> {
		return Promise.resolve(this.sessions.get(sessionId)?.session ?? this.opening.get(sessionId));
	}

	private async openManager(manager: SessionManager): Promise<AgentSession> {
		const id = manager.getSessionId();
		const current = this.sessions.get(id)?.session;
		if (current) return current;
		const pending = this.opening.get(id);
		if (pending) return pending;
		const opening = this.buildSession(manager)
			.then((session) => {
				const unsubscribe = session.subscribe((event) => {
					try {
						this.options.sessionEvent?.({ sessionId: id, event });
					} catch {
						// A UI transport cannot interrupt Pi's event loop.
					}
				});
				this.sessions.set(id, { session, unsubscribe });
				return session;
			})
			.finally(() => this.opening.delete(id));
		this.opening.set(id, opening);
		return opening;
	}

	private async buildSession(manager: SessionManager): Promise<AgentSession> {
		const models = await this.options.models.getModels();
		const character = this.options.character();
		const companionId = character.id;
		const sessionId = manager.getSessionId();
		let session!: AgentSession;
		const settings = SettingsManager.create(this.cwd, this.cwd);
		const explicitMemory = (await this.options.memory.explicit.read(companionId)).trim();
		const sessionContext = (await this.options.sessionContext?.(sessionId))?.trim();
		const baseSystemPrompt = [
			this.roleResources.appendSystemPrompt,
			sessionContext,
			explicitMemory ? `<explicit_memory>\n${explicitMemory}\n</explicit_memory>` : undefined,
		]
			.filter((value): value is string => Boolean(value?.trim()))
			.join("\n\n");
		const loader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.cwd,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: baseSystemPrompt,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						const recall = await this.options.memory.recall(companionId, sessionId, event.prompt);
						const additions = [
							await this.options.context?.(sessionId, event.prompt),
							recall.appendSystemContext,
							recall.prependContext,
						].filter((value): value is string => Boolean(value?.trim()));
						if (!additions.length) return;
						return {
							systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}`,
						};
					});
					pi.on("agent_settled", () => {
						return this.options.memory.capture(companionId, sessionId, session.messages);
					});
				},
			],
		});
		await loader.reload();
		const tools = {
			...Object.fromEntries(createReadOnlyTools(this.cwd).map((tool) => [tool.name, tool])),
			...registerHostTools({
				sessionId: () => sessionId,
				entryId: () => manager.getLeafId() ?? sessionId,
				character: () => character,
				store: this.options.store,
				delegate: this.options.delegate,
				canon: (query, limit) => this.options.canon(companionId, query, limit),
				memorySearch: (query, limit) => this.options.memory.search(companionId, query, limit),
				conversationSearch: (query, limit) =>
					this.options.memory.searchConversations(companionId, sessionId, query, limit),
				explicitMemory: {
					read: () => this.options.memory.explicit.read(companionId),
					edit: (oldText, newText) =>
						this.options.memory.explicit.edit(companionId, oldText, newText),
				},
			}),
		};
		const pluginTools = await loadRolePluginTools(this.roleResources.pluginPaths);
		for (const tool of pluginTools) {
			if (tool.name in tools)
				throw new Error(`role plugin tool conflicts with Host tool: ${tool.name}`);
		}
		const allTools = [...Object.values(tools), ...pluginTools];
		const remembered = manager.buildSessionContext().model;
		const route = remembered
			? { providerId: remembered.provider, modelId: remembered.modelId }
			: this.options.defaultModel(companionId);
		const model = route && models.getModel(route.providerId, route.modelId);
		if (!model) throw { kind: "unavailable", reason: "provider_auth_required" };
		const created = await createAgentSession({
			cwd: this.cwd,
			agentDir: this.cwd,
			modelRuntime: models,
			model,
			sessionManager: manager,
			settingsManager: settings,
			resourceLoader: loader,
			customTools: allTools,
			tools: allTools.map((tool) => tool.name),
		});
		session = created.session;
		return session;
	}

	private async nameFirstTurn(session: AgentSession, text: string): Promise<void> {
		const model = session.model;
		if (!model || session.sessionName) return;
		const result = await session.modelRuntime.completeSimple(
			model,
			{
				systemPrompt:
					"Write a concise title in the user's language. Return only the title, without quotes.",
				messages: [{ role: "user", content: text, timestamp: Date.now() }],
			},
			{ maxTokens: 40, reasoning: "minimal" },
		);
		const title = result.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("")
			.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
			.replace(/[\r\n]+/g, " ")
			.trim()
			.slice(0, 80);
		if (!title || session.sessionName) return;
		session.setSessionName(title);
		this.options.titleChanged?.(session.sessionId, title);
	}
}

function isExternalResult(entry: SessionEntry, runId: string): boolean {
	return (
		entry.type === "custom_message" &&
		entry.customType === "host_external_agent_result" &&
		typeof entry.details === "object" &&
		entry.details !== null &&
		"runId" in entry.details &&
		entry.details.runId === runId
	);
}
