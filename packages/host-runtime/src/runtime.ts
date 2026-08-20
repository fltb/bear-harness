/**
 * HostRuntime — the instance-scoped companion host.
 *
 * One instance owns the canonical database (connection, migrations and
 * schema backups), every domain service, the character loader (injected
 * character root, never source-tree-relative), the product config inputs,
 * the RPC dispatcher, and the start/close lifecycle. There are no
 * module-level singletons: nothing here is shared between instances.
 *
 * Wiring order mirrors the legacy desktop boot (`initHostServices`):
 *   constructor  — open DB, migrate, build services, wire all handlers,
 *                  seed the active character package;
 *   start()      — resolve the active character, configure the Companion
 *                  Pi runtime, start the supervisor;
 *   close()      — stop the supervisor, dispose services, close the DB.
 */

import { join } from "node:path";
import type { MemoryTdaiConfig } from "@bear-harness/tdai-core";
import { and, eq } from "drizzle-orm";
import { ArtifactStore } from "./artifacts/index.js";
import { CanonHubService } from "./canon/service.js";
import { CommissionService } from "./commissions/service.js";
import { CharacterBehaviorService } from "./companion/character-behavior.js";
import { CharacterDraftService } from "./companion/character-draft-service.js";
import { CharacterLoader } from "./companion/character-loader.js";
import { ContextPackCompiler } from "./companion/context-pack.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { RoleplayService } from "./companion/roleplay-service.js";
import { CompanionSupervisor } from "./companion/supervisor.js";
import { TurnPipeline } from "./companion/turn-pipeline.js";
import {
	type HostCompositionContext,
	proposeMemoryCandidate,
	rememberConversationEntry,
	wireHostHandlers,
} from "./composition.js";
import { ConversationRepository } from "./conversations/repository.js";
import { Dispatcher, type RpcResponse } from "./dispatcher.js";
import { CodexAdapter } from "./executors/codex-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { ExecutorRouter } from "./executors/router.js";
import type { MemoryBackend } from "./memory/backend.js";
import { namespaceFor } from "./memory/tencentdb-backend.js";
import type { DeepPartial } from "./memory/tencentdb-runtime.js";
import { TencentDbRuntime } from "./memory/tencentdb-runtime.js";
import { ModelRegistry } from "./models/registry.js";
import { applyProxyConfig, type SystemProxyResolver } from "./network/proxy-config.js";
import { ProviderCatalog } from "./providers/catalog.js";
import { CredentialStore, type CredentialVault } from "./providers/credential-store.js";
import { AuditStore, wireAuditToEvents } from "./security/audit-store.js";
import { type FsProtectionHandle, installFsProtection } from "./security/fs-protection.js";
import { createModerationService, type ModerationService } from "./security/moderation.js";
import { type AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import { Database, MIGRATIONS } from "./storage/database.js";
import { EventBus } from "./storage/event-bus.js";
import { conversations, memoryCandidates, messages } from "./storage/schema.js";
import { StoryService } from "./story/service.js";

/** The subset of the product configuration the host runtime consumes. */
export interface RuntimeProductConfig {
	/** ASCII kebab-case id of the default character package. */
	readonly defaultCharacterId: string;
}

export interface HostRuntimeOptions {
	/**
	 * Root directory for all runtime-owned state: the canonical database
	 * lives under `<dataDir>/storage`, artifacts under `<dataDir>/artifacts`,
	 * and the Companion/Pi runtime under `<dataDir>/companion-runtime`.
	 */
	dataDir: string;
	/**
	 * Character package root — a directory of `<characterId>/character.yaml`
	 * packages. Injected, never derived from the source tree. The
	 * `BEAR_CONFIG_DIR` environment override still wins when set (kept from
	 * the legacy loader).
	 */
	characterRoot: string;
	/** Product identity inputs (the fork-visible product config). */
	productConfig: RuntimeProductConfig;
	/** Platform encryption boundary for provider credentials. */
	credentialVault: CredentialVault;
	/** Development throws protocol bugs; packaged apps isolate them into a safe RPC error. */
	protocolViolationMode?: "throw" | "isolate";
	/** Stable product-local identity used to isolate the direct memory bank. */
	memoryScope?: { readonly installationId: string; readonly userId: string };
	/**
	 * Partial TdaiCore configuration injected into the memory runtime
	 * (embedding provider details, pipeline tuning). Defaults: full power.
	 */
	memoryConfig?: DeepPartial<MemoryTdaiConfig>;
	/**
	 * Optional Electron host resolver for "auto" proxy mode: uses Chromium's
	 * session.resolveProxy (PAC-aware). Pure-Node hosts omit it and fall back
	 * to the platform/system proxy resolvers.
	 */
	systemProxyResolver?: SystemProxyResolver;
	/**
	 * Optional factory that renders an artifact id into a renderer-loadable
	 * custom-scheme URL (e.g. `bear-artifact://artifact/<id>`) when the host
	 * shell has registered a protocol handler. Absent → the `artifact.url:v1`
	 * RPC returns an empty string (protocol unavailable).
	 */
	artifactProtocolUrlFactory?: (artifactId: string) => string;
	/**
	 * Optional app-update service supplied by the host shell (desktop). The
	 * `update.check:v1` RPC delegates to `check()`; the resolved value must
	 * match the protocol `UpdateCheckResponse` shape.
	 */
	updateService?: { check(): Promise<unknown> };
	/**
	 * Directories whose deletion is sentinel-warned by fs-protection (WARN +
	 * audit entry; deletes are never blocked). Defaults to `[dataDir]` — the
	 * host's config, database, memory, and logs all live under it.
	 */
	protectedRoots?: string[];
	/**
	 * Optional remote moderation policy service. Local moderation rules always
	 * apply first; remote errors fail open.
	 */
	moderation?: { remoteEndpoint?: string; remoteApiKey?: string };
	/** Directory for the hash-chained audit store; defaults to `<dataDir>/audit`. */
	auditDir?: string;
	logger?: { debug?: (message: string) => void; warn?: (message: string) => void };
}

export class HostRuntime {
	/** RPC dispatcher: validates against the shared protocol schemas. */
	readonly dispatcher: Dispatcher;

	private readonly db: Database;
	private readonly providers: ProviderCatalog;
	private readonly supervisor: CompanionSupervisor;
	private readonly characterBehavior: CharacterBehaviorService;
	private readonly characterLoader: CharacterLoader;
	private readonly unsubscribeStoryAutomation: () => void;
	private readonly composition: HostCompositionContext;
	private readonly systemProxyResolver?: HostRuntimeOptions["systemProxyResolver"];
	private readonly logger?: HostRuntimeOptions["logger"];
	readonly memoryRuntime: TencentDbRuntime;
	readonly memoryBackend: MemoryBackend;
	readonly memoryScope: { readonly installationId: string; readonly userId: string };
	/** Content-addressed artifact store (CAS + ownership rows). */
	readonly artifacts: ArtifactStore;
	/** Hash-chained append-only audit store (commission/run/fsop/memory/config). */
	readonly auditStore: AuditStore;
	/** Text moderation: deterministic local rules + optional remote policy. */
	readonly moderation: ModerationService;
	private readonly fsProtectedRoots: string[];
	private started = false;
	private closed = false;
	private uninstallFsProtection?: FsProtectionHandle;
	private unsubscribeAudit?: () => void;
	private unsubscribeProxyHotReload?: () => void;

	constructor(options: HostRuntimeOptions) {
		const dataDir = options.dataDir;
		const characterRoot = process.env.BEAR_CONFIG_DIR ?? options.characterRoot;

		// Canonical storage: one connection, migrations applied at boot.
		const db = new Database(join(dataDir, "storage"));
		db.migrate(MIGRATIONS);
		db.assertSchemaContract();

		const eventBus = new EventBus(db.orm);
		const artifactStore = new ArtifactStore(db.orm, join(dataDir, "artifacts"));
		const credentials = new CredentialStore(db.orm, options.credentialVault);
		const providers = new ProviderCatalog(credentials, join(dataDir, "companion-runtime"));
		const characterLoader = new CharacterLoader(characterRoot, join(dataDir, "characters"));
		const conversationRepository = new ConversationRepository(db.orm, {
			sessionDir: join(dataDir, "sessions"),
		});
		const sessionResolver = conversationRepository.getSessionResolver();
		const supervisor = new CompanionSupervisor(dataDir, eventBus, providers, sessionResolver);
		const roleplay = new RoleplayService(db.orm);
		const drafts = new CharacterDraftService(db.orm, characterLoader);
		const characterBehavior = new CharacterBehaviorService(
			db.orm,
			eventBus,
			characterLoader,
			roleplay,
		);
		const story = new StoryService(db.orm, eventBus);
		const canon = new CanonHubService(db.orm, artifactStore, eventBus);
		const unsubscribeStoryAutomation = eventBus.subscribe((event) => {
			if (event.kind !== "message.user_sent" || !event.payload || typeof event.payload !== "object")
				return;
			const payload = event.payload as Record<string, unknown>;
			if (
				typeof payload.conversationId !== "string" ||
				typeof payload.messageId !== "string" ||
				typeof payload.text !== "string"
			)
				return;
			const context = db.orm
				.select({ companionId: conversations.companionId, branchId: messages.branchId })
				.from(conversations)
				.innerJoin(messages, eq(messages.conversationId, conversations.id))
				.where(
					and(eq(conversations.id, payload.conversationId), eq(messages.id, payload.messageId)),
				)
				.get();
			if (!context) return;
			const result = story.handleUserText({
				companionId: context.companionId,
				conversationId: payload.conversationId,
				branchId: context.branchId,
				text: payload.text,
			});
			if (result.action === "ambiguous") {
				story.propose({
					companionId: context.companionId,
					conversationId: payload.conversationId,
					branchId: context.branchId,
					text: payload.text,
				});
			}
		});
		const onboarding = new FirstMeetingMachine(db.orm, eventBus, characterLoader);
		const appSettings = new AppSettingsStore(db.orm);
		const models = new ModelRegistry(db.orm, eventBus);
		const memoryScope = options.memoryScope ?? {
			installationId: "cyber-bear-installation",
			userId: "default-user",
		};
		const appRecord = appSettings.load();
		const memoryConfig = mergeEmbeddingConfig(options.memoryConfig, appRecord.memoryVectorService);
		const mirrorEndpoint = appRecord.modelDownloadMirror.endpoint?.trim();
		if (mirrorEndpoint) process.env.HF_ENDPOINT = mirrorEndpoint.trim();

		const memoryRuntime = new TencentDbRuntime({
			dataDir,
			providers,
			models,
			companionId: options.productConfig.defaultCharacterId,
			installationId: memoryScope.installationId,
			userId: memoryScope.userId,
			memoryConfig,
		});
		const turns = new TurnPipeline(db.orm, supervisor, eventBus, sessionResolver, {
			// Feed every settled turn to the TdaiCore capture pipeline (L0 → L1
			// extraction → L2/L3). This is a side channel: a failure here never
			// blocks the reply that was already persisted.
			onTurnCommitted: ({ conversationId, userText, assistantText, startedAt }) => {
				void memoryRuntime
					.captureTurn({
						userText,
						assistantText,
						messages: [
							{ role: "user", content: userText, timestamp: startedAt ?? Date.now() },
							{ role: "assistant", content: assistantText, timestamp: Date.now() },
						],
						sessionKey: namespaceFor({
							...memoryScope,
							companionId: options.productConfig.defaultCharacterId,
						}),
						sessionId: conversationId,
					})
					.catch((error: unknown) => {
						eventBus.publish("diagnostics.memory_capture_failed", {
							message: error instanceof Error ? error.message : String(error),
						});
					});
			},
		});
		const contextPack = new ContextPackCompiler(db.orm, characterLoader, canon, {
			backend: memoryRuntime.backend,
			scope: memoryScope,
			systemContext: (query) =>
				memoryRuntime
					.systemContext(
						query,
						namespaceFor({ ...memoryScope, companionId: options.productConfig.defaultCharacterId }),
					)
					.catch(() => {
						// persona/scene injection is best-effort; L1 recall already succeeded
						return undefined;
					}),
		});
		supervisor.setContextHandler(async (conversationId, includeHistory, message) =>
			contextPack.render(
				await contextPack.compileForTurn(conversationId, {
					includeConversationHistory: includeHistory,
					canonQuery: message,
					memoryQuery: message,
				}),
			),
		);
		onboarding.setConversationCreatedHandler((companionId, conversationId) => {
			models.applyDefaultToConversation(companionId, conversationId);
		});
		supervisor.setModelSelectionHandler((conversationId, requiresImages) =>
			models.resolve(conversationId, requiresImages),
		);
		seedPiAcpProfile(db.orm);
		const executorRouter = new ExecutorRouter(db.orm);
		executorRouter.register("product-managed", new PiAcpAdapter(db.orm, dataDir));
		executorRouter.register("codex", new CodexAdapter(db.orm, eventBus));
		const commissions = new CommissionService(db.orm, eventBus, artifactStore, executorRouter);
		supervisor.setHostToolHandler(async (call) => {
			if (call.tool === "host_search_conversation_history") {
				const args = call.args as { query: string; limit?: number };
				const conversation = db.orm
					.select({ companionId: conversations.companionId })
					.from(conversations)
					.where(eq(conversations.id, call.conversationId))
					.get();
				if (!conversation)
					return {
						ok: false,
						code: "conversation_not_found",
						message: "Conversation not found.",
					};
				if (
					!onboarding.getState(conversation.companionId).stateData.decisions
						.conversation_history_read_enabled
				)
					return {
						ok: false,
						code: "conversation_history_read_disabled",
						message: "Cross-conversation reading is disabled.",
					};
				const repository = new ConversationRepository(db.orm);
				const hits = repository.search(conversation.companionId, args.query, {
					excludeConversationId: call.conversationId,
					limit: args.limit,
				});
				return {
					ok: true,
					message: hits.length
						? "Conversation history found."
						: "No matching conversation history.",
					data: { hits },
				};
			}
			if (call.tool === "host_search_canon") {
				const args = call.args as { query: string; moduleId?: string };
				const conversation = db.orm
					.select({ companionId: conversations.companionId })
					.from(conversations)
					.where(eq(conversations.id, call.conversationId))
					.get();
				if (!conversation) throw { kind: "not_found", reason: "conversation_not_found" };
				const citations = canon.retrieve(conversation.companionId, args.query, {
					moduleId: args.moduleId,
					limit: 8,
				});
				return {
					ok: true,
					message: citations.length
						? "Canon evidence retrieved."
						: "No matching original-work evidence is installed for this character.",
					data: { citations },
				};
			}
			if (call.tool === "host_remember") {
				// Assistant-suggested memories become user-visible candidates the user
				// must approve before they enter relationship memory (plan §7.6).
				const candidate = await proposeMemoryCandidate(this.composition, call.conversationId);
				return {
					ok: true,
					message: "Memory suggestion created — approve or edit it in the memory panel.",
					data: candidate,
				};
			}
			if (call.tool !== "host_propose_work") return characterBehavior.invoke(call);
			if (!call.triggerMessageId) {
				return {
					ok: false,
					code: "trigger_message_required",
					message: "A real user message is required to propose work.",
				};
			}
			const args = call.args as {
				title: string;
				description: string;
				reads: string[];
				writes: string[];
				networkAllowed: boolean;
				toolNames: string[];
			};
			const triggerMessageId = call.triggerMessageId;
			const draft = commissions.draft({
				conversationId: call.conversationId,
				triggerMessageId,
				...args,
			});
			return {
				ok: true,
				message: "Action proposal created and is waiting for user approval.",
				data: draft,
			};
		});

		this.db = db;
		this.memoryRuntime = memoryRuntime;
		this.memoryBackend = memoryRuntime.backend;
		this.memoryScope = memoryScope;
		this.artifacts = artifactStore;
		this.providers = providers;
		this.supervisor = supervisor;
		this.characterBehavior = characterBehavior;
		this.characterLoader = characterLoader;
		this.unsubscribeStoryAutomation = unsubscribeStoryAutomation;
		this.systemProxyResolver = options.systemProxyResolver;
		this.logger = options.logger;
		// Security primitives: hash-chained audit + deterministic moderation.
		// fs-protection installs at `start()` so the global fs patch happens
		// at the lifecycle boundary, not during construction.
		this.fsProtectedRoots = options.protectedRoots ?? [dataDir];
		this.auditStore = new AuditStore({
			dir: options.auditDir ?? join(dataDir, "audit"),
			logger: this.logger,
		});
		this.moderation = createModerationService({
			remoteEndpoint: options.moderation?.remoteEndpoint,
			remoteApiKey: options.moderation?.remoteApiKey,
			logger: this.logger,
		});
		this.composition = {
			orm: db.orm,
			eventBus,
			onboarding,
			turns,
			models,
			memoryBackend: memoryRuntime.backend,
			memoryScope,
			appSettings,
			commissions,
			artifacts: artifactStore,
			story,
			canon,
			supervisor,
			providers,
			characterLoader,
			characterBehavior,
			drafts,
			roleplay,
			defaultCharacterId: options.productConfig.defaultCharacterId,
			conversationRepository,
			piSessionDir: join(dataDir, "sessions"),
			artifactUrlFactory: options.artifactProtocolUrlFactory,
			updateService: options.updateService,
			auditStore: this.auditStore,
		};
		// Start auditing commission/run/roleplay events from construction.
		this.unsubscribeAudit = wireAuditToEvents(this.auditStore, this.composition.eventBus);
		this.dispatcher = new Dispatcher({
			responseValidation: options.protocolViolationMode ?? "throw",
			onProtocolViolation: (error) => {
				eventBus.publish("diagnostics.protocol_violation", {
					channel: error.channel,
					issues: error.issues.map((issue) => ({
						path: issue.path.join("."),
						message: issue.message,
					})),
				});
			},
		});
		wireHostHandlers(this.dispatcher, this.composition);
	}

	/** Dispatch a protocol channel; validates and returns the shared envelope. */
	dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		return this.dispatcher.dispatch(channel, params);
	}

	/**
	 * Start the companion runtime: resolve the active character package,
	 * configure the Pi resources, and start the supervisor. Idempotent.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		// Apply the persisted network proxy before any host network call goes out.
		// Non-direct mode consults the platform/system proxy; Electron hosts pass
		// a session.resolveProxy resolver via `systemProxyResolver`.
		const proxy = this.composition.appSettings.load().networkProxy;
		if (proxy.mode !== "direct") {
			await applyProxyConfig(
				{ mode: proxy.mode, url: proxy.url, bypass: proxy.bypass },
				{ resolve: this.systemProxyResolver, logger: this.logger },
			);
		}
		// Live proxy hot-reload: settings changes re-apply the dispatcher without
		// a restart. Remember to subscribe AFTER the composition is ready.
		this.unsubscribeProxyHotReload = this.composition.eventBus.subscribe((event) => {
			const payload = event.payload as { changed?: string[] } | undefined;
			if (event.kind === "settings.changed" && payload?.changed?.includes("networkProxy")) {
				const next = this.composition.appSettings.load().networkProxy;
				void applyProxyConfig(
					{ mode: next.mode, url: next.url, bypass: next.bypass },
					{ resolve: this.systemProxyResolver, logger: this.logger },
				);
			}
		});
		// Security sentinels: fs-protection wraps the global delete APIs (WARN
		// + audit entry on hits; deletes are never blocked), and retention runs
		// once per boot. Audit event wiring already started in the constructor.
		this.uninstallFsProtection = installFsProtection({
			protectedRoots: this.fsProtectedRoots,
			logger: this.logger,
			onHit: (hit) => {
				void this.auditStore.append("fsop", "delete_attempt", JSON.stringify(hit)).catch(() => {
					// sentinel is warn-only; audit failure must not throw
				});
			},
		});
		void this.auditStore.prune().catch(() => {
			// retention is best-effort at boot
		});
		await this.memoryRuntime.start();
		// Local embedding: preload the offline model in the background so the
		// first hybrid recall doesn't pay download + load latency synchronously.
		const memoryVector = this.composition.appSettings.load().memoryVectorService;
		if (memoryVector.enabled && memoryVector.provider === "local") {
			void this.memoryRuntime.startLocalEmbeddingWarmup();
		}
		const activeCharacterId = this.characterLoader.getActiveCharacterId(
			this.composition.orm,
			this.composition.defaultCharacterId,
		);
		const activeCharacter = this.characterLoader.load(activeCharacterId);
		if (!activeCharacter) throw new Error(`character package missing: ${activeCharacterId}`);
		const trust = this.characterLoader.pluginTrust(this.composition.orm, activeCharacter);
		this.supervisor.configureRuntime(
			this.characterLoader.piResources(activeCharacter, trust.trusted),
		);
		await this.supervisor.start();
	}

	/** Stop the companion runtime, dispose services, and close the database. */
	async close(): Promise<void> {
		await this.memoryRuntime.close();
		if (this.closed) return;
		this.closed = true;
		await this.supervisor.stop();
		this.uninstallFsProtection?.uninstall();
		this.unsubscribeAudit?.();
		this.composition.turns.dispose();
		this.unsubscribeStoryAutomation();
		this.unsubscribeProxyHotReload?.();
		this.characterBehavior.dispose();
		this.providers.dispose();
		this.db.close();
	}
}

