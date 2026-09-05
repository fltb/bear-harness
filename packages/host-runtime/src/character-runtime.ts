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
import { CodexAdapter } from "./executors/codex-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { ExecutorRouter } from "./executors/router.js";
import {
	ExternalAgentRunService,
	externalAgentResultMessage,
	type TerminalRunResult,
} from "./external-agents/run-service.js";
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
import { conversations } from "./storage/schema.js";

export interface CharacterRuntimeOptions {
	dataRoot: string;
	systemProviderDir: string;
	storage: CompanionStorageHandle;
	systemDb: AppDatabase;
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
	readonly externalAgents: CodexAdapter;
	readonly auditStore: AuditStore;
	private readonly explicitMemoryFile: ExplicitMemoryFile;
	private memory?: TencentDbRuntime;
	private unsubscribeRunChanges?: () => void;
	private closed = false;

	constructor(private readonly options: CharacterRuntimeOptions) {
		const { database, paths } = options.storage;
		const db = database.orm;
		const character = this.character();
		this.companionId = character.id;
		this.explicitMemoryFile = new ExplicitMemoryFile(
			options.dataRoot,
			options.memoryScope.userId,
			character.id,
		);
		this.invalidations = new InvalidationHub();
		this.artifacts = new ArtifactStore(db, paths.artifacts);
		this.models = new ModelRegistry(
			options.systemDb,
			db,
			this.invalidations,
			options.appSettings,
			options.forEachCompanionDatabase,
		);
		this.companionStore = new CompanionStateStore(db);
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
		this.pi = new PiRuntime({
			paths: { runtime: paths.root, sessions: paths.sessions },
			models: options.providers,
			character: () => this.character(),
			store: this.companionStore,
			delegate: (params) => {
				this.pi.requireAvailable(params.conversationId);
				return this.externalAgentRuns.delegate(params);
			},
			canon: async (_companionId, query, limit) =>
				this.canon.search(this.companionId, query, limit),
			memory: {
				recall: async (_companionId, _sessionId, userText) => {
					if (!this.memoryEnabled()) return {};
					return (await this.startMemory()).recall(userText, this.memoryNamespace);
				},
				capture: async (_companionId, sessionId, messages) => {
					if (!this.memoryEnabled()) return;
					await (await this.startMemory()).captureTurn({
						userText: messageTextForRole(messages, "user"),
						assistantText: messageTextForRole(messages, "assistant"),
						messages,
						sessionKey: this.memoryNamespace,
						sessionId,
					});
				},
				search: async (_companionId, query, limit) => {
					this.requireMemoryEnabled();
					return (await this.startMemory()).searchMemories(query, limit);
				},
				searchConversations: async (_companionId, _sessionId, query, limit) => {
					this.requireMemoryEnabled();
					return (await this.startMemory()).searchConversations(query, this.memoryNamespace, limit);
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
			multimodalFallback: () =>
				this.models.multimodalFallback(options.providers.modelProjectionFacts()),
			sessionDiscarded: (sessionId) =>
				db.delete(conversations).where(eq(conversations.id, sessionId)).run(),
			context: async (conversationId, message) => {
				const context = await contextPack.compileForTurn(conversationId, { canonQuery: message });
				return contextPack.render(context);
			},
			sessionContext: (conversationId) => contextPack.sessionContext(conversationId),
			titleChanged: () => this.invalidations.invalidate(CacheKey.conversations()),
			sessionEvent: (envelope) => {
				const event = projectPiTransientEvent(envelope.event);
				if (!event) return;
				options.onLivePush({
					type: "pi",
					conversationId: envelope.sessionId,
					event,
				});
			},
		});
		seedPiAcpProfile(options.systemDb);
		const executorRouter = new ExecutorRouter(options.systemDb);
		executorRouter.register(
			"pi",
			new PiAcpAdapter(db, options.systemProviderDir, options.piWorkerPath, options.bundledGit),
		);
		this.externalAgents = new CodexAdapter(options.systemDb, db, this.invalidations);
		executorRouter.register("codex", this.externalAgents);
		this.externalAgentRuns = new ExternalAgentRunService(
			db,
			executorRouter,
			this.artifacts,
			paths.runs,
			async (agent) => {
				if (agent === "pi") return "pi-default";
				const status = await this.externalAgents.status();
				if (!status.available) throw { kind: "unavailable", reason: "codex_not_configured" };
				return status.profileId;
			},
			async (conversationId) => {
				const route = await this.pi.modelFor(conversationId);
				if (!route) return undefined;
				const credential = await options.credentials.get(route.providerId);
				const apiKey =
					credential?.piCredential?.type === "api_key"
						? credential.piCredential.key
						: credential?.apiKey;
				return { ...route, ...(apiKey ? { apiKey } : {}) };
			},
			async ({ run, outputs, needsResultReport }: TerminalRunResult, signal) => {
				await awaitSource(
					this.pi.deliverExternalResult(
						run.conversationId,
						run.id,
						externalAgentResultMessage({ run, outputs }),
					),
					signal,
				);
				return { resultReported: needsResultReport };
			},
		);
		this.unsubscribeRunChanges = this.externalAgentRuns.subscribeChanges((run) =>
			options.onLivePush({ type: "run", run }),
		);
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
		if (!this.memory) {
			this.memory = new TencentDbRuntime({
				dataDir: this.options.storage.paths.tdaiMemory,
				providers: this.options.providers,
				models: this.models,
				companionId: this.companionId,
				installationId: this.options.memoryScope.installationId,
				userId: this.options.memoryScope.userId,
				memoryConfig: this.options.memoryConfig(),
			});
		}
		return this.memory;
	}

	async resetMemory(): Promise<void> {
		const current = this.memory;
		this.memory = undefined;
		await current?.close();
	}

	async recoverExternalRuns(): Promise<number> {
		return this.externalAgentRuns.recoverUnfinishedRuns();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribeRunChanges?.();
		let failure: unknown;
		try {
			await this.externalAgentRuns.close();
		} catch (error) {
			failure = error;
		}
		for (const close of [() => this.pi.closeAll(), () => this.memory?.close()]) {
			try {
				await close();
			} catch (error) {
				failure ??= error;
			}
		}
		try {
			await this.auditStore.flush();
		} catch (error) {
			failure ??= error;
		}
		if (failure) throw failure;
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
			throw { kind: "not_found", reason: "character_runtime_not_active" };
		return this.explicitMemoryFile;
	}

	private get memoryNamespace() {
		return namespaceFor({ ...this.options.memoryScope, companionId: this.companionId });
	}

	private memoryEnabled(): boolean {
		return this.options.appSettings.load().memoryVectorService.enabled;
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
