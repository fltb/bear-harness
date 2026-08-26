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
	MemoryEntry,
	MemoryListResponse,
	MemorySearchResponse,
	ResponseOf,
} from "@bear-harness/protocol";
import { CharacterRuntimeState, RPC } from "@bear-harness/protocol/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ArtifactStore } from "./artifacts/index.js";
import type { CanonHubService } from "./canon/service.js";
import type { CharacterBehaviorService } from "./companion/character-behavior.js";
import type {
	CharacterDraftFiles,
	CharacterDraftService,
} from "./companion/character-draft-service.js";
import type { CharacterLoader } from "./companion/character-loader.js";
import type { FirstMeetingMachine } from "./companion/first-meeting.js";
import type { PiSessionMessageEntry } from "./companion/pi-session-store.js";
import type { RoleplayService } from "./companion/roleplay-service.js";
import type { CompanionSupervisor } from "./companion/supervisor.js";
import type { TurnPipeline } from "./companion/turn-pipeline.js";
import type { ConversationAttachmentService } from "./conversation-attachments/service.js";
import type { ConversationProjection, ConversationRepository } from "./conversations/repository.js";
import type { Dispatcher } from "./dispatcher.js";
import type { ExternalAgentRunService, RunSummary } from "./external-agents/run-service.js";
import type { MemoryBackend, MemoryBankScope, MemoryRecord } from "./memory/backend.js";
import type { TencentDbRuntime } from "./memory/tencentdb-runtime.js";
import type { ModelRecord, ModelRegistry } from "./models/registry.js";
import type { OAuthSessionState, ProviderCatalog } from "./providers/catalog.js";
import type { AuditStore } from "./security/audit-store.js";
import {
	findHostLocalEmbeddingCandidate,
	HOST_SETTINGS_CAPABILITIES,
} from "./settings/capabilities.js";
import type { AppSettingsRecord, AppSettingsStore } from "./storage/app-settings-store.js";
import type { AppDatabase } from "./storage/database.js";
import type { EventBus } from "./storage/event-bus.js";
import {
	activeCharacter,
	artifacts,
	companionIdentity,
	conversations,
	memoryCandidates,
	memoryDecisions,
	memoryPresentation,
	relationshipMemoryEntries,
	runs,
	sceneState,
} from "./storage/schema.js";

/** Desktop-owned update lifecycle adapter used by the optional Host wiring. */
export type HostUpdateService = {
	check(): Promise<ResponseOf<typeof RPC.update.check>>;
	discard(): Promise<ResponseOf<typeof RPC.update.discard>>;
	apply(): Promise<ResponseOf<typeof RPC.update.apply>>;
};

export interface ConversationAttachmentUrlFactoryRequest {
	conversationId: string;
	attachmentId: string;
	relativePath: string;
	operation: "preview" | "download";
	mime: string;
	name: string;
	bytes: number;
}

