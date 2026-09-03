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
	ArtifactActionRequest,
	LivePush,
	ProviderLoginResponse,
	ResponseOf,
} from "@bear-harness/protocol";
import {
	ArtifactActionResponse,
	CacheKey,
	type EmbeddingDownloadState,
	MAX_ARTIFACT_READ_BYTES,
	RPC,
} from "@bear-harness/protocol/schema";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { and, eq } from "drizzle-orm";
import type { ArtifactRecord, ArtifactStore } from "./artifacts/index.js";
import {
	type ArtifactPresenter,
	createArtifactPresentationAccess,
} from "./artifacts/presentation.js";
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
import type { Dispatcher } from "./dispatcher.js";
import type { ExternalAgentRunService, RunSummary } from "./external-agents/run-service.js";
import type {
	validateLocalEmbedding,
	validateRemoteEmbedding,
} from "./memory/tencentdb-runtime.js";
import type { ModelRecord, ModelRegistry } from "./models/registry.js";
import type { OAuthSessionState, ProviderCatalog } from "./providers/catalog.js";
import {
	type CredentialStore,
	REMOTE_EMBEDDING_CREDENTIAL_ID,
} from "./providers/credential-store.js";
import type { AuditStore } from "./security/audit-store.js";
import {
	findHostLocalEmbeddingCandidate,
	HOST_SETTINGS_CAPABILITIES,
} from "./settings/capabilities.js";
import type { AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import type { AppDatabase } from "./storage/database.js";
import type { InvalidationHub } from "./storage/invalidation-hub.js";
import { artifacts, conversations, runs } from "./storage/schema.js";

/** Desktop-owned update lifecycle adapter used by the optional Host wiring. */
export type HostUpdateService = {
	check(): Promise<ResponseOf<typeof RPC.update.check>>;
	discard(): Promise<ResponseOf<typeof RPC.update.discard>>;
	apply(): Promise<ResponseOf<typeof RPC.update.apply>>;
};

/** Domain services and runtime-owned inputs the handlers read and mutate. */
export interface HostCompositionContext {
	/** Host lifetime; adapters must not publish after it ends. */
	signal: AbortSignal;
	systemOrm: AppDatabase;
	orm: AppDatabase;
	invalidations: InvalidationHub;
	livePush(event: LivePush): void;
	onboarding: FirstMeetingMachine;
	pi: PiRuntime;
	sessions: SessionCatalog;
	models: ModelRegistry;
	appSettings: AppSettingsStore;
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
		externalAgents: {
		discover(): Promise<
			Array<{
				candidatePath: string;
				canonicalPath: string | null;
				version: string | null;
				sha256: string | null;
				status: "usable" | "not_found" | "rejected";
			}>
		>;
		consent(params: {
			canonicalPath: string;
			version: string;
			sha256: string;
		}): Promise<{ profileId: string; version: string; sha256: string }>;
		status(): Promise<
			| { available: true; profileId: string; version: string; hash: string }
			| { available: false; reason: "no_codex_found" }
			| { available: false; reason: "not_connected" }
		>;
	};
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
	activateCharacter(character: CharacterPackage, origin?: CharacterPackageOrigin): Promise<void>;
	seedCharacter(character: CharacterPackage, origin?: CharacterPackageOrigin): void;
	characterDeletionStatus(characterId: string): {
		characterId: string;
		active: boolean;
		default: boolean;
		runtimePresent: boolean;
		packagePresent: boolean;
	};
	deleteCharacterRuntime(characterId: string): { deleted: boolean };
	deleteCharacterPackage(characterId: string): { deleted: boolean };
	/** Optional update lifecycle service (desktop only; undefined on web). */
	updateService?: HostUpdateService;
	auditStore: Pick<AuditStore, "append" | "list" | "exportLines">;
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
	models: ModelRegistry,
	publish = true,
): Promise<ModelRecord[]> {
	const provider = (await providers.listProviders()).find(
		(candidate) => candidate.id === providerId,
	)!;
	return provider.availableModels.map((model) => {
		const input = {
			providerId,
			modelId: model.id,
			label: model.name,
			supportsImages: model.supportsImages,
		};
		return publish ? models.enable(input) : models.sync(input);
	});
}
export async function syncAllProviderModels(
	providers: ProviderCatalog,
	models: ModelRegistry,
): Promise<ModelRecord[]> {
	const providerList = (await providers.listProviders()).filter((provider) => provider.added);
	return (
		await Promise.all(
			providerList.map((provider) => syncProviderModels(provider.id, providers, models, false)),
		)
	).flat();
}

export function wireHostHandlers(dispatcher: Dispatcher, s: HostCompositionContext): void {
	const acceptedMessages = new Map<string, Promise<Awaited<ReturnType<typeof s.pi.send>>>>();
	const projectSettings = async (companionId: string, app = s.appSettings.load()) => {
		const stateData = s.onboarding.getState(companionId).stateData;
		const embeddingCredential = await s.credentials.get(REMOTE_EMBEDDING_CREDENTIAL_ID);
		return {
			firstRunStage: app.firstRunStage,
			relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
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
	const saveMemoryVectorService = async (
		memoryVectorService: AppSettingsRecord["memoryVectorService"],
	): Promise<void> => {
		if (memoryVectorService.provider !== "remote")
			await s.credentials.remove(REMOTE_EMBEDDING_CREDENTIAL_ID);
		const app = s.appSettings.save({ memoryVectorService });
		await s.memoryEmbedding.resetRuntimes();
		s.invalidations.invalidate(CacheKey.settings());
	};
	// Load and seed the active character package from the character root once.
	ensureCharacterSeeded(s);

	// --- character package -----------------------------------------------------
	dispatcher.registerHandler(RPC.character.get, async () => {
		const companionId = getCompanionId(s);
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.list, async () => ({
		characters: s.characterLoader.list(s.systemOrm, s.defaultCharacterId),
	}));
	dispatcher.registerHandler(RPC.character.activate, async ({ characterId }) => {
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		if (getCompanionId(s) === characterId) {
			return { character: s.characterLoader.display(character) };
		}
		await s.activateCharacter(character);
		return { character: s.characterLoader.display(character) };
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
		if (getCompanionId(s) === character.id) {
			s.companionStore.reconcileSchema(character.id, character.state);
			s.onboarding.initialize(character.id);
			s.canon.syncPackage(character.id, character.canon);
			await s.pi.closeAll();
			configureCharacterRuntime(s, character);
		}
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
			...s.deleteCharacterRuntime(characterId),
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
		const trust = s.characterLoader.pluginTrust(s.systemOrm, character);
		s.invalidations.invalidate(CacheKey.characters());
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustGet, async ({ characterId: requestedId }) => {
		const characterId = requestedId ?? getCompanionId(s);
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return { trust: s.characterLoader.pluginTrust(s.systemOrm, character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustConfirm, async ({ characterId }) => {
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		s.seedCharacter(character);
		const trust = s.characterLoader.confirmPluginTrust(s.systemOrm, character);
		s.invalidations.invalidate(CacheKey.characterPackage(getCompanionId(s)));
		if (getCompanionId(s) === characterId) {
			configureCharacterRuntime(s, character);
		}
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
		await s.activateCharacter(result.character, "local");
		return {
			draft: result.draft,
			character: s.characterLoader.display(result.character),
		};
	});
	dispatcher.registerHandler(RPC.companionState.update, async ({ conversationId, changes }) => {
		await requireOwnedConversation(s, conversationId);
		const character = s.characterLoader.load(getCompanionId(s));
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
		const character = s.characterLoader.load(getCompanionId(s));
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

	// --- role-defined onboarding -----------------------------------------------
	dispatcher.registerHandler(RPC.onboarding.get, async () => {
		const companionId = getCompanionId(s);
		return s.onboarding.getState(companionId);
	});
	dispatcher.registerHandler(RPC.onboarding.submit, async ({ stepId, answer }) => {
		const companionId = getCompanionId(s);
		return s.onboarding.submit(companionId, stepId, answer);
	});

	// --- conversation ---------------------------------------------------------
	dispatcher.registerHandler(RPC.conversation.list, async ({ archived, title, cursor, limit }) => {
		const sessions = await s.sessions.list(getCompanionId(s), { archived, title });
		const cursorIndex = cursor ? sessions.findIndex((session) => session.id === cursor) : -1;
		if (cursor && cursorIndex < 0)
			throw { kind: "not_found", reason: "conversation_cursor_not_found" };
		const page = sessions.slice(cursorIndex + 1, cursorIndex + 1 + limit);
		const hasMore = cursorIndex + 1 + page.length < sessions.length;
		return {
			conversations: page.map((session) =>
				sessionWire(session, s.pi.snapshot(session.id)?.isStreaming ?? false),
			),
			...(hasMore && page.at(-1) ? { nextCursor: page.at(-1)?.id } : {}),
		};
	});
	dispatcher.registerHandler(RPC.conversation.create, async ({ title }) => {
		const session = await s.sessions.create(getCompanionId(s), title);
		s.invalidations.invalidate(CacheKey.conversations());
		return projectPiConversationDetail(session);
	});
	dispatcher.registerHandler(RPC.conversation.open, async ({ conversationId }) => {
		const session = await s.sessions.open(getCompanionId(s), conversationId);
		return projectPiConversationDetail(session);
	});
	dispatcher.registerHandler(
		RPC.conversation.history,
		async ({ conversationId, beforeEntryId, limit }) => {
			const session = await s.sessions.open(getCompanionId(s), conversationId);
			return projectPiConversationHistory(session, beforeEntryId, limit);
		},
	);
	dispatcher.registerHandler(RPC.conversation.rename, async ({ conversationId, title }) => {
		await s.sessions.rename(getCompanionId(s), conversationId, title.trim());
		s.invalidations.invalidate(CacheKey.conversations());
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.archive, async ({ conversationId, archived }) => {
		await s.sessions.archive(getCompanionId(s), conversationId, archived);
		s.invalidations.invalidate(CacheKey.conversations());
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.delete, async ({ conversationId }) => {
		await s.sessions.delete(getCompanionId(s), conversationId);
		s.invalidations.invalidate(CacheKey.conversations());
		return {};
	});

	// --- message ----------------------------------------------------------------
	dispatcher.registerHandler(
		RPC.message.send,
		async ({ conversationId, text, clientMessageId }) => {
		await requireOwnedConversation(s, conversationId);
		const key = `${conversationId}:${clientMessageId}`;
		let accepted = acceptedMessages.get(key);
		if (!accepted) {
			accepted = s.pi.send(conversationId, text);
			acceptedMessages.set(key, accepted);
			void accepted.catch(() => acceptedMessages.delete(key));
			if (acceptedMessages.size > 1_000) {
				const oldest = acceptedMessages.keys().next().value;
				if (oldest) acceptedMessages.delete(oldest);
			}
		}
		await accepted;
		return {};
		},
	);
	dispatcher.registerHandler(RPC.message.abort, async ({ conversationId }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.abort(conversationId);
		return {};
	});
	dispatcher.registerHandler(
		RPC.message.regenerate,
		async ({ conversationId, entryId, feedback }) => {
			await requireOwnedConversation(s, conversationId);
			await s.pi.regenerate(conversationId, entryId, feedback);
			return projectPiConversationDetail(await s.sessions.open(getCompanionId(s), conversationId));
		},
	);
	dispatcher.registerHandler(RPC.message.switchVersion, async ({ conversationId, leafId }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.navigate(conversationId, leafId);
		return projectPiConversationDetail(await s.sessions.open(getCompanionId(s), conversationId));
	});
	dispatcher.registerHandler(RPC.message.edit, async ({ conversationId, entryId, text }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.edit(conversationId, entryId, text);
		return projectPiConversationDetail(await s.sessions.open(getCompanionId(s), conversationId));
	});
	dispatcher.registerHandler(RPC.message.continue, async ({ conversationId }) => {
		await requireOwnedConversation(s, conversationId);
		await s.pi.continue(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.branch, async ({ conversationId, entryId }) => {
		await requireOwnedConversation(s, conversationId);
		const session = await s.sessions.fork(getCompanionId(s), conversationId, entryId);
		return projectPiConversationDetail(session);
	});
	let embeddingDownload: EmbeddingDownloadState = { status: "idle", downloadedBytes: 0 };
	const updateEmbeddingDownload = (next: EmbeddingDownloadState) => {
		if (s.signal.aborted) return;
		const previous = embeddingDownload;
		embeddingDownload = next;
		// Notify only at meaningful byte/percent boundaries, never on a timer.
		if (
			next.status !== previous.status ||
			next.totalBytes !== previous.totalBytes ||
			Math.floor(
				next.downloadedBytes / (next.totalBytes ? Math.max(1, next.totalBytes / 100) : 1048576),
			) !==
				Math.floor(
					previous.downloadedBytes /
						(next.totalBytes ? Math.max(1, next.totalBytes / 100) : 1048576),
				)
		) {
			s.livePush({ type: "embeddingDownload", state: next });
		}
	};
	let embeddingAbort: AbortController | undefined;
	dispatcher.registerHandler(RPC.memory.localEmbeddingDownloadStatus, async () => ({
		...embeddingDownload,
	}));
	dispatcher.registerHandler(RPC.memory.cancelLocalEmbeddingDownload, async () => {
		if (!embeddingAbort) throw { kind: "conflict", reason: "embedding_download_not_running" };
		if (embeddingDownload.status === "activating")
			throw { kind: "conflict", reason: "embedding_activation_in_progress" };
		embeddingAbort.abort();
		return {};
	});
	dispatcher.registerHandler(
		RPC.memory.configureLocalEmbedding,
		async ({ provider, candidateId, customPath }) => {
			if (embeddingAbort) throw { kind: "conflict", reason: "embedding_download_in_progress" };
			if (provider === "none") {
				await saveMemoryVectorService({ enabled: false, provider: "none" });
				s.signal.throwIfAborted();
				return { ready: true as const };
			}
			const candidate = candidateId ? findHostLocalEmbeddingCandidate(candidateId) : undefined;
			if (candidateId && !candidate)
				throw {
					kind: "invalid_request",
					reason: "local_embedding_candidate_not_found",
				};
			const modelPath = candidate?.modelPath ?? customPath?.trim();
			if (!modelPath)
				throw {
					kind: "invalid_request",
					reason: "local_embedding_model_not_selected",
				};
			const source = s.appSettings.load().modelDownloadSource;
			const hfEndpoint =
				source.type === "official"
					? "https://huggingface.co"
					: source.type === "hf-mirror"
						? "https://hf-mirror.com"
						: source.endpoint;
			const endpointUrl = new URL(hfEndpoint);
			if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password) {
				throw {
					kind: "invalid_request",
					reason: "invalid_model_download_endpoint",
				};
			}
			const abort = new AbortController();
			embeddingAbort = abort;
			const abortOnClose = () => abort.abort();
			s.signal.addEventListener("abort", abortOnClose, { once: true });
			if (s.signal.aborted) abort.abort();
			updateEmbeddingDownload({ status: "preparing", downloadedBytes: 0 });
			try {
				await s.memoryEmbedding.validateLocal({
					modelPath,
					dimensions: 768,
					hfEndpoint: endpointUrl.href.replace(/\/$/, ""),
					signal: abort.signal,
					onProgress: ({ downloadedSize, totalSize }) => {
						if (abort.signal.aborted || embeddingAbort !== abort) return;
						updateEmbeddingDownload({
							status: "downloading",
							downloadedBytes: downloadedSize,
							...(totalSize > 0 ? { totalBytes: totalSize } : {}),
						});
					},
					onPhase: (status) => {
						if (abort.signal.aborted || embeddingAbort !== abort) return;
						updateEmbeddingDownload({ ...embeddingDownload, status });
					},
				});
				abort.signal.throwIfAborted();
				await saveMemoryVectorService({
					enabled: true,
					provider: "local",
					...(candidate ? { localModel: candidate.id } : { customPath: modelPath }),
				});
				updateEmbeddingDownload({ ...embeddingDownload, status: "completed" });
				return { ready: true as const };
			} catch (error) {
				updateEmbeddingDownload({
					...embeddingDownload,
					status: abort.signal.aborted ? "cancelled" : "failed",
				});
				if (abort.signal.aborted)
					throw { kind: "conflict", reason: "embedding_download_cancelled" };
				throw error;
			} finally {
				s.signal.removeEventListener("abort", abortOnClose);
				if (embeddingAbort === abort) embeddingAbort = undefined;
			}
		},
	);
	// --- canon hub (advanced authoring) ---------------------------------------------
	dispatcher.registerHandler(RPC.canon.listSources, async () => ({
		sources: s.canon.listSources(getCompanionId(s)),
	}));
	dispatcher.registerHandler(RPC.canon.addSource, async ({ logicalName, content }) => {
		return {
			source: s.canon.addSource(getCompanionId(s), logicalName, content),
		};
	});
	dispatcher.registerHandler(RPC.canon.search, async ({ query }) => ({
		chunks: await s.canon.searchHybrid(getCompanionId(s), query),
	}));
	dispatcher.registerHandler(RPC.canon.removeSource, async ({ sourceId }) => {
		s.canon.removeSource(getCompanionId(s), sourceId);
		return {};
	});
	dispatcher.registerHandler(RPC.canon.listModules, async () => ({
		modules: s.canon.listModules(getCompanionId(s)),
	}));
	dispatcher.registerHandler(RPC.canon.upsertModule, async (_p) => ({
		module: s.canon.upsertModule({
			..._p,
			companionId: getCompanionId(s),
		}),
	}));
	dispatcher.registerHandler(RPC.canon.deleteModule, async ({ id }) => {
		s.canon.deleteModule(getCompanionId(s), id);
		return {};
	});

	// --- provider ------------------------------------------------------------------
	dispatcher.registerHandler(RPC.provider.list, async () => {
		return { providers: await s.providers.listProviders() };
	});
	dispatcher.registerHandler(RPC.provider.customUpsert, async (input) => {
		await s.providers.upsertCustomProvider(input);
		await syncProviderModels(input.providerId, s.providers, s.models);
		return {};
	});
	dispatcher.registerHandler(RPC.provider.importPiConfig, async ({ configJson }) => {
		await s.providers.importPiConfig(configJson);
		const models = await syncAllProviderModels(s.providers, s.models);
		return { models };
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
		await s.providers.removeProvider(providerId);
		for (const model of s.models
			.list()
			.filter((candidate) => candidate.providerId === providerId)) {
			s.models.disable(model.providerId, model.modelId);
		}
		return {};
	});
	dispatcher.registerHandler(RPC.provider.logout, async ({ providerId }) => {
		await s.providers.logout(providerId);
		return {};
	});

	// --- configured models ------------------------------------------------------------
	dispatcher.registerHandler(RPC.model.poolGet, async () => {
		const providerNames = new Map(
			(await s.providers.listProviders()).map((provider) => [provider.id, provider.name]),
		);
		return {
			models: s.models.list().map((model) => ({
				...model,
				providerName: providerNames.get(model.providerId) ?? model.providerId,
			})),
		};
	});
	dispatcher.registerHandler(RPC.model.enable, async ({ providerId, modelId, label }) => {
		const provider = (await s.providers.listProviders()).find((item) => item.id === providerId);
		if (!provider) throw { kind: "not_found", reason: "provider_not_found" };
		const catalogModel = provider.availableModels.find((model) => model.id === modelId);
		if (!catalogModel) throw { kind: "not_found", reason: "model_not_found" };
		return {
			model: s.models.enable({
				providerId,
				modelId,
				label: label ?? catalogModel.name,
				supportsImages: catalogModel.supportsImages,
			}),
		};
	});
	dispatcher.registerHandler(RPC.model.disable, async ({ providerId, modelId }) => {
		s.models.disable(providerId, modelId);
		return {};
	});
	dispatcher.registerHandler(RPC.model.defaultsGet, async () => {
		const companionId = getCompanionId(s);
		return modelDefaultsWire(s.models.defaults(companionId));
	});
	dispatcher.registerHandler(RPC.model.defaultsSetReply, async ({ reply }) => {
		const companionId = getCompanionId(s);
		return modelDefaultsWire(s.models.setDefaultReply(companionId, reply));
	});
	dispatcher.registerHandler(RPC.model.defaultsSetVision, async (vision) => {
		const companionId = getCompanionId(s);
		return modelDefaultsWire(s.models.setVisionDefault(companionId, vision));
	});
	dispatcher.registerHandler(RPC.model.systemDefaultsGet, async () =>
		systemModelDefaultsWire(s.models.systemDefaults()),
	);
	dispatcher.registerHandler(RPC.model.systemDefaultsSet, async (defaults) =>
		systemModelDefaultsWire(s.models.setSystemDefaults(defaults)),
	);
	dispatcher.registerHandler(RPC.model.defaultsInitialize, async () => {
		const companionId = getCompanionId(s);
		if (s.models.seedFromSystemDefaults(companionId) === "missing_system_default") {
			throw { kind: "unavailable", reason: "system_default_model_required" };
		}
		return modelDefaultsWire(s.models.defaults(companionId));
	});
	dispatcher.registerHandler(RPC.model.defaultsCompleteOnboarding, async () => {
		const companionId = getCompanionId(s);
		return modelDefaultsWire(s.models.completeOnboarding(companionId));
	});
	dispatcher.registerHandler(RPC.model.routeGet, async ({ conversationId }) => {
		await requireOwnedConversation(s, conversationId);
		const selected = await s.pi.modelFor(conversationId);
		return {
			conversationId,
			...(selected ? { selected } : {}),
		};
	});
	dispatcher.registerHandler(RPC.model.routeSet, async ({ conversationId, selected }) => {
		await requireOwnedConversation(s, conversationId);
		const model = await s.pi.setModel(conversationId, selected.providerId, selected.modelId);
		s.invalidations.invalidate(CacheKey.modelRoute(conversationId));
		return { conversationId, selected: model };
	});

	// --- external agents and direct runs -----------------------------------------
	dispatcher.registerHandler(RPC.externalAgent.discoverCodex, async () => ({
		candidates: await s.externalAgents.discover(),
	}));
	dispatcher.registerHandler(RPC.externalAgent.connectCodex, async (_p) => {
		const connected = await s.externalAgents.consent(_p);
		return {
			profileId: connected.profileId,
			version: connected.version,
			hash: connected.sha256,
		};
	});
	dispatcher.registerHandler(RPC.externalAgent.status, async () => ({
		pi: { available: true as const, profileId: "pi-default" as const },
		codex: await s.externalAgents.status(),
	}));
	dispatcher.registerHandler(RPC.run.list, async () => {
		const companionId = getCompanionId(s);
		return {
			runs: s.externalAgentRuns.list(companionId).map((run) => runWire(s, run)),
		};
	});
	dispatcher.registerHandler(RPC.run.steer, async ({ runId, instruction }) => {
		await requireOwnedRun(s, runId);
		await s.externalAgentRuns.steerRun(runId, instruction);
		return {};
	});
	dispatcher.registerHandler(RPC.run.interrupt, async ({ runId }) => {
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.interruptRun(runId));
	});
	dispatcher.registerHandler(RPC.run.resume, async ({ runId }) => {
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.resumeRun(runId));
	});
	dispatcher.registerHandler(RPC.run.cancel, async ({ runId }) => {
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.cancelRun(runId));
	});
	dispatcher.registerHandler(RPC.run.respondPermission, async ({ runId, requestId, optionId }) => {
		await requireOwnedRun(s, runId);
		return runWire(
			s,
			await s.externalAgentRuns.respondToExecutorPermission(runId, requestId, optionId),
		);
	});

	// --- run-owned artifacts -------------------------------------------------------
	dispatcher.registerHandler(RPC.artifact.read, async (_p) => {
		const { offset = 0, length = MAX_ARTIFACT_READ_BYTES } = _p;
		const artifact = requireOwnedArtifact(s, _p);
		const range = s.artifacts.readBlobRange(artifact.id, offset, length);
		if (!range) throw { kind: "not_found", reason: "artifact_not_found" };
		return {
			artifact: artifactWire(artifact),
			offset,
			nextOffset: range.nextOffset,
			eof: range.eof,
			base64: range.buffer.toString("base64"),
		};
	});
	dispatcher.registerHandler(RPC.artifact.open, async (_p) => presentArtifact(s, "open", _p));
	dispatcher.registerHandler(RPC.artifact.reveal, async (_p) => presentArtifact(s, "reveal", _p));
	dispatcher.registerHandler(RPC.artifact.saveAs, async (_p) => presentArtifact(s, "saveAs", _p));

	// --- settings ----------------------------------------------------------------------
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
	dispatcher.registerHandler(RPC.settings.get, async () => {
		const companionId = getCompanionId(s);
		return { settings: await projectSettings(companionId) };
	});
	dispatcher.registerHandler(RPC.settings.set, async ({ settings }) => {
		const companionId = getCompanionId(s);
		if ("relationshipMemoryEnabled" in settings) {
			const enabled = Boolean(settings.relationshipMemoryEnabled);
			if (!enabled) await s.memoryEmbedding.releaseRuntime(companionId);
			s.onboarding.setRelationshipMemory(companionId, enabled);
		}
		let app = s.appSettings.load();
		if ("firstRunStage" in settings) {
			app = s.appSettings.save({
				firstRunStage: settings.firstRunStage as never,
			});
		}
		if ("networkProxy" in settings) {
			app = s.appSettings.save({
				networkProxy: settings.networkProxy as never,
			});
		}
		if ("memoryVectorService" in settings) {
			const memoryVectorService = settings.memoryVectorService as
				| {
						provider?: unknown;
						enabled?: boolean;
						baseUrl?: string;
						apiKey?: string;
						model?: string;
						dimensions?: number;
				  }
				| undefined;
			if (memoryVectorService?.provider === "local") {
				throw {
					kind: "conflict",
					reason: "local_embedding_requires_transaction",
				};
			}
			if (memoryVectorService?.provider === "remote" && memoryVectorService.enabled) {
				const replacementApiKey = memoryVectorService.apiKey?.trim();
				const storedApiKey = (await s.credentials.get(REMOTE_EMBEDDING_CREDENTIAL_ID))?.apiKey;
				const apiKey = replacementApiKey || storedApiKey;
				if (
					!memoryVectorService.baseUrl ||
					!apiKey ||
					!memoryVectorService.model ||
					!memoryVectorService.dimensions
				)
					throw { kind: "invalid_request", reason: "remote_embedding_config_incomplete" };
				await s.memoryEmbedding.validateRemote({
					baseUrl: memoryVectorService.baseUrl,
					apiKey,
					model: memoryVectorService.model,
					dimensions: memoryVectorService.dimensions,
				});
				if (replacementApiKey)
					await s.credentials.set(REMOTE_EMBEDDING_CREDENTIAL_ID, {
						apiKey: replacementApiKey,
					});
			} else if (memoryVectorService?.provider !== "remote") {
				await s.credentials.remove(REMOTE_EMBEDDING_CREDENTIAL_ID);
			}
			const { apiKey: _apiKey, ...persistedMemoryVectorService } = memoryVectorService ?? {};
			app = s.appSettings.save({
				memoryVectorService: persistedMemoryVectorService as never,
			});
			await s.memoryEmbedding.resetRuntimes();
		}
		if ("modelDownloadSource" in settings) {
			app = s.appSettings.save({
				modelDownloadSource: settings.modelDownloadSource as never,
			});
		}
		const nextSettings = await projectSettings(companionId, app);
		s.invalidations.invalidate(CacheKey.settings());
		return { settings: nextSettings };
	});

	// --- update --------------------------------------------------------------------------
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

	// --- audit ---------------------------------------------------------------------------
	dispatcher.registerHandler(RPC.audit.list, async ({ limit, afterSeq }) => {
		return s.auditStore.list({ limit: limit ?? 100, afterSeq });
	});
	dispatcher.registerHandler(RPC.audit.export, async () => {
		return s.auditStore.exportLines();
	});

	dispatcher.registerHandler(RPC.snapshot.get, () => {
		const companionId = getCompanionId(s);
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

function modelDefaultsWire(defaults: {
	reply?: { providerId: string; modelId: string };
	vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
	onboardingComplete: boolean;
}) {
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
	};
}

function systemModelDefaultsWire(defaults: {
	reply?: { providerId: string; modelId: string };
	vision: { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } };
}) {
	return {
		...(defaults.reply ? { reply: modelRouteWire(defaults.reply) } : {}),
		vision:
			defaults.vision.mode === "manual"
				? { mode: "manual" as const, route: modelRouteWire(defaults.vision.route) }
				: { mode: "auto" as const },
	};
}

async function requireOwnedConversation(
	s: HostCompositionContext,
	conversationId: string,
): Promise<void> {
	const companionId = getCompanionId(s);
	const row = s.orm
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.companionId, companionId)))
		.get();
	if (!row) throw { kind: "not_found", reason: "conversation_not_found" };
}

async function requireOwnedRun(s: HostCompositionContext, runId: string): Promise<void> {
	const row = s.orm
		.select({ conversationId: runs.conversationId })
		.from(runs)
		.where(eq(runs.id, runId))
		.get();
	if (!row) throw { kind: "not_found", reason: "run_not_found" };
	await requireOwnedConversation(s, row.conversationId);
}

function requireOwnedArtifact(
	s: HostCompositionContext,
	identity: ArtifactActionRequest,
): ArtifactRecord {
	const conversation = s.orm
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.id, identity.conversationId))
		.get();
	if (!conversation) throw { kind: "not_found", reason: "conversation_not_found" };

	const run = s.orm
		.select({ id: runs.id, conversationId: runs.conversationId })
		.from(runs)
		.where(eq(runs.id, identity.runId))
		.get();
	if (!run || run.conversationId !== identity.conversationId)
		throw { kind: "not_found", reason: "run_not_found" };

	const binding = s.orm
		.select({ id: artifacts.id, producerRunId: artifacts.producerRunId })
		.from(artifacts)
		.where(eq(artifacts.id, identity.artifactId))
		.get();
	if (!binding || binding.producerRunId !== identity.runId)
		throw { kind: "not_found", reason: "artifact_not_found" };

	const record = s.artifacts.get(identity.artifactId);
	if (!record || record.producerRunId !== identity.runId)
		throw { kind: "not_found", reason: "artifact_not_found" };
	return record;
}

async function presentArtifact(
	s: HostCompositionContext,
	action: "open" | "reveal" | "saveAs",
	identity: ArtifactActionRequest,
): Promise<{ outcome: "completed" | "cancelled" | "unsupported" }> {
	const artifact = requireOwnedArtifact(s, identity);
	if (!s.artifacts.readBlobRange(artifact.id, 0, 1))
		throw { kind: "not_found", reason: "artifact_not_found" };
	const presenter = s.artifactPresenter;
	const present = presenter?.[action];
	if (!presenter || !present) return { outcome: "unsupported" };

	const scoped = createArtifactPresentationAccess(s.artifacts, artifact);
	let result: Awaited<ReturnType<NonNullable<typeof present>>>;
	try {
		result = await present.call(presenter, {
			artifact: Object.freeze({ ...artifact }),
			access: scoped.access,
		});
	} finally {
		await scoped.close();
	}
	const response = ArtifactActionResponse.parse(result);
	if (action === "saveAs" && response.outcome === "completed") {
		s.artifacts.markSaved(artifact.id);
	}
	return response;
}

function artifactWire(artifact: ArtifactRecord) {
	return {
		id: artifact.id,
		name: artifact.logicalName,
		mime: artifact.mime,
		bytes: artifact.bytes,
		sha256: artifact.sha256,
		status: artifact.status,
		createdAt: artifact.createdAt,
	};
}

function runWire(s: HostCompositionContext, run: RunSummary) {
	return s.externalAgentRuns.project(run);
}

function getCompanionId(s: HostCompositionContext): string {
	const packageId = s.characterLoader.getActiveCharacterId(s.systemOrm, s.defaultCharacterId);
	if (!s.characterLoader.load(packageId))
		throw { kind: "unavailable", reason: "character_package_missing" };
	return packageId;
}

/** Seed the active character package if it has not been seeded yet. */
function ensureCharacterSeeded(s: HostCompositionContext): void {
	const activeId = s.characterLoader.getActiveCharacterId(s.systemOrm, s.defaultCharacterId);
	const character = s.characterLoader.load(activeId);
	if (!character) throw new Error(`character package missing: ${activeId}`);
	s.companionStore.reconcileSchema(character.id, character.state);
}

/** Skills are always declarative context; executable plugins require current package trust. */
function configureCharacterRuntime(
	s: HostCompositionContext,
	character: Parameters<CharacterLoader["piResources"]>[0],
): void {
	const trust = s.characterLoader.pluginTrust(s.systemOrm, character);
	s.pi.configure(s.characterLoader.piResources(character, trust.trusted));
}
