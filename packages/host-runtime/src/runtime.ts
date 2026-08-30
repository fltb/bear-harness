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
import { eq } from "drizzle-orm";
import { ArtifactStore } from "./artifacts/index.js";
import { awaitSource } from "./await-source.js";
import { CanonHubService } from "./canon/service.js";
import { CharacterDraftService } from "./companion/character-draft-service.js";
import { CharacterLoader } from "./companion/character-loader.js";
import { CompanionStateStore } from "./companion/companion-store.js";
import { ContextPackCompiler } from "./companion/context-pack.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { PiRuntime } from "./companion/pi-runtime.js";
import { SessionCatalog } from "./companion/session-catalog.js";
import {
	type HostCompositionContext,
	type HostUpdateService,
	rememberConversationEntry,
	syncAllProviderModels,
	syncProviderModels,
	wireHostHandlers,
} from "./composition.js";
import type { Diagnostics } from "./diagnostics/index.js";
import { Dispatcher, type RpcResponse } from "./dispatcher.js";
import { CodexAdapter } from "./executors/codex-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { ExecutorRouter } from "./executors/router.js";
import {
	type DelegateParams,
	type DelegateResult,
	ExternalAgentRunService,
	externalAgentResultMessage,
	sanitizeExternalAgentMemoryText,
	type TerminalRunResult,
} from "./external-agents/run-service.js";
import { type MemoryBackend, withMemoryNotifications } from "./memory/backend.js";
import { namespaceFor } from "./memory/tencentdb-backend.js";
import type { DeepPartial } from "./memory/tencentdb-runtime.js";
import { TencentDbRuntime } from "./memory/tencentdb-runtime.js";
import { ModelRegistry } from "./models/registry.js";
import { applyProxyConfig, type SystemProxyResolver } from "./network/proxy-config.js";
import { ProviderCatalog } from "./providers/catalog.js";
import { CredentialStore, type CredentialVault } from "./providers/credential-store.js";
import { AuditStore, auditReasonCode, wireAuditToEvents } from "./security/audit-store.js";
import { type FsProtectionHandle, installFsProtection } from "./security/fs-protection.js";
import { createModerationService, type ModerationService } from "./security/moderation.js";
import { findHostLocalEmbeddingCandidate } from "./settings/capabilities.js";
import { type AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import { Database, loadInstallationId, MIGRATIONS } from "./storage/database.js";
import { EventBus } from "./storage/event-bus.js";
import { conversations } from "./storage/schema.js";

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
	logger?: {
		debug?: (message: string) => void;
		warn?: (message: string) => void;
	};
	/** Host-shell diagnostics sink used for end-to-end business traces. */
	diagnostics?: Diagnostics;
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
	private unsubscribeSync?: () => void;
	private readonly providers: ProviderCatalog;
	private readonly pi: PiRuntime;
	private readonly characterLoader: CharacterLoader;
	private readonly composition: HostCompositionContext;
	private readonly systemProxyResolver?: HostRuntimeOptions["systemProxyResolver"];
	private readonly logger?: HostRuntimeOptions["logger"];
	private readonly backgroundAttemptTimeoutMs: number;
	readonly memoryRuntime: TencentDbRuntime;
	readonly memoryBackend: MemoryBackend;
	readonly memoryScope: {
		readonly installationId: string;
		readonly userId: string;
	};
	/** Content-addressed artifact store (CAS + ownership rows). */
	readonly artifacts: ArtifactStore;
	/** Hash-chained append-only audit store (run/fsop/memory/config). */
	readonly auditStore: AuditStore;
	/** Text moderation: deterministic local rules + optional remote policy. */
	readonly moderation: ModerationService;
	private readonly fsProtectedRoots: string[];
	private readonly backgroundAttempts = new Set<BackgroundAttempt>();
	private started = false;
	private closed = false;
	private readonly lifetime = new AbortController();
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
		const credentials = new CredentialStore(db.orm, options.credentialVault);
		const providers = new ProviderCatalog(
			credentials,
			join(dataDir, "companion-runtime"),
			(providerId) => {
				eventBus.publish("provider.login_changed", { providerId });
				this.scheduleBackground("OAuth model reconciliation", async () => {
					const state = await providers.getOAuthSession(providerId);
					if (state.status === "completed")
						await syncProviderModels(providerId, providers, this.composition.models);
				});
			},
		);
		const characterLoader = new CharacterLoader(characterSeedRoot, join(dataDir, "characters"));
		characterLoader.bootstrapLibrary(options.productConfig.defaultCharacterId);
		const companionStore = new CompanionStateStore(db.orm);
		const drafts = new CharacterDraftService(db.orm, characterLoader);
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

		const notifyMemoryChanged = () => {
			if (!this.lifetime.signal.aborted) eventBus.publish("memory.records_changed", {});
		};
		const memoryRuntime = new TencentDbRuntime({
			onRecordsChanged: notifyMemoryChanged,
			dataDir,
			providers,
			models,
			companionId: options.productConfig.defaultCharacterId,
			installationId: memoryScope.installationId,
			userId: memoryScope.userId,
			memoryConfig,
		});
		const memoryBackend = withMemoryNotifications(
			memoryRuntime.backend,
			notifyMemoryChanged,
			this.lifetime.signal,
		);
		const canon = new CanonHubService(
			db.orm,
			artifactStore,
			eventBus,
			() => memoryRuntime.getEmbeddingService(),
			db,
		);
		const contextPack = new ContextPackCompiler(
			db.orm,
			characterLoader,
			canon,
			{
				backend: memoryBackend,
				scope: memoryScope,
				systemContext: (query) =>
					memoryRuntime
						.systemContext(
							query,
							namespaceFor({
								...memoryScope,
								companionId: options.productConfig.defaultCharacterId,
							}),
						)
						.catch(() => {
							// persona/scene injection is best-effort; L1 recall already succeeded
							return undefined;
						}),
			},
			companionStore,
		);
		const renderContext = async (conversationId: string, message: string) => {
			const diagnostics = options.diagnostics;
			const span = diagnostics?.startSpan("context.compile", {
				conversationId,
			});
			try {
				const context = await (span && diagnostics
					? diagnostics.runInSpan(span, async () =>
							contextPack.render(
								await contextPack.compileForTurn(conversationId, {
									canonQuery: message,
									memoryQuery: message,
								}),
							),
						)
					: contextPack.render(
							await contextPack.compileForTurn(conversationId, {
								canonQuery: message,
								memoryQuery: message,
							}),
						));
				span?.end("ok", { contextBytes: Buffer.byteLength(context, "utf8") });
				return context;
			} catch (error) {
				options.logger?.warn?.(
					`context compile failed: ${
						error instanceof Error
							? error.message
							: JSON.stringify(error, undefined, 2) || String(error)
					}`,
				);
				span?.end("error", { contextBytes: 0, errorCode: "context_compile_failed" });
				throw error;
			}
		};
		const activeCharacter = () => {
			const id = characterLoader.getActiveCharacterId(
				db.orm,
				options.productConfig.defaultCharacterId,
			);
			const character = characterLoader.load(id);
			if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
			return character;
		};
		let delegateExternalAgent: ((params: DelegateParams) => Promise<DelegateResult>) | undefined;
		const pi = new PiRuntime({
			dataDir,
			models: providers,
			character: activeCharacter,
			store: companionStore,
			delegate: (params) => {
				if (!delegateExternalAgent)
					throw { kind: "unavailable", reason: "external_agent_not_ready" };
				return delegateExternalAgent(params);
			},
			history: async (query, limit) => {
				const companionId = activeCharacter().id;
				if (!onboarding.getState(companionId).stateData.decisions.conversation_history_read_enabled)
					throw { reason: "conversation_history_read_disabled" };
				const current = pi.snapshot()?.sessionId;
				const needle = query.toLocaleLowerCase();
				return (await sessions.list(companionId))
					.filter(
						(session) =>
							session.id !== current &&
							session.allMessagesText.toLocaleLowerCase().includes(needle),
					)
					.slice(0, limit)
					.map((session) => ({
						id: session.id,
						title: session.name,
						text: session.allMessagesText,
					}));
			},
			canon: async (query, limit) => canon.search(activeCharacter().id, query, limit),
			memory: async (query, limit) => {
				const companionId = activeCharacter().id;
				if (!onboarding.getState(companionId).stateData.decisions.relationship_memory_enabled)
					throw { reason: "relationship_memory_disabled" };
				const scope = { ...memoryScope, companionId };
				await memoryBackend.open({ scope });
				return (await memoryBackend.recall({ scope, query, limit })).map(({ record, score }) => ({
					id: record.id,
					text: record.text,
					score,
				}));
			},
			defaultModel: () => models.defaults(activeCharacter().id).reply,
			context: renderContext,
			titleChanged: (sessionId, title) =>
				eventBus.publish("conversation.renamed", { conversationId: sessionId, title }),
		});
		const sessions = new SessionCatalog(db.orm, pi);
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
			if (pi.snapshot()?.sessionId !== run.conversationId) {
				return { resultReported: false, memoryCaptured: false };
			}

			const content = externalAgentResultMessage({ run, outputs });
			await awaitSource(pi.deliverExternalResult(run.id, content), signal);

			let memoryCaptured = false;
			if (needsMemoryCapture) {
				try {
					const timestamp = Date.now();
					const userText = sanitizeExternalAgentMemoryText(content, 6_000);
					const assistantText = "External agent result delivered to Pi.";
					await awaitSource(
						memoryRuntime.captureTurn({
							userText,
							assistantText,
							messages: [
								{ role: "user", content: userText, timestamp },
								{
									role: "assistant",
									content: assistantText,
									timestamp: timestamp + 1,
								},
							],
							sessionKey: namespaceFor({
								...memoryScope,
								companionId: activeCharacter().id,
							}),
							sessionId: run.conversationId,
						}),
						signal,
					);
					memoryCaptured = true;
				} catch {
					// Memory is a retryable side channel; native result delivery already committed.
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
			artifactStore,
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
				const route = await pi.modelFor(conversationId);
				if (!route) return undefined;
				const credential = await credentials.get(route.providerId);
				const apiKey =
					credential?.piCredential?.type === "api_key"
						? credential.piCredential.key
						: credential?.apiKey;
				return {
					providerId: route.providerId,
					modelId: route.modelId,
					...(apiKey ? { apiKey } : {}),
				};
			},
			reconcileTerminalRun,
			undefined,
			options.diagnostics,
		);
		delegateExternalAgent = (params) => externalAgentRuns.delegate(params);

		this.db = db;
		this.memoryRuntime = memoryRuntime;
		this.memoryBackend = memoryBackend;
		this.memoryScope = memoryScope;
		this.artifacts = artifactStore;
		this.providers = providers;
		this.pi = pi;
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
			signal: this.lifetime.signal,
			orm: db.orm,
			eventBus,
			onboarding,
			pi,
			sessions,
			models,
			memoryBackend,
			memoryRuntime,
			memoryScope,
			appSettings,
			externalAgentRuns,
			externalAgents: codex,
			artifacts: artifactStore,
			canon,
			providers,
			characterLoader,
			drafts,
			companionStore,
			defaultCharacterId: options.productConfig.defaultCharacterId,
			updateService: options.updateService,
			auditStore: this.auditStore,
		};
		// Start auditing Host events from construction.
		this.unsubscribeAudit = wireAuditToEvents(this.auditStore, this.composition.eventBus);
		const syncEpoch = randomUUID();
		const syncRevision = () => ({
			epoch: syncEpoch,
			revision: db.syncRevision(),
		});
		this.unsubscribeSync = db.subscribeSync((revision, sources) => {
			eventBus.publish("sync.invalidated", {
				sync: { epoch: syncEpoch, revision },
				sources: sources.length > 256 ? ["all"] : sources,
			});
		});
		this.dispatcher = new Dispatcher({
			syncRevision,
			onDispatchResult: ({ channel, operation, outcome, error }) => {
				if (operation !== "mutation" && outcome !== "error") return;
				const kind = channel.startsWith("run.")
					? "run"
					: channel.startsWith("settings.") ||
							channel.startsWith("provider.") ||
							channel.startsWith("model.") ||
							channel.startsWith("character.")
						? "config"
						: "memory";
				void this.auditStore
					.append(
						kind,
						outcome === "ok" ? "rpc_committed" : "rpc_failed",
						JSON.stringify({
							channel,
							...(error
								? {
										error: {
											kind: error.kind,
											reason: auditReasonCode(error.reason),
										},
									}
								: {}),
						}),
					)
					.catch(() => undefined);
			},
			responseValidation: options.protocolViolationMode ?? "throw",
			onProtocolViolation: (error) => {
				void this.auditStore
					.append(
						"config",
						"protocol_violation",
						JSON.stringify({
							channel: error.channel,
							issues: error.issues.map((issue) => ({
								path: issue.path.join("."),
								message: issue.message,
							})),
						}),
					)
					.catch(() => undefined);
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

	/** Replay every stored page, then keep delivering Host events until unsubscribed. */
	subscribeEvents(
		listener: (event: import("./storage/event-bus.js").HostEvent) => void,
		afterSeq: number,
	): () => void {
		const stop = this.composition.eventBus.subscribe(listener);
		try {
			let cursor = afterSeq;
			for (;;) {
				const batch = this.composition.eventBus.after(cursor);
				if (!batch.length) break;
				for (const event of batch) {
					listener(event);
					cursor = event.seq;
				}
			}
			return stop;
		} catch (error) {
			stop();
			throw error;
		}
	}

	/** Dispatch a protocol channel; validates and returns the shared envelope. */
	dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		if (this.closed)
			return Promise.resolve({
				ok: false,
				error: { kind: "unavailable", reason: "host_closed" },
			});
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
			this.pi.configure(
				this.characterLoader.piResources(activeCharacter, trust.trusted).appendSystemPrompt,
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
			this.scheduleBackground("provider model reconciliation", () =>
				syncAllProviderModels(this.composition.providers, this.composition.models),
			);
			this.scheduleBackground("Canon embedding reconciliation", (signal) =>
				awaitSource(this.composition.canon.indexPending(activeCharacterId), signal),
			);
			this.scheduleBackground("external-agent result reconciliation", (signal) =>
				this.composition.externalAgentRuns.reconcilePending(undefined, {
					signal,
					timeoutMs: this.backgroundAttemptTimeoutMs,
				}),
			);
		} catch (error) {
			this.started = false;
			await this.pi.close().catch(() => undefined);
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
			controller.signal.addEventListener("abort", () => resolve(), {
				once: true,
			});
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
		this.lifetime.abort();
		this.providers.dispose();
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
		let failure: unknown;
		try {
			await this.pi.close();
		} catch (error) {
			failure = error;
		}
		this.uninstallFsProtection?.uninstall();
		this.uninstallFsProtection = undefined;
		this.unsubscribeAudit?.();
		this.unsubscribeAudit = undefined;
		await this.auditStore.flush();
		try {
			await this.memoryRuntime.close();
		} catch (error) {
			failure ??= error;
		}
		this.unsubscribeSync?.();
		this.db.close();
		if (failure) throw failure;
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
