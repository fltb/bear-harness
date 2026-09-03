import type { LivePush } from "@bear-harness/protocol";
import { CacheKey, ProviderLoginResponse } from "@bear-harness/protocol/schema";
import type { MemoryTdaiConfig } from "@bear-harness/tdai-core";
import { eq } from "drizzle-orm";
import type { ArtifactStore } from "./artifacts/index.js";
import type { ArtifactPresenter } from "./artifacts/presentation.js";
import { CharacterRuntime } from "./character-runtime.js";
import { CharacterDraftService } from "./companion/character-draft-service.js";
import {
	CharacterLoader,
	type CharacterPackage,
	type CharacterPackageOrigin,
} from "./companion/character-loader.js";
import {
	type HostCompositionContext,
	type HostUpdateService,
	syncAllProviderModels,
	syncProviderModels,
	wireHostHandlers,
} from "./composition.js";
import { Dispatcher, type RpcResponse } from "./dispatcher.js";
import { HostEventLoop, type RuntimeResource } from "./host-event-loop.js";
import {
	type DeepPartial,
	type TencentDbRuntime,
	validateLocalEmbedding,
	validateRemoteEmbedding,
} from "./memory/tencentdb-runtime.js";
import { ModelRegistry } from "./models/registry.js";
import { applyProxyConfig, type SystemProxyResolver } from "./network/proxy-config.js";
import { ProviderCatalog } from "./providers/catalog.js";
import {
	CredentialStore,
	type CredentialVault,
	REMOTE_EMBEDDING_CREDENTIAL_ID,
} from "./providers/credential-store.js";
import {
	type AuditStore,
	auditKindForRpcMutation,
	auditReasonCode,
} from "./security/audit-store.js";
import { type FsAuditHandle, installFsAudit } from "./security/fs-audit.js";
import { findHostLocalEmbeddingCandidate } from "./settings/capabilities.js";
import { type AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import { CompanionStorageRegistry } from "./storage/companion-storage.js";
import { loadInstallationId } from "./storage/database.js";
import type { InvalidationListener } from "./storage/invalidation-hub.js";
import { activeCharacter } from "./storage/schema.js";

export interface RuntimeProductConfig {
	readonly defaultCharacterId: string;
}

export interface HostRuntimeOptions {
	dataDir: string;
	characterSeedRoot: string;
	productConfig: RuntimeProductConfig;
	credentialVault: CredentialVault;
	memoryScope?: { readonly installationId: string; readonly userId: string };
	memoryConfig?: DeepPartial<MemoryTdaiConfig>;
	systemProxyResolver?: SystemProxyResolver;
	bundledGit?: { shellPath: string; pathEntries: string[] };
	piWorkerPath?: string;
	updateService?: HostUpdateService;
	artifactPresenter?: ArtifactPresenter;
	characterPackagePresenter?: { reveal(directory: string): Promise<void> };
	auditRoots?: string[];
	logger?: { debug?: (message: string) => void; warn?: (message: string) => void };
}

interface InvalidationSubscription {
	listener: InvalidationListener;
	stop?: () => void;
}

interface RoleResource extends RuntimeResource {
	readonly runtime: CharacterRuntime;
	readonly dispatcher: Dispatcher;
	readonly memoryEmbedding: HostCompositionContext["memoryEmbedding"];
}

/** Installation services plus one physically isolated, replaceable character runtime. */
export class HostRuntime {
	readonly dispatcher: Pick<Dispatcher, "dispatch">;
	readonly memoryScope: { readonly installationId: string; readonly userId: string };
	private readonly options: HostRuntimeOptions;
	private readonly storage: CompanionStorageRegistry;
	private readonly providers: ProviderCatalog;
	private readonly credentials: CredentialStore;
	private readonly characterLoader: CharacterLoader;
	private readonly appSettings: AppSettingsStore;
	private readonly drafts: CharacterDraftService;
	private readonly lifetime = new AbortController();
	private readonly backgroundAttempts = new Set<Promise<void>>();
	private readonly invalidationSubscriptions = new Set<InvalidationSubscription>();
	private readonly livePushListeners = new Set<(event: LivePush) => void>();
	private readonly lifecycle: HostEventLoop<RoleResource>;
	private uninstallFsAudit?: FsAuditHandle;
	private unsubscribeProxyHotReload?: () => void;
	private started = false;
	private closed = false;

	constructor(options: HostRuntimeOptions) {
		this.options = options;
		this.storage = new CompanionStorageRegistry(options.dataDir);
		const systemDb = this.storage.system.orm;
		this.characterLoader = new CharacterLoader(
			options.characterSeedRoot,
			this.storage.layout.charactersRoot,
		);
		this.characterLoader.bootstrapLibrary(options.productConfig.defaultCharacterId);
		this.credentials = new CredentialStore(systemDb, options.credentialVault);
		this.appSettings = new AppSettingsStore(systemDb);
		this.memoryScope = options.memoryScope ?? {
			installationId: loadInstallationId(systemDb),
			userId: "default-user",
		};
		this.providers = new ProviderCatalog(
			this.credentials,
			this.storage.layout.systemProviders,
			(providerId) => {
				this.scheduleBackground("OAuth model reconciliation", async () => {
					const state = await this.providers.getOAuthSession(providerId);
					for (const listener of this.livePushListeners)
						listener({
							type: "providerLogin",
							providerId,
							state: ProviderLoginResponse.parse(state),
						});
					if (state.status === "completed")
						await syncProviderModels(
							providerId,
							this.providers,
							this.lifecycle.active().runtime.models,
						);
				});
			},
		);
		this.drafts = new CharacterDraftService(systemDb, this.characterLoader);

		const activeId = this.characterLoader.getActiveCharacterId(
			systemDb,
			options.productConfig.defaultCharacterId,
		);
		const character = this.characterLoader.load(activeId);
		if (!character) throw new Error(`character package missing: ${activeId}`);
		const hasPersistedActive = systemDb
			.select({ id: activeCharacter.characterId })
			.from(activeCharacter)
			.where(eq(activeCharacter.singleton, 1))
			.get();
		if (hasPersistedActive) this.characterLoader.seed(systemDb, character);
		else this.characterLoader.activate(systemDb, character);
		const initialRuntime = this.createCharacterRuntime(character.id);
		const initial = this.createRoleResource(`${character.id}:1`, initialRuntime);
		this.lifecycle = new HostEventLoop(initial);
		this.dispatcher = Object.freeze({
			dispatch: (channel: string, params: unknown) => this.dispatch(channel, params),
		});
	}

	get artifacts(): ArtifactStore {
		return this.lifecycle.active().runtime.artifacts;
	}
	get auditStore(): AuditStore {
		return this.lifecycle.active().runtime.auditStore;
	}
	get memoryRuntime(): TencentDbRuntime {
		return this.lifecycle.active().runtime.memoryRuntime;
	}
	get memoryEmbedding(): HostCompositionContext["memoryEmbedding"] {
		return this.lifecycle.active().memoryEmbedding;
	}

	subscribeInvalidations(listener: InvalidationListener): () => void {
		const subscription: InvalidationSubscription = { listener };
		this.invalidationSubscriptions.add(subscription);
		this.bindInvalidationSubscription(subscription);
		return () => {
			subscription.stop?.();
			this.invalidationSubscriptions.delete(subscription);
		};
	}

	subscribeLivePush(listener: (event: LivePush) => void): () => void {
		this.livePushListeners.add(listener);
		return () => this.livePushListeners.delete(listener);
	}

	dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		if (this.closed)
			return Promise.resolve({ ok: false, error: { kind: "unavailable", reason: "host_closed" } });
		return this.lifecycle.route((resource) => resource.dispatcher.dispatch(channel, params));
	}

	characterDeletionStatus(characterId: string): {
		characterId: string;
		active: boolean;
		default: boolean;
		runtimePresent: boolean;
		packagePresent: boolean;
	} {
		if (this.closed) throw { kind: "unavailable", reason: "host_closed" };
		const runtimePresent = this.storage.hasCompanionRuntime(characterId);
		return {
			characterId,
			active: characterId === this.lifecycle.active().characterId,
			default: characterId === this.options.productConfig.defaultCharacterId,
			runtimePresent,
			packagePresent: this.characterLoader.load(characterId) !== null,
		};
	}

	deleteCharacterRuntime(characterId: string): { deleted: boolean } {
		if (this.closed) throw { kind: "unavailable", reason: "host_closed" };
		if (characterId === this.lifecycle.active().characterId) {
			throw { kind: "conflict", reason: "character_runtime_active" };
		}
		return { deleted: this.storage.deleteCompanionRuntime(characterId) };
	}

	deleteCharacterPackage(characterId: string): { deleted: boolean } {
		if (this.closed) throw { kind: "unavailable", reason: "host_closed" };
		return {
			deleted: this.characterLoader.deletePackage(this.storage.system.orm, characterId, {
				defaultCharacterId: this.options.productConfig.defaultCharacterId,
				runtimeExists: this.storage.hasCompanionRuntime(characterId),
			}),
		};
	}

	async start(): Promise<void> {
		if (this.started) return;
		if (this.closed) throw new Error("Host runtime is closed");
		const role = this.lifecycle.active().runtime;
		try {
			this.uninstallFsAudit = installFsAudit({
				auditRoots: this.options.auditRoots ?? [this.options.dataDir],
				logger: this.options.logger,
				onHit: (hit) => {
					void this.lifecycle
						.active()
						.runtime.auditStore.append("fsop", "delete_attempt", JSON.stringify(hit))
						.catch(() => undefined);
				},
			});
			await role.recoverExternalRuns();
			this.started = true;
			this.bindRoleInternalSubscriptions();
			void role.auditStore.prune().catch(() => undefined);
			this.reconcileProxy("network proxy reconciliation");
			this.scheduleRoleReconciliation();
		} catch (error) {
			this.started = false;
			await role.pi.closeAll().catch(() => undefined);
			this.uninstallFsAudit?.uninstall();
			this.uninstallFsAudit = undefined;
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.lifetime.abort();
		this.started = false;
		this.providers.dispose();
		this.unsubscribeProxyHotReload?.();
		for (const subscription of this.invalidationSubscriptions) subscription.stop?.();
		this.invalidationSubscriptions.clear();
		this.livePushListeners.clear();
		await Promise.allSettled(this.backgroundAttempts.values());
		this.backgroundAttempts.clear();
		let failure: unknown;
		try {
			await this.lifecycle.close();
		} catch (error) {
			failure = error;
		}
		this.uninstallFsAudit?.uninstall();
		this.storage.close();
		if (failure) throw failure;
	}

	private createRoleResource(runtimeId: string, runtime: CharacterRuntime): RoleResource {
		const memoryEmbedding: HostCompositionContext["memoryEmbedding"] = {
			validateLocal: (input) => validateLocalEmbedding({ ...input, logger: this.memoryLogger }),
			validateRemote: (input) => validateRemoteEmbedding({ ...input, logger: this.memoryLogger }),
			resetRuntimes: () => runtime.resetMemory(),
			releaseRuntime: (companionId) =>
				companionId === runtime.companionId ? runtime.resetMemory() : Promise.resolve(),
		};
		const context: HostCompositionContext = Object.freeze({
			signal: this.lifetime.signal,
			systemOrm: this.storage.system.orm,
			orm: runtime.db.orm,
			invalidations: runtime.invalidations,
			livePush: (event: LivePush) => {
				for (const listener of this.livePushListeners) listener(event);
			},
			onboarding: runtime.onboarding,
			pi: runtime.pi,
			sessions: runtime.sessions,
			models: runtime.models,
			memoryEmbedding,
			memoryScope: this.memoryScope,
			appSettings: this.appSettings,
			credentials: this.credentials,
			externalAgentRuns: runtime.externalAgentRuns,
			externalAgents: runtime.externalAgents,
			artifacts: runtime.artifacts,
			artifactPresenter: this.options.artifactPresenter,
			characterPackagePresenter: this.options.characterPackagePresenter,
			canon: runtime.canon,
			providers: this.providers,
			characterLoader: this.characterLoader,
			drafts: this.drafts,
			companionStore: runtime.companionStore,
			defaultCharacterId: this.options.productConfig.defaultCharacterId,
			updateService: this.options.updateService,
			auditStore: runtime.auditStore,
			activateCharacter: (next: CharacterPackage, origin?: CharacterPackageOrigin) =>
				this.activateCharacter(next, origin),
			seedCharacter: (next: CharacterPackage, origin?: CharacterPackageOrigin) =>
				this.seedCharacter(next, origin, runtime),
			characterDeletionStatus: (characterId: string) => this.characterDeletionStatus(characterId),
			deleteCharacterRuntime: (characterId: string) => this.deleteCharacterRuntime(characterId),
			deleteCharacterPackage: (characterId: string) => this.deleteCharacterPackage(characterId),
		});
		const dispatcher = new Dispatcher({
			onDispatchResult: ({ channel, operation, outcome, error }) => {
				if (operation !== "mutation") return;
				void runtime.auditStore
					.append(
						auditKindForRpcMutation(channel),
						outcome === "ok" ? "rpc_committed" : "rpc_failed",
						JSON.stringify({
							channel,
							...(error
								? { error: { kind: error.kind, reason: auditReasonCode(error.reason) } }
								: {}),
						}),
					)
					.catch(() => undefined);
			},
			onProtocolViolation: (error) => {
				void runtime.auditStore
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
				runtime.invalidations.invalidate(CacheKey.audit());
			},
		});
		wireHostHandlers(dispatcher, context);
		return Object.freeze({
			runtimeId,
			characterId: runtime.companionId,
			runtime,
			dispatcher,
			memoryEmbedding,
			close: async () => {
				let failure: unknown;
				try {
					await runtime.close();
				} catch (error) {
					failure = error;
				}
				try {
					this.storage.closeCompanion(runtime.companionId);
				} catch (error) {
					failure ??= error;
				}
				if (failure) throw failure;
			},
		});
	}

	private createCharacterRuntime(companionId: string): CharacterRuntime {
		return new CharacterRuntime({
			dataRoot: this.options.dataDir,
			systemProviderDir: this.storage.layout.systemProviders,
			storage: this.storage.open(companionId),
			systemDb: this.storage.system.orm,
			characterLoader: this.characterLoader,
			providers: this.providers,
			credentials: this.credentials,
			appSettings: this.appSettings,
			forEachCompanionDatabase: (visit) => this.storage.forEachCompanionDatabase(visit),
			memoryScope: this.memoryScope,
			memoryConfig: () => {
				const settings = this.appSettings.load();
				const embeddingApiKey = this.credentials.read(REMOTE_EMBEDDING_CREDENTIAL_ID)?.apiKey;
				return mergeEmbeddingConfig(
					this.options.memoryConfig,
					settings.memoryVectorService,
					settings.modelDownloadSource,
					embeddingApiKey,
				);
			},
			piWorkerPath: this.options.piWorkerPath,
			bundledGit: this.options.bundledGit,
			logger: this.options.logger,
			onLivePush: (event) => {
				for (const listener of this.livePushListeners) listener(event);
			},
		});
	}

	private async activateCharacter(
		character: CharacterPackage,
		origin?: CharacterPackageOrigin,
	): Promise<void> {
		const previousRuntimeId = this.lifecycle.snapshot().activeRuntimeId;
		await this.lifecycle.activate(
			character.id,
			async (runtimeId) => {
				this.characterLoader.seed(this.storage.system.orm, character, origin);
				let runtime: CharacterRuntime | undefined;
				try {
					runtime = this.createCharacterRuntime(character.id);
					await runtime.recoverExternalRuns();
					this.characterLoader.activate(this.storage.system.orm, character, origin);
					return this.createRoleResource(runtimeId, runtime);
				} catch (error) {
					await runtime?.close().catch(() => undefined);
					this.storage.closeCompanion(character.id);
					throw error;
				}
			},
			(resource) => {
				this.seedCharacter(character, origin, resource.runtime);
				resource.runtime.companionStore.reconcileSchema(character.id, character.state);
				resource.runtime.canon.syncPackage(character.id, character.canon);
				const trust = this.characterLoader.pluginTrust(this.storage.system.orm, character);
				resource.runtime.pi.configure(this.characterLoader.piResources(character, trust.trusted));
			},
		);
		if (this.lifecycle.snapshot().activeRuntimeId === previousRuntimeId) return;
		for (const subscription of this.invalidationSubscriptions) {
			subscription.stop?.();
			this.bindInvalidationSubscription(subscription);
		}
		this.bindRoleInternalSubscriptions();
		if (this.started) this.scheduleRoleReconciliation();
	}

	private seedCharacter(
		character: CharacterPackage,
		origin?: CharacterPackageOrigin,
		owner = this.lifecycle.active().runtime,
	): void {
		const handle = this.storage.open(character.id);
		this.characterLoader.seed(this.storage.system.orm, character, origin);
		const invalidations = owner.invalidations;
		new ModelRegistry(
			this.storage.system.orm,
			handle.database.orm,
			invalidations,
			this.appSettings,
			(visit) => this.storage.forEachCompanionDatabase(visit),
		).seedFromSystemDefaults(character.id);
		if (character.id !== owner.companionId) this.storage.closeCompanion(character.id);
	}

	private bindInvalidationSubscription(subscription: InvalidationSubscription): void {
		subscription.stop = this.lifecycle
			.active()
			.runtime.invalidations.subscribe(subscription.listener);
	}

	private bindRoleInternalSubscriptions(): void {
		this.unsubscribeProxyHotReload?.();
		if (!this.started) return;
		this.unsubscribeProxyHotReload = this.lifecycle
			.active()
			.runtime.invalidations.subscribe(({ keys }) => {
				if (!keys.some((key) => key[0] === "settings")) return;
				this.reconcileProxy("network proxy hot reload");
			});
	}

	private reconcileProxy(label: string): void {
		const proxy = this.appSettings.load().networkProxy;
		this.scheduleBackground(label, () =>
			applyProxyConfig(proxy, {
				resolve: this.options.systemProxyResolver,
				logger: this.options.logger,
			}),
		);
	}

	private scheduleRoleReconciliation(): void {
		const role = this.lifecycle.active().runtime;
		this.scheduleBackground("provider model reconciliation", () =>
			syncAllProviderModels(this.providers, role.models),
		);
		this.scheduleBackground("Canon embedding reconciliation", () =>
			role.canon.indexPending(role.companionId),
		);
		this.scheduleBackground("external-agent result reconciliation", (signal) =>
			role.externalAgentRuns.reconcilePending(undefined, { signal }),
		);
	}

	private scheduleBackground(label: string, run: (signal: AbortSignal) => unknown): void {
		if (this.closed) return;
		let settled: Promise<void>;
		settled = Promise.resolve()
			.then(() => run(this.lifetime.signal))
			.then(() => undefined)
			.catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.options.logger?.warn?.(`${label} failed: ${detail.slice(0, 1_024)}`);
			})
			.finally(() => {
				this.backgroundAttempts.delete(settled);
			});
		this.backgroundAttempts.add(settled);
	}

	private get memoryLogger() {
		const logger = this.options.logger;
		return {
			debug: logger?.debug ?? (() => undefined),
			info: logger?.debug ?? (() => undefined),
			warn: logger?.warn ?? (() => undefined),
			error: logger?.warn ?? (() => undefined),
		};
	}
}

function mergeEmbeddingConfig(
	base: DeepPartial<MemoryTdaiConfig> | undefined,
	service: AppSettingsRecord["memoryVectorService"],
	downloadSource: AppSettingsRecord["modelDownloadSource"],
	embeddingApiKey?: string,
): DeepPartial<MemoryTdaiConfig> | undefined {
	if (!service.enabled || service.provider === "none") return base;
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
		embedding.dimensions = candidate?.dimensions;
		embedding.modelPath = candidate?.modelPath ?? service.customPath;
		embedding.hfEndpoint =
			downloadSource.type === "official"
				? "https://huggingface.co"
				: downloadSource.type === "hf-mirror"
					? "https://hf-mirror.com"
					: downloadSource.endpoint;
	} else {
		embedding.provider = "remote";
		embedding.baseUrl = service.baseUrl;
		embedding.apiKey = embeddingApiKey;
		embedding.model = service.model;
		embedding.dimensions = service.dimensions;
	}
	return { ...base, embedding: { ...base?.embedding, ...embedding } };
}

export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
	return new HostRuntime(options);
}
