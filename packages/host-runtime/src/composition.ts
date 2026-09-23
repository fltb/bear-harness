/**
 * Host composition — wires all domain services to the instance dispatcher.
 *
 * Called from `HostRuntime` construction after the database is open. Each
 * domain registers its handlers via `dispatcher.registerHandler(channel,
 * handler)`. Handlers run inside the dispatcher's schema-validation envelope
 * and receive no `BrowserWindow` argument: everything they need lives on the
 * instance-scoped composition context.
 *
 * Every public RPC endpoint is registered here; the contract gate prevents
 * protocol additions from landing without a corresponding Host handler.
 */

import type {
	LivePush,
	MemoryInspectRequest,
	MemoryInspectResponse,
	ProviderLoginResponse,
	ResponseOf,
} from "@bear-harness/protocol";
import { CacheKey, RPC } from "@bear-harness/protocol/schema";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { and, eq } from "drizzle-orm";
import type { ArtifactStore } from "./artifacts/index.js";
import type { ArtifactPresenter } from "./artifacts/presentation.js";
import { registerArtifactHandlers } from "./artifacts/rpc.js";
import type { CanonHubService } from "./canon/service.js";
import type { CharacterDraftService } from "./companion/character-draft-service.js";
import type {
	CharacterLoader,
	CharacterPackage,
	CharacterPackageOrigin,
} from "./companion/character-loader.js";
import type { CompanionStateStore } from "./companion/companion-store.js";
import type { FirstMeetingMachine } from "./companion/first-meeting.js";
import {
	projectPiConversationDetail,
	projectPiConversationHistory,
} from "./companion/pi-live-events.js";
import type { PiRuntime } from "./companion/pi-runtime.js";
import type { SessionCatalog } from "./companion/session-catalog.js";
import type { CharacterTrace } from "./diagnostics/character-trace.js";
import type { Dispatcher } from "./dispatcher.js";
import { registerRunnerHandlers } from "./executors/rpc.js";
import type { ExternalAgentRunService, RunSummary } from "./external-agents/run-service.js";
import type { LocalEmbeddingAcquisitionService } from "./memory/local-embedding-acquisition.js";
import type {
	validateLocalEmbedding,
	validateRemoteEmbedding,
} from "./memory/tencentdb-runtime.js";
import type {
	ModelDefaults,
	ModelRecord,
	ModelRegistry,
	SystemModelDefaults,
	SystemModelRegistry,
} from "./models/registry.js";
import type { OAuthSessionState, ProviderCatalog } from "./providers/catalog.js";
import {
	type CredentialStore,
	REMOTE_EMBEDDING_CREDENTIAL_ID,
} from "./providers/credential-store.js";
import type { AuditStore } from "./security/audit-store.js";
import { HOST_SETTINGS_CAPABILITIES } from "./settings/capabilities.js";
import type { AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import type { AppDatabase } from "./storage/database.js";
import type { InvalidationHub } from "./storage/invalidation-hub.js";
import { characterMemorySettings, conversations } from "./storage/schema.js";
import { assertSystemOnboardingLicenses } from "./system-onboarding-license.js";

/** Desktop-owned update lifecycle adapter used by the optional Host wiring. */
export type HostUpdateService = {
	check(): Promise<ResponseOf<typeof RPC.update.check>>;
	discard(): Promise<ResponseOf<typeof RPC.update.discard>>;
	apply(): Promise<ResponseOf<typeof RPC.update.apply>>;
};

/** Domain services and runtime-owned inputs the handlers read and mutate. */
export interface HostCompositionContext {
	readonly characterId: string;
	/** Host lifetime; adapters must not publish after it ends. */
	signal: AbortSignal;
	systemOrm: AppDatabase;
	runnerProbeRoot: string;
	runnerProviderRoot: string;
	piWorkerPath?: string;
	orm: AppDatabase;
	invalidations: InvalidationHub;
	livePush(event: LivePush): void;
	onboarding: FirstMeetingMachine;
	pi: PiRuntime;
	sessions: SessionCatalog;
	models: ModelRegistry;
	appSettings: AppSettingsStore;
	diagnostics: CharacterTrace;
	diagnosticDirectories: { system: string; character: string; memory: string };
	localEmbeddingAcquisition: LocalEmbeddingAcquisitionService;
	inspectMemory(request: MemoryInspectRequest): Promise<MemoryInspectResponse>;
	memoryEmbedding: {
		validateLocal(options: Parameters<typeof validateLocalEmbedding>[0]): Promise<{ ready: true }>;
		validateRemote(
			options: Parameters<typeof validateRemoteEmbedding>[0],
		): Promise<{ ready: true }>;
		resetRuntimes(): Promise<void>;
		releaseRuntime(companionId: string): Promise<void>;
	};
	memoryScope: { readonly installationId: string; readonly userId: string };
	externalAgentRuns: ExternalAgentRunService;
	artifacts: ArtifactStore;
	/** Optional trusted OS-shell adapter; renderer code never receives artifact paths. */
	artifactPresenter?: ArtifactPresenter;
	characterPackagePresenter?: { reveal(directory: string): Promise<void> };
	canon: CanonHubService;
	providers: ProviderCatalog;
	credentials: CredentialStore;
	characterLoader: CharacterLoader;
	drafts: CharacterDraftService;
	companionStore: CompanionStateStore;
	defaultCharacterId: string;
	reloadCharacter(characterId: string): Promise<void>;
	seedCharacter(character: CharacterPackage, origin?: CharacterPackageOrigin): void;
	characterDeletionStatus(characterId: string): {
		characterId: string;
		default: boolean;
		runtimePresent: boolean;
		packagePresent: boolean;
	};
	deleteCharacterRuntime(characterId: string): Promise<{ deleted: boolean }>;
	deleteCharacterPackage(characterId: string): { deleted: boolean };
	/** Optional update lifecycle service (desktop only; undefined on web). */
	updateService?: HostUpdateService;
	auditStore: Pick<AuditStore, "append" | "list" | "exportLines">;
}

export type SystemCompositionContext = Omit<
	HostCompositionContext,
	| "characterId"
	| "orm"
	| "onboarding"
	| "pi"
	| "sessions"
	| "models"
	| "diagnostics"
	| "diagnosticDirectories"
	| "inspectMemory"
	| "externalAgentRuns"
	| "artifacts"
	| "canon"
	| "companionStore"
	| "auditStore"
> & { models: SystemModelRegistry };

function pageAfter<T>(
	items: readonly T[],
	cursor: string | undefined,
	limit: number,
	key: (item: T) => string,
	notFoundReason: string,
): { items: T[]; nextCursor?: string } {
	const cursorIndex = cursor === undefined ? -1 : items.findIndex((item) => key(item) === cursor);
	if (cursor !== undefined && cursorIndex < 0) {
		throw { kind: "not_found", reason: notFoundReason };
	}
	const page = items.slice(cursorIndex + 1, cursorIndex + 1 + limit);
	if (cursorIndex + 1 + page.length >= items.length) return { items: page };
	const last = page.at(-1);
	return last ? { items: page, nextCursor: key(last) } : { items: page };
}

function oauthWire(state: OAuthSessionState): ProviderLoginResponse {
	return {
		...state,
		events: state.events.map((event) => {
			if (event.type === "info")
				return {
					...event,
					links: event.links?.map((link) => ({ ...link })),
				};
			return { ...event };
		}),
		prompt: state.prompt
			? {
					...state.prompt,
					options: state.prompt.options ? [...state.prompt.options] : undefined,
				}
			: undefined,
	};
}
export async function syncProviderModels(
	providerId: string,
	providers: ProviderCatalog,
	models: SystemModelRegistry,
): Promise<ModelRecord[]> {
	const provider = (await providers.listProviders()).find(
		(candidate) => candidate.id === providerId,
	);
	if (!provider) throw { kind: "not_found", reason: "provider_not_found" };
	const facts = providers.modelProjectionFacts();
	return provider.availableModels.map((model) =>
		models.sync(
			{
				providerId,
				modelId: model.id,
				label: model.name,
				supportsImages: model.supportsImages,
			},
			facts,
		),
	);
}

export async function syncAllProviderModels(
	providers: ProviderCatalog,
	models: SystemModelRegistry,
): Promise<ModelRecord[]> {
	const providerList = (await providers.listProviders()).filter((provider) => provider.added);
	const facts = providers.modelProjectionFacts();
	return providerList.flatMap((provider) =>
		provider.availableModels.map((model) =>
			models.sync(
				{
					providerId: provider.id,
					modelId: model.id,
					label: model.name,
					supportsImages: model.supportsImages,
				},
				facts,
			),
		),
	);
}

export async function recoverProviderRemovals(
	providers: ProviderCatalog,
	models: SystemModelRegistry,
): Promise<void> {
	for (const providerId of models.listPendingProviderRemovalIds()) {
		await providers.removeProvider(providerId);
		models.finalizeProviderRemoval(providerId);
	}
}

export function wireSystemHandlers(dispatcher: Dispatcher, s: SystemCompositionContext): void {
	registerRunnerHandlers(dispatcher, s);
	dispatcher.registerHandler(RPC.bootstrap.get, () => ({
		defaultCharacterId: s.defaultCharacterId,
	}));
	const projectSettings = async (app = s.appSettings.load()) => {
		const embeddingCredential = await s.credentials.get(REMOTE_EMBEDDING_CREDENTIAL_ID);
		return {
			firstRunStage: app.firstRunStage,
			relationshipMemoryEnabled: app.memoryVectorService.enabled,
			networkProxy: app.networkProxy,
			memoryVectorService:
				app.memoryVectorService.provider === "remote"
					? {
							...app.memoryVectorService,
							hasCredential: Boolean(embeddingCredential?.apiKey),
						}
					: app.memoryVectorService,
			modelDownloadSource: app.modelDownloadSource,
		};
	};
	const persistMemoryVectorService = async (
		memoryVectorService: AppSettingsRecord["memoryVectorService"],
		options: { completeOnboarding: boolean; replacementApiKey?: string },
	): Promise<AppSettingsRecord> => {
		const previousCredential = await s.credentials.get(REMOTE_EMBEDDING_CREDENTIAL_ID);
		let credentialChanged = false;
		let app: AppSettingsRecord;
		try {
			if (memoryVectorService.provider !== "remote") {
				await s.credentials.remove(REMOTE_EMBEDDING_CREDENTIAL_ID);
				credentialChanged = true;
			} else if (options.replacementApiKey) {
				await s.credentials.set(REMOTE_EMBEDDING_CREDENTIAL_ID, {
					apiKey: options.replacementApiKey,
				});
				credentialChanged = true;
			}
			app = options.completeOnboarding
				? s.appSettings.completeEmbeddingOnboarding({ memoryVectorService })
				: s.appSettings.save({ memoryVectorService });
		} catch (error) {
			if (credentialChanged) {
				if (previousCredential?.apiKey) {
					await s.credentials.set(REMOTE_EMBEDDING_CREDENTIAL_ID, {
						apiKey: previousCredential.apiKey,
					});
				} else {
					await s.credentials.remove(REMOTE_EMBEDDING_CREDENTIAL_ID);
				}
			}
			throw error;
		}
		await s.memoryEmbedding.resetRuntimes();
		s.invalidations.invalidate(CacheKey.settings());
		return app;
	};
	dispatcher.registerHandler(RPC.character.list, async ({ cursor, limit }) => {
		return s.characterLoader.list({
			...(cursor ? { cursor } : {}),
			limit,
		});
	});
	dispatcher.registerHandler(RPC.character.packageGet, async ({ characterId }) => {
		return { package: s.characterLoader.readPackageDocument(characterId) };
	});
	dispatcher.registerHandler(RPC.character.packageUpdate, async (params) => {
		let updated: ReturnType<typeof s.characterLoader.writePackageDocument>;
		try {
			updated = s.characterLoader.writePackageDocument(params);
		} catch (error) {
			if (error && typeof error === "object" && "kind" in error) throw error;
			throw { kind: "invalid_request", reason: "character_package_invalid" };
		}
		const character = updated.character;
		s.seedCharacter(character, "local");
		await s.reloadCharacter(character.id);
		return { package: s.characterLoader.readPackageDocument(character.id) };
	});
	dispatcher.registerHandler(RPC.character.packageReveal, async ({ characterId }) => {
		const presenter = s.characterPackagePresenter;
		if (!presenter) throw { kind: "unavailable", reason: "character_package_reveal_unavailable" };
		await presenter.reveal(s.characterLoader.packageLocation(characterId));
		return { revealed: true as const };
	});
	dispatcher.registerHandler(RPC.character.deletionStatusGet, async ({ characterId }) => {
		return { status: s.characterDeletionStatus(characterId) };
	});
	dispatcher.registerHandler(RPC.character.runtimeDelete, async ({ characterId }) => {
		return {
			characterId,
			target: "runtime" as const,
			...(await s.deleteCharacterRuntime(characterId)),
		};
	});
	dispatcher.registerHandler(RPC.character.packageDelete, async ({ characterId }) => {
		return {
			characterId,
			target: "package" as const,
			...s.deleteCharacterPackage(characterId),
		};
	});
	dispatcher.registerHandler(RPC.character.import, async ({ files }) => {
		let character: ReturnType<CharacterLoader["install"]>;
		try {
			character = s.characterLoader.install(files);
		} catch (error) {
			if (error && typeof error === "object" && "kind" in error) throw error;
			throw {
				kind: "invalid_request",
				reason: error instanceof Error ? error.message : "character_package_invalid",
			};
		}
		s.seedCharacter(character, "imported");
		s.invalidations.invalidate(CacheKey.characters());
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.archiveBegin, () => s.characterLoader.archives.begin());
	dispatcher.registerHandler(RPC.character.archiveAppend, ({ uploadId, offset, base64 }) => {
		s.characterLoader.archives.append(uploadId, offset, base64);
		return {};
	});
	dispatcher.registerHandler(RPC.character.archiveCancel, ({ uploadId }) => {
		s.characterLoader.archives.cancel(uploadId);
		return {};
	});
	dispatcher.registerHandler(RPC.character.archiveFinish, async ({ uploadId }) => {
		const character = await s.characterLoader.archives.finish(uploadId);
		s.seedCharacter(character, "imported");
		s.invalidations.invalidate(CacheKey.characters());
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustGet, async ({ characterId }) => {
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return { trust: s.characterLoader.pluginTrust(s.systemOrm, character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustConfirm, async ({ characterId }) => {
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		s.seedCharacter(character);
		const trust = s.characterLoader.confirmPluginTrust(s.systemOrm, character);
		s.invalidations.invalidate(CacheKey.characterPackage(characterId));
		await s.reloadCharacter(characterId);
		return { trust };
	});
	dispatcher.registerHandler(RPC.character.draftCreate, async ({ basePackageId, locale }) => {
		return { draft: s.drafts.create({ basePackageId, locale }) };
	});
	dispatcher.registerHandler(RPC.character.draftGet, async ({ id }) => {
		return { draft: s.drafts.get(id) };
	});
	dispatcher.registerHandler(RPC.character.draftPatch, async ({ id, expectedRevision, files }) => {
		return { draft: s.drafts.applyPatch(id, expectedRevision, files) };
	});
	dispatcher.registerHandler(
		RPC.character.draftUploadAssets,
		async ({ id, expectedRevision, assets }) => {
			return { draft: s.drafts.uploadAssets(id, expectedRevision, assets) };
		},
	);
	dispatcher.registerHandler(RPC.character.draftListRevisions, async ({ id }) => {
		return { revisions: s.drafts.listRevisions(id) };
	});
	dispatcher.registerHandler(
		RPC.character.draftRestoreRevision,
		async ({ id, expectedRevision, sourceRevision }) => {
			return {
				draft: s.drafts.restoreRevision(id, expectedRevision, sourceRevision),
			};
		},
	);
	dispatcher.registerHandler(RPC.character.draftValidate, async ({ id, expectedRevision }) => {
		return { draft: s.drafts.validate(id, expectedRevision) };
	});
	dispatcher.registerHandler(RPC.character.draftPublish, async ({ id, expectedRevision }) => {
		const result = s.drafts.publish(id, expectedRevision);
		s.seedCharacter(result.character, "local");
		return {
			draft: result.draft,
			character: s.characterLoader.display(result.character),
		};
	});
	const configuredLocalTarget = () => {
		const memory = s.appSettings.load().memoryVectorService;
		if (memory.provider !== "local" || !memory.enabled) return undefined;
		if (memory.localModel) {
			return { kind: "candidate" as const, candidateId: memory.localModel };
		}
		if (memory.customPath && memory.dimensions) {
			return {
				kind: "custom" as const,
				customPath: memory.customPath,
				dimensions: memory.dimensions,
			};
		}
		return undefined;
	};
	dispatcher.registerHandler(RPC.memory.localEmbeddingInventory, async () =>
		s.localEmbeddingAcquisition.inventory(configuredLocalTarget()),
	);
	dispatcher.registerHandler(RPC.memory.localEmbeddingAcquisitionStart, async (request) =>
		s.localEmbeddingAcquisition.start(request),
	);
	dispatcher.registerHandler(RPC.memory.localEmbeddingAcquisitionStatus, async () =>
		s.localEmbeddingAcquisition.status(),
	);
	dispatcher.registerHandler(RPC.memory.localEmbeddingAcquisitionCancel, async (request) =>
		s.localEmbeddingAcquisition.cancel(request),
	);
	dispatcher.registerHandler(RPC.memory.activateLocalEmbedding, async ({ target }) => {
		const resolved = await s.localEmbeddingAcquisition.resolveInstalledTarget(target);
		await s.memoryEmbedding.validateLocal({
			modelPath: resolved.modelPath,
			dimensions: resolved.dimensions,
			download: false,
			signal: s.signal,
		});
		const app = await persistMemoryVectorService(
			{
				enabled: true,
				provider: "local",
				dimensions: resolved.dimensions,
				...(target.kind === "candidate"
					? { localModel: target.candidateId }
					: { customPath: resolved.modelPath }),
			},
			{ completeOnboarding: false },
		);
		return { settings: await projectSettings(app) };
	});
	dispatcher.registerHandler(RPC.provider.list, async ({ cursor, limit }) => {
		const result = pageAfter(
			(await s.providers.listProviders()).sort((left, right) => left.id.localeCompare(right.id)),
			cursor,
			limit,
			(provider) => provider.id,
			"provider_cursor_not_found",
		);
		return {
			providers: result.items,
			...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		};
	});
	dispatcher.registerHandler(RPC.provider.customUpsert, async (input) => {
		await s.providers.upsertCustomProvider(input);
		await syncProviderModels(input.providerId, s.providers, s.models);
		return {};
	});
	dispatcher.registerHandler(RPC.provider.importPiConfig, async ({ configJson }) => {
		await s.providers.importPiConfig(configJson);
		const models = await syncAllProviderModels(s.providers, s.models);
		return { importedCount: models.length };
	});
	dispatcher.registerHandler(RPC.provider.overrideBaseUrl, async (input) => {
		await s.providers.overrideProviderBaseUrl(input);
		return {};
	});
	dispatcher.registerHandler(
		RPC.provider.setApiKey,
		async ({ providerId, apiKey, sessionOnly }) => {
			await s.providers.setApiKey(providerId, apiKey, sessionOnly);
			await syncProviderModels(providerId, s.providers, s.models);
			return {};
		},
	);
	dispatcher.registerHandler(RPC.provider.login, async ({ providerId }) => {
		const state = s.providers.startOAuth(providerId);
		s.livePush({ type: "providerLogin", providerId, state: oauthWire(state) });
		return oauthWire(state);
	});
	dispatcher.registerHandler(RPC.provider.loginCancel, async ({ providerId }) => {
		s.providers.cancelOAuth(providerId);
		s.livePush({
			type: "providerLogin",
			providerId,
			state: { providerId, status: "failed", events: [], error: "cancelled" },
		});
		return {};
	});
	dispatcher.registerHandler(RPC.provider.loginStatus, async ({ providerId }) => {
		return oauthWire(await s.providers.getOAuthSession(providerId));
	});
	dispatcher.registerHandler(RPC.provider.loginAnswer, async ({ providerId, answer }) => {
		const state = await s.providers.answerOAuth(providerId, answer);
		s.livePush({ type: "providerLogin", providerId, state: oauthWire(state) });
		if (state.status === "completed") {
			await syncProviderModels(state.providerId, s.providers, s.models);
		}
		return oauthWire(state);
	});
	dispatcher.registerHandler(RPC.provider.remove, async ({ providerId }) => {
		s.models.prepareProviderRemoval(providerId);
		await s.providers.removeProvider(providerId);
		s.models.finalizeProviderRemoval(providerId);
		return {};
	});
	dispatcher.registerHandler(RPC.provider.logout, async ({ providerId }) => {
		await s.providers.logout(providerId);
		return {};
	});
	dispatcher.registerHandler(RPC.model.poolGet, async ({ cursor, limit }) => {
		await s.providers.listProviders();
		const result = pageAfter(
			s.models.list(s.providers.modelProjectionFacts()),
			cursor ? `${cursor.providerId}\u0000${cursor.modelId}` : undefined,
			limit,
			(model) => `${model.providerId}\u0000${model.modelId}`,
			"model_cursor_not_found",
		);
		const last = result.items.at(-1);
		return {
			models: result.items,
			...(result.nextCursor && last
				? { nextCursor: { providerId: last.providerId, modelId: last.modelId } }
				: {}),
		};
	});
	dispatcher.registerHandler(RPC.model.enable, async ({ providerId, modelId, label }) => {
		const provider = (await s.providers.listProviders()).find((item) => item.id === providerId);
		if (!provider) throw { kind: "not_found", reason: "provider_not_found" };
		const catalogModel = provider.availableModels.find((model) => model.id === modelId);
		if (!catalogModel) throw { kind: "not_found", reason: "model_not_found" };
		return {
			model: s.models.enable(
				{
					providerId,
					modelId,
					label: label ?? catalogModel.name,
					supportsImages: catalogModel.supportsImages,
				},
				s.providers.modelProjectionFacts(),
			),
		};
	});
	dispatcher.registerHandler(RPC.model.disable, async ({ providerId, modelId }) => {
		s.models.disable(providerId, modelId);
		return {};
	});
	dispatcher.registerHandler(RPC.model.systemDefaultsGet, async () =>
		systemModelDefaultsWire(s.models.systemDefaults(s.providers.modelProjectionFacts())),
	);
	dispatcher.registerHandler(RPC.model.systemDefaultsSet, async (defaults) =>
		systemModelDefaultsWire(
			s.models.setSystemDefaults(defaults, s.providers.modelProjectionFacts()),
		),
	);
	dispatcher.registerHandler(RPC.systemOnboarding.completeModel, async (request) => {
		const { licensesAcknowledged, ...defaults } = request;
		assertSystemOnboardingLicenses(process.platform, licensesAcknowledged);
		const completed = s.models.completeSystemModelOnboarding(
			defaults,
			s.providers.modelProjectionFacts(),
		);
		return {
			settings: await projectSettings(),
			defaults: systemModelDefaultsWire(completed),
		};
	});
	dispatcher.registerHandler(RPC.settings.capabilitiesGet, async () => ({
		networkProxyModes: HOST_SETTINGS_CAPABILITIES.networkProxyModes.map(({ id }) => ({ id })),
		memoryVectorProviders: HOST_SETTINGS_CAPABILITIES.memoryVectorProviders.map(
			({ id, onboarding }) => ({
				id,
				onboarding,
			}),
		),
		memoryVectorPresets: HOST_SETTINGS_CAPABILITIES.memoryVectorPresets.map(
			({ id, model, dimensions }) => ({
				id,
				model,
				dimensions,
			}),
		),
		localEmbeddingCandidates: HOST_SETTINGS_CAPABILITIES.localEmbeddingCandidates.map(
			({ id, name, dimensions, isDefault }) => ({
				id,
				name,
				dimensions,
				isDefault,
			}),
		),
	}));
	dispatcher.registerHandler(RPC.settings.get, async () => ({
		settings: await projectSettings(),
	}));
	dispatcher.registerHandler(RPC.settings.set, async ({ settings }) => {
		let app = s.appSettings.load();
		if (settings.networkProxy) {
			app = s.appSettings.save({ networkProxy: settings.networkProxy });
		} else if (settings.memoryVectorService) {
			const memoryVectorService = settings.memoryVectorService;
			if (memoryVectorService.provider === "local") {
				throw {
					kind: "conflict",
					reason: "local_embedding_requires_activation",
				};
			}
			if (memoryVectorService.provider === "remote") {
				const replacementApiKey = memoryVectorService.apiKey?.trim();
				const storedApiKey = (await s.credentials.get(REMOTE_EMBEDDING_CREDENTIAL_ID))?.apiKey;
				const apiKey = replacementApiKey || storedApiKey;
				if (
					!memoryVectorService.baseUrl ||
					!apiKey ||
					!memoryVectorService.model ||
					!memoryVectorService.dimensions
				) {
					throw { kind: "invalid_request", reason: "remote_embedding_config_incomplete" };
				}
				await s.memoryEmbedding.validateRemote({
					baseUrl: memoryVectorService.baseUrl,
					apiKey,
					model: memoryVectorService.model,
					dimensions: memoryVectorService.dimensions,
				});
				const { apiKey: _apiKey, ...persisted } = memoryVectorService;
				app = await persistMemoryVectorService(persisted, {
					completeOnboarding: false,
					...(replacementApiKey ? { replacementApiKey } : {}),
				});
			} else {
				const { apiKey: _apiKey, ...persisted } = memoryVectorService;
				app = await persistMemoryVectorService(persisted, {
					completeOnboarding: false,
				});
			}
		} else if (settings.modelDownloadSource) {
			app = s.appSettings.save({
				modelDownloadSource: settings.modelDownloadSource,
			});
		}
		s.invalidations.invalidate(CacheKey.settings());
		return { settings: await projectSettings(app) };
	});
	dispatcher.registerHandler(RPC.systemOnboarding.completeEmbedding, async (request) => {
		let app: AppSettingsRecord;
		if (request.choice === "none") {
			app = await persistMemoryVectorService(
				{ enabled: false, provider: "none" },
				{ completeOnboarding: true },
			);
		} else if (request.choice === "local") {
			const resolved = await s.localEmbeddingAcquisition.resolveInstalledTarget(request.target);
			await s.memoryEmbedding.validateLocal({
				modelPath: resolved.modelPath,
				dimensions: resolved.dimensions,
				download: false,
				signal: s.signal,
			});
			app = await persistMemoryVectorService(
				{
					enabled: true,
					provider: "local",
					dimensions: resolved.dimensions,
					...(request.target.kind === "candidate"
						? { localModel: request.target.candidateId }
						: { customPath: resolved.modelPath }),
				},
				{ completeOnboarding: true },
			);
		} else {
			const replacementApiKey = request.configuration.apiKey?.trim();
			const storedApiKey = (await s.credentials.get(REMOTE_EMBEDDING_CREDENTIAL_ID))?.apiKey;
			const apiKey = replacementApiKey || storedApiKey;
			if (!apiKey) {
				throw { kind: "invalid_request", reason: "remote_embedding_config_incomplete" };
			}
			await s.memoryEmbedding.validateRemote({
				baseUrl: request.configuration.baseUrl,
				apiKey,
				model: request.configuration.model,
				dimensions: request.configuration.dimensions,
			});
			app = await persistMemoryVectorService(
				{
					enabled: true,
					provider: "remote",
					baseUrl: request.configuration.baseUrl,
					model: request.configuration.model,
					dimensions: request.configuration.dimensions,
				},
				{
					completeOnboarding: true,
					...(replacementApiKey ? { replacementApiKey } : {}),
				},
			);
		}
		return { settings: await projectSettings(app) };
	});
	dispatcher.registerHandler(RPC.update.check, async () => {
		if (!s.updateService) {
			return {
				state: "disabled" as const,
				currentVersion: undefined,
				latestVersion: undefined,
				feedUrl: undefined,
				error: undefined,
			};
		}
		return s.updateService.check();
	});
	dispatcher.registerHandler(RPC.update.discard, async () => {
		if (!s.updateService) {
			return { state: "disabled" as const, discarded: false };
		}
		return s.updateService.discard();
	});
	dispatcher.registerHandler(RPC.update.apply, async () => {
		if (!s.updateService) {
			return {
				state: "disabled" as const,
				applyUnsupported: true as const,
				error: "Update installation is not supported by this host",
			};
		}
		return s.updateService.apply();
	});
}

export function wireCharacterHandlers(dispatcher: Dispatcher, s: HostCompositionContext): void {
	dispatcher.registerHandler(RPC.character.memoryGet, () => ({
		enabled:
			s.orm.select().from(characterMemorySettings).where(eq(characterMemorySettings.id, 1)).get()
				?.enabled === true,
	}));
	dispatcher.registerHandler(RPC.character.memorySet, async ({ enabled }) => {
		s.orm
			.insert(characterMemorySettings)
			.values({ id: 1, enabled })
			.onConflictDoUpdate({ target: characterMemorySettings.id, set: { enabled } })
			.run();
		await s.memoryEmbedding.releaseRuntime(s.characterId);
		s.invalidations.invalidate(CacheKey.characterPackage(s.characterId));
		return { enabled };
	});
	dispatcher.registerHandler(RPC.character.get, async () => {
		const companionId = s.characterId;
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.companionState.update, async ({ conversationId, changes }) => {
		await requireOwnedConversation(s, conversationId);
		const character = s.characterLoader.load(s.characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		s.companionStore.writeCompanion({
			companionId: character.id,
			conversationId,
			definition: character.state,
			changes,
			character,
		});
		const projection = s.companionStore.project(character.id, conversationId, character.state);
		s.livePush({
			type: "companionState",
			characterId: s.characterId,
			conversationId,
			state: {
				schema: JSON.parse(JSON.stringify(character.state)),
				state: {
					character: {
						document: projection.document,
						revisions: projection.revisions,
					},
					...s.companionStore.snapshot(character, conversationId),
				},
			},
		});
		return {};
	});
	dispatcher.registerHandler(RPC.companionState.get, async ({ conversationId }) => {
		await requireOwnedConversation(s, conversationId);
		const character = s.characterLoader.load(s.characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		const projection = s.companionStore.project(character.id, conversationId, character.state);
		return {
			schema: JSON.parse(JSON.stringify(character.state)),
			state: {
				character: {
					document: projection.document,
					revisions: projection.revisions,
				},
				...s.companionStore.snapshot(character, conversationId),
			},
		};
	});
	dispatcher.registerHandler(RPC.onboarding.get, async () => {
		const companionId = s.characterId;
		return s.onboarding.getState(companionId);
	});
	dispatcher.registerHandler(RPC.onboarding.submit, async ({ stepId, answer }) => {
		const companionId = s.characterId;
		return s.onboarding.submit(companionId, stepId, answer);
	});
	dispatcher.registerHandler(RPC.conversation.list, async ({ archived, title, cursor, limit }) => {
		const page = await s.sessions.listPage(s.characterId, { archived, title, cursor, limit });
		return {
			conversations: page.sessions.map((session) =>
				sessionWire(session, s.pi.snapshot(session.id)?.isStreaming ?? false),
			),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
		};
	});
	dispatcher.registerHandler(RPC.conversation.create, async ({ title }) => {
		const session = await s.sessions.create(s.characterId, title);
		s.invalidations.invalidate(CacheKey.conversations());
		return projectPiConversationDetail(session);
	});
	dispatcher.registerHandler(RPC.conversation.open, async ({ conversationId }) => {
		const session = await s.sessions.open(s.characterId, conversationId);
		return projectPiConversationDetail(session);
	});
	dispatcher.registerHandler(
		RPC.conversation.history,
		async ({ conversationId, beforeEntryId, limit }) => {
			const session = await s.sessions.open(s.characterId, conversationId);
			return projectPiConversationHistory(session, beforeEntryId, limit);
		},
	);
	dispatcher.registerHandler(RPC.conversation.rename, async ({ conversationId, title }) => {
		await s.sessions.rename(s.characterId, conversationId, title.trim());
		s.invalidations.invalidate(CacheKey.conversations());
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.archive, async ({ conversationId, archived }) => {
		await s.sessions.archive(s.characterId, conversationId, archived);
		s.invalidations.invalidate(CacheKey.conversations());
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.delete, async ({ conversationId }) => {
		await s.sessions.delete(s.characterId, conversationId);
		s.invalidations.invalidate(CacheKey.conversations(), CacheKey.conversation(conversationId));
		return {};
	});
	dispatcher.registerHandler(
		RPC.message.send,
		async ({ conversationId, text, clientMessageId }) => {
			await requireOwnedConversation(s, conversationId);
			await s.pi.send(conversationId, text, undefined, clientMessageId);
			return {};
		},
	);
	dispatcher.registerHandler(RPC.message.abort, async ({ conversationId }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.abort(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.correct, async ({ conversationId, entryId, feedback }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.correct(conversationId, entryId, feedback);
		return projectPiConversationDetail(await s.sessions.open(s.characterId, conversationId));
	});
	dispatcher.registerHandler(RPC.message.switchVersion, async ({ conversationId, leafId }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.navigate(conversationId, leafId);
		return projectPiConversationDetail(await s.sessions.open(s.characterId, conversationId));
	});
	dispatcher.registerHandler(RPC.message.edit, async ({ conversationId, entryId, text }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.edit(conversationId, entryId, text);
		return projectPiConversationDetail(await s.sessions.open(s.characterId, conversationId));
	});
	dispatcher.registerHandler(RPC.message.continue, async ({ conversationId }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.continue(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.branch, async ({ conversationId, entryId }) => {
		await requireOwnedConversation(s, conversationId);
		const session = await s.sessions.fork(s.characterId, conversationId, entryId);
		s.invalidations.invalidate(CacheKey.conversations());
		return projectPiConversationDetail(session);
	});
	dispatcher.registerHandler(RPC.memory.inspect, (request) => s.inspectMemory(request));
	dispatcher.registerHandler(RPC.canon.listSources, async ({ cursor, limit }) => {
		const result = pageAfter(
			s.canon.listSources(s.characterId),
			cursor,
			limit,
			(source) => source.id,
			"canon_source_cursor_not_found",
		);
		return {
			sources: result.items,
			...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		};
	});
	dispatcher.registerHandler(RPC.canon.addSource, async ({ logicalName, content }) => {
		return {
			source: s.canon.addSource(s.characterId, logicalName, content),
		};
	});
	dispatcher.registerHandler(RPC.canon.search, async ({ query }) => ({
		chunks: await s.canon.searchHybrid(s.characterId, query),
	}));
	dispatcher.registerHandler(RPC.canon.removeSource, async ({ sourceId }) => {
		s.canon.removeSource(s.characterId, sourceId);
		return {};
	});
	dispatcher.registerHandler(RPC.canon.listModules, async ({ cursor, limit }) => {
		const result = pageAfter(
			s.canon.listModules(s.characterId),
			cursor,
			limit,
			(module) => module.id,
			"canon_module_cursor_not_found",
		);
		return {
			modules: result.items,
			...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		};
	});
	dispatcher.registerHandler(RPC.canon.upsertModule, async (_p) => ({
		module: s.canon.upsertModule({
			..._p,
			companionId: s.characterId,
		}),
	}));
	dispatcher.registerHandler(RPC.canon.deleteModule, async ({ id }) => {
		s.canon.deleteModule(s.characterId, id);
		return {};
	});
	dispatcher.registerHandler(RPC.model.defaultsGet, async () => {
		const companionId = s.characterId;
		return modelDefaultsWire(s.models.defaults(companionId, s.providers.modelProjectionFacts()));
	});
	dispatcher.registerHandler(RPC.model.defaultsSetReply, async ({ reply, thinkingLevel }) => {
		const companionId = s.characterId;
		return modelDefaultsWire(
			s.models.setDefaultReply(
				companionId,
				reply,
				s.providers.modelProjectionFacts(),
				thinkingLevel,
			),
		);
	});
	dispatcher.registerHandler(RPC.model.defaultsSetVision, async (vision) => {
		const companionId = s.characterId;
		return modelDefaultsWire(
			s.models.setVisionDefault(companionId, vision, s.providers.modelProjectionFacts()),
		);
	});
	dispatcher.registerHandler(RPC.model.defaultsInitialize, async () => {
		const companionId = s.characterId;
		const facts = s.providers.modelProjectionFacts();
		if (s.models.seedFromSystemDefaults(companionId, facts) === "missing_system_default") {
			throw { kind: "unavailable", reason: "system_default_model_required" };
		}
		return modelDefaultsWire(s.models.defaults(companionId, facts));
	});
	dispatcher.registerHandler(RPC.model.defaultsCompleteOnboarding, async () => {
		const companionId = s.characterId;
		return modelDefaultsWire(
			s.models.completeOnboarding(companionId, s.providers.modelProjectionFacts()),
		);
	});
	dispatcher.registerHandler(RPC.model.routeGet, async ({ conversationId }) => {
		await requireOwnedConversation(s, conversationId);
		return { conversationId, ...(await s.pi.modelSettingsFor(conversationId)) };
	});
	dispatcher.registerHandler(
		RPC.model.routeSet,
		async ({ conversationId, selected, thinkingLevel }) => {
			await requireOwnedConversation(s, conversationId);
			await s.pi.setModel(conversationId, selected.providerId, selected.modelId, thinkingLevel);
			s.invalidations.invalidate(CacheKey.modelRoute(conversationId));
			return { conversationId, ...(await s.pi.modelSettingsFor(conversationId)) };
		},
	);
	dispatcher.registerHandler(RPC.run.list, async (request) => {
		if (request.conversationId) await requireOwnedConversation(s, request.conversationId);
		return s.externalAgentRuns.listPage(s.characterId, request);
	});
	dispatcher.registerHandler(RPC.run.get, async (request) => {
		await requireOwnedRun(s, request.runId);
		return s.externalAgentRuns.getDetail(request.runId, request);
	});
	dispatcher.registerHandler(RPC.run.steer, async ({ runId, instruction }) => {
		await requireOwnedRun(s, runId);
		return s.externalAgentRuns.steerRun(runId, instruction);
	});
	dispatcher.registerHandler(RPC.run.interrupt, async ({ runId }) => {
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.interruptRun(runId));
	});
	dispatcher.registerHandler(RPC.run.resume, async ({ runId, instruction }) => {
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.resumeRun(runId, instruction));
	});
	dispatcher.registerHandler(RPC.run.cancel, async ({ runId }) => {
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.cancelRun(runId));
	});
	dispatcher.registerHandler(RPC.run.retryDelivery, async ({ runId }) => {
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.retryDelivery(runId));
	});
	dispatcher.registerHandler(RPC.run.respondPermission, async ({ runId, requestId, optionId }) => {
		await requireOwnedRun(s, runId);
		return runWire(
			s,
			await s.externalAgentRuns.respondToExecutorPermission(runId, requestId, optionId),
		);
	});
	registerArtifactHandlers(dispatcher, s);
	const diagnosticSettings = () => ({
		policy: s.appSettings.loadDiagnostics(),
		health: s.diagnostics.health(),
		canReveal: Boolean(s.characterPackagePresenter),
	});
	dispatcher.registerHandler(RPC.diagnostics.get, async () => diagnosticSettings());
	dispatcher.registerHandler(RPC.diagnostics.renderer, async ({ records, rendererId, dropped }) => {
		for (const id of new Set(records.map((record) => record.conversationId)))
			await requireOwnedConversation(s, id);
		for (const record of records) {
			const { error, ...metadata } = record;
			s.diagnostics.emit(
				`renderer.${record.event}`,
				record.event === "fault" ? "error" : "trace",
				{ ...metadata, rendererId, source: "renderer-reported" },
				{ conversationId: record.conversationId },
				error ? { error } : undefined,
			);
		}
		s.diagnostics.emit(
			"renderer.buffer",
			dropped ? "warn" : "debug",
			{ rendererId, dropped, source: "renderer-reported" },
			{ conversationId: records[0]?.conversationId },
		);
		return {};
	});
	dispatcher.registerHandler(RPC.diagnostics.pin, async ({ traceId, pinned }) => {
		await s.diagnostics.pin(traceId, pinned);
		return {};
	});
	dispatcher.registerHandler(RPC.diagnostics.metrics, async () => ({
		content: JSON.stringify(s.diagnostics.metrics()),
	}));
	dispatcher.registerHandler(RPC.diagnostics.set, async ({ policy }) => {
		if (policy.traceUntil > Date.now() + 60 * 60 * 1000)
			throw { kind: "invalid_request", reason: "trace_window_max_one_hour" };
		s.appSettings.saveDiagnostics(policy);
		return diagnosticSettings();
	});
	const diagnosticRead = async <T>(operation: string, read: () => Promise<T>): Promise<T> => {
		try {
			return await read();
		} catch (error) {
			s.diagnostics.emit("diagnostics.read_failed", "error", { operation, error });
			throw { kind: "unavailable", reason: "diagnostics_read_failed" };
		}
	};
	dispatcher.registerHandler(RPC.diagnostics.list, async (query) =>
		diagnosticRead("list", () => s.diagnostics.query(query)),
	);
	dispatcher.registerHandler(RPC.diagnostics.read, async ({ traceId, offset }) =>
		diagnosticRead("read", async () => ({
			...(await s.diagnostics.page(traceId, offset)),
			pinned: await s.diagnostics.isPinned(traceId),
		})),
	);
	dispatcher.registerHandler(RPC.diagnostics.payload, async ({ traceId, sha256 }) => ({
		content: await diagnosticRead("payload", () => s.diagnostics.payload(traceId, sha256)),
	}));
	dispatcher.registerHandler(RPC.diagnostics.export, async ({ traceId }) => ({
		content: await diagnosticRead("export", () => s.diagnostics.exportTrace(traceId)),
	}));
	dispatcher.registerHandler(RPC.diagnostics.exportPage, async ({ traceId, offset, end }) =>
		diagnosticRead("export", () => s.diagnostics.exportPage(traceId, offset, end)),
	);
	dispatcher.registerHandler(RPC.diagnostics.reveal, async ({ scope }) => {
		if (!s.characterPackagePresenter)
			throw { kind: "unavailable", reason: "native_directory_reveal_unavailable" };
		await s.diagnostics.flush();
		await s.characterPackagePresenter.reveal(
			scope === "latest" ? await s.diagnostics.latestDirectory() : s.diagnosticDirectories[scope],
		);
		return {};
	});
	dispatcher.registerHandler(RPC.audit.list, async ({ limit, afterSeq }) => {
		return s.auditStore.list({ limit: limit ?? 100, afterSeq });
	});
	dispatcher.registerHandler(RPC.audit.export, async () => {
		return s.auditStore.exportLines();
	});
	dispatcher.registerHandler(RPC.snapshot.get, () => {
		const companionId = s.characterId;
		const onboarding = s.onboarding.getState(companionId);
		const character = s.characterLoader.load(companionId);
		if (!character) {
			throw { kind: "unavailable", reason: "character_package_missing" };
		}
		return {
			onboarding,
			character: s.characterLoader.display(character),
		};
	});
}

function modelRouteWire(model: { providerId: string; modelId: string }) {
	return { providerId: model.providerId, modelId: model.modelId };
}

function sessionWire(session: SessionInfo, isStreaming: boolean) {
	const firstMessage = session.firstMessage ?? "";
	return {
		conversationId: session.id,
		...(session.name ? { name: session.name } : {}),
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage,
		isStreaming,
	};
}

function modelDefaultsWire(defaults: ModelDefaults) {
	return {
		...(defaults.reply ? { reply: modelRouteWire(defaults.reply) } : {}),
		vision:
			defaults.vision.mode === "manual"
				? {
						mode: "manual" as const,
						route: modelRouteWire(defaults.vision.route),
					}
				: { mode: "auto" as const },
		onboardingComplete: defaults.onboardingComplete,
		...(defaults.thinkingLevel ? { thinkingLevel: defaults.thinkingLevel } : {}),
	};
}

function systemModelDefaultsWire(defaults: SystemModelDefaults) {
	return {
		...(defaults.reply ? { reply: modelRouteWire(defaults.reply) } : {}),
		vision:
			defaults.vision.mode === "manual"
				? { mode: "manual" as const, route: modelRouteWire(defaults.vision.route) }
				: { mode: "auto" as const },
		...(defaults.thinkingLevel ? { thinkingLevel: defaults.thinkingLevel } : {}),
	};
}

async function requireOwnedConversation(
	s: HostCompositionContext,
	conversationId: string,
): Promise<void> {
	const companionId = s.characterId;
	const row = s.orm
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.companionId, companionId)))
		.get();
	if (!row) throw { kind: "not_found", reason: "conversation_not_found" };
}

async function requireOwnedRun(s: HostCompositionContext, runId: string): Promise<void> {
	s.externalAgentRuns.assertCharacterRun(s.characterId, runId);
}

function runWire(s: HostCompositionContext, run: RunSummary) {
	return s.externalAgentRuns.project(run);
}
