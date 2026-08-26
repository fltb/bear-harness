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

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MemoryTdaiConfig } from "@bear-harness/tdai-core";
import { and, eq } from "drizzle-orm";
import { ArtifactStore } from "./artifacts/index.js";
import { CanonHubService } from "./canon/service.js";
import { CharacterBehaviorService } from "./companion/character-behavior.js";
import { CharacterDraftService } from "./companion/character-draft-service.js";
import { CharacterLoader } from "./companion/character-loader.js";
import { ContextPackCompiler } from "./companion/context-pack.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { RoleplayService } from "./companion/roleplay-service.js";
import { CompanionSupervisor } from "./companion/supervisor.js";
import { TurnPipeline } from "./companion/turn-pipeline.js";
import {
	type ConversationAttachmentUrlFactoryRequest,
	type HostCompositionContext,
	type HostUpdateService,
	proposeMemoryCandidate,
	rememberConversationEntry,
	wireHostHandlers,
} from "./composition.js";
import { ConversationAttachmentService } from "./conversation-attachments/service.js";
import { ConversationRepository } from "./conversations/repository.js";
import { Dispatcher, type RpcResponse } from "./dispatcher.js";
import { CodexAdapter } from "./executors/codex-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { ExecutorRouter } from "./executors/router.js";
import {
	ExternalAgentRunService,
	externalAgentResultMessage,
	sanitizeExternalAgentMemoryText,
	type TerminalRunResult,
} from "./external-agents/run-service.js";
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
import { findHostLocalEmbeddingCandidate } from "./settings/capabilities.js";
import { type AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import { Database, loadInstallationId, MIGRATIONS } from "./storage/database.js";
import { EventBus } from "./storage/event-bus.js";
import { conversations, memoryCandidates } from "./storage/schema.js";

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
	 * Packaged character seed directory — a directory of
	 * `<characterId>/character.yaml` packages. Runtime copies seeds into the
	 * local library on first boot; all subsequent load/list/import/edit operate
	 * on the local library. Injected, never derived from the source tree. The
	 * `BEAR_CONFIG_DIR` environment override still wins when set.
	 */
	characterSeedRoot: string;
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
	/** Maximum duration of one startup reconciliation attempt before it remains pending. */
	backgroundAttemptTimeoutMs?: number;

	/**
	 * Optional Electron host resolver for "auto" proxy mode: uses Chromium's
	 * session.resolveProxy (PAC-aware). Pure-Node hosts omit it and fall back
	 * to the platform/system proxy resolvers.
	 */
	systemProxyResolver?: SystemProxyResolver;
	/** Optional desktop factory for short-lived renderer-bound attachment URLs. */
	conversationAttachmentUrlFactory?: (request: ConversationAttachmentUrlFactoryRequest) => string;
	/** Optional verified packaged Git runtime supplied by a desktop shell. */
	bundledGit?: { shellPath: string; pathEntries: string[] };
	/** Optional absolute Pi ACP worker entrypoint supplied by an embedding host. */
	piWorkerPath?: string;
	/**
	 * Optional app-update lifecycle service supplied by the host shell
	 * (desktop). `check()` stages a verified archive; `discard()` removes it;
	 * `apply()` is an explicit typed boundary and may report unsupported.
	 */
	updateService?: HostUpdateService;
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
interface BackgroundAttempt {
	controller: AbortController;
	settled: Promise<void>;
}

const DEFAULT_BACKGROUND_ATTEMPT_TIMEOUT_MS = 15_000;

export class HostRuntime {
	/** RPC dispatcher: validates against the shared protocol schemas. */
	readonly dispatcher: Dispatcher;

	private readonly db: Database;
	private readonly providers: ProviderCatalog;
	private readonly supervisor: CompanionSupervisor;
	private readonly characterBehavior: CharacterBehaviorService;
	private readonly characterLoader: CharacterLoader;
	private readonly composition: HostCompositionContext;
	private readonly systemProxyResolver?: HostRuntimeOptions["systemProxyResolver"];
	private readonly logger?: HostRuntimeOptions["logger"];
	private readonly backgroundAttemptTimeoutMs: number;
	readonly memoryRuntime: TencentDbRuntime;
	readonly memoryBackend: MemoryBackend;
	readonly memoryScope: { readonly installationId: string; readonly userId: string };
	/** Content-addressed artifact store (CAS + ownership rows). */
	readonly artifacts: ArtifactStore;
	readonly attachments: ConversationAttachmentService;
	/** Hash-chained append-only audit store (run/fsop/memory/config). */
	readonly auditStore: AuditStore;
	/** Text moderation: deterministic local rules + optional remote policy. */
	readonly moderation: ModerationService;
	private readonly fsProtectedRoots: string[];
	private readonly backgroundAttempts = new Set<BackgroundAttempt>();
	private started = false;
	private closed = false;
	private uninstallFsProtection?: FsProtectionHandle;
	private unsubscribeAudit?: () => void;
	private unsubscribeProxyHotReload?: () => void;
	private unsubscribeRunResultDrain?: () => void;

	constructor(options: HostRuntimeOptions) {
		this.backgroundAttemptTimeoutMs =
			options.backgroundAttemptTimeoutMs ?? DEFAULT_BACKGROUND_ATTEMPT_TIMEOUT_MS;
		const dataDir = options.dataDir;
		const characterSeedRoot = process.env.BEAR_CONFIG_DIR ?? options.characterSeedRoot;

		// Canonical storage: one connection, migrations applied at boot.
		const db = new Database(join(dataDir, "storage"));
		db.migrate(MIGRATIONS);
		db.assertSchemaContract();

		const eventBus = new EventBus(db.orm);
		const artifactStore = new ArtifactStore(db.orm, join(dataDir, "artifacts"));
		const attachments = new ConversationAttachmentService(
			db.orm,
			artifactStore,
			join(dataDir, "attachment-uploads"),
		);
		const credentials = new CredentialStore(db.orm, options.credentialVault);
		const providers = new ProviderCatalog(credentials, join(dataDir, "companion-runtime"));
		const characterLoader = new CharacterLoader(characterSeedRoot, join(dataDir, "characters"));
		characterLoader.bootstrapLibrary(options.productConfig.defaultCharacterId);
		const conversationRepository = new ConversationRepository(db.orm, {
			sessionDir: join(dataDir, "sessions"),
		});
		const sessionResolver = conversationRepository.getSessionResolver();
		const supervisor = new CompanionSupervisor(dataDir, eventBus, providers, sessionResolver);
		conversationRepository.setLiveSessionResolver(supervisor.getLiveSessionResolver());
		const roleplay = new RoleplayService(db.orm);
		const drafts = new CharacterDraftService(db.orm, characterLoader);
		const characterBehavior = new CharacterBehaviorService(
			db.orm,
			eventBus,
			characterLoader,
			roleplay,
			(conversationId) => supervisor.getLiveSessionResolver().get(conversationId),
		);
		const onboarding = new FirstMeetingMachine(db.orm, eventBus, characterLoader);
		const appSettings = new AppSettingsStore(db.orm);
		const models = new ModelRegistry(db.orm, eventBus);
		const memoryScope = options.memoryScope ?? {
			installationId: loadInstallationId(db.orm),
			userId: "default-user",
		};
		const appRecord = appSettings.load();
		const memoryConfig = mergeEmbeddingConfig(
			options.memoryConfig,
			appRecord.memoryVectorService,
			appRecord.modelDownloadSource,
		);

		const memoryRuntime = new TencentDbRuntime({
			dataDir,
			providers,
			models,
			companionId: options.productConfig.defaultCharacterId,
			installationId: memoryScope.installationId,
			userId: memoryScope.userId,
			memoryConfig,
		});
		const canon = new CanonHubService(
			db.orm,
			artifactStore,
			eventBus,
			() => memoryRuntime.getEmbeddingService(),
			db,
		);
		const turns = new TurnPipeline(db.orm, supervisor, eventBus, {
			finishAttachmentSend: (conversationId, nonce, nativeUserEntryId) =>
				attachments.finishSend(conversationId, nonce, nativeUserEntryId),
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
		supervisor.setContextHandler(async (conversationId, _includeHistory, message) =>
			contextPack.render(
				await contextPack.compileForTurn(conversationId, {
					canonQuery: message,
					memoryQuery: message,
				}),
			),
		);
		onboarding.setConversationFactory(({ companionId, title, sceneTitle, onCommit }) => {
			const id = randomUUID();
			const created = conversationRepository.createAndSelect({
				id,
				companionId,
				title,
				sceneTitle,
				onCommit,
			});
			return {
				conversationId: created.id,
				title: created.title,
				sceneTitle: created.sceneTitle,
			};
		});
		onboarding.setConversationCreatedHandler((companionId, conversationId) => {
			models.applyDefaultToConversation(companionId, conversationId);
		});
		supervisor.setModelSelectionHandler((conversationId, requiresImages) =>
			models.resolve(conversationId, requiresImages),
		);
		seedPiAcpProfile(db.orm);
		const executorRouter = new ExecutorRouter(db.orm);
		executorRouter.register(
			"pi",
			new PiAcpAdapter(db.orm, dataDir, options.piWorkerPath, options.bundledGit),
		);
		const codex = new CodexAdapter(db.orm, eventBus);
		executorRouter.register("codex", codex);
		const reconcileTerminalRun = async (
			{ run, outputs, needsResultReport, needsMemoryCapture }: TerminalRunResult,
			signal: AbortSignal,
		) => {
			const owner = db.orm
				.select({ companionId: conversations.companionId })
				.from(conversations)
				.where(eq(conversations.id, run.conversationId))
				.get();
			if (!owner || conversationRepository.active(owner.companionId)?.id !== run.conversationId) {
				return { resultReported: false, memoryCaptured: false };
			}

			const content = externalAgentResultMessage({ run, outputs });
			const followUp = await turns.deliverExternalAgentResult(run.conversationId, run.id, content, {
				signal,
				timeoutMs: this.backgroundAttemptTimeoutMs,
			});
			attachments.bindGenerated(
				run.conversationId,
				outputs.map((output) => output.id),
				followUp.entryId,
			);

			let memoryCaptured = false;
			if (needsMemoryCapture) {
				try {
					const timestamp = Date.now();
					const userText = sanitizeExternalAgentMemoryText(content, 6_000);
					const assistantText = sanitizeExternalAgentMemoryText(followUp.text, 4_000);
					await waitForRuntimeAbort(
						memoryRuntime.captureTurn({
							userText,
							assistantText,
							messages: [
								{ role: "user", content: userText, timestamp },
								{ role: "assistant", content: assistantText, timestamp: timestamp + 1 },
							],
							sessionKey: namespaceFor({ ...memoryScope, companionId: owner.companionId }),
							sessionId: run.conversationId,
						}),
						signal,
					);
					memoryCaptured = true;
				} catch {
					// Memory is a retryable side channel; native result delivery and
					// generated attachment binding have already committed.
				}
			}
			return {
				resultReported: needsResultReport,
				memoryCaptured,
			};
		};

		const externalAgentRuns = new ExternalAgentRunService(
			db.orm,
			eventBus,
			executorRouter,
			attachments,
			join(dataDir, "external-agent-runs"),
			async (agent) => {
				if (agent === "pi") return "pi-default";
				const status = await codex.status();
				if (!status.available) {
					throw { kind: "unavailable", reason: "codex_not_configured" };
				}
				return status.profileId;
			},
			async (conversationId) => {
				const route = models.resolve(conversationId, false);
				if (!route) return undefined;
				const credential = await credentials.get(route.providerId);
				return {
					providerId: route.providerId,
					modelId: route.modelId,
					...(credential?.apiKey ? { apiKey: credential.apiKey } : {}),
				};
			},
			reconcileTerminalRun,
		);
		this.unsubscribeRunResultDrain = eventBus.subscribe((event) => {
			if (event.kind !== "conversation.selected") return;
			const payload = event.payload as { id?: unknown };
			if (typeof payload.id !== "string" || !this.started) return;
			this.scheduleBackground("external-agent activation reconciliation", (signal) =>
				externalAgentRuns.reconcilePending(payload.id as string, {
					signal,
					timeoutMs: this.backgroundAttemptTimeoutMs,
				}),
			);
		});
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
				const citations = await canon.retrieveHybrid(conversation.companionId, args.query, {
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
			if (call.tool === "host_list_attachments") {
				return {
					ok: true,
					message: "Conversation attachments listed.",
					data: { attachments: attachments.list(call.conversationId) },
				};
			}
			if (call.tool === "host_read_attachment") {
				const args = call.args as {
					attachmentId: string;
					relativePath?: string;
					query?: string;
					cursor?: string;
				};
				return {
					ok: true,
					message: "Conversation attachment read.",
					data: attachments.readForRole({
						conversationId: call.conversationId,
						...args,
					}),
				};
			}
			if (call.tool === "host_delegate_agent") {
				const triggerEntryId = supervisor
					.getLiveSessionResolver()
					.get(call.conversationId)?.currentUserEntryId;
				if (!triggerEntryId) {
					return {
						ok: false,
						code: "trigger_entry_required",
						message: "A current user entry is required.",
					};
				}
				const args = call.args as {
					agent: "pi" | "codex";
					attachmentIds: string[];
					workspaceAttachmentId?: string;
					instruction: string;
				};
				try {
					const run = await externalAgentRuns.delegate({
						conversationId: call.conversationId,
						triggerEntryId,
						...args,
					});
					return {
						ok: true,
						message: "External agent started.",
						data: run,
					};
				} catch (error) {
					const code =
						error &&
						typeof error === "object" &&
						"reason" in error &&
						typeof error.reason === "string"
							? error.reason
							: "external_agent_launch_failed";
					return { ok: false, code, message: code };
				}
			}
			return characterBehavior.invoke(call);
		});

		this.db = db;
		this.memoryRuntime = memoryRuntime;
		this.memoryBackend = memoryRuntime.backend;
		this.memoryScope = memoryScope;
		this.artifacts = artifactStore;
		this.attachments = attachments;
		this.providers = providers;
		this.supervisor = supervisor;
		this.characterBehavior = characterBehavior;
		this.characterLoader = characterLoader;
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
			memoryRuntime,
			memoryScope,
			appSettings,
			externalAgentRuns,
			externalAgents: codex,
			artifacts: artifactStore,
			attachments,
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
			attachmentUrlFactory: options.conversationAttachmentUrlFactory,
			updateService: options.updateService,
			auditStore: this.auditStore,
		};
		// Start auditing run/roleplay events from construction.
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
		if (this.closed) throw new Error("Host runtime is closed");
		this.composition.externalAgentRuns.markOrphansInterrupted();
		try {
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

			// Security sentinels are local lifecycle state and must be installed
			// before the Host becomes available.
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
			await this.supervisor.start();
			this.started = true;

			// Every provider/model/network-dependent attempt starts only after the
			// local Host and RPC surface are usable. Each wrapper is bounded,
			// cancellation-aware, and rejection-contained.
			const proxy = this.composition.appSettings.load().networkProxy;
			this.scheduleBackground("network proxy reconciliation", () =>
				applyProxyConfig(
					{ mode: proxy.mode, url: proxy.url, bypass: proxy.bypass },
					{ resolve: this.systemProxyResolver, logger: this.logger },
				),
			);
			this.unsubscribeProxyHotReload = this.composition.eventBus.subscribe((event) => {
				const payload = event.payload as { changed?: string[] } | undefined;
				if (event.kind !== "settings.changed" || !payload?.changed?.includes("networkProxy")) {
					return;
				}
				const next = this.composition.appSettings.load().networkProxy;
				this.scheduleBackground("network proxy hot reload", () =>
					applyProxyConfig(
						{ mode: next.mode, url: next.url, bypass: next.bypass },
						{ resolve: this.systemProxyResolver, logger: this.logger },
					),
				);
			});
			this.scheduleBackground("Canon embedding reconciliation", (signal) =>
				waitForRuntimeAbort(this.composition.canon.indexPending(activeCharacterId), signal),
			);
			this.scheduleBackground("pending turn reconciliation", (signal) =>
				this.composition.turns.reconcilePendingTurns({
					signal,
					timeoutMs: this.backgroundAttemptTimeoutMs,
				}),
			);
			this.scheduleBackground("external-agent result reconciliation", (signal) =>
				this.composition.externalAgentRuns.reconcilePending(undefined, {
					signal,
					timeoutMs: this.backgroundAttemptTimeoutMs,
				}),
			);
		} catch (error) {
			this.started = false;
			if (this.supervisor.isRunning) await this.supervisor.stop().catch(() => undefined);
			this.uninstallFsProtection?.uninstall();
			this.uninstallFsProtection = undefined;
			this.unsubscribeProxyHotReload?.();
			this.unsubscribeProxyHotReload = undefined;
			throw error;
		}
	}

	private scheduleBackground(
		label: string,
		run: (signal: AbortSignal) => void | Promise<unknown>,
	): void {
		if (this.closed) return;
		const controller = new AbortController();
		const work = Promise.resolve().then(() => run(controller.signal));
		// Promise.race observes `work`; this additional terminal catch also keeps
		// a late rejection handled after cancellation won the race.
		void work.catch(() => undefined);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancelled = new Promise<void>((resolve) => {
			controller.signal.addEventListener("abort", () => resolve(), { once: true });
			timer = setTimeout(() => controller.abort(), this.backgroundAttemptTimeoutMs);
		});
		const attempt = {} as BackgroundAttempt;
		attempt.controller = controller;
		attempt.settled = Promise.race([work.then(() => undefined), cancelled])
			.catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.logger?.warn?.(`${label} failed: ${detail.slice(0, 1_024)}`);
			})
			.finally(() => {
				clearTimeout(timer);
				this.backgroundAttempts.delete(attempt);
			});
		this.backgroundAttempts.add(attempt);
	}

	/** Stop the companion runtime, dispose services, and close the database. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.started = false;
		this.unsubscribeProxyHotReload?.();
		this.unsubscribeProxyHotReload = undefined;
		this.unsubscribeRunResultDrain?.();
		this.unsubscribeRunResultDrain = undefined;
		const attempts = [...this.backgroundAttempts];
		for (const attempt of attempts) attempt.controller.abort();
		await Promise.allSettled(attempts.map((attempt) => attempt.settled));
		this.backgroundAttempts.clear();
		await this.composition.externalAgentRuns.close();
		this.composition.turns.dispose();

		let failure: unknown;
		try {
			await this.supervisor.stop();
		} catch (error) {
			failure = error;
		}
		this.uninstallFsProtection?.uninstall();
		this.uninstallFsProtection = undefined;
		this.unsubscribeAudit?.();
		this.unsubscribeAudit = undefined;
		this.characterBehavior.dispose();
		this.providers.dispose();
		try {
			await this.memoryRuntime.close();
		} catch (error) {
			failure ??= error;
		}
		this.db.close();
		if (failure) throw failure;
	}
}

async function waitForRuntimeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("runtime_background_attempt_cancelled");
	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("runtime_background_attempt_cancelled"));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([work, cancelled]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

/**
 * Derive the TdaiCore embedding config from the persisted memory vector
 * service setting, layered onto any options-provided base config.
 */
function mergeEmbeddingConfig(
	base: DeepPartial<MemoryTdaiConfig> | undefined,
	service: AppSettingsRecord["memoryVectorService"],
	downloadSource: AppSettingsRecord["modelDownloadSource"],
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
		const candidate = service.localModel
			? findHostLocalEmbeddingCandidate(service.localModel)
			: undefined;
		embedding.provider = "local";
		embedding.dimensions = candidate?.dimensions ?? 768;
		embedding.modelPath = candidate?.modelPath ?? service.customPath;
		embedding.hfEndpoint =
			downloadSource.type === "official"
				? "https://huggingface.co"
				: downloadSource.type === "hf-mirror"
					? "https://hf-mirror.com"
					: downloadSource.endpoint;
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
