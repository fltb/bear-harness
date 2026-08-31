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

import type { ArtifactActionRequest, ResponseOf } from "@bear-harness/protocol";
import {
	ArtifactActionResponse,
	EmbeddingDownloadState,
	MAX_ARTIFACT_READ_BYTES,
	RPC,
} from "@bear-harness/protocol/schema";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { and, desc, eq } from "drizzle-orm";
import type { ArtifactRecord, ArtifactStore } from "./artifacts/index.js";
import {
	type ArtifactPresenter,
	createArtifactPresentationAccess,
} from "./artifacts/presentation.js";
import type { CanonHubService } from "./canon/service.js";
import type {
	CharacterDraftFiles,
	CharacterDraftService,
} from "./companion/character-draft-service.js";
import type {
	CharacterLoader,
	CharacterPackage,
	CharacterPackageOrigin,
} from "./companion/character-loader.js";
import type { CompanionStateStore } from "./companion/companion-store.js";
import type { FirstMeetingMachine } from "./companion/first-meeting.js";
import { projectPiConversationDetail } from "./companion/pi-live-events.js";
import type { PiRuntime } from "./companion/pi-runtime.js";
import type { SessionCatalog } from "./companion/session-catalog.js";
import type { Dispatcher } from "./dispatcher.js";
import {
	type ExternalAgentRunService,
	type RunSummary,
	sanitizeExternalAgentMemoryText,
} from "./external-agents/run-service.js";
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
import type { EventBus } from "./storage/event-bus.js";
import { artifacts, conversations, events, evidence, runs } from "./storage/schema.js";

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
	eventBus: EventBus;
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
			codexHome: string;
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
	/** Optional hash-chained audit store (security layer). */
	auditStore?: Pick<AuditStore, "append" | "list" | "exportLines">;
}

function oauthWire(state: OAuthSessionState) {
	return {
		...state,
		infoLinks: state.infoLinks ? state.infoLinks.map((link) => ({ ...link })) : undefined,
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
	);
	if (!provider) return [];
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
): Promise<void> {
	const providerList = (await providers.listProviders()).filter((provider) => provider.added);
	await Promise.all(
		providerList.map((provider) => syncProviderModels(provider.id, providers, models, false)),
	);
}