/**
 * Derive the TdaiCore embedding config from the persisted memory vector
 * service setting, layered onto any options-provided base config.
 */
function mergeEmbeddingConfig(
	base: DeepPartial<MemoryTdaiConfig> | undefined,
	service: AppSettingsRecord["memoryVectorService"],
): DeepPartial<MemoryTdaiConfig> | undefined {
	if (!service.enabled || service.provider === "none") {
		return base; // provider-less default already degrades hybrid recall
	}
	const embedding: DeepPartial<MemoryTdaiConfig>["embedding"] = {
		enabled: true,
		provider: "none",
		sendDimensions: true,
	};
	if (service.provider === "local") {
		embedding.provider = "local";
		const { localModel, customPath } = service;
		if (localModel === "bge-base-zh") {
			embedding.modelPath = "hf:CompendiumLabs/bge-small-zh-v1.5-gguf/bge-small-zh-v1.5-q8_0.gguf";
		} else if (localModel === "multilingual-e5") {
			embedding.modelPath =
				"hf:dinab/multilingual-e5-base-Q8_0-GGUF/multilingual-e5-base-q8_0.gguf";
		} else if (localModel === "custom" && customPath?.trim()) {
			embedding.modelPath = customPath.trim();
		}
		// embeddinggemma (default) leaves modelPath undefined → TdaiCore uses its built-in default
	} else {
		embedding.provider = "remote";
		embedding.baseUrl = service.baseUrl ?? "";
		embedding.apiKey = service.apiKey ?? "";
		embedding.model = service.model ?? "";
		embedding.dimensions = service.dimensions ?? 0;
	}
	return { ...base, embedding: { ...base?.embedding, ...embedding } };
}

/** Create an instance-scoped companion host runtime. */
export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
	return new HostRuntime(options);
}
