import type { PiSessionLiveEvent } from "@bear-harness/protocol";
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
import { type FsProtectionHandle, installFsProtection } from "./security/fs-protection.js";
import { createModerationService, type ModerationService } from "./security/moderation.js";
import { findHostLocalEmbeddingCandidate } from "./settings/capabilities.js";
import { type AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import { CompanionStorageRegistry } from "./storage/companion-storage.js";
import { loadInstallationId } from "./storage/database.js";
import { EventBus, type HostEvent } from "./storage/event-bus.js";
import { activeCharacter } from "./storage/schema.js";

export interface RuntimeProductConfig {
	readonly defaultCharacterId: string;
}

export interface HostRuntimeOptions {
	dataDir: string;
	characterSeedRoot: string;
	productConfig: RuntimeProductConfig;
	credentialVault: CredentialVault;
	protocolViolationMode?: "throw" | "isolate";
	memoryScope?: { readonly installationId: string; readonly userId: string };
	memoryConfig?: DeepPartial<MemoryTdaiConfig>;
	backgroundAttemptTimeoutMs?: number;
	systemProxyResolver?: SystemProxyResolver;
	bundledGit?: { shellPath: string; pathEntries: string[] };
	piWorkerPath?: string;
	updateService?: HostUpdateService;
	artifactPresenter?: ArtifactPresenter;
	protectedRoots?: string[];
	moderation?: { remoteEndpoint?: string; remoteApiKey?: string };
	logger?: { debug?: (message: string) => void; warn?: (message: string) => void };
}

interface EventSubscription {
	listener: (event: HostEvent) => void;
	stop?: () => void;
}

const DEFAULT_BACKGROUND_ATTEMPT_TIMEOUT_MS = 15_000;

/** Installation services plus one physically isolated, replaceable character runtime. */
export class HostRuntime {
	readonly dispatcher: Dispatcher;
	readonly memoryScope: { readonly installationId: string; readonly userId: string };
	readonly moderation: ModerationService;
	private readonly options: HostRuntimeOptions;
	private readonly storage: CompanionStorageRegistry;
	private readonly providers: ProviderCatalog;
	private readonly credentials: CredentialStore;
	private readonly characterLoader: CharacterLoader;
	private readonly appSettings: AppSettingsStore;
	private readonly drafts: CharacterDraftService;
	private readonly lifetime = new AbortController();
	private readonly backgroundAttempts = new Map<AbortController, Promise<void>>();
	private readonly eventSubscriptions = new Set<EventSubscription>();
	private readonly piEventListeners = new Set<(event: PiSessionLiveEvent) => void>();
	private readonly composition: HostCompositionContext;
	private role: CharacterRuntime;
	private uninstallFsProtection?: FsProtectionHandle;
	private unsubscribeProxyHotReload?: () => void;
	private started = false;
	private closed = false;

	constructor(options: HostRuntimeOptions) {
		this.options = options;
		this.storage = new CompanionStorageRegistry(options.dataDir);
		const systemDb = this.storage.system.orm;
		const characterSeedRoot = process.env.BEAR_CONFIG_DIR ?? options.characterSeedRoot;
		this.characterLoader = new CharacterLoader(
			characterSeedRoot,
			this.storage.layout.charactersRoot,
		);
		this.characterLoader.bootstrapLibrary(options.productConfig.defaultCharacterId);
		this.credentials = new CredentialStore(systemDb, options.credentialVault);
		this.appSettings = new AppSettingsStore(systemDb);
		this.memoryScope = options.memoryScope ?? {
			installationId: loadInstallationId(systemDb),
			userId: "default-user",
		};
		this.moderation = createModerationService({
			remoteEndpoint: options.moderation?.remoteEndpoint,
			remoteApiKey: options.moderation?.remoteApiKey,
			logger: options.logger,
		});
		this.providers = new ProviderCatalog(
			this.credentials,
			this.storage.layout.systemProviders,
			(providerId) => {
				this.role?.eventBus.publish("provider.login_changed", { providerId });
				this.scheduleBackground("OAuth model reconciliation", async () => {
					const state = await this.providers.getOAuthSession(providerId);
					if (state.status === "completed")
						await syncProviderModels(providerId, this.providers, this.role.models);
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
		const handle = this.storage.open(character.id);
		const seedEvents = new EventBus(handle.database.orm);
		const hasPersistedActive = systemDb
			.select({ id: activeCharacter.characterId })
			.from(activeCharacter)
			.where(eq(activeCharacter.singleton, 1))
			.get();
		if (hasPersistedActive) this.characterLoader.seed(systemDb, seedEvents, character);
		else this.characterLoader.activate(systemDb, seedEvents, character);
		this.role = this.createCharacterRuntime(character.id);

		const memoryEmbedding: HostCompositionContext["memoryEmbedding"] = {
			validateLocal: (input) => validateLocalEmbedding({ ...input, logger: this.memoryLogger }),
			validateRemote: (input) => validateRemoteEmbedding({ ...input, logger: this.memoryLogger }),
			resetRuntimes: () => this.role.resetMemory(),
			releaseRuntime: (companionId) =>
				companionId === this.role.companionId ? this.role.resetMemory() : Promise.resolve(),
		};
		this.composition = {
			signal: this.lifetime.signal,
			systemOrm: systemDb,
			orm: this.role.db.orm,
			eventBus: this.role.eventBus,
			onboarding: this.role.onboarding,
			pi: this.role.pi,
			sessions: this.role.sessions,
			models: this.role.models,
			memoryEmbedding,
			memoryScope: this.memoryScope,
			appSettings: this.appSettings,
			credentials: this.credentials,
			externalAgentRuns: this.role.externalAgentRuns,
			externalAgents: this.role.externalAgents,
			artifacts: this.role.artifacts,
			artifactPresenter: options.artifactPresenter,
			canon: this.role.canon,
			providers: this.providers,
			characterLoader: this.characterLoader,
			drafts: this.drafts,
			companionStore: this.role.companionStore,
			defaultCharacterId: options.productConfig.defaultCharacterId,
			updateService: options.updateService,
			auditStore: this.role.auditStore,
			activateCharacter: (next, origin) => this.activateCharacter(next, origin),
			seedCharacter: (next, origin) => this.seedCharacter(next, origin),
			characterDeletionStatus: (characterId) => this.characterDeletionStatus(characterId),
			deleteCharacterRuntime: (characterId) => this.deleteCharacterRuntime(characterId),
			deleteCharacterPackage: (characterId) => this.deleteCharacterPackage(characterId),
		};
		this.dispatcher = new Dispatcher({
			syncRevision: () => this.role.syncRevision(),
			onDispatchResult: ({ channel, operation, outcome, error }) => {
				if (operation !== "mutation") return;
				void this.role.auditStore
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
			responseValidation: options.protocolViolationMode ?? "throw",
			onProtocolViolation: (error) => {
				void this.role.auditStore
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
				this.role.eventBus.publish("diagnostics.protocol_violation", {
					channel: error.channel,
					issues: error.issues,
				});
			},
		});
		wireHostHandlers(this.dispatcher, this.composition);
	}

	get artifacts(): ArtifactStore {
		return this.role.artifacts;
	}
	get auditStore(): AuditStore {
		return this.role.auditStore;
	}
	get memoryRuntime(): TencentDbRuntime {
		return this.role.memoryRuntime;
	}
	get memoryEmbedding(): HostCompositionContext["memoryEmbedding"] {
		return this.composition.memoryEmbedding;
	}

	subscribeEvents(listener: (event: HostEvent) => void, afterSeq: number): () => void {
		const subscription: EventSubscription = { listener };
		this.eventSubscriptions.add(subscription);
		this.bindEventSubscription(subscription, afterSeq);
		return () => {
			subscription.stop?.();
			this.eventSubscriptions.delete(subscription);
		};
	}

	subscribePiEvents(listener: (event: PiSessionLiveEvent) => void): () => void {
		this.piEventListeners.add(listener);
		return () => this.piEventListeners.delete(listener);
	}

	dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		if (this.closed)
			return Promise.resolve({ ok: false, error: { kind: "unavailable", reason: "host_closed" } });
		return this.dispatcher.dispatch(channel, params);
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
			active: characterId === this.role.companionId,
			default: characterId === this.options.productConfig.defaultCharacterId,
			runtimePresent,
			packagePresent: this.characterLoader.load(characterId) !== null,
		};
	}

	deleteCharacterRuntime(characterId: string): { deleted: boolean } {
		if (this.closed) throw { kind: "unavailable", reason: "host_closed" };
		if (characterId === this.role.companionId) {
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
		try {
			this.uninstallFsProtection = installFsProtection({
				protectedRoots: this.options.protectedRoots ?? [this.options.dataDir],
				logger: this.options.logger,
				onHit: (hit) => {
					void this.role.auditStore
						.append("fsop", "delete_attempt", JSON.stringify(hit))
						.catch(() => undefined);
				},
			});
			await this.role.recoverExternalRuns();
			this.started = true;
			this.bindRoleInternalSubscriptions();
			void this.role.auditStore.prune().catch(() => undefined);
			this.reconcileProxy("network proxy reconciliation");
			this.scheduleRoleReconciliation();
		} catch (error) {
			this.started = false;
			await this.role.pi.closeAll().catch(() => undefined);
			this.uninstallFsProtection?.uninstall();
			this.uninstallFsProtection = undefined;
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
		for (const subscription of this.eventSubscriptions) subscription.stop?.();
		this.eventSubscriptions.clear();
		this.piEventListeners.clear();
		for (const controller of this.backgroundAttempts.keys()) controller.abort();
		await Promise.allSettled(this.backgroundAttempts.values());
		this.backgroundAttempts.clear();
		let failure: unknown;
		try {
			await this.role.close();
		} catch (error) {
			failure = error;
		}
		this.uninstallFsProtection?.uninstall();
		this.storage.close();
		if (failure) throw failure;
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
			onPiEvent: (event) => {
				for (const listener of this.piEventListeners) listener(event);
			},
		});
	}

	private async activateCharacter(
		character: CharacterPackage,
		origin?: CharacterPackageOrigin,
	): Promise<void> {
		if (character.id === this.role.companionId) {
			this.seedCharacter(character, origin);
			this.role.companionStore.reconcileSchema(character.id, character.state);
			this.role.canon.syncPackage(character.id, character.canon);
			const trust = this.characterLoader.pluginTrust(this.storage.system.orm, character);
			this.role.pi.configure(this.characterLoader.piResources(character, trust.trusted));
			return;
		}
		const handle = this.storage.open(character.id);
		const targetEvents = new EventBus(handle.database.orm);
		this.characterLoader.seed(this.storage.system.orm, targetEvents, character, origin);
		let next: CharacterRuntime | undefined;
		try {
			next = this.createCharacterRuntime(character.id);
			await next.recoverExternalRuns();
			this.characterLoader.activate(this.storage.system.orm, next.eventBus, character, origin);
		} catch (error) {
			await next?.close().catch(() => undefined);
			this.storage.closeCompanion(character.id);
			throw error;
		}
		const previous = this.role;
		this.role = next;
		this.applyRoleToComposition();
		for (const subscription of this.eventSubscriptions) {
			subscription.stop?.();
			this.bindEventSubscription(subscription, 0);
		}
		this.bindRoleInternalSubscriptions();
		try {
			await previous.close();
		} catch {
			this.options.logger?.warn?.("previous character runtime cleanup failed after activation");
		}
		try {
			this.storage.closeCompanion(previous.companionId);
		} catch {
			this.options.logger?.warn?.("previous character database cleanup failed after activation");
		}
		if (this.started) this.scheduleRoleReconciliation();
	}

	private seedCharacter(character: CharacterPackage, origin?: CharacterPackageOrigin): void {
		const handle = this.storage.open(character.id);
		const events =
			character.id === this.role.companionId
				? this.role.eventBus
				: new EventBus(handle.database.orm);
		this.characterLoader.seed(this.storage.system.orm, events, character, origin);
		new ModelRegistry(
			this.storage.system.orm,
			handle.database.orm,
			events,
			this.appSettings,
		).seedFromSystemDefaults(character.id);
		if (character.id !== this.role.companionId) this.storage.closeCompanion(character.id);
	}

	private applyRoleToComposition(): void {
		Object.assign(this.composition, {
			orm: this.role.db.orm,
			eventBus: this.role.eventBus,
			onboarding: this.role.onboarding,
			pi: this.role.pi,
			sessions: this.role.sessions,
			models: this.role.models,
			externalAgentRuns: this.role.externalAgentRuns,
			externalAgents: this.role.externalAgents,
			artifacts: this.role.artifacts,
			canon: this.role.canon,
			companionStore: this.role.companionStore,
			auditStore: this.role.auditStore,
		});
	}

	private bindEventSubscription(subscription: EventSubscription, afterSeq: number): void {
		const bus = this.role.eventBus;
		subscription.stop = bus.subscribe(subscription.listener);
		let cursor = afterSeq;
		for (;;) {
			const batch = bus.after(cursor);
			if (!batch.length) break;
			for (const event of batch) {
				subscription.listener(event);
				cursor = event.seq;
			}
		}
	}

	private bindRoleInternalSubscriptions(): void {
		this.unsubscribeProxyHotReload?.();
		if (!this.started) return;
		this.unsubscribeProxyHotReload = this.role.eventBus.subscribe((event) => {
			const payload = event.payload as { changed?: string[] } | undefined;
			if (event.kind !== "settings.changed" || !payload?.changed?.includes("networkProxy")) return;
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
		const role = this.role;
		this.scheduleBackground("provider model reconciliation", () =>
			syncAllProviderModels(this.providers, role.models),
		);
		this.scheduleBackground("Canon embedding reconciliation", () =>
			role.canon.indexPending(role.companionId),
		);
		this.scheduleBackground("external-agent result reconciliation", (signal) =>
			role.externalAgentRuns.reconcilePending(undefined, {
				signal,
				timeoutMs: this.backgroundAttemptTimeoutMs,
			}),
		);
	}

	private scheduleBackground(label: string, run: (signal: AbortSignal) => unknown): void {
		if (this.closed) return;
		const controller = new AbortController();
		const work = Promise.resolve().then(() => run(controller.signal));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancelled = new Promise<void>((resolve) => {
			controller.signal.addEventListener("abort", () => resolve(), { once: true });
			timer = setTimeout(() => controller.abort(), this.backgroundAttemptTimeoutMs);
		});
		const settled = Promise.race([work.then(() => undefined), cancelled])
			.catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.options.logger?.warn?.(`${label} failed: ${detail.slice(0, 1_024)}`);
			})
			.finally(() => {
				clearTimeout(timer);
				this.backgroundAttempts.delete(controller);
			});
		this.backgroundAttempts.set(controller, settled);
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

	private get backgroundAttemptTimeoutMs(): number {
		return this.options.backgroundAttemptTimeoutMs ?? DEFAULT_BACKGROUND_ATTEMPT_TIMEOUT_MS;
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
		embedding.apiKey = embeddingApiKey ?? "";
		embedding.model = service.model ?? "";
		embedding.dimensions = service.dimensions ?? 0;
	}
	return { ...base, embedding: { ...base?.embedding, ...embedding } };
}

export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
	return new HostRuntime(options);
}
