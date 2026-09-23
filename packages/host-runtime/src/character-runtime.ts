import type { LivePush } from "@bear-harness/protocol";
import { CacheKey } from "@bear-harness/protocol/schema";
import type { MemoryTdaiConfig } from "@bear-harness/tdai-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import { ArtifactStore } from "./artifacts/index.js";
import { awaitSource } from "./await-source.js";
import { CanonHubService } from "./canon/service.js";
import type { CharacterLoader, CharacterPackage } from "./companion/character-loader.js";
import { CompanionStateStore } from "./companion/companion-store.js";
import { ContextPackCompiler } from "./companion/context-pack.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { projectPiTransientEvent } from "./companion/pi-live-events.js";
import { PiRuntime } from "./companion/pi-runtime.js";
import { SessionCatalog } from "./companion/session-catalog.js";
import { CharacterTrace } from "./diagnostics/character-trace.js";
import { CodexAdapter } from "./executors/codex-adapter.js";
import { CustomAcpAdapter } from "./executors/custom-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { RunnerProfiles } from "./executors/profiles.js";
import { ExecutorRouter } from "./executors/router.js";
import {
	ExternalAgentRunService,
	externalAgentResultMessage,
	type TerminalRunResult,
} from "./external-agents/run-service.js";
import { createMemoryDiagnosticsLogger } from "./memory/diagnostics.js";
import { ExplicitMemoryFile } from "./memory/explicit-memory.js";
import type { DeepPartial } from "./memory/tencentdb-runtime.js";
import { namespaceFor, TencentDbRuntime } from "./memory/tencentdb-runtime.js";
import { ModelRegistry } from "./models/registry.js";
import type { ProviderCatalog } from "./providers/catalog.js";
import type { CredentialStore } from "./providers/credential-store.js";
import { AuditStore } from "./security/audit-store.js";
import type { AppSettingsStore } from "./storage/app-settings-store.js";
import type { CompanionStorageHandle } from "./storage/companion-storage.js";
import type { AppDatabase } from "./storage/database.js";
import { InvalidationHub } from "./storage/invalidation-hub.js";
import { characterMemorySettings, conversations } from "./storage/schema.js";

export interface CharacterRuntimeOptions {
	systemLaunchId?: string;
	dataRoot: string;
	systemProviderDir: string;
	storage: CompanionStorageHandle;
	systemDb: AppDatabase;
	systemInvalidations: InvalidationHub;
	characterLoader: CharacterLoader;
	providers: ProviderCatalog;
	credentials: CredentialStore;
	appSettings: AppSettingsStore;
	forEachCompanionDatabase(visit: (database: AppDatabase) => void): void;
	memoryScope: { readonly installationId: string; readonly userId: string };
	memoryConfig(): DeepPartial<MemoryTdaiConfig> | undefined;
	piWorkerPath?: string;
	bundledGit?: { shellPath: string; pathEntries: string[] };
	logger?: { debug?: (message: string) => void; warn?: (message: string) => void };
	onLivePush(event: LivePush): void;
}

/** All mutable state and live resources owned by exactly one character. */
export class CharacterRuntime {
	readonly companionId: string;
	readonly invalidations: InvalidationHub;
	readonly artifacts: ArtifactStore;
	readonly models: ModelRegistry;
	readonly companionStore: CompanionStateStore;
	readonly onboarding: FirstMeetingMachine;
	readonly canon: CanonHubService;
	readonly pi: PiRuntime;
	readonly sessions: SessionCatalog;
	readonly externalAgentRuns: ExternalAgentRunService;
	readonly auditStore: AuditStore;
	readonly diagnostics: CharacterTrace;
	private readonly explicitMemoryFile: ExplicitMemoryFile;
	private memory?: TencentDbRuntime;
	private readonly memoryCaptures = new Map<string, Set<Promise<void>>>();
	private unsubscribeRunChanges?: () => void;
	private closed = false;
	private readonly lifetime = new AbortController();
	private stopping?: Promise<void>;
	private closing?: Promise<void>;
	get signal(): AbortSignal {
		return this.lifetime.signal;
	}