function readPiConfigProviderIds(configJson: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(configJson);
	} catch {
		return [];
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) return [];
	return Object.keys(parsed.providers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function wireHostHandlers(dispatcher: Dispatcher, s: HostCompositionContext): void {
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
		s.eventBus.publish("settings.changed", {
			settings: await projectSettings(getCompanionId(s), app),
			changed: ["memoryVectorService"],
		});
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
	dispatcher.registerHandler(RPC.character.activate, async (_p) => {
		const { characterId } = _p as { characterId: string };
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		if (getCompanionId(s) === characterId) {
			return { character: s.characterLoader.display(character) };
		}
		await s.activateCharacter(character);
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.packageGet, async (_p) => {
		const { characterId } = _p as { characterId: string };
		return { package: s.characterLoader.readPackageDocument(characterId) };
	});
	dispatcher.registerHandler(RPC.character.packageUpdate, async (_p) => {
		const params = _p as {
			characterId: string;
			yaml: string;
			expectedSha256: string;
		};
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
			s.canon.syncPackage(character.id, character.canon);
			configureCharacterRuntime(s, character);
		}
		return { package: s.characterLoader.readPackageDocument(character.id) };
	});
	dispatcher.registerHandler(RPC.character.deletionStatusGet, async (_p) => {
		const { characterId } = _p as { characterId: string };
		return { status: s.characterDeletionStatus(characterId) };
	});
	dispatcher.registerHandler(RPC.character.runtimeDelete, async (_p) => {
		const { characterId } = _p as { characterId: string };
		return {
			characterId,
			target: "runtime" as const,
			...s.deleteCharacterRuntime(characterId),
		};
	});
	dispatcher.registerHandler(RPC.character.packageDelete, async (_p) => {
		const { characterId } = _p as { characterId: string };
		return {
			characterId,
			target: "package" as const,
			...s.deleteCharacterPackage(characterId),
		};
	});
	dispatcher.registerHandler(RPC.character.import, async (_p) => {
		const { files } = _p as { files: Array<{ path: string; base64: string }> };
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
		s.eventBus.publish("character.imported", {
			characterId: character.id,
			trust,
		});
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustGet, async (_p) => {
		const requestedId = (_p as { characterId?: string }).characterId;
		const characterId = requestedId ?? getCompanionId(s);
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return { trust: s.characterLoader.pluginTrust(s.systemOrm, character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustConfirm, async (_p) => {
		const { characterId } = _p as { characterId: string };
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		s.seedCharacter(character);
		const trust = s.characterLoader.confirmPluginTrust(s.systemOrm, character);
		s.eventBus.publish("character.pluginsTrusted", {
			characterId,
			pluginHash: trust.pluginHash,
		});
		if (getCompanionId(s) === characterId) {
			configureCharacterRuntime(s, character);
		}
		return { trust };
	});
	dispatcher.registerHandler(RPC.character.draftCreate, async (_p) => {
		const { basePackageId, locale } = _p as {
			basePackageId?: string;
			locale?: string;
		};
		return { draft: s.drafts.create({ basePackageId, locale }) };
	});
	dispatcher.registerHandler(RPC.character.draftGet, async (_p) => {
		const { id } = _p as { id: string };
		return { draft: s.drafts.get(id) };
	});
	dispatcher.registerHandler(RPC.character.draftPatch, async (_p) => {
		const { id, expectedRevision, files } = _p as {
			id: string;
			expectedRevision: number;
			files: CharacterDraftFiles;
		};
		return { draft: s.drafts.applyPatch(id, expectedRevision, files) };
	});
	dispatcher.registerHandler(RPC.character.draftUploadAssets, async (_p) => {
		const { id, expectedRevision, assets } = _p as {
			id: string;
			expectedRevision: number;
			assets: Array<{ path: string; mime: string; base64: string }>;
		};
		return { draft: s.drafts.uploadAssets(id, expectedRevision, assets) };
	});
	dispatcher.registerHandler(RPC.character.draftListRevisions, async (_p) => {
		const { id } = _p as { id: string };
		return { revisions: s.drafts.listRevisions(id) };
	});
	dispatcher.registerHandler(RPC.character.draftRestoreRevision, async (_p) => {
		const { id, expectedRevision, sourceRevision } = _p as {
			id: string;
			expectedRevision: number;
			sourceRevision: number;
		};
		return {
			draft: s.drafts.restoreRevision(id, expectedRevision, sourceRevision),
		};
	});
	dispatcher.registerHandler(RPC.character.draftValidate, async (_p) => {
		const { id, expectedRevision } = _p as {
			id: string;
			expectedRevision: number;
		};
		return { draft: s.drafts.validate(id, expectedRevision) };
	});
	dispatcher.registerHandler(RPC.character.draftPublish, async (_p) => {
		const { id, expectedRevision } = _p as {
			id: string;
			expectedRevision: number;
		};
		const result = s.drafts.publish(id, expectedRevision);
		await s.activateCharacter(result.character, "local");
		return {
			draft: result.draft,
			character: s.characterLoader.display(result.character),
		};
	});
	dispatcher.registerHandler(RPC.companionState.update, async (_p) => {
		const { conversationId, changes } = _p as {
			conversationId: string;
			changes: Array<{
				path: string;
				value: unknown;
			}>;
		};
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
		s.eventBus.publish("companion.snapshot_changed", {
			conversationId,
		});
		return {};
	});
	dispatcher.registerHandler(RPC.companionState.get, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
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
					schemaHash: projection.schemaHash,
				},
				...s.companionStore.snapshot(character, conversationId),
			},
		};
	});

	// --- role-defined onboarding -----------------------------------------------
	dispatcher.registerHandler(RPC.onboarding.get, async () => {
		const companionId = getCompanionId(s);
		return {
			...s.onboarding.getState(companionId),
			eventSeq: s.eventBus.currentSeq,
		};
	});
	dispatcher.registerHandler(RPC.onboarding.submit, async (_p) => {
		const { stepId, answer } = _p as { stepId: string; answer?: string };
		const companionId = getCompanionId(s);
		return {
			...s.onboarding.submit(companionId, stepId, answer),
			eventSeq: s.eventBus.currentSeq,
		};
	});

	// --- conversation ---------------------------------------------------------
	dispatcher.registerHandler(RPC.conversation.list, async ({ archived, title }) => ({
		sessions: (await s.sessions.list(getCompanionId(s), { archived, title })).map(sessionWire),
	}));
	dispatcher.registerHandler(RPC.conversation.create, async ({ title }) => {
		const session = await s.sessions.create(getCompanionId(s), title);
		s.eventBus.publish("conversation.created", {
			conversationId: session.sessionId,
			...(title ? { title } : {}),
		});
		return projectPiConversationDetail(session);
	});
	dispatcher.registerHandler(RPC.conversation.open, async (_p) => {
		const { id } = _p as { id: string };
		const session = await s.sessions.open(getCompanionId(s), id);
		return projectPiConversationDetail(session);
	});
	dispatcher.registerHandler(RPC.conversation.rename, async (_p) => {
		const { id, title } = _p as { id: string; title: string };
		await s.sessions.rename(getCompanionId(s), id, title.trim());
		s.eventBus.publish("conversation.renamed", {
			conversationId: id,
			title: title.trim(),
		});
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.archive, async ({ id, archived }) => {
		await s.sessions.archive(getCompanionId(s), id, archived);
		s.eventBus.publish("conversation.archived", {
			conversationId: id,
			archived,
		});
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.delete, async ({ id }) => {
		await s.sessions.delete(getCompanionId(s), id);
		s.eventBus.publish("conversation.deleted", { conversationId: id });
		return {};
	});

	// --- message ----------------------------------------------------------------
	dispatcher.registerHandler(RPC.message.send, async (_p) => {
		const { conversationId, text } = _p as { conversationId: string; text: string };
		await requireOwnedConversation(s, conversationId);
		await s.pi.send(conversationId, text);
		return { accepted: true as const };
	});
	dispatcher.registerHandler(RPC.message.abort, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await requireOwnedConversation(s, conversationId);
		await s.pi.abort(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.regenerate, async (_p) => {
		const { conversationId, entryId, feedback } = _p as {
			conversationId: string;
			entryId: string;
			feedback?: string;
		};
		await requireOwnedConversation(s, conversationId);
		await s.pi.regenerate(conversationId, entryId, feedback);
		return {};
	});
	dispatcher.registerHandler(RPC.message.switchVersion, async (_p) => {
		const { conversationId, leafId } = _p as {
			conversationId: string;
			leafId: string;
		};
		await requireOwnedConversation(s, conversationId);
		await s.pi.navigate(conversationId, leafId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.edit, async (_p) => {
		const { conversationId, entryId, text } = _p as {
			conversationId: string;
			entryId: string;
			text: string;
		};
		await requireOwnedConversation(s, conversationId);
		await s.pi.edit(conversationId, entryId, text);
		return {};
	});
	dispatcher.registerHandler(RPC.message.continue, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await requireOwnedConversation(s, conversationId);
		await s.pi.continue(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.branch, async (_p) => {
		const { conversationId, entryId } = _p as {
			conversationId: string;
			entryId: string;
		};
		await requireOwnedConversation(s, conversationId);
		const session = await s.sessions.fork(getCompanionId(s), conversationId, entryId);
		return projectPiConversationDetail(session);
	});
	const previousDownload = s.orm
		.select({ payload: events.payload })
		.from(events)
		.where(eq(events.kind, "memory.embedding_download_changed"))
		.orderBy(desc(events.seq))
		.limit(1)
		.get();
	const restoredDownload = EmbeddingDownloadState.safeParse(previousDownload?.payload);
	let embeddingDownload: EmbeddingDownloadState = restoredDownload.success
		? restoredDownload.data
		: { status: "idle", downloadedBytes: 0 };
	if (["preparing", "downloading", "validating", "activating"].includes(embeddingDownload.status)) {
		// A previous Host owned this task. Never report it as still running or
		// automatically repeat activation after a crash; a user may retry it.
		embeddingDownload = { ...embeddingDownload, status: "cancelled" };
		s.eventBus.publish("memory.embedding_download_changed", embeddingDownload);
	}
	const updateEmbeddingDownload = (next: EmbeddingDownloadState) => {
		if (s.signal?.aborted) return;
		const previous = embeddingDownload;
		embeddingDownload = next;
		// Persist progress only at meaningful byte/percent boundaries, never on a timer.
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
			s.eventBus.publish("memory.embedding_download_changed", next);
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
	dispatcher.registerHandler(RPC.memory.configureLocalEmbedding, async (_p) => {
		const { provider, candidateId, customPath } = _p as {
			provider: "none" | "local";
			candidateId?: string;
			customPath?: string;
		};
		if (embeddingAbort) throw { kind: "conflict", reason: "embedding_download_in_progress" };
		if (provider === "none") {
			await saveMemoryVectorService({ enabled: false, provider: "none" });
			s.signal?.throwIfAborted();
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
		s.signal?.addEventListener("abort", abortOnClose, { once: true });
		if (s.signal?.aborted) abort.abort();
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
			if (abort.signal.aborted) throw { kind: "conflict", reason: "embedding_download_cancelled" };
			throw error;
		} finally {
			s.signal?.removeEventListener("abort", abortOnClose);
			if (embeddingAbort === abort) embeddingAbort = undefined;
		}
	});
	// --- canon hub (advanced authoring) ---------------------------------------------
	dispatcher.registerHandler(RPC.canon.listSources, async (_p) => ({
		sources: s.canon.listSources(_p.characterId ?? getCompanionId(s)),
	}));
	dispatcher.registerHandler(RPC.canon.addSource, async (_p) => {
		const { logicalName, content } = _p as {
			logicalName: string;
			content: string;
		};
		return {
			source: s.canon.addSource(_p.characterId ?? getCompanionId(s), logicalName, content),
		};
	});
	dispatcher.registerHandler(RPC.canon.search, async (_p) => ({
		chunks: await s.canon.searchHybrid(
			_p.characterId ?? getCompanionId(s),
			(_p as { query: string }).query,
		),
	}));
	dispatcher.registerHandler(RPC.canon.removeSource, async (_p) => {
		s.canon.removeSource(
			_p.characterId ?? getCompanionId(s),
			(_p as { sourceId: string }).sourceId,
		);
		return {};
	});
	dispatcher.registerHandler(RPC.canon.listModules, async (_p) => ({
		modules: s.canon.listModules(_p.characterId ?? getCompanionId(s)),
	}));
	dispatcher.registerHandler(RPC.canon.upsertModule, async (_p) => ({
		module: s.canon.upsertModule({
			...(_p as Parameters<CanonHubService["upsertModule"]>[0]),
			companionId: _p.characterId ?? getCompanionId(s),
		}),
	}));
	dispatcher.registerHandler(RPC.canon.deleteModule, async (_p) => {
		s.canon.deleteModule(_p.characterId ?? getCompanionId(s), (_p as { id: string }).id);
		return {};
	});

	// --- provider ------------------------------------------------------------------
	dispatcher.registerHandler(RPC.provider.list, async () => {
		return { providers: await s.providers.listProviders() };
	});
	dispatcher.registerHandler(RPC.provider.customUpsert, async (_p) => {
		const input = _p as {
			providerId: string;
			name: string;
			baseUrl: string;
			apiKey?: string;
			models: Array<{ id: string; name?: string; supportsImages?: boolean }>;
		};
		await s.providers.upsertCustomProvider(input);
		await syncProviderModels(input.providerId, s.providers, s.models);
		return {};
	});
	dispatcher.registerHandler(RPC.provider.importPiConfig, async (_p) => {
		const configJson = (_p as { configJson: string }).configJson;
		const imported = await s.providers.importPiConfig(configJson);
		const providerIds = new Set([
			...imported.map((model) => model.providerId),
			...readPiConfigProviderIds(configJson),
		]);
		const models = (
			await Promise.all(
				[...providerIds].map((providerId) => syncProviderModels(providerId, s.providers, s.models)),
			)
		).flat();
		return { models };
	});
	dispatcher.registerHandler(RPC.provider.overrideBaseUrl, async (_p) => {
		const input = _p as { providerId: string; baseUrl: string };
		await s.providers.overrideProviderBaseUrl(input);
		return {};
	});
	dispatcher.registerHandler(RPC.provider.setApiKey, async (_p) => {
		const { providerId, apiKey, sessionOnly } = _p as {
			providerId: string;
			apiKey: string;
			sessionOnly?: boolean;
		};
		await s.providers.setApiKey(providerId, apiKey, sessionOnly);
		await syncProviderModels(providerId, s.providers, s.models);
		return {};
	});
	dispatcher.registerHandler(RPC.provider.login, async (_p) => {
		const { providerId } = _p as { providerId: string };
		const state = await s.providers.startOAuth(providerId);
		s.eventBus.publish("provider.login_changed", { providerId });
		return oauthWire(state);
	});
	dispatcher.registerHandler(RPC.provider.loginCancel, async (_p) => {
		const { providerId } = _p as { providerId: string };
		s.providers.cancelOAuth(providerId);
		s.eventBus.publish("provider.login_changed", { providerId });
		return {};
	});
	dispatcher.registerHandler(RPC.provider.loginStatus, async (_p) => {
		const providerId = (_p as { providerId: string }).providerId;
		try {
			return oauthWire(await s.providers.getOAuthSession(providerId));
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"reason" in error &&
				error.reason === "oauth_session_not_found"
			)
				return { providerId, status: "idle" as const };
			throw error;
		}
	});
	dispatcher.registerHandler(RPC.provider.loginAnswer, async (_p) => {
		const { providerId, answer } = _p as { providerId: string; answer: string };
		const state = await s.providers.answerOAuth(providerId, answer);
		s.eventBus.publish("provider.login_changed", { providerId });
		if (state.status === "completed") {
			await syncProviderModels(state.providerId, s.providers, s.models);
		}
		return oauthWire(state);
	});
	dispatcher.registerHandler(RPC.provider.remove, async (_p) => {
		const { providerId } = _p as { providerId: string };
		await s.providers.removeProvider(providerId);
		for (const model of s.models
			.list()
			.filter((candidate) => candidate.providerId === providerId)) {
			s.models.disable(model.providerId, model.modelId);
		}
		return {};
	});
	dispatcher.registerHandler(RPC.provider.logout, async (_p) => {
		const { providerId } = _p as { providerId: string };
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
	dispatcher.registerHandler(RPC.model.enable, async (_p) => {
		const { providerId, modelId, label } = _p as {
			providerId: string;
			modelId: string;
			label?: string;
		};
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
	dispatcher.registerHandler(RPC.model.disable, async (_p) => {
		const { providerId, modelId } = _p as {
			providerId: string;
			modelId: string;
		};
		s.models.disable(providerId, modelId);
		return {};
	});
	dispatcher.registerHandler(RPC.model.defaultsGet, async () => {
		const companionId = getCompanionId(s);
		return modelDefaultsWire(s.models.defaults(companionId));
	});
	dispatcher.registerHandler(RPC.model.defaultsSetReply, async (_p) => {
		const { reply } = _p as {
			reply: { providerId: string; modelId: string } | null;
		};
		const companionId = getCompanionId(s);
		return modelDefaultsWire(s.models.setDefaultReply(companionId, reply));
	});
	dispatcher.registerHandler(RPC.model.defaultsSetVision, async (_p) => {
		const companionId = getCompanionId(s);
		return modelDefaultsWire(
			s.models.setVisionDefault(
				companionId,
				_p as { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } },
			),
		);
	});
	dispatcher.registerHandler(RPC.model.systemDefaultsGet, async () =>
		systemModelDefaultsWire(s.models.systemDefaults()),
	);
	dispatcher.registerHandler(RPC.model.systemDefaultsSet, async (_p) =>
		systemModelDefaultsWire(
			s.models.setSystemDefaults(
				_p as {
					reply: { providerId: string; modelId: string };
					vision:
						| { mode: "auto" }
						| { mode: "manual"; route: { providerId: string; modelId: string } };
				},
			),
		),
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
	dispatcher.registerHandler(RPC.model.routeGet, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await requireOwnedConversation(s, conversationId);
		const selected = await s.pi.modelFor(conversationId);
		return {
			conversationId,
			...(selected ? { selected } : {}),
		};
	});
	dispatcher.registerHandler(RPC.model.routeSet, async (_p) => {
		const { conversationId, selected } = _p as {
			conversationId: string;
			selected: { providerId: string; modelId: string };
		};
		await requireOwnedConversation(s, conversationId);
		const model = await s.pi.setModel(conversationId, selected.providerId, selected.modelId);
		s.eventBus.publish("model.selected", { conversationId, ...model });
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
		const permissions = new Map(
			s.externalAgentRuns.pendingPermissions(companionId).map((item) => [item.runId, item]),
		);
		return {
			runs: s.externalAgentRuns
				.list(companionId)
				.map((run) => runWire(s, run, permissions.get(run.id))),
		};
	});
	dispatcher.registerHandler(RPC.run.steer, async (_p) => {
		const { runId, instruction } = _p as { runId: string; instruction: string };
		await requireOwnedRun(s, runId);
		await s.externalAgentRuns.steerRun(runId, instruction);
		return {};
	});
	dispatcher.registerHandler(RPC.run.interrupt, async (_p) => {
		const { runId } = _p as { runId: string };
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.interruptRun(runId));
	});
	dispatcher.registerHandler(RPC.run.resume, async (_p) => {
		const { runId } = _p as { runId: string };
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.resumeRun(runId));
	});
	dispatcher.registerHandler(RPC.run.cancel, async (_p) => {
		const { runId } = _p as { runId: string };
		await requireOwnedRun(s, runId);
		return runWire(s, await s.externalAgentRuns.cancelRun(runId));
	});
	dispatcher.registerHandler(RPC.run.respondPermission, async (_p) => {
		const { runId, requestId, optionId } = _p as {
			runId: string;
			requestId: string;
			optionId: string;
		};
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
	dispatcher.registerHandler(RPC.settings.get, async (_p) => {
		const { characterId } = _p as { characterId?: string };
		const companionId = companionIdForCharacter(s, characterId);
		return { settings: await projectSettings(companionId) };
	});
	dispatcher.registerHandler(RPC.settings.set, async (_p) => {
		const { characterId, settings } = _p as {
			characterId?: string;
			settings: Record<string, unknown>;
		};
		const companionId = companionIdForCharacter(s, characterId);
		if (
			characterId &&
			["firstRunStage", "networkProxy", "memoryVectorService", "modelDownloadSource"].some(
				(key) => key in settings,
			)
		)
			throw {
				kind: "invalid_request",
				reason: "character_settings_may_only_change_relationship_options",
			};
		if ("relationshipMemoryEnabled" in settings) {
			const enabled = Boolean(settings.relationshipMemoryEnabled);
			s.onboarding.setRelationshipMemory(companionId, enabled);
			if (!enabled) await s.memoryEmbedding.releaseRuntime(companionId);
		}
		let app = s.appSettings.load();
		const changed: string[] = [];
		if ("firstRunStage" in settings) {
			app = s.appSettings.save({
				firstRunStage: settings.firstRunStage as never,
			});
			changed.push("firstRunStage");
		}
		if ("networkProxy" in settings) {
			app = s.appSettings.save({
				networkProxy: settings.networkProxy as never,
			});
			changed.push("networkProxy");
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
			changed.push("memoryVectorService");
		}
		if ("modelDownloadSource" in settings) {
			app = s.appSettings.save({
				modelDownloadSource: settings.modelDownloadSource as never,
			});
			changed.push("modelDownloadSource");
		}
		const nextSettings = await projectSettings(companionId, app);
		s.eventBus.publish("settings.changed", { settings: nextSettings, changed });
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
	dispatcher.registerHandler(RPC.audit.list, async (_p) => {
		const { limit, afterSeq } = _p as { limit?: number; afterSeq?: number };
		if (!s.auditStore) {
			return { entries: [], oldestSeq: 0 };
		}
		return s.auditStore.list({ limit: limit ?? 100, afterSeq });
	});
	dispatcher.registerHandler(RPC.audit.export, async () => {
		if (!s.auditStore) {
			return { lines: "", verified: false };
		}
		return s.auditStore.exportLines();
	});

	// --- events -----------------------------------------------------------------------
	dispatcher.registerHandler(RPC.events.subscribe, async (_p) => {
		const { afterSeq } = _p as { afterSeq?: number };
		return { events: s.eventBus.after(afterSeq ?? 0) };
	});
	dispatcher.registerHandler(RPC.snapshot.get, () => {
		const companionId = getCompanionId(s);
		// All projections and the event cursor are captured in one synchronous read cut.
		const onboarding = s.onboarding.getState(companionId);
		const character = s.characterLoader.load(companionId);
		if (!character) {
			throw { kind: "unavailable", reason: "character_package_missing" };
		}
		const eventSeq = s.eventBus.currentSeq;

		return {
			eventSeq,
			onboarding: { ...onboarding, eventSeq },
			character: s.characterLoader.display(character),
		};
	});
}

function modelRouteWire(model: { providerId: string; modelId: string }) {
	return { providerId: model.providerId, modelId: model.modelId };
}

function sessionWire(session: SessionInfo) {
	const firstMessage = session.firstMessage ?? "";
	return {
		id: session.id,
		title: session.name ?? firstMessage,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage,
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

function companionIdForCharacter(s: HostCompositionContext, characterId?: string): string {
	const activeId = getActiveCompanionId(s);
	const resolvedId = characterId ?? activeId;
	const character = s.characterLoader.load(resolvedId);
	if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
	if (resolvedId !== activeId) throw { kind: "conflict", reason: "character_runtime_not_active" };
	return resolvedId;
}

function getActiveCompanionId(s: HostCompositionContext): string {
	const packageId = s.characterLoader.getActiveCharacterId(s.systemOrm, s.defaultCharacterId);
	if (!s.characterLoader.load(packageId))
		throw { kind: "unavailable", reason: "character_package_missing" };
	return packageId;
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

function runWire(
	s: HostCompositionContext,
	run: RunSummary,
	permission?: ReturnType<ExternalAgentRunService["pendingPermissions"]>[number],
) {
	return {
		id: run.id,
		conversationId: run.conversationId,
		triggerEntryId: run.triggerEntryId,
		executorProfile: run.executorProfile,
		title: run.title,
		status: run.status,
		artifacts: run.artifacts.map(artifactWire),
		...(run.summary ? { summary: safeWireSummary(run.summary, 4_096) } : {}),
		evidence: evidenceWire(s, run.id),
		...(permission ? { permission } : {}),
		startedAt: run.startedAt ?? undefined,
		completedAt: run.completedAt ?? undefined,
	};
}

const SAFE_EVIDENCE_KEYS = ["kind", "name", "status", "title", "used", "size", "cost"] as const;

function evidenceWire(s: HostCompositionContext, runId: string) {
	return s.orm
		.select({ kind: evidence.kind, data: evidence.data, createdAt: evidence.createdAt })
		.from(evidence)
		.where(eq(evidence.runId, runId))
		.orderBy(desc(evidence.createdAt))
		.limit(20)
		.all()
		.reverse()
		.map((item) => {
			const summary = summarizeEvidence(item.data);
			return {
				kind: safeWireSummary(item.kind, 128) || "evidence",
				...(summary ? { summary } : {}),
				createdAt: item.createdAt,
			};
		});
}

function summarizeEvidence(data: unknown): string | undefined {
	if (typeof data === "string" || typeof data === "number" || typeof data === "boolean")
		return safeWireSummary(String(data), 512) || undefined;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	const parts = SAFE_EVIDENCE_KEYS.flatMap((key) => {
		const value = record[key];
		return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
			? [`${key}: ${String(value)}`]
			: [];
	});
	if (parts.length === 0) return undefined;
	return safeWireSummary(parts.join(" · "), 512) || undefined;
}

function safeWireSummary(value: string, maxBytes: number): string {
	return sanitizeExternalAgentMemoryText(value, maxBytes)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*\b/gi, "Bearer <redacted>")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
		.replace(
			/\b(authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
			"$1: <redacted>",
		)
		.trim();
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
	s.canon.syncPackage(character.id, character.canon);
	s.onboarding.initialize(character.id);
}

/** Skills are always declarative context; executable plugins require current package trust. */
function configureCharacterRuntime(
	s: HostCompositionContext,
	character: Parameters<CharacterLoader["piResources"]>[0],
): void {
	const trust = s.characterLoader.pluginTrust(s.systemOrm, character);
	s.pi.configure(s.characterLoader.piResources(character, trust.trusted).appendSystemPrompt);
}