/** Domain services and runtime-owned inputs the handlers read and mutate. */
export interface HostCompositionContext {
	orm: AppDatabase;
	eventBus: EventBus;
	onboarding: FirstMeetingMachine;
	turns: TurnPipeline;
	models: ModelRegistry;
	appSettings: AppSettingsStore;
	memoryBackend: MemoryBackend;
	memoryRuntime: TencentDbRuntime;
	memoryScope: Pick<MemoryBankScope, "installationId" | "userId">;
	externalAgentRuns: ExternalAgentRunService;
	externalAgents: {
		discover(): Promise<
			Array<{
				candidatePath: string;
				canonicalPath: string | null;
				version: string | null;
				sha256: string | null;
				status: "usable" | "version_mismatch" | "not_found" | "rejected";
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
			| { available: false; reason: "version_mismatch"; found: string }
		>;
	};
	artifacts: ArtifactStore;
	attachments: ConversationAttachmentService;
	canon: CanonHubService;
	supervisor: CompanionSupervisor;
	providers: ProviderCatalog;
	characterLoader: CharacterLoader;
	characterBehavior: CharacterBehaviorService;
	drafts: CharacterDraftService;
	roleplay: RoleplayService;
	defaultCharacterId: string;
	/** Product-local directory for Pi conversation session files. */
	conversationRepository: ConversationRepository;
	piSessionDir: string;
	/** Renderer-bound conversation attachment capability factory (desktop only). */
	attachmentUrlFactory?: (request: ConversationAttachmentUrlFactoryRequest) => string;
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
async function syncProviderModels(
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
async function syncAllProviderModels(
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
	const conversationRepository = s.conversationRepository;
	const saveMemoryVectorService = async (
		memoryVectorService: AppSettingsRecord["memoryVectorService"],
	): Promise<void> => {
		const app = s.appSettings.save({ memoryVectorService });
		const stateData = s.onboarding.getState(await getCompanionId(s)).stateData;
		s.eventBus.publish("settings.changed", {
			settings: {
				relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
				conversationHistoryReadEnabled:
					stateData.decisions.conversation_history_read_enabled ?? false,
				networkProxy: app.networkProxy,
				memoryVectorService: app.memoryVectorService,
				modelDownloadSource: app.modelDownloadSource,
			},
			changed: ["memoryVectorService"],
		});
	};
	// Load and seed the active character package from the character root once.
	ensureCharacterSeeded(s);

	// --- character package -----------------------------------------------------
	dispatcher.registerHandler(RPC.character.get, async () => {
		const companionId = await getCompanionId(s);
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.list, async () => ({
		characters: s.characterLoader.list(s.orm, s.defaultCharacterId),
	}));
	dispatcher.registerHandler(RPC.character.activate, async (_p) => {
		const { characterId } = _p as { characterId: string };
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		if ((await getCompanionId(s)) === characterId) {
			return { character: s.characterLoader.display(character) };
		}
		s.characterLoader.activate(s.orm, s.eventBus, character);
		s.canon.syncPackage(character.id, character.canon);
		await s.supervisor.stop();
		configureCharacterRuntime(s, character);
		await s.supervisor.start();
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.packageGet, async (_p) => {
		const { characterId } = _p as { characterId: string };
		return { package: s.characterLoader.readPackageDocument(characterId) };
	});
	dispatcher.registerHandler(RPC.character.packageUpdate, async (_p) => {
		const params = _p as { characterId: string; yaml: string; expectedSha256: string };
		let updated: ReturnType<typeof s.characterLoader.writePackageDocument>;
		try {
			updated = s.characterLoader.writePackageDocument(params);
		} catch (error) {
			if (error && typeof error === "object" && "kind" in error) throw error;
			throw { kind: "invalid_request", reason: "character_package_invalid" };
		}
		const character = updated.character;
		s.characterLoader.seed(s.orm, s.eventBus, character, "local");
		s.canon.syncPackage(character.id, character.canon);
		if ((await getCompanionId(s)) === character.id) {
			await s.supervisor.stop();
			configureCharacterRuntime(s, character);
			await s.supervisor.start();
		}
		return { package: s.characterLoader.readPackageDocument(character.id) };
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
		s.characterLoader.seed(s.orm, s.eventBus, character, "imported");
		s.canon.syncPackage(character.id, character.canon);
		const trust = s.characterLoader.pluginTrust(s.orm, character);
		s.eventBus.publish("character.imported", { characterId: character.id, trust });
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustGet, async (_p) => {
		const requestedId = (_p as { characterId?: string }).characterId;
		const characterId = requestedId ?? (await getCompanionId(s));
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		s.characterLoader.seed(s.orm, s.eventBus, character);
		return { trust: s.characterLoader.pluginTrust(s.orm, character) };
	});
	dispatcher.registerHandler(RPC.character.pluginTrustConfirm, async (_p) => {
		const { characterId } = _p as { characterId: string };
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		s.characterLoader.seed(s.orm, s.eventBus, character);
		const trust = s.characterLoader.confirmPluginTrust(s.orm, character);
		s.eventBus.publish("character.pluginsTrusted", { characterId, pluginHash: trust.pluginHash });
		if ((await getCompanionId(s)) === characterId) {
			await s.supervisor.stop();
			configureCharacterRuntime(s, character);
			await s.supervisor.start();
		}
		return { trust };
	});
	dispatcher.registerHandler(RPC.character.draftCreate, async (_p) => {
		const { basePackageId, locale } = _p as { basePackageId?: string; locale?: string };
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
		return { draft: s.drafts.restoreRevision(id, expectedRevision, sourceRevision) };
	});
	dispatcher.registerHandler(RPC.character.draftValidate, async (_p) => {
		const { id, expectedRevision } = _p as { id: string; expectedRevision: number };
		return { draft: s.drafts.validate(id, expectedRevision) };
	});
	dispatcher.registerHandler(RPC.character.draftPublish, async (_p) => {
		const { id, expectedRevision } = _p as { id: string; expectedRevision: number };
		const result = s.drafts.publish(id, expectedRevision);
		s.characterLoader.activate(s.orm, s.eventBus, result.character, "local");
		s.canon.syncPackage(result.character.id, result.character.canon);
		await s.supervisor.stop();
		configureCharacterRuntime(s, result.character);
		await s.supervisor.start();
		return { draft: result.draft, character: s.characterLoader.display(result.character) };
	});
	dispatcher.registerHandler(RPC.roleplay.get, async (_p) => {
		const companionId = await getCompanionId(s);
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return {
			state: s.roleplay.project(character, (_p as { conversationId?: string }).conversationId),
		};
	});
	dispatcher.registerHandler(RPC.roleplay.trigger, async (_p) => {
		const { conversationId, eventId, dedupeKey } = _p as {
			conversationId: string;
			eventId: string;
			dedupeKey: string;
		};
		const state = s.characterBehavior.triggerUserRoleplayEvent({
			eventId,
			conversationId,
			dedupeKey,
		});
		return { state };
	});
	dispatcher.registerHandler(RPC.roleplay.dismissMedia, async (_p) => {
		const { conversationId, mediaId } = _p as { conversationId: string; mediaId: string };
		await requireOwnedConversation(s, conversationId);
		const character = s.characterLoader.load(await getCompanionId(s));
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		if (!character.roleplay.media.some((media) => media.id === mediaId))
			throw { kind: "not_found", reason: "roleplay_media_not_found" };
		s.eventBus.publish("roleplay.media_dismissed", { conversationId, mediaId });
		return {};
	});
	dispatcher.registerHandler(RPC.roleplay.resetUnlocks, async () => {
		s.roleplay.resetUnlocks(await getCompanionId(s));
		s.eventBus.publish("roleplay.unlocks_reset", {});
		return {};
	});

	// --- role-defined onboarding -----------------------------------------------
	dispatcher.registerHandler(RPC.onboarding.get, async () => {
		const companionId = await getCompanionId(s);
		return { ...s.onboarding.getState(companionId), eventSeq: s.eventBus.currentSeq };
	});
	dispatcher.registerHandler(RPC.onboarding.submit, async (_p) => {
		const { stepId, answer } = _p as { stepId: string; answer?: string };
		const companionId = await getCompanionId(s);
		return {
			...s.onboarding.submit(companionId, stepId, answer),
			eventSeq: s.eventBus.currentSeq,
		};
	});

	// --- conversation ---------------------------------------------------------
	dispatcher.registerHandler(RPC.conversation.list, async () => {
		const companionId = await getCompanionId(s);
		return { conversations: conversationRepository.list(companionId) };
	});
	dispatcher.registerHandler(RPC.conversation.activeGet, async () => {
		const companionId = await getCompanionId(s);
		const active = conversationRepository.active(companionId);
		if (!active) return {};
		await s.supervisor.ensureSession(active.id);
		const conversation = conversationRepository.get(active.id, companionId);
		return conversation ? { conversation } : {};
	});
	dispatcher.registerHandler(RPC.conversation.create, async (_p) => {
		const companionId = await getCompanionId(s);
		const id = crypto.randomUUID();
		const title = (_p as { title?: string }).title ?? "新对话";
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		const sceneTitle = character.character.scene_title;
		let conversation: ConversationProjection;
		try {
			conversation = conversationRepository.createAndSelect({
				id,
				companionId,
				title,
				sceneTitle,
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		await s.supervisor.ensureSession(id);
		conversation = conversationRepository.get(id, companionId) ?? conversation;
		s.models.applyDefaultToConversation(companionId, id);
		s.eventBus.publish("conversation.created", { conversationId: id });
		return conversation;
	});
	dispatcher.registerHandler(RPC.conversation.select, async (_p) => {
		const { id } = _p as { id: string };
		const companionId = await getCompanionId(s);
		if (!conversationRepository.get(id, companionId))
			throw { kind: "not_found", reason: "conversation_not_found" };
		await s.supervisor.ensureSession(id);
		const conversation = conversationRepository.select(id, companionId);
		if (!conversation) throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.selected", { id });
		return conversation;
	});
	dispatcher.registerHandler(RPC.conversation.rename, async (_p) => {
		const { id, title } = _p as { id: string; title: string };
		const companionId = await getCompanionId(s);
		if (!conversationRepository.rename(id, companionId, title.trim()))
			throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.renamed", { conversationId: id, title: title.trim() });
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.archive, async (_p) => {
		const { id, archived } = _p as { id: string; archived: boolean };
		const companionId = await getCompanionId(s);
		if (!conversationRepository.get(id, companionId))
			throw { kind: "not_found", reason: "conversation_not_found" };
		if (archived) await s.supervisor.invalidateConversation(id);
		const result = conversationRepository.archiveAndResolve(id, companionId, archived);
		s.eventBus.publish("conversation.archived", { conversationId: id, archived });
		return result.active ? { conversation: result.active } : {};
	});
	dispatcher.registerHandler(RPC.conversation.delete, async (_p) => {
		const { id } = _p as { id: string };
		const companionId = await getCompanionId(s);
		if (!conversationRepository.get(id, companionId))
			throw { kind: "not_found", reason: "conversation_not_found" };
		await s.supervisor.invalidateConversation(id);
		const result = conversationRepository.deleteAndResolve(id, companionId);
		s.eventBus.publish("conversation.deleted", { conversationId: id });
		return result.active ? { conversation: result.active } : {};
	});
	dispatcher.registerHandler(RPC.conversation.search, async (_p) => {
		const { query, includeArchived, limit } = _p as {
			query: string;
			includeArchived?: boolean;
			limit?: number;
		};
		const companionId = await getCompanionId(s);
		return {
			hits: conversationRepository.search(companionId, query, {
				includeArchived,
				limit,
			}),
		};
	});

	// --- conversation attachments ------------------------------------------------
	dispatcher.registerHandler(RPC.conversationAttachment.list, async (_p) => {
		const { conversationId, attachmentId } = _p as {
			conversationId: string;
			attachmentId?: string;
		};
		await requireOwnedConversation(s, conversationId);
		return { attachments: s.attachments.list(conversationId, attachmentId) };
	});
	dispatcher.registerHandler(RPC.conversationAttachment.discard, async (_p) => {
		const { conversationId, attachmentId } = _p as { conversationId: string; attachmentId: string };
		await requireOwnedConversation(s, conversationId);
		s.attachments.discard(conversationId, attachmentId);
		return {};
	});
	dispatcher.registerHandler(RPC.conversationAttachment.read, async (_p) => {
		await requireOwnedConversation(s, _p.conversationId);
		return _p.mode === "bytes" ? s.attachments.readBytes(_p) : s.attachments.semanticRead(_p);
	});
	dispatcher.registerHandler(RPC.conversationAttachment.url, async (_p) => {
		const { conversationId, attachmentId, relativePath, operation } = _p;
		await requireOwnedConversation(s, conversationId);
		if (!s.attachmentUrlFactory) {
			throw { kind: "unavailable", reason: "attachment_url_unavailable" };
		}
		const file = s.attachments.resolveFile(conversationId, attachmentId, relativePath);
		return {
			url: s.attachmentUrlFactory({
				conversationId,
				attachmentId,
				relativePath: file.relativePath,
				operation,
				mime: file.mime,
				name: file.name,
				bytes: file.bytes,
			}),
		};
	});
	dispatcher.registerHandler(RPC.conversationAttachment.startUpload, async (_p) => {
		const { conversationId, kind, name, entries } = _p;
		await requireOwnedConversation(s, conversationId);
		return {
			uploadId: s.attachments.startUpload({ conversationId, kind, name, entries }),
		};
	});
	dispatcher.registerHandler(RPC.conversationAttachment.cancelUpload, async (_p) => {
		const { conversationId, uploadId } = _p;
		await requireOwnedConversation(s, conversationId);
		s.attachments.cancelUpload(conversationId, uploadId);
		return {};
	});
	dispatcher.registerHandler(RPC.conversationAttachment.appendChunk, async (_p) => {
		const { conversationId, uploadId, fileIndex, offset, base64 } = _p;
		await requireOwnedConversation(s, conversationId);
		s.attachments.appendChunk({ conversationId, uploadId, fileIndex, offset, base64 });
		return {};
	});
	dispatcher.registerHandler(RPC.conversationAttachment.completeUpload, async (_p) => {
		const { conversationId, uploadId } = _p;
		await requireOwnedConversation(s, conversationId);
		return { attachment: await s.attachments.completeUpload(conversationId, uploadId) };
	});

	// --- message ----------------------------------------------------------------
	dispatcher.registerHandler(RPC.message.send, async (_p) => {
		const {
			conversationId,
			text,
			attachmentIds = [],
		} = _p as {
			conversationId: string;
			text: string;
			attachmentIds?: string[];
		};
		await requireOwnedConversation(s, conversationId);
		const nonce = s.attachments.beginSend(conversationId, attachmentIds);
		try {
			const selectedAttachments = new Map(
				s.attachments
					.list(conversationId, undefined, true)
					.filter((attachment) => attachmentIds.includes(attachment.id))
					.map((attachment) => [attachment.id, attachment]),
			);
			const attachmentNames = attachmentIds.map((attachmentId) => {
				const attachment = selectedAttachments.get(attachmentId);
				return `${attachmentId}: ${attachment?.name ?? attachmentId}`;
			});
			const currentMessageImages = attachmentIds.flatMap((attachmentId) => {
				const attachment = selectedAttachments.get(attachmentId);
				if (attachment?.kind !== "file" || attachment.fileCount !== 1) return [];
				const metadata = s.attachments.resolveFile(conversationId, attachmentId);
				if (!metadata.mime.toLowerCase().startsWith("image/")) return [];
				const file = s.attachments.readFile(conversationId, attachmentId);
				return [{ data: file.buffer, mimeType: metadata.mime }];
			});
			const framed = nonce
				? `<host_context>\nConversation attachment references for this message (use Host attachment tools; these are not paths):\n${attachmentNames.join("\n")}\nSend nonce: ${nonce}\n</host_context>\n\n<current_user_message>\n${text}\n</current_user_message>`
				: text;
			const receipt = await s.turns.sendUserMessage(conversationId, framed, currentMessageImages);
			if (nonce) s.attachments.finishSend(conversationId, nonce, receipt.entryId);
			return receipt;
		} catch (error) {
			if (nonce) s.attachments.abortSend(conversationId, nonce);
			throw error;
		}
	});
	dispatcher.registerHandler(RPC.message.abort, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await requireOwnedConversation(s, conversationId);
		await s.turns.abort(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.regenerate, async (_p) => {
		const { conversationId, entryId } = _p as { conversationId: string; entryId: string };
		await requireOwnedConversation(s, conversationId);
		await s.turns.regenerate(conversationId, entryId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.switchVersion, async (_p) => {
		const { conversationId, leafId } = _p as { conversationId: string; leafId: string };
		await requireOwnedConversation(s, conversationId);
		await s.turns.switchVersion(conversationId, leafId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.edit, async (_p) => {
		const { conversationId, entryId, text } = _p as {
			conversationId: string;
			entryId: string;
			text: string;
		};
		await requireOwnedConversation(s, conversationId);
		await s.turns.edit(conversationId, entryId, text);
		return {};
	});
	dispatcher.registerHandler(RPC.message.continue, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await requireOwnedConversation(s, conversationId);
		await s.turns.continue(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.correct, async (_p) => {
		const { conversationId, reason, applyScope } = _p as {
			conversationId: string;
			reason: string;
			applyScope: "once" | "session" | "always";
		};
		await requireOwnedConversation(s, conversationId);
		await s.turns.correct(conversationId, reason, applyScope);
		return {};
	});
	dispatcher.registerHandler(RPC.message.branch, async (_p) => {
		const { conversationId, entryId } = _p as { conversationId: string; entryId: string };
		await requireOwnedConversation(s, conversationId);
		return s.turns.branch(conversationId, entryId);
	});
	dispatcher.registerHandler(RPC.memory.capture, async (_p) => {
		const params = _p as { conversationId: string; entryId: string };
		return rememberConversationEntry(s, params.conversationId, params.entryId, "user_capture");
	});

	dispatcher.registerHandler(RPC.memory.configureLocalEmbedding, async (_p) => {
		const { provider, candidateId, customPath } = _p as {
			provider: "none" | "local";
			candidateId?: string;
			customPath?: string;
		};
		if (provider === "none") {
			await s.memoryRuntime.disableLocalEmbedding();
			await saveMemoryVectorService({ enabled: false, provider: "none" });
			return { ready: true as const };
		}
		const candidate = candidateId ? findHostLocalEmbeddingCandidate(candidateId) : undefined;
		if (candidateId && !candidate)
			throw { kind: "invalid_request", reason: "local_embedding_candidate_not_found" };
		const modelPath = candidate?.modelPath ?? customPath?.trim();
		if (!modelPath) throw { kind: "invalid_request", reason: "local_embedding_model_not_selected" };
		const source = s.appSettings.load().modelDownloadSource;
		const hfEndpoint =
			source.type === "official"
				? "https://huggingface.co"
				: source.type === "hf-mirror"
					? "https://hf-mirror.com"
					: source.endpoint;
		const endpointUrl = new URL(hfEndpoint);
		if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password) {
			throw { kind: "invalid_request", reason: "invalid_model_download_endpoint" };
		}
		await s.memoryRuntime.configureLocalEmbedding({
			modelPath,
			dimensions: 768,
			hfEndpoint: endpointUrl.href.replace(/\/$/, ""),
		});
		await saveMemoryVectorService({
			enabled: true,
			provider: "local",
			...(candidate ? { localModel: candidate.id } : { customPath: modelPath }),
		});
		return { ready: true as const };
	});
	dispatcher.registerHandler(RPC.memory.search, async (_p): Promise<MemorySearchResponse> => {
		const { characterId, query } = _p as { characterId?: string; query: string };
		const scope = memoryBackendScopeForCharacter(s, characterId);
		await s.memoryBackend.open({ scope });
		const hits = await s.memoryBackend.recall({
			scope,
			query,
			limit: 50,
		});
		return {
			entries: hits.map(({ record }) => projectMemoryEntry(record)),
		};
	});
	dispatcher.registerHandler(RPC.memory.list, async (_p): Promise<MemoryListResponse> => {
		const {
			characterId,
			enabled = true,
			limit,
		} = _p as { characterId?: string; enabled?: boolean; limit?: number };
		if (!enabled) return { entries: [] };
		const scope = memoryBackendScopeForCharacter(s, characterId);
		await s.memoryBackend.open({ scope });
		const records = await s.memoryBackend.list({
			scope,
			limit: limit ?? 50,
		});
		return {
			entries: records.map((record) => projectMemoryEntry(record)),
		};
	});
	dispatcher.registerHandler(RPC.memory.forget, async (_p) => {
		const { characterId, entryId } = _p as { characterId?: string; entryId: string };
		const scope = memoryBackendScopeForCharacter(s, characterId);
		await s.memoryBackend.open({ scope });
		await s.memoryBackend.forget({ scope, memoryId: entryId });
		return {};
	});
	dispatcher.registerHandler(RPC.memory.edit, async (_p) => {
		const { characterId, entryId, newText } = _p as {
			characterId?: string;
			entryId: string;
			newText: string;
		};
		const scope = memoryBackendScopeForCharacter(s, characterId);
		await s.memoryBackend.open({ scope });
		await s.memoryBackend.update({ scope, memoryId: entryId, text: newText });
		return {};
	});
	dispatcher.registerHandler(RPC.memory.exclude, async (_p) => {
		const { characterId, memoryId, excluded } = _p as {
			characterId?: string;
			memoryId: string;
			excluded: boolean;
		};
		const { installationId, userId } = s.memoryScope;
		const companionId = memoryBackendScopeForCharacter(s, characterId).companionId;
		if (excluded) {
			const now = new Date().toISOString();
			const existing = s.orm
				.select({ backendMemoryId: memoryPresentation.backendMemoryId })
				.from(memoryPresentation)
				.where(
					and(
						eq(memoryPresentation.backendMemoryId, memoryId),
						eq(memoryPresentation.installationId, installationId),
						eq(memoryPresentation.userId, userId),
						eq(memoryPresentation.companionId, companionId),
					),
				)
				.get();
			if (existing) {
				s.orm
					.update(memoryPresentation)
					.set({ excludedAt: now })
					.where(
						and(
							eq(memoryPresentation.backendMemoryId, memoryId),
							eq(memoryPresentation.installationId, installationId),
							eq(memoryPresentation.userId, userId),
							eq(memoryPresentation.companionId, companionId),
						),
					)
					.run();
			} else {
				s.orm
					.insert(memoryPresentation)
					.values({
						backendMemoryId: memoryId,
						installationId,
						userId,
						companionId,
						sourcePiEntryId: null,
						createdBy: "auto_episode",
						pinned: false,
						excludedAt: now,
					})
					.onConflictDoUpdate({
						target: [
							memoryPresentation.backendMemoryId,
							memoryPresentation.installationId,
							memoryPresentation.userId,
							memoryPresentation.companionId,
						],
						set: { excludedAt: now },
					})
					.run();
			}
		} else {
			s.orm
				.update(memoryPresentation)
				.set({ excludedAt: null })
				.where(
					and(
						eq(memoryPresentation.backendMemoryId, memoryId),
						eq(memoryPresentation.installationId, installationId),
						eq(memoryPresentation.userId, userId),
						eq(memoryPresentation.companionId, companionId),
					),
				)
				.run();
		}
		return {};
	});
	dispatcher.registerHandler(RPC.memory.candidatesList, async (_p) => {
		const { characterId, status } = _p as {
			characterId?: string;
			status?: "pending" | "approved" | "rejected" | "expired";
		};
		const companionId = memoryBackendScopeForCharacter(s, characterId).companionId;
		const rows = s.orm
			.select({
				id: memoryCandidates.id,
				kind: memoryCandidates.kind,
				sourceKind: memoryCandidates.sourceKind,
				normalizedText: memoryCandidates.normalizedText,
				why: memoryCandidates.why,
				suggestedScope: memoryCandidates.suggestedScope,
				status: memoryCandidates.status,
				createdAt: memoryCandidates.createdAt,
			})
			.from(memoryCandidates)
			.where(
				and(
					eq(memoryCandidates.companionId, companionId),
					eq(memoryCandidates.status, status ?? "pending"),
				),
			)
			.orderBy(desc(memoryCandidates.createdAt))
			.all();
		return {
			candidates: rows.map((row) => ({
				...row,
				kind: row.kind,
				sourceKind: row.sourceKind,
				suggestedScope: row.suggestedScope,
				status: row.status,
			})),
		};
	});
	dispatcher.registerHandler(RPC.memory.candidateApprove, async (_p) => {
		const { characterId, candidateId, editedText, decidedScope } = _p as {
			characterId?: string;
			candidateId: string;
			editedText?: string;
			decidedScope?: "self" | "relationship" | "scene";
		};
		const companionId = memoryBackendScopeForCharacter(s, characterId).companionId;
		const candidate = s.orm
			.select()
			.from(memoryCandidates)
			.where(
				and(
					eq(memoryCandidates.id, candidateId),
					eq(memoryCandidates.companionId, companionId),
					eq(memoryCandidates.status, "pending"),
				),
			)
			.get();
		if (!candidate) throw { kind: "not_found", reason: "memory_candidate_not_found" };
		const effectiveScope = decidedScope ?? candidate.suggestedScope;
		const finalText = editedText?.trim() || candidate.normalizedText;
		const decisionId = crypto.randomUUID();
		const entryId = crypto.randomUUID();
		const now = new Date().toISOString();
		const backendScope: MemoryBankScope = { ...s.memoryScope, companionId };

		// Stage the provider record first. If the owned pending-row transition
		// loses a race, compensate this provider write and leave Host rows
		// untouched.
		await s.memoryBackend.open({ scope: backendScope });
		const backendRecord = await s.memoryBackend.remember({
			scope: backendScope,
			text: finalText,
			importance: 1.0,
			provenance: {
				kind: "inferred",
				piSessionEntryIds: [candidate.sourceNativeEntryId ?? candidate.id],
				sourceRef: candidate.id,
			},
			metadata: { scope: effectiveScope },
		});

		try {
			// Candidate state, decision audit, and relationship projection are one
			// database transition. A concurrent approve/reject cannot leave a
			// decision row without exactly one corresponding pending transition.
			s.orm.transaction((transaction) => {
				const changed = transaction
					.update(memoryCandidates)
					.set({ status: "approved", decidedAt: now })
					.where(
						and(
							eq(memoryCandidates.id, candidateId),
							eq(memoryCandidates.companionId, companionId),
							eq(memoryCandidates.status, "pending"),
						),
					)
					.run().changes;
				if (Number(changed) !== 1) {
					throw { kind: "conflict", reason: "memory_candidate_already_decided" };
				}
				transaction
					.insert(memoryDecisions)
					.values({
						id: decisionId,
						candidateId,
						decision: editedText?.trim() ? "approve_edited" : "approve",
						editedText: editedText?.trim() || null,
						decidedScope: effectiveScope,
					})
					.run();
				transaction
					.insert(relationshipMemoryEntries)
					.values({
						id: entryId,
						companionId,
						kind: candidate.kind,
						scope: effectiveScope,
						text: finalText,
						normalizedText: finalText,
						sourcePiSessionId: candidate.sourcePiSessionId,
						sourceNativeEntryId: candidate.sourceNativeEntryId,
						sourceConversationId: candidate.sourceConversationId,
						sourceKind: candidate.sourceKind,
						status: "active",
					})
					.run();
			});
		} catch (error) {
			await s.memoryBackend
				.forget({ scope: backendScope, memoryId: backendRecord.id })
				.catch(() => undefined);
			throw error;
		}
		return {};
	});
	dispatcher.registerHandler(RPC.memory.candidateReject, async (_p) => {
		const { characterId, candidateId } = _p as { characterId?: string; candidateId: string };
		const companionId = memoryBackendScopeForCharacter(s, characterId).companionId;
		const candidate = s.orm
			.select({ id: memoryCandidates.id, status: memoryCandidates.status })
			.from(memoryCandidates)
			.where(
				and(eq(memoryCandidates.id, candidateId), eq(memoryCandidates.companionId, companionId)),
			)
			.get();
		if (!candidate) throw { kind: "not_found", reason: "memory_candidate_not_found" };
		if (candidate.status !== "pending") {
			throw { kind: "conflict", reason: "memory_candidate_already_decided" };
		}
		const decisionId = crypto.randomUUID();
		const now = new Date().toISOString();
		s.orm.transaction((transaction) => {
			const changed = transaction
				.update(memoryCandidates)
				.set({ status: "rejected", decidedAt: now })
				.where(
					and(
						eq(memoryCandidates.id, candidateId),
						eq(memoryCandidates.companionId, companionId),
						eq(memoryCandidates.status, "pending"),
					),
				)
				.run().changes;
			if (Number(changed) !== 1) {
				throw { kind: "conflict", reason: "memory_candidate_already_decided" };
			}
			transaction
				.insert(memoryDecisions)
				.values({ id: decisionId, candidateId, decision: "reject" })
				.run();
		});
		return {};
	});

	// --- canon hub (advanced authoring) ---------------------------------------------
	dispatcher.registerHandler(RPC.canon.listSources, async () => ({
		sources: s.canon.listSources(await getCompanionId(s)),
	}));
	dispatcher.registerHandler(RPC.canon.addSource, async (_p) => {
		const { logicalName, content } = _p as { logicalName: string; content: string };
		return { source: s.canon.addSource(await getCompanionId(s), logicalName, content) };
	});
	dispatcher.registerHandler(RPC.canon.search, async (_p) => ({
		chunks: await s.canon.searchHybrid(await getCompanionId(s), (_p as { query: string }).query),
	}));
	dispatcher.registerHandler(RPC.canon.removeSource, async (_p) => {
		s.canon.removeSource(await getCompanionId(s), (_p as { sourceId: string }).sourceId);
		return {};
	});
	dispatcher.registerHandler(RPC.canon.listModules, async () => ({
		modules: s.canon.listModules(await getCompanionId(s)),
	}));
	dispatcher.registerHandler(RPC.canon.upsertModule, async (_p) => ({
		module: s.canon.upsertModule({
			...(_p as Parameters<CanonHubService["upsertModule"]>[0]),
			companionId: await getCompanionId(s),
		}),
	}));
	dispatcher.registerHandler(RPC.canon.deleteModule, async (_p) => {
		s.canon.deleteModule(await getCompanionId(s), (_p as { id: string }).id);
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
		await s.supervisor.stop();
		await s.supervisor.start();
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
		await s.supervisor.stop();
		await s.supervisor.start();
		return { models };
	});
	dispatcher.registerHandler(RPC.provider.overrideBaseUrl, async (_p) => {
		const input = _p as { providerId: string; baseUrl: string };
		await s.providers.overrideProviderBaseUrl(input);
		await s.supervisor.stop();
		await s.supervisor.start();
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
		await s.supervisor.stop();
		await s.supervisor.start();
		return {};
	});
	dispatcher.registerHandler(RPC.provider.login, async (_p) => {
		const { providerId } = _p as { providerId: string };
		return oauthWire(await s.providers.startOAuth(providerId));
	});
	dispatcher.registerHandler(RPC.provider.loginCancel, async (_p) => {
		const { providerId } = _p as { providerId: string };
		s.providers.cancelOAuth(providerId);
		return {};
	});
	dispatcher.registerHandler(RPC.provider.loginStatus, async (_p) => {
		const providerId = (_p as { providerId: string }).providerId;
		const state = await s.providers.getOAuthSession(providerId);
		if (state.status === "completed") {
			await syncProviderModels(state.providerId, s.providers, s.models);
		}
		return oauthWire(state);
	});
	dispatcher.registerHandler(RPC.provider.loginAnswer, async (_p) => {
		const { providerId, answer } = _p as { providerId: string; answer: string };
		const state = await s.providers.answerOAuth(providerId, answer);
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
		await s.supervisor.stop();
		await s.supervisor.start();
		return {};
	});
	dispatcher.registerHandler(RPC.provider.logout, async (_p) => {
		const { providerId } = _p as { providerId: string };
		await s.providers.logout(providerId);
		return {};
	});

	// --- configured models ------------------------------------------------------------
	dispatcher.registerHandler(RPC.model.poolGet, async () => {
		await syncAllProviderModels(s.providers, s.models);
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
		const { providerId, modelId } = _p as { providerId: string; modelId: string };
		s.models.disable(providerId, modelId);
		return {};
	});
	dispatcher.registerHandler(RPC.model.defaultsGet, async () => {
		const companionId = await getCompanionId(s);
		return modelDefaultsWire(s.models.defaults(companionId));
	});
	dispatcher.registerHandler(RPC.model.defaultsSetReply, async (_p) => {
		const { reply } = _p as { reply: { providerId: string; modelId: string } | null };
		const companionId = await getCompanionId(s);
		return modelDefaultsWire(s.models.setDefaultReply(companionId, reply));
	});
	dispatcher.registerHandler(RPC.model.defaultsSetVision, async (_p) => {
		const companionId = await getCompanionId(s);
		return modelDefaultsWire(
			s.models.setVisionDefault(
				companionId,
				_p as { mode: "auto" } | { mode: "manual"; route: { providerId: string; modelId: string } },
			),
		);
	});
	dispatcher.registerHandler(RPC.model.routeGet, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		const selected = s.models.selected(conversationId);
		return {
			conversationId,
			...(selected ? { selected: modelRouteWire(selected) } : {}),
		};
	});
	dispatcher.registerHandler(RPC.model.routeSet, async (_p) => {
		const { conversationId, selected } = _p as {
			conversationId: string;
			selected: { providerId: string; modelId: string };
		};
		const model = s.models.select(conversationId, selected.providerId, selected.modelId);
		return { conversationId, selected: modelRouteWire(model) };
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
		const companionId = await getCompanionId(s);
		return { runs: s.externalAgentRuns.list(companionId).map(runWire) };
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
		return runWire(await s.externalAgentRuns.interruptRun(runId));
	});
	dispatcher.registerHandler(RPC.run.resume, async (_p) => {
		const { runId } = _p as { runId: string };
		await requireOwnedRun(s, runId);
		return runWire(await s.externalAgentRuns.resumeRun(runId));
	});
	dispatcher.registerHandler(RPC.run.cancel, async (_p) => {
		const { runId } = _p as { runId: string };
		await requireOwnedRun(s, runId);
		return runWire(await s.externalAgentRuns.cancelRun(runId));
	});
	dispatcher.registerHandler(RPC.run.respondPermission, async (_p) => {
		const { runId, requestId, optionId } = _p as {
			runId: string;
			requestId: string;
			optionId: string;
		};
		await requireOwnedRun(s, runId);
		return runWire(
			await s.externalAgentRuns.respondToExecutorPermission(runId, requestId, optionId),
		);
	});

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
			({ id, name, dimensions, isDefault }) => ({ id, name, dimensions, isDefault }),
		),
	}));
	dispatcher.registerHandler(RPC.settings.get, async (_p) => {
		const { characterId } = _p as { characterId?: string };
		const companionId = memoryBackendScopeForCharacter(s, characterId).companionId;
		const stateData = s.onboarding.getState(companionId).stateData;
		const app = s.appSettings.load();
		return {
			settings: {
				relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
				conversationHistoryReadEnabled:
					stateData.decisions.conversation_history_read_enabled ?? false,
				networkProxy: app.networkProxy,
				memoryVectorService: app.memoryVectorService,
				modelDownloadSource: app.modelDownloadSource,
			},
		};
	});
	dispatcher.registerHandler(RPC.settings.set, async (_p) => {
		const { characterId, settings } = _p as {
			characterId?: string;
			settings: Record<string, unknown>;
		};
		const companionId = memoryBackendScopeForCharacter(s, characterId).companionId;
		if (
			characterId &&
			["networkProxy", "memoryVectorService", "modelDownloadSource"].some((key) => key in settings)
		)
			throw {
				kind: "invalid_request",
				reason: "character_settings_may_only_change_relationship_options",
			};
		if ("relationshipMemoryEnabled" in settings) {
			s.onboarding.setRelationshipMemory(companionId, Boolean(settings.relationshipMemoryEnabled));
		}
		if ("conversationHistoryReadEnabled" in settings) {
			s.onboarding.setConversationHistoryRead(
				companionId,
				Boolean(settings.conversationHistoryReadEnabled),
			);
		}
		let app = s.appSettings.load();
		const changed: string[] = [];
		if ("networkProxy" in settings) {
			app = s.appSettings.save({ networkProxy: settings.networkProxy as never });
			changed.push("networkProxy");
		}
		if ("memoryVectorService" in settings) {
			const memoryVectorService = settings.memoryVectorService as
				| { provider?: unknown }
				| undefined;
			if (memoryVectorService?.provider === "local") {
				throw { kind: "conflict", reason: "local_embedding_requires_transaction" };
			}
			app = s.appSettings.save({ memoryVectorService: settings.memoryVectorService as never });
			changed.push("memoryVectorService");
		}
		if ("modelDownloadSource" in settings) {
			app = s.appSettings.save({ modelDownloadSource: settings.modelDownloadSource as never });
			changed.push("modelDownloadSource");
		}
		const nextStateData = s.onboarding.getState(companionId).stateData;
		const nextSettings = {
			relationshipMemoryEnabled: nextStateData.decisions.relationship_memory_enabled ?? false,
			conversationHistoryReadEnabled:
				nextStateData.decisions.conversation_history_read_enabled ?? false,
			networkProxy: app.networkProxy,
			memoryVectorService: app.memoryVectorService,
			modelDownloadSource: app.modelDownloadSource,
		};
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
	dispatcher.registerHandler(RPC.snapshot.get, async () => {
		const companionId = await getCompanionId(s);
		const onboarding = s.onboarding.getState(companionId);
		const character = s.characterLoader.load(companionId);
		if (!character) {
			throw { kind: "unavailable", reason: "character_package_missing" };
		}
		const allowedSceneIds = new Set(character.scenes.map((scene) => scene.id));
		const allowedVisualStates = new Set(
			character.visual.expressions.map((expression) => expression.id),
		);
		const convRows = conversationRepository.list(companionId);
		const conversationIds = new Set(convRows.map((row) => row.id));
		const characterRuntimeByConversation: Record<string, { sceneId: string; visualState: string }> =
			{};
		const sceneRows = s.orm.select().from(sceneState).orderBy(desc(sceneState.updatedAt)).all();
		for (const row of sceneRows) {
			if (
				!conversationIds.has(row.conversationId) ||
				characterRuntimeByConversation[row.conversationId]
			) {
				continue;
			}
			const state = CharacterRuntimeState.parse({ sceneId: row.scene, ...row.stateJson });
			if (!allowedSceneIds.has(state.sceneId) || !allowedVisualStates.has(state.visualState)) {
				throw new Error(`invalid persisted scene state for conversation ${row.conversationId}`);
			}
			characterRuntimeByConversation[row.conversationId] = {
				sceneId: state.sceneId,
				visualState: state.visualState,
			};
		}
		const eventSeq = s.eventBus.currentSeq;
		const activeProjection = conversationRepository.active(companionId);
		const activeConversationSnapshot = activeProjection
			? {
					activeConversationId: activeProjection.activeConversationId,
					id: activeProjection.id,
					title: activeProjection.title,
					sceneTitle: activeProjection.sceneTitle,
					piTimeline: activeProjection.piTimeline,
				}
			: undefined;
		const defaults = s.models.defaults(companionId);
		const providerNames = new Map(
			(await s.providers.listProviders()).map((provider) => [provider.id, provider.name]),
		);
		return {
			eventSeq,
			onboarding: { ...onboarding, eventSeq },
			character: s.characterLoader.display(character),
			conversation: {
				conversations: convRows,
				...(activeConversationSnapshot ?? {}),
			},
			run: {
				runs: s.externalAgentRuns.list(companionId).map(runWire),
			},
			characterRuntime: { byConversation: characterRuntimeByConversation },
			roleplay: s.roleplay.project(character, activeProjection?.id),
			model: {
				pool: {
					models: s.models.list().map((model) => ({
						...model,
						providerName: providerNames.get(model.providerId) ?? model.providerId,
					})),
				},
				defaults: modelDefaultsWire(defaults),
				...(activeProjection
					? {
							route: modelRouteResponse(
								activeProjection.id,
								s.models.selected(activeProjection.id),
							),
						}
					: {}),
			},
			settings: {
				relationshipMemoryEnabled:
					onboarding.stateData.decisions.relationship_memory_enabled ?? false,
				conversationHistoryReadEnabled:
					onboarding.stateData.decisions.conversation_history_read_enabled ?? false,
				networkProxy: s.appSettings.load().networkProxy,
				memoryVectorService: s.appSettings.load().memoryVectorService,
				modelDownloadSource: s.appSettings.load().modelDownloadSource,
			},
		};
	});
}

function modelRouteWire(model: { providerId: string; modelId: string }) {
	return { providerId: model.providerId, modelId: model.modelId };
}

function modelRouteResponse(
	conversationId: string,
	selected: { providerId: string; modelId: string } | undefined,
) {
	return { conversationId, ...(selected ? { selected: modelRouteWire(selected) } : {}) };
}

function modelDefaultsWire(defaults: {
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

export type MemoryCaptureCreator = "user_capture" | "assistant_tool";

export async function proposeMemoryCandidate(
	s: HostCompositionContext,
	conversationId: string,
): Promise<{ memoryId: string; sourceEntryId: string; createdBy: MemoryCaptureCreator }> {
	// host_remember has no entry ID: resolve the most recent user message on
	// the conversation's current native Pi branch as the suggestion source.
	const session = s.conversationRepository.getSession(conversationId);
	const source = session
		? [...session.readMessageEntries()].reverse().find((entry) => entry.message.role === "user")
		: undefined;
	if (!source) throw { kind: "not_found", reason: "memory_source_not_found" };
	return rememberConversationEntry(s, conversationId, source.id, "assistant_tool");
}

/**
 * A source must resolve to a native Pi SessionManager entry on the
 * conversation's active branch; Host SQLite messages are not a projection.
 */
export async function rememberConversationEntry(
	s: HostCompositionContext,
	conversationId: string,
	entryId: string | undefined,
	createdBy: MemoryCaptureCreator,
): Promise<{ memoryId: string; sourceEntryId: string; createdBy: MemoryCaptureCreator }> {
	const companionId = await getCompanionId(s);
	const conversation = s.orm
		.select({ id: conversations.id, companionId: conversations.companionId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.get();
	if (!conversation || conversation.companionId !== companionId) {
		throw { kind: "not_found", reason: "conversation_not_found" };
	}
	const session = s.conversationRepository.getSession(conversationId);
	const directSource =
		session && entryId
			? session.readMessageEntries().find((candidate) => candidate.id === entryId)
			: undefined;
	const projectedSource =
		session && entryId
			? s.conversationRepository.getCurrentPiEntryForMessage?.(conversationId, entryId)
			: undefined;
	const source = directSource ?? projectedSource;
	const sessionSource = session && entryId ? session.getMessageEntry(entryId) : undefined;
	if (!source && sessionSource) {
		throw { kind: "conflict", reason: "memory_source_not_current_branch" };
	}
	if (!source) {
		throw { kind: "not_found", reason: "memory_source_not_found" };
	}
	const text = piEntryText(source.message);
	if (!text) throw { kind: "invalid_input", reason: "memory_source_empty" };
	const sourceEntryId = source.id;
	const scope = { ...s.memoryScope, companionId };
	await s.memoryBackend.open({ scope });
	const record = await s.memoryBackend.remember({
		scope,
		text,
		provenance: {
			kind: createdBy === "user_capture" ? "explicit" : "inferred",
			piSessionEntryIds: [sourceEntryId],
			sourceRef: conversationId,
		},
		metadata: {
			conversationId,
			companionId,
			...(session ? { sessionId: session.sessionId } : {}),
			sourceEntryId,
			createdBy,
		},
	});
	return { memoryId: record.id, sourceEntryId, createdBy };
}

/**
 * Extract text from a native Pi message for memory provenance.
 */
function piEntryText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((part) => {
							if (!part || typeof part !== "object" || !("type" in part) || !("text" in part))
								return "";
							const type = part.type;
							const value = part.text;
							return type === "text" && typeof value === "string" ? value : "";
						})
						.filter(Boolean)
						.join("\n")
				: "";
	if ("role" in message && message.role === "user") {
		const projected = extractPiCurrentUserMessage(text);
		if (projected !== undefined) return projected;
	}
	return text.trim();
}

const HOST_CONTEXT_PREFIX = "<host_context>\n";
const HOST_CONTEXT_SEPARATOR = "\n</host_context>\n\n<current_user_message>\n";
const CURRENT_USER_MESSAGE_SUFFIX = "\n</current_user_message>";

function extractPiCurrentUserMessage(content: string): string | undefined {
	if (!content.startsWith(HOST_CONTEXT_PREFIX) || !content.endsWith(CURRENT_USER_MESSAGE_SUFFIX)) {
		return undefined;
	}
	const separatorIndex = content.indexOf(HOST_CONTEXT_SEPARATOR, HOST_CONTEXT_PREFIX.length);
	if (separatorIndex <= HOST_CONTEXT_PREFIX.length) return undefined;
	return content.slice(
		separatorIndex + HOST_CONTEXT_SEPARATOR.length,
		-CURRENT_USER_MESSAGE_SUFFIX.length,
	);
}

function memoryBackendScopeForCharacter(
	s: HostCompositionContext,
	characterId?: string,
): MemoryBankScope {
	const resolvedId = characterId ?? getActiveCompanionId(s);
	const character = s.characterLoader.load(resolvedId);
	if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
	return { ...s.memoryScope, companionId: resolvedId };
}

function getActiveCompanionId(s: HostCompositionContext): string {
	const packageId = s.characterLoader.getActiveCharacterId(s.orm, s.defaultCharacterId);
	ensureCharacterSeeded(s);
	const seeded = s.orm
		.select({ id: companionIdentity.id })
		.from(companionIdentity)
		.where(eq(companionIdentity.id, packageId))
		.get();
	if (!seeded) throw { kind: "unavailable", reason: "character_package_missing" };
	return seeded.id;
}

async function requireOwnedConversation(
	s: HostCompositionContext,
	conversationId: string,
): Promise<void> {
	const companionId = await getCompanionId(s);
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

async function requireOwnedUserEntry(
	s: HostCompositionContext,
	conversationId: string,
	entryId: string,
): Promise<PiSessionMessageEntry> {
	await requireOwnedConversation(s, conversationId);
	const session = s.conversationRepository.getSession(conversationId);
	if (!session) throw { kind: "unavailable", reason: "conversation_pi_session_missing" };
	const piEntry = session.getMessageEntry(entryId);
	if (!piEntry || piEntry.message.role !== "user")
		throw { kind: "not_found", reason: "message_entry_not_found" };
	if (!session.isEntryOnCurrentBranch(piEntry.id))
		throw { kind: "conflict", reason: "message_not_current_branch" };
	return piEntry;
}

function runWire(run: RunSummary) {
	return {
		id: run.id,
		conversationId: run.conversationId,
		triggerEntryId: run.triggerEntryId,
		executorProfile: run.executorProfile,
		title: run.title,
		status: run.status,
		startedAt: run.startedAt ?? undefined,
		completedAt: run.completedAt ?? undefined,
	};
}

function projectMemoryEntry(record: MemoryRecord): MemoryEntry {
	const metadata = record.metadata;
	const kind = typeof metadata.kind === "string" ? metadata.kind : "fact";
	const scope: MemoryEntry["scope"] =
		metadata.scope === "self" || metadata.scope === "scene" ? metadata.scope : "relationship";
	const sourceEntryId =
		typeof metadata.sourceEntryId === "string" &&
		metadata.sourceEntryId.length > 0 &&
		metadata.sourceEntryId.length <= 128
			? metadata.sourceEntryId
			: undefined;
	return {
		id: record.id,
		kind,
		scope,
		text: record.text,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		importance: record.importance,
		...(sourceEntryId ? { sourceEntryId } : {}),
	};
}

async function getCompanionId(s: HostCompositionContext): Promise<string> {
	const packageId = s.characterLoader.getActiveCharacterId(s.orm, s.defaultCharacterId);
	ensureCharacterSeeded(s);
	const seeded = s.orm
		.select({ id: companionIdentity.id })
		.from(companionIdentity)
		.where(eq(companionIdentity.id, packageId))
		.get();
	if (!seeded) throw { kind: "unavailable", reason: "character_package_missing" };
	return seeded.id;
}

/** Seed the active character package if it has not been seeded yet. */
function ensureCharacterSeeded(s: HostCompositionContext): void {
	const activeId = s.characterLoader.getActiveCharacterId(s.orm, s.defaultCharacterId);
	const character = s.characterLoader.load(activeId);
	if (!character) throw new Error(`character package missing: ${activeId}`);
	s.characterLoader.seed(s.orm, s.eventBus, character);
	s.canon.syncPackage(character.id, character.canon);
	const active = s.orm
		.select({ characterId: activeCharacter.characterId })
		.from(activeCharacter)
		.where(eq(activeCharacter.singleton, 1))
		.get();
	if (!active) s.characterLoader.activate(s.orm, s.eventBus, character);
}

/** Skills are always declarative context; executable plugins require current package trust. */
function configureCharacterRuntime(
	s: HostCompositionContext,
	character: Parameters<CharacterLoader["piResources"]>[0],
): void {
	const trust = s.characterLoader.pluginTrust(s.orm, character);
	s.supervisor.configureRuntime(s.characterLoader.piResources(character, trust.trusted));
}