	constructor(private readonly options: CharacterRuntimeOptions) {
		const { database, paths } = options.storage;
		const db = database.orm;
		const character = this.character();
		this.companionId = character.id;
		this.diagnostics = new CharacterTrace(
			paths.diagnostics,
			character.id,
			() => options.appSettings.loadDiagnostics(),
			options.systemLaunchId,
		);
		this.explicitMemoryFile = new ExplicitMemoryFile(
			options.dataRoot,
			options.memoryScope.userId,
			character.id,
		);
		this.invalidations = new InvalidationHub({ scope: "character", characterId: character.id });
		this.artifacts = new ArtifactStore(db, paths.artifacts);
		this.models = new ModelRegistry(
			options.systemDb,
			db,
			this.invalidations,
			options.appSettings,
			options.forEachCompanionDatabase,
			options.systemInvalidations,
		);
		this.companionStore = new CompanionStateStore(db);
		this.companionStore.reconcileSchema(character.id, character.state);
		this.onboarding = new FirstMeetingMachine(db, options.characterLoader);
		this.canon = new CanonHubService(
			db,
			this.artifacts,
			this.invalidations,
			() => this.memoryRuntime.getEmbeddingService(),
			database,
		);
		const contextPack = new ContextPackCompiler(
			db,
			options.characterLoader,
			this.canon,
			this.companionStore,
		);
		const runnerProfiles = new RunnerProfiles(options.systemDb, options.credentials);
		this.pi = new PiRuntime({
			runners: () => runnerProfiles.catalog(),
			paths: { runtime: paths.root, sessions: paths.sessions },
			models: options.providers,
			character: () => this.character(),
			store: this.companionStore,
			delegate: (params) => {
				this.pi.requireAvailable(params.conversationId);
				return this.externalAgentRuns.delegate(params);
			},
			runRead: async (conversationId, runId) => {
				this.pi.requireAvailable(conversationId);
				if (runId) {
					this.externalAgentRuns.assertConversationRun(conversationId, runId);
					return this.externalAgentRuns.getDetail(runId);
				}
				return this.externalAgentRuns.listPage(this.companionId, { conversationId });
			},
			runControl: async (conversationId, request) => {
				this.pi.requireAvailable(conversationId);
				this.externalAgentRuns.assertConversationRun(conversationId, request.runId);
				const { runId, instruction } = request;
				switch (request.action) {
					case "steer":
						if (!instruction)
							throw { kind: "validation_failed", reason: "external_agent_instruction_invalid" };
						return this.externalAgentRuns.steerRun(runId, instruction);
					case "interrupt":
						return this.externalAgentRuns.project(await this.externalAgentRuns.interruptRun(runId));
					case "resume":
						return this.externalAgentRuns.project(
							await this.externalAgentRuns.resumeRun(runId, instruction),
						);
					case "cancel":
						return this.externalAgentRuns.project(await this.externalAgentRuns.cancelRun(runId));
					case "retryDelivery":
						return this.externalAgentRuns.project(
							await this.externalAgentRuns.retryDelivery(runId),
						);
				}
			},
			canon: async (_companionId, query, limit, moduleId) =>
				this.canon.retrieve(this.companionId, query, { limit, moduleId, includeAdjacent: false }),
			memory: {
				enabled: () => this.memoryEnabled(),
				recall: async (_companionId, sessionId, userText) => {
					if (!this.memoryEnabled()) return {};
					return this.diagnostics.operation(
						"memory.recall",
						{ conversationId: sessionId },
						{ userText },
						async () => (await this.startMemory()).recall(userText, this.memoryNamespace),
					);
				},
				capture: async (_companionId, sessionId, messages) => {
					if (!this.memoryEnabled()) return;
					const pending = this.memoryCaptures.get(sessionId) ?? new Set<Promise<void>>();
					this.memoryCaptures.set(sessionId, pending);
					const capture = this.diagnostics.operation(
						"memory.capture",
						{ conversationId: sessionId },
						undefined,
						async () => {
							await (await this.startMemory()).captureTurn({
								userText: messageTextForRole(messages, "user"),
								assistantText: messageTextForRole(messages, "assistant"),
								messages,
								sessionKey: this.memoryNamespace,
								sessionId,
							});
						},
					);
					pending.add(capture);
					try {
						await capture;
					} finally {
						pending.delete(capture);
						if (!pending.size) this.memoryCaptures.delete(sessionId);
					}
				},
				drain: async (sessionId) => {
					await Promise.allSettled(this.memoryCaptures.get(sessionId) ?? []);
				},
				search: async (_companionId, query, limit) => {
					this.requireMemoryEnabled();
					return this.diagnostics.operation("memory.search", {}, { query, limit }, async () =>
						(await this.startMemory()).searchMemories(query, limit),
					);
				},
				searchConversations: async (_companionId, sessionId, query, limit) => {
					this.requireMemoryEnabled();
					return this.diagnostics.operation(
						"memory.conversation_search",
						{ conversationId: sessionId },
						{ query, limit },
						async () =>
							(await this.startMemory()).searchConversations(query, this.memoryNamespace, limit),
					);
				},
				explicit: {
					read: () => this.explicitMemory(this.companionId).read(),
					edit: (_companionId, oldText, newText) => {
						return this.explicitMemory(this.companionId).edit(oldText, newText);
					},
				},
			},
			defaultModel: () =>
				this.models.defaults(this.companionId, options.providers.modelProjectionFacts()).reply,
			defaultThinkingLevel: () =>
				this.models.defaults(this.companionId, options.providers.modelProjectionFacts())
					.thinkingLevel,
			multimodalFallback: () =>
				this.models.multimodalFallback(options.providers.modelProjectionFacts()),
			sessionDiscarded: (sessionId) =>
				db.delete(conversations).where(eq(conversations.id, sessionId)).run(),
			context: (conversationId, message) =>
				this.diagnostics.operation("pi.context.turn", { conversationId }, undefined, async () => {
					const context = await contextPack.compileForTurn(conversationId, { canonQuery: message });
					return contextPack.render(context);
				}),
			sessionContext: (conversationId) =>
				this.diagnostics.operation("pi.context.session", { conversationId }, undefined, async () =>
					contextPack.sessionContext(conversationId),
				),
			titleChanged: () => this.invalidations.invalidate(CacheKey.conversations()),
			sessionActivity: (event) => options.onLivePush({ ...event, characterId: this.companionId }),
			sessionEvent: (sessionId, nativeEvent, version) => {
				this.diagnostics.native(sessionId, nativeEvent);
				const event = projectPiTransientEvent(nativeEvent);
				if (!event) return;
				// Pi notifies message_end listeners before appending to SessionManager.
				// Defer all events alike to preserve order and expose post-append snapshots.
				queueMicrotask(() => {
					try {
						options.onLivePush({
							type: "pi",
							characterId: this.companionId,
							conversationId: sessionId,
							event,
							version,
						});
						this.diagnostics.emit(
							"transport.pi.published",
							"trace",
							{ version },
							{ conversationId: sessionId },
						);
					} catch {
						// A UI transport cannot interrupt Pi's event loop.
					}
				});
			},
		});
		seedPiAcpProfile(options.systemDb);
		const executorRouter = new ExecutorRouter(options.systemDb);
		executorRouter.register(
			"pi",
			new PiAcpAdapter(db, options.systemProviderDir, options.piWorkerPath, options.bundledGit),
		);
		executorRouter.register("codex", new CodexAdapter(options.systemDb, db, this.invalidations));
		executorRouter.register("custom", new CustomAcpAdapter(runnerProfiles, db));
		this.externalAgentRuns = new ExternalAgentRunService(
			db,
			executorRouter,
			this.artifacts,
			paths.runs,
			async (conversationId, pinned) => {
				const route = pinned ?? (await this.pi.modelFor(conversationId));
				if (!route) return undefined;
				const stored = await options.credentials.get(route.providerId);
				const credential =
					stored?.piCredential ??
					(stored?.apiKey ? { type: "api_key" as const, key: stored.apiKey } : undefined);
				return { ...route, ...(credential ? { credential } : {}) };
			},
			async ({ run, needsResultReport }: TerminalRunResult, signal) => {
				await this.diagnostics.operation(
					"run.delivery",
					{ runId: run.id, conversationId: run.conversationId },
					{ needsResultReport },
					() =>
						awaitSource(
							this.pi.deliverExternalResult(
								run.conversationId,
								run.id,
								externalAgentResultMessage({ run }),
							),
							signal,
						),
				);
				return { resultReported: needsResultReport };
			},
			undefined,
			(runId, conversationId, event) =>
				this.diagnostics.emit(
					`executor.${event.type}`,
					"debug",
					{},
					{ runId, conversationId },
					event,
					{ traceId: runId.replaceAll("-", ""), spanId: runId.replaceAll("-", "").slice(0, 16) },
				),
		);
		this.unsubscribeRunChanges = this.externalAgentRuns.subscribeChanges((run) => {
			this.diagnostics.protect(
				run.id.replaceAll("-", ""),
				["enqueued", "running", "needs_user", "interrupted"].includes(run.status),
			);
			this.diagnostics.emit(
				"run.changed",
				run.status === "failed" || run.status === "forced_termination" ? "error" : "info",
				{ status: run.status },
				{ runId: run.id, conversationId: run.conversationId },
				run,
				{ traceId: run.id.replaceAll("-", ""), spanId: run.id.replaceAll("-", "").slice(0, 16) },
			);
			options.onLivePush({ type: "run", characterId: this.companionId, run });
		});
		this.sessions = new SessionCatalog(db, this.pi, this.companionStore, {
			beforeDelete: (sessionId) => this.externalAgentRuns.prepareConversationDeletion(sessionId),
			artifacts: this.artifacts,
		});

		this.auditStore = new AuditStore({ dir: paths.audit, logger: options.logger });
		this.onboarding.initialize(this.companionId);
		this.canon.syncPackage(this.companionId, character.canon);
		const trust = options.characterLoader.pluginTrust(options.systemDb, character);
		this.pi.configure(options.characterLoader.piResources(character, trust.trusted));
	}

