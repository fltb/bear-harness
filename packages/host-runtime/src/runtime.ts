import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { LivePush, MemoryInspectRequest, MemoryInspectResponse } from "@bear-harness/protocol";
import {
	CacheKey,
	CHANNEL_CONTRACTS,
	type Channel,
	ProviderLoginResponse,
} from "@bear-harness/protocol/schema";
import { inspectLocalMemory, type MemoryTdaiConfig } from "@bear-harness/tdai-core";
import type { Credential as PiCredential, Provider } from "@earendil-works/pi-ai";
import { isNull, or } from "drizzle-orm";
import type { ArtifactPresenter } from "./artifacts/presentation.js";
import { CharacterRuntime } from "./character-runtime.js";
import { type CharacterResource, CharacterRuntimeRegistry } from "./character-runtime-registry.js";
import { CharacterDraftService } from "./companion/character-draft-service.js";
import {
	CharacterLoader,
	type CharacterPackage,
	type CharacterPackageOrigin,
} from "./companion/character-loader.js";
import {
	type HostCompositionContext,
	type HostUpdateService,
	recoverProviderRemovals,
	type SystemCompositionContext,
	syncAllProviderModels,
	syncProviderModels,
	wireCharacterHandlers,
	wireSystemHandlers,
} from "./composition.js";
import { Dispatcher, normalizeHandlerError, type RpcResponse } from "./dispatcher.js";
import { assertRuntimeDeletable } from "./external-agents/run-service.js";
import { ExplicitMemoryFile } from "./memory/explicit-memory.js";
import { LocalEmbeddingAcquisitionService } from "./memory/local-embedding-acquisition.js";
import {
	type DeepPartial,
	validateLocalEmbedding,
	validateRemoteEmbedding,
} from "./memory/tencentdb-runtime.js";
import { SystemModelRegistry } from "./models/registry.js";
import { applyProxyConfig, type SystemProxyResolver } from "./network/proxy-config.js";
import { ProviderCatalog } from "./providers/catalog.js";
import {
	CredentialStore,
	type CredentialVault,
	REMOTE_EMBEDDING_CREDENTIAL_ID,
} from "./providers/credential-store.js";
import { auditKindForRpcMutation, auditReasonCode } from "./security/audit-store.js";
import { type FsAuditHandle, installFsAudit } from "./security/fs-audit.js";
import { findHostLocalEmbeddingCandidate } from "./settings/capabilities.js";
import { type AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import { CompanionStorageRegistry } from "./storage/companion-storage.js";
import { loadInstallationId } from "./storage/database.js";
import { InvalidationHub, type InvalidationListener } from "./storage/invalidation-hub.js";
import { runs } from "./storage/schema.js";

export interface RuntimeProductConfig {
	readonly defaultCharacterId: string;
}

export interface HostRuntimeOptions {
	systemDiagnosticsDirectory?: string;
	systemLaunchId?: string;
	systemDiagnostic?: (attributes: {
		stage: string;
		outcome: string;
		durationMs: number;
		bytes: number;
	}) => void;
	dataDir: string;
	characterSeedRoot: string;
	productConfig: RuntimeProductConfig;
	credentialVault: CredentialVault;
	/** Trusted Host-only credentials injected for this process and never persisted. */
	sessionProviderCredentials?: readonly {
		readonly providerId: string;
		readonly credential: PiCredential;
	}[];
	memoryScope?: { readonly installationId: string; readonly userId: string };
	nativeProviders?: readonly Provider[];
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

interface RoleResource extends CharacterResource {
	readonly runtime: CharacterRuntime;
	readonly dispatcher: Dispatcher;
}

/** Installation services and an explicit registry of independently retained characters. */
export class HostRuntime {
	readonly dispatcher: Pick<Dispatcher, "dispatch">;
	readonly memoryScope: { readonly installationId: string; readonly userId: string };
	readonly memoryEmbedding: HostCompositionContext["memoryEmbedding"];
	private readonly storage: CompanionStorageRegistry;
	private readonly providers: ProviderCatalog;
	private readonly credentials: CredentialStore;
	private readonly characterLoader: CharacterLoader;
	private readonly appSettings: AppSettingsStore;
	private readonly drafts: CharacterDraftService;
	private readonly models: SystemModelRegistry;
	private readonly systemInvalidations = new InvalidationHub();
	private readonly localEmbeddingAcquisition: LocalEmbeddingAcquisitionService;
	private readonly lifetime = new AbortController();
	private readonly backgroundAttempts = new Set<Promise<void>>();
	private readonly systemRequests = new Set<Promise<RpcResponse>>();
	private readonly invalidationListeners = new Set<InvalidationListener>();
	private readonly livePushListeners = new Set<(event: LivePush) => void>();
	private readonly registry: CharacterRuntimeRegistry<RoleResource>;
	private readonly systemDispatcher: Dispatcher;
	private readonly systemContext: SystemCompositionContext;
	private uninstallFsAudit?: FsAuditHandle;
	private started = false;
	private startPromise?: Promise<void>;
	private closed = false;
	private closePromise?: Promise<void>;
	private shutdownComplete = false;

	get diagnosticsPolicy() {
		return this.appSettings.loadDiagnostics();
	}

	constructor(private readonly options: HostRuntimeOptions) {
		this.storage = new CompanionStorageRegistry(options.dataDir);
		const systemDb = this.storage.system.orm;
		this.characterLoader = new CharacterLoader(
			options.characterSeedRoot,
			this.storage.layout.charactersRoot,
		);
		this.characterLoader.bootstrapLibrary(options.productConfig.defaultCharacterId);
		this.credentials = new CredentialStore(systemDb, options.credentialVault);
		this.appSettings = new AppSettingsStore(systemDb);
		this.localEmbeddingAcquisition = new LocalEmbeddingAcquisitionService({
			diagnostic: options.systemDiagnostic,
			layout: this.storage.layout,
			onStateChange: (state) => this.publish({ type: "embeddingAcquisition", state }),
		});
		this.memoryScope = options.memoryScope ?? {
			installationId: loadInstallationId(systemDb),
			userId: "default-user",
		};
		this.models = new SystemModelRegistry(
			systemDb,
			this.systemInvalidations,
			this.appSettings,
			(visit) => this.storage.forEachCompanionDatabase(visit),
		);
		this.providers = new ProviderCatalog(
			this.credentials,
			this.storage.layout.systemProviders,
			(providerId) => {
				this.scheduleBackground("OAuth model reconciliation", async () => {
					const state = await this.providers.getOAuthSession(providerId);
					this.publish({
						type: "providerLogin",
						providerId,
						state: ProviderLoginResponse.parse(state),
					});
					if (state.status === "completed")
						await syncProviderModels(providerId, this.providers, this.models);
				});
			},
			options.nativeProviders,
		);
		this.drafts = new CharacterDraftService(systemDb, this.characterLoader);
		const defaultCharacter = this.characterLoader.load(options.productConfig.defaultCharacterId);
		if (!defaultCharacter) throw new Error("default character package missing");
		this.characterLoader.seed(systemDb, defaultCharacter);
		this.registry = new CharacterRuntimeRegistry((id, retain) =>
			this.createRoleResource(id, retain),
		);
		this.memoryEmbedding = {
			validateLocal: (input) => validateLocalEmbedding({ ...input, logger: this.memoryLogger }),
			validateRemote: (input) => validateRemoteEmbedding({ ...input, logger: this.memoryLogger }),
			resetRuntimes: () => this.registry.visitOpen((resource) => resource.runtime.resetMemory()),
			releaseRuntime: (id) =>
				this.registry.visitOpen((resource) =>
					resource.characterId === id ? resource.runtime.resetMemory() : undefined,
				),
		};
		this.systemContext = Object.freeze({
			signal: this.lifetime.signal,
			systemOrm: systemDb,
			runnerProbeRoot: join(this.storage.layout.systemProviders, "runner-probes"),
			runnerProviderRoot: this.storage.layout.systemProviders,
			piWorkerPath: options.piWorkerPath,
			invalidations: this.systemInvalidations,
			livePush: (event: LivePush) => this.publish(event),
			models: this.models,
			memoryEmbedding: this.memoryEmbedding,
			localEmbeddingAcquisition: this.localEmbeddingAcquisition,
			memoryScope: this.memoryScope,
			appSettings: this.appSettings,
			credentials: this.credentials,
			providers: this.providers,
			characterLoader: this.characterLoader,
			drafts: this.drafts,
			artifactPresenter: options.artifactPresenter,
			characterPackagePresenter: options.characterPackagePresenter,
			defaultCharacterId: options.productConfig.defaultCharacterId,
			updateService: options.updateService,
			reloadCharacter: (id: string) => this.registry.close(id),
			seedCharacter: (character: CharacterPackage, origin?: CharacterPackageOrigin) => {
				this.characterLoader.seed(systemDb, character, origin);
				this.systemInvalidations.invalidate(CacheKey.characters());
			},
			characterDeletionStatus: (id: string) => this.characterDeletionStatus(id),
			deleteCharacterRuntime: (id: string) => this.deleteCharacterRuntime(id),
			deleteCharacterPackage: (id: string) => this.deleteCharacterPackage(id),
		});
		this.systemDispatcher = new Dispatcher();
		wireSystemHandlers(this.systemDispatcher, this.systemContext);
		this.systemDispatcher.seal();
		this.systemInvalidations.subscribe((notice) => {
			this.notifyInvalidation(notice);
			if (this.started && notice.keys.some((key) => key[0] === "settings"))
				this.reconcileProxy("network proxy hot reload");
		});
		this.dispatcher = Object.freeze({
			dispatch: (channel: string, params: unknown) => this.dispatch(channel, params),
		});
	}

	subscribeInvalidations(listener: InvalidationListener): () => void {
		this.invalidationListeners.add(listener);
		return () => {
			this.invalidationListeners.delete(listener);
		};
	}
	subscribeLivePush(listener: (event: LivePush) => void): () => void {
		this.livePushListeners.add(listener);
		return () => {
			this.livePushListeners.delete(listener);
		};
	}
	private notifyInvalidation(notice: Parameters<InvalidationListener>[0]): void {
		for (const listener of this.invalidationListeners) {
			try {
				listener(notice);
			} catch {
				/* transient subscriber */
			}
		}
	}
	private publish(event: LivePush): void {
		if (this.closed) return;
		for (const listener of this.livePushListeners) {
			try {
				listener(event);
			} catch {
				/* transient subscriber */
			}
		}
	}

	async dispatch(channel: string, params: unknown): Promise<RpcResponse> {
		if (this.closed) return { ok: false, error: { kind: "unavailable", reason: "host_closed" } };
		const contract = CHANNEL_CONTRACTS[channel as Channel];
		if (!contract)
			return { ok: false, error: { kind: "unavailable", reason: "handler_not_registered" } };
		// Reject malformed routes before constructing any character resources.
		const parsed = contract.request.safeParse(params);
		if (!parsed.success)
			return { ok: false, error: { kind: "invalid_request", reason: "request_validation_failed" } };
		if (contract.scope === "system") {
			const request = this.systemDispatcher.dispatch(channel, parsed.data);
			this.systemRequests.add(request);
			try {
				return await request;
			} finally {
				this.systemRequests.delete(request);
			}
		}
		const characterId = (parsed.data as { characterId: string }).characterId;
		try {
			return await this.registry.use(characterId, (resource) => {
				if (channel.startsWith("diagnostics."))
					return resource.dispatcher.dispatch(channel, parsed.data);
				const span = resource.runtime.diagnostics.span("rpc.request", {}, { channel }, true);
				return span.run(async () => {
					try {
						const response = await resource.dispatcher.dispatch(channel, parsed.data);
						span.end(response.ok ? "ok" : "error", response.ok ? undefined : response.error);
						return response;
					} catch (error) {
						span.end("error", error);
						throw error;
					}
				});
			});
		} catch (error) {
			if (error instanceof Error && error.name === "ProtocolResponseValidationError") throw error;
			return { ok: false, error: normalizeHandlerError(error) };
		}
	}

	/** Trusted Host operations pin an explicitly identified resource until completion. */
	useCharacter<T>(
		characterId: string,
		operation: (runtime: CharacterRuntime) => T | Promise<T>,
	): Promise<T> {
		return this.registry.use(characterId, (resource) => operation(resource.runtime));
	}
	characterDeletionStatus(characterId: string) {
		if (this.closed) throw { kind: "unavailable", reason: "host_closed" };
		return {
			characterId,
			default: characterId === this.options.productConfig.defaultCharacterId,
			runtimePresent: this.storage.hasCompanionRuntime(characterId),
			packagePresent: this.characterLoader.load(characterId) !== null,
		};
	}
	async deleteCharacterRuntime(characterId: string): Promise<{ deleted: boolean }> {
		if (this.closed) throw { kind: "unavailable", reason: "host_closed" };
		const deleted = await this.registry.deleteRuntime(characterId, () => {
			// Recheck cold runtimes and deletion requests that arrived during an ordinary
			// close. The registry still fences admissions while this temporary DB is open.
			if (this.storage.hasCompanionRuntime(characterId)) {
				const storage = this.storage.open(characterId);
				try {
					assertRuntimeDeletable(storage.database.orm);
				} finally {
					this.storage.release(storage);
				}
			}
			return this.storage.deleteCompanionRuntime(characterId);
		});
		this.systemInvalidations.invalidate(
			CacheKey.characterRuntime(characterId),
			CacheKey.characters(),
		);
		return { deleted };
	}
	deleteCharacterPackage(characterId: string): { deleted: boolean } {
		if (this.closed) throw { kind: "unavailable", reason: "host_closed" };
		const deleted = this.characterLoader.deletePackage(this.storage.system.orm, characterId, {
			defaultCharacterId: this.options.productConfig.defaultCharacterId,
			runtimeExists: this.storage.hasCompanionRuntime(characterId),
		});
		this.systemInvalidations.invalidate(CacheKey.characters());
		return { deleted };
	}

	start(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Host runtime is closed"));
		if (this.started) return Promise.resolve();
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startResources().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async startResources(): Promise<void> {
		for (const seed of this.options.sessionProviderCredentials ?? [])
			await this.credentials.set(
				seed.providerId,
				{ piCredential: seed.credential },
				{ sessionOnly: true },
			);
		if (this.closed) throw new Error("Host runtime is closed");
		await recoverProviderRemovals(this.providers, this.models);
		if (this.closed) throw new Error("Host runtime is closed");
		await syncAllProviderModels(this.providers, this.models);
		if (this.closed) throw new Error("Host runtime is closed");
		this.uninstallFsAudit = installFsAudit({
			auditRoots: this.options.auditRoots ?? [this.options.dataDir],
			onHit: (hit) =>
				this.options.systemDiagnostic?.({
					stage: "fs.delete",
					outcome: hit.operation,
					durationMs: 0,
					bytes: 0,
				}),
		});
		this.started = true;
		this.reconcileProxy("network proxy reconciliation");
		// Recovery is independent of UI selection. Existing character runtimes remain isolated.
		const recovering: string[] = [];
		this.storage.forEachCompanionDatabase((database, characterId) => {
			if (
				database
					.select({ id: runs.id })
					.from(runs)
					.where(or(isNull(runs.completedAt), isNull(runs.resultReportedAt)))
					.limit(1)
					.get()
			)
				recovering.push(characterId);
		});
		for (const id of recovering)
			if (this.characterLoader.load(id))
				await this.registry.use(id, (resource) => resource.runtime.recoverExternalRuns());
	}

	close(): Promise<void> {
		if (this.shutdownComplete) return Promise.resolve();
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.started = false;
		this.lifetime.abort();
		this.closePromise = this.closeResources().finally(() => {
			this.closePromise = undefined;
		});
		return this.closePromise;
	}
	private async closeResources(): Promise<void> {
		// Stop producers immediately; admitted work may need this cancellation to finish.
		const shutdown = this.registry.shutdown();
		const acquisition = this.localEmbeddingAcquisition.close();
		const stopping = Promise.allSettled([shutdown, acquisition]);
		await Promise.allSettled([
			this.startPromise,
			...this.systemRequests,
			...this.backgroundAttempts,
		]);
		const results = await stopping;
		const errors = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (errors.length) throw new AggregateError(errors, "Host resource shutdown failed");
		this.providers.dispose();
		this.uninstallFsAudit?.uninstall();
		await this.characterLoader.closeImports();
		this.storage.close();
		this.invalidationListeners.clear();
		this.livePushListeners.clear();
		this.shutdownComplete = true;
	}

	private async createRoleResource(
		characterId: string,
		retain: (resource: RoleResource) => void,
	): Promise<RoleResource> {
		const character = this.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		this.characterLoader.seed(this.storage.system.orm, character);
		const storage = this.storage.open(characterId);
		let runtime: CharacterRuntime;
		try {
			runtime = this.createCharacterRuntime(storage);
		} catch (error) {
			this.storage.release(storage);
			throw error;
		}
		const stopInvalidations = runtime.invalidations.subscribe((notice) =>
			this.notifyInvalidation(notice),
		);
		const context: HostCompositionContext = Object.freeze({
			...this.systemContext,
			characterId,
			signal: runtime.signal,
			orm: runtime.db.orm,
			invalidations: runtime.invalidations,
			onboarding: runtime.onboarding,
			pi: runtime.pi,
			sessions: runtime.sessions,
			models: runtime.models,
			inspectMemory: (request: MemoryInspectRequest) => this.inspectMemory(runtime, request),
			diagnostics: runtime.diagnostics,
			diagnosticDirectories: {
				system: this.options.systemDiagnosticsDirectory ?? this.storage.layout.systemDiagnostics,
				character: runtime.diagnostics.root,
				memory: storage.paths.tdaiMemory,
			},
			externalAgentRuns: runtime.externalAgentRuns,
			artifacts: runtime.artifacts,
			canon: runtime.canon,
			companionStore: runtime.companionStore,
			auditStore: runtime.auditStore,
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
		const resource = Object.freeze({
			characterId,
			runtime,
			dispatcher,
			stop: () => runtime.stop(),
			verifyDelete: () => runtime.externalAgentRuns.assertRuntimeDeletable(),
			close: async () => {
				await runtime.close();
				stopInvalidations();
				this.storage.release(storage);
			},
		});
		retain(resource);
		await runtime.artifacts.initMaintenance();
		wireCharacterHandlers(dispatcher, context);
		dispatcher.seal();
		runtime.models.seedFromSystemDefaults(characterId, this.providers.modelProjectionFacts());
		this.scheduleBackground("character reconciliation", () =>
			this.registry.use(characterId, async (resource) => {
				await resource.runtime.recoverExternalRuns();
				if (resource.runtime.signal.aborted) return;
				await resource.runtime.canon.indexPending(characterId);
				await resource.runtime.externalAgentRuns.reconcilePending(undefined, {
					signal: resource.runtime.signal,
				});
			}),
		);
		return resource;
	}

	private createCharacterRuntime(
		storage: import("./storage/companion-storage.js").CompanionStorageHandle,
	): CharacterRuntime {
		return new CharacterRuntime({
			systemLaunchId: this.options.systemLaunchId,
			dataRoot: this.options.dataDir,
			systemProviderDir: this.storage.layout.systemProviders,
			storage,
			systemDb: this.storage.system.orm,
			systemInvalidations: this.systemInvalidations,
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
					(candidateId) => this.localEmbeddingAcquisition.resolveCandidatePath(candidateId),
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

	private async inspectMemory(
		runtime: CharacterRuntime,
		request: MemoryInspectRequest,
	): Promise<MemoryInspectResponse> {
		const status = this.characterDeletionStatus(request.characterId);
		if (!status.packagePresent) throw { kind: "not_found", reason: "character_package_missing" };
		const base = {
			characterId: request.characterId,
			relationshipMemoryEnabled: runtime.relationshipMemoryEnabled,
		};
		if (!status.runtimePresent) return { ...base, explicit: "", items: [] };
		const paths = this.storage.layout.companion(request.characterId);
		for (const directory of request.kind === "explicit"
			? [paths.memory]
			: [paths.memory, paths.tdaiMemory]) {
			try {
				const stat = await lstat(directory);
				if (!stat.isDirectory() || stat.isSymbolicLink()) {
					throw { kind: "unavailable", reason: "character_memory_path_unsafe" };
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (request.kind === "explicit") {
			const explicit = await new ExplicitMemoryFile(
				this.options.dataDir,
				this.memoryScope.userId,
				request.characterId,
			).read();
			return { ...base, explicit, items: [] };
		}
		const page = await inspectLocalMemory(paths.tdaiMemory, {
			kind: request.kind,
			offset: request.offset,
			limit: request.limit,
		});
		return { ...base, ...page };
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
	embeddingApiKey: string | undefined,
	resolveCandidatePath: (candidateId: string) => string,
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
		embedding.modelPath = candidate ? resolveCandidatePath(candidate.id) : service.customPath;
		embedding.download = false;
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