	get db() {
		return this.options.storage.database;
	}

	get memoryRuntime(): TencentDbRuntime {
		if (this.lifetime.signal.aborted)
			throw { kind: "unavailable", reason: "character_runtime_closing" };
		if (!this.memory) {
			this.memory = new TencentDbRuntime({
				dataDir: this.options.storage.paths.tdaiMemory,
				providers: this.options.providers,
				models: this.models,
				companionId: this.companionId,
				installationId: this.options.memoryScope.installationId,
				userId: this.options.memoryScope.userId,
				memoryConfig: this.options.memoryConfig(),
				diagnostics: this.diagnostics,
				logger: createMemoryDiagnosticsLogger(this.diagnostics),
			});
		}
		return this.memory;
	}

	async resetMemory(): Promise<void> {
		const current = this.memory;
		await current?.close();
		if (this.memory === current) this.memory = undefined;
	}

	async recoverExternalRuns(): Promise<number> {
		return this.externalAgentRuns.recoverUnfinishedRuns();
	}

	stop(): Promise<void> {
		this.lifetime.abort();
		if (this.stopping) return this.stopping;
		this.stopping = (async () => {
			const results = await Promise.allSettled([
				this.externalAgentRuns.close(),
				this.pi.shutdown(),
				this.artifacts.close(),
			]);
			const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
			if (errors.length) throw new AggregateError(errors, "character producers failed to stop");
		})().catch((error) => {
			this.stopping = undefined;
			throw error;
		});
		return this.stopping;
	}
	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.closing) return this.closing;
		this.closing = (async () => {
			await this.stop();
			await this.memory?.close();
			await this.auditStore.flush();
			await this.diagnostics.close();
			this.unsubscribeRunChanges?.();
			this.closed = true;
		})().finally(() => {
			this.closing = undefined;
		});
		return this.closing;
	}
	get relationshipMemoryEnabled(): boolean {
		return (
			this.options.appSettings.load().memoryVectorService.enabled &&
			this.db.orm
				.select()
				.from(characterMemorySettings)
				.where(eq(characterMemorySettings.id, 1))
				.get()?.enabled === true
		);
	}

	private async startMemory(): Promise<TencentDbRuntime> {
		const memory = this.memoryRuntime;
		await memory.start();
		return memory;
	}

	private character(): CharacterPackage {
		const character = this.options.characterLoader.load(this.options.storage.paths.id);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		return character;
	}

	private explicitMemory(companionId: string) {
		if (companionId !== this.companionId)
			throw { kind: "not_found", reason: "character_runtime_mismatch" };
		return this.explicitMemoryFile;
	}

	private get memoryNamespace() {
		return namespaceFor({ ...this.options.memoryScope, companionId: this.companionId });
	}

	private memoryEnabled(): boolean {
		return !this.signal.aborted && this.relationshipMemoryEnabled;
	}

	private requireMemoryEnabled(): void {
		if (!this.memoryEnabled()) throw { reason: "relationship_memory_disabled" };
	}
}

function messageTextForRole(messages: AgentMessage[], role: "user" | "assistant"): string {
	return messages
		.filter((message) => message.role === role && "content" in message)
		.map((message) => messageText("content" in message ? message.content : ""))
		.join("\n");
}

function messageText(content: unknown): string {
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
