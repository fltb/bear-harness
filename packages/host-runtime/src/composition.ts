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

import { CharacterRuntimeState, RPC } from "@bear-harness/protocol/schema";
import type {
	MemoryEntry,
	MemoryListResponse,
	MemorySearchResponse,
} from "@bear-harness/protocol";
import { desc, eq } from "drizzle-orm";
import type { ArtifactStore } from "./artifacts/index.js";
import type { CanonHubService } from "./canon/service.js";
import type { CommissionService, RunStatus } from "./commissions/service.js";
import type { CharacterBehaviorService } from "./companion/character-behavior.js";
import type {
	CharacterDraftFiles,
	CharacterDraftService,
} from "./companion/character-draft-service.js";
import type { CharacterLoader } from "./companion/character-loader.js";
import type { FirstMeetingMachine } from "./companion/first-meeting.js";
import type { RoleplayService } from "./companion/roleplay-service.js";
import type { CompanionSupervisor } from "./companion/supervisor.js";
import type { TurnPipeline } from "./companion/turn-pipeline.js";
import { ConversationRepository } from "./conversations/repository.js";
import type { Dispatcher } from "./dispatcher.js";
import type { MemoryBackend, MemoryBankScope, MemoryRecord } from "./memory/backend.js";
import type {
	MemoryPresentationMetadata,
	MemoryPresentationStore,
} from "./memory/presentation-store.js";
import type { MemoryService } from "./memory/service.js";
import type { ModelRegistry } from "./models/registry.js";
import type { ProviderCatalog } from "./providers/catalog.js";
import type { AppDatabase } from "./storage/database.js";
import type { EventBus } from "./storage/event-bus.js";
import { activeCharacter, companionIdentity, conversations, runs, sceneState } from "./storage/schema.js";
import type { StoryService } from "./story/service.js";

/** Domain services and runtime-owned inputs the handlers read and mutate. */
export interface HostCompositionContext {
	orm: AppDatabase;
	eventBus: EventBus;
	onboarding: FirstMeetingMachine;
	turns: TurnPipeline;
	models: ModelRegistry;
	memory: MemoryService;
	memoryBackend: MemoryBackend;
	memoryPresentation: MemoryPresentationStore;
	memoryScope: Pick<MemoryBankScope, "installationId" | "userId">;
	commissions: CommissionService;
	artifacts: ArtifactStore;
	story: StoryService;
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
}

function oauthWire(state: Awaited<ReturnType<ProviderCatalog["startOAuth"]>>) {
	return {
		...state,
		prompt: state.prompt
			? {
					...state.prompt,
					options: state.prompt.options ? [...state.prompt.options] : undefined,
				}
			: undefined,
	};
}
export function wireHostHandlers(dispatcher: Dispatcher, s: HostCompositionContext): void {
	const conversationRepository = s.conversationRepository;
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
	dispatcher.registerHandler(RPC.conversation.create, async (_p) => {
		const companionId = await getCompanionId(s);
		const id = crypto.randomUUID();
		const branchId = crypto.randomUUID();
		const title = (_p as { title?: string }).title ?? "新对话";
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		const sceneTitle = character.character.scene_title;
		try {
			conversationRepository.create({ id, branchId, companionId, title, sceneTitle });
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		s.models.applyDefaultToConversation(companionId, id);
		s.eventBus.publish("conversation.created", { conversationId: id });
		return { id };
	});
	dispatcher.registerHandler(RPC.conversation.select, async (_p) => {
		const { id } = _p as { id: string };
		const companionId = await getCompanionId(s);
		const conversation = conversationRepository.get(id, companionId);
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
		if (!conversationRepository.archive(id, companionId, archived))
			throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.archived", { conversationId: id, archived });
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.delete, async (_p) => {
		const { id } = _p as { id: string };
		const companionId = await getCompanionId(s);
		s.supervisor.invalidateConversation(id);
		if (!conversationRepository.delete(id, companionId))
			throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.deleted", { conversationId: id });
		return {};
	});
	dispatcher.registerHandler(RPC.conversation.search, async (_p) => {
		const { query, includeArchived, limit } = _p as {
			query: string;
			includeArchived?: boolean;
			limit?: number;
		};
		return {
			hits: conversationRepository.search(await getCompanionId(s), query, {
				includeArchived,
				limit,
			}),
		};
	});

	// --- message ----------------------------------------------------------------
	dispatcher.registerHandler(RPC.message.send, async (_p) => {
		const { conversationId, text, attachments } = _p as {
			conversationId: string;
			text: string;
			attachments?: Array<{ name: string; mime: string; base64: string }>;
		};
		return s.turns.sendUserMessage(conversationId, text, attachments);
	});
	dispatcher.registerHandler(RPC.message.abort, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await s.turns.abort(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.regenerate, async (_p) => {
		const { conversationId, messageId } = _p as { conversationId: string; messageId: string };
		return s.turns.regenerate(conversationId, messageId);
	});
	dispatcher.registerHandler(RPC.message.switchVersion, async (_p) => {
		const { conversationId, messageId, versionId } = _p as {
			conversationId: string;
			messageId: string;
			versionId: string;
		};
		await s.turns.switchVersion(conversationId, messageId, versionId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.edit, async (_p) => {
		const { conversationId, messageId, text, isUserMessage } = _p as {
			conversationId: string;
			messageId: string;
			text: string;
			isUserMessage: boolean;
		};
		await s.turns.edit(conversationId, messageId, text, isUserMessage);
		return {};
	});
	dispatcher.registerHandler(RPC.message.continue, async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await s.turns.continue(conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.message.correct, async (_p) => {
		const { conversationId, reason, applyScope } = _p as {
			conversationId: string;
			reason: string;
			applyScope: "once" | "session" | "always";
		};
		await s.turns.correct(conversationId, reason, applyScope);
		return {};
	});
	dispatcher.registerHandler(RPC.message.branch, async (_p) => {
		const { conversationId, messageId } = _p as { conversationId: string; messageId: string };
		const branchId = await s.turns.branch(conversationId, messageId);
		return { branchId };
	});
	dispatcher.registerHandler(RPC.memory.capture, async (_p) => {
		const params = _p as { conversationId: string; entryId: string };
		return rememberConversationEntry(s, params.conversationId, params.entryId, "user_capture");
	});
	dispatcher.registerHandler(RPC.memory.invalidate, async (_p) => {
		const params = _p as { memoryId: string; replacementMemoryId?: string };
		const scope = await memoryBackendScope(s);
		await s.memoryBackend.open({ scope });
		await s.memoryBackend.invalidate({
			scope,
			memoryId: params.memoryId,
			replacementMemoryId: params.replacementMemoryId,
		});
		s.memoryPresentation.recordReplacement(scope, params.memoryId, params.replacementMemoryId);
		return {};
	});

	// --- memory ------------------------------------------------------------------
	dispatcher.registerHandler(RPC.memory.search, async (_p): Promise<MemorySearchResponse> => {
		const { query } = _p;
		const scope = await memoryBackendScope(s);
		await s.memoryBackend.open({ scope });
		const hits = await s.memoryBackend.recall({
			scope,
			query,
			limit: 50,
		});
		const records = hits.map(({ record }) => record);
		const presentations = presentationByMemoryId(s.memoryPresentation, scope, records);
		return {
			entries: records.map((record) => projectMemoryEntry(record, presentations.get(record.id))),
		};
	});
	dispatcher.registerHandler(RPC.memory.list, async (_p): Promise<MemoryListResponse> => {
		const { enabled = true, limit } = _p;
		if (!enabled) return { entries: [] };
		const scope = await memoryBackendScope(s);
		await s.memoryBackend.open({ scope });
		const records = await s.memoryBackend.list({
			scope,
			limit: limit ?? 50,
		});
		const presentations = presentationByMemoryId(s.memoryPresentation, scope, records);
		return {
			entries: records.map((record) => projectMemoryEntry(record, presentations.get(record.id))),
		};
	});
	dispatcher.registerHandler(RPC.memory.pin, async (_p) => {
		const { entryId, pinned } = _p as { entryId: string; pinned: boolean };
		const scope = await memoryBackendScope(s);
		await s.memoryBackend.open({ scope });
		await s.memoryBackend.setImportance({
			scope,
			memoryId: entryId,
			importance: pinned ? 1 : 0,
		});
		s.memoryPresentation.setPinned(scope, entryId, pinned);
		return {};
	});
	dispatcher.registerHandler(RPC.memory.forget, async (_p) => {
		const { entryId } = _p as { entryId: string };
		const scope = await memoryBackendScope(s);
		await s.memoryBackend.open({ scope });
		await s.memoryBackend.forget({ scope, memoryId: entryId });
		s.memoryPresentation.forget(scope, entryId);
		return {};
	});
	dispatcher.registerHandler(RPC.memory.edit, async (_p) => {
		const { entryId, newText } = _p as { entryId: string; newText: string };
		const scope = await memoryBackendScope(s);
		await s.memoryBackend.open({ scope });
		await s.memoryBackend.update({ scope, memoryId: entryId, text: newText });
		return {};
	});

	// --- story archive -------------------------------------------------------------
	dispatcher.registerHandler(RPC.story.listChanges, async (_p) => {
		const { branchId } = _p as { branchId?: string };
		return { changes: s.story.list({ companionId: await getCompanionId(s), branchId }) };
	});
	dispatcher.registerHandler(RPC.story.applyChange, async (_p) => {
		const params = _p as {
			conversationId?: string;
			branchId?: string;
			text: string;
			scope: "global" | "branch";
		};
		return {
			change: s.story.apply({
				...params,
				companionId: await getCompanionId(s),
				source: "user_confirmed",
			}),
		};
	});
	dispatcher.registerHandler(RPC.story.revertChange, async (_p) => {
		const { changeId, conversationId } = _p as { changeId: string; conversationId?: string };
		s.story.revert(changeId, conversationId);
		return {};
	});
	dispatcher.registerHandler(RPC.story.reset, async (_p) => {
		const { conversationId, branchId } = _p as { conversationId?: string; branchId?: string };
		return {
			count: s.story.reset({
				companionId: await getCompanionId(s),
				conversationId,
				branchId,
			}),
		};
	});
	dispatcher.registerHandler(RPC.story.listProposals, async (_p) => {
		const { conversationId } = _p as { conversationId?: string };
		return {
			proposals: s.story.listProposals({
				companionId: await getCompanionId(s),
				conversationId,
			}),
		};
	});
	dispatcher.registerHandler(RPC.story.resolveProposal, async (_p) => {
		const { proposalId, accept } = _p as { proposalId: string; accept: boolean };
		return { change: s.story.resolveProposal({ proposalId, accept }) };
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
		chunks: s.canon.search(await getCompanionId(s), (_p as { query: string }).query),
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
			modelId: string;
			apiKey?: string;
			supportsImages?: boolean;
		};
		await s.providers.upsertCustomProvider(input);
		await s.supervisor.stop();
		await s.supervisor.start();
		return {};
	});
	dispatcher.registerHandler(RPC.provider.importPiConfig, async (_p) => {
		const imported = await s.providers.importPiConfig((_p as { configJson: string }).configJson);
		const models = imported.map((model) =>
			s.models.enable({
				providerId: model.providerId,
				modelId: model.modelId,
				label: model.name,
				supportsImages: model.supportsImages,
			}),
		);
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
		return {};
	});
	dispatcher.registerHandler(RPC.provider.login, async (_p) => {
		const { providerId } = _p as { providerId: string };
		return oauthWire(await s.providers.startOAuth(providerId));
	});
	dispatcher.registerHandler(RPC.provider.loginStatus, async (_p) => {
		return oauthWire(await s.providers.getOAuthSession((_p as { providerId: string }).providerId));
	});
	dispatcher.registerHandler(RPC.provider.loginAnswer, async (_p) => {
		const { providerId, answer } = _p as { providerId: string; answer: string };
		return oauthWire(await s.providers.answerOAuth(providerId, answer));
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

	// --- run ------------------------------------------------------------------------
	dispatcher.registerHandler(RPC.run.list, async () => {
		const rows = s.orm.select().from(runs).orderBy(desc(runs.createdAt)).limit(10).all();
		return {
			runs: rows.map((r) => ({
				id: r.id,
				commissionId: r.commissionId,
				executorProfile: r.executorProfile,
				status: r.status as RunStatus,
				startedAt: r.startedAt ?? undefined,
				completedAt: r.completedAt ?? undefined,
			})),
		};
	});
	dispatcher.registerHandler(RPC.commission.list, async () => {
		return {
			commissions: s.commissions.list().map((commission) => ({
				id: commission.id,
				conversationId: commission.conversationId ?? undefined,
				status: commission.status,
				createdAt: commission.createdAt,
				draft: commission.draft,
			})),
		};
	});
	dispatcher.registerHandler(RPC.commission.draft, async (_p) => {
		const params = _p as {
			conversationId: string;
			title: string;
			description: string;
			reads?: string[];
			writes?: string[];
			networkAllowed?: boolean;
			toolNames?: string[];
		};
		return s.commissions.draft(params);
	});
	dispatcher.registerHandler(RPC.commission.approve, async (_p) => {
		const { commissionId, approvedHash } = _p as { commissionId: string; approvedHash: string };
		s.commissions.approve(commissionId, approvedHash);
		return {};
	});
	dispatcher.registerHandler(RPC.commission.reject, async (_p) => {
		s.commissions.reject((_p as { commissionId: string }).commissionId);
		return {};
	});
	dispatcher.registerHandler(RPC.commission.launch, async (_p) => {
		const { commissionId, executorProfile } = _p as {
			commissionId: string;
			executorProfile: string;
		};
		return s.commissions.launch({ commissionId, executorProfile });
	});
	dispatcher.registerHandler(RPC.run.steer, async (_p) => {
		const { runId, instruction } = _p as { runId: string; instruction: string };
		await s.commissions.steerRun(runId, instruction);
		return {};
	});
	dispatcher.registerHandler(RPC.run.cancel, async (_p) => {
		const { runId } = _p as { runId: string };
		const run = await s.commissions.cancelRun(runId);
		return {
			id: run.id,
			commissionId: run.commissionId,
			executorProfile: run.executorProfile,
			status: run.status,
			startedAt: run.startedAt ?? undefined,
			completedAt: run.completedAt ?? undefined,
		};
	});
	dispatcher.registerHandler(RPC.run.respondPermission, async (_p) => {
		const { runId, requestId, optionId } = _p as {
			runId: string;
			requestId: string;
			optionId: string;
		};
		const run = await s.commissions.respondToExecutorPermission(runId, requestId, optionId);
		return {
			id: run.id,
			commissionId: run.commissionId,
			executorProfile: run.executorProfile,
			status: run.status,
			startedAt: run.startedAt ?? undefined,
			completedAt: run.completedAt ?? undefined,
		};
	});

	// --- artifacts ------------------------------------------------------------------
	dispatcher.registerHandler(RPC.artifact.list, async () => ({
		artifacts: s.artifacts.list().map((artifact) => ({
			...artifact,
			producerRunId: artifact.producerRunId ?? undefined,
		})),
	}));
	dispatcher.registerHandler(RPC.artifact.read, async (_p) => {
		const { artifactId } = _p as { artifactId: string };
		const artifact = s.artifacts.get(artifactId);
		const blob = s.artifacts.readBlob(artifactId);
		if (!artifact || !blob) throw { kind: "not_found", reason: "artifact_not_found" };
		return {
			logicalName: artifact.logicalName,
			mime: artifact.mime,
			base64: blob.toString("base64"),
		};
	});

	// --- settings ----------------------------------------------------------------------
	dispatcher.registerHandler(RPC.settings.get, async () => {
		const companionId = await getCompanionId(s);
		const stateData = s.onboarding.getState(companionId).stateData;
		return {
			settings: {
				relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
				conversationHistoryReadEnabled:
					stateData.decisions.conversation_history_read_enabled ?? false,
			},
		};
	});
	dispatcher.registerHandler(RPC.settings.set, async (_p) => {
		const { settings } = _p as { settings: Record<string, unknown> };
		const companionId = await getCompanionId(s);
		if ("relationshipMemoryEnabled" in settings) {
			s.onboarding.setRelationshipMemory(companionId, Boolean(settings.relationshipMemoryEnabled));
		}
		if ("conversationHistoryReadEnabled" in settings) {
			s.onboarding.setConversationHistoryRead(
				companionId,
				Boolean(settings.conversationHistoryReadEnabled),
			);
		}
		const nextStateData = s.onboarding.getState(companionId).stateData;
		const nextSettings = {
			relationshipMemoryEnabled: nextStateData.decisions.relationship_memory_enabled ?? false,
			conversationHistoryReadEnabled:
				nextStateData.decisions.conversation_history_read_enabled ?? false,
		};
		s.eventBus.publish("settings.changed", { settings: nextSettings });
		return { settings: nextSettings };
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
		const activeRow = convRows[0];
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
				...(activeRow
					? conversationRepository.project(activeRow.id, activeRow.title, activeRow.sceneTitle)
					: {}),
			},
			artifact: {
				artifacts: s.artifacts.list().map((artifact) => ({
					...artifact,
					producerRunId: artifact.producerRunId ?? undefined,
				})),
			},
			story: {
				changes: s.story.list({
					companionId,
					branchId: activeRow
						? (conversationRepository.project(activeRow.id, activeRow.title, activeRow.sceneTitle)
								.activeBranchId as string | undefined)
						: undefined,
				}),
			},
			characterRuntime: { byConversation: characterRuntimeByConversation },
			roleplay: s.roleplay.project(character, activeRow?.id),
			model: {
				pool: {
					models: s.models.list().map((model) => ({
						...model,
						providerName: providerNames.get(model.providerId) ?? model.providerId,
					})),
				},
				defaults: modelDefaultsWire(defaults),
				...(activeRow
					? {
							route: modelRouteResponse(activeRow.id, s.models.selected(activeRow.id)),
						}
					: {}),
			},
			settings: {
				relationshipMemoryEnabled:
					onboarding.stateData.decisions.relationship_memory_enabled ?? false,
				conversationHistoryReadEnabled:
					onboarding.stateData.decisions.conversation_history_read_enabled ?? false,
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

/**
 * Save one Host-selected Pi source entry through the direct memory backend.
 * The entry ID is never trusted as a source by itself: it must belong to the
 * Pi branch currently selected for the conversation.
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
	if (!session) throw { kind: "not_found", reason: "conversation_session_not_found" };
	const entries = session.readMessageEntries();
	const source = entryId ? entries.find((candidate) => candidate.id === entryId) : entries.at(-1);
	if (!source) {
		throw { kind: "conflict", reason: "memory_source_not_current_branch" };
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
			sessionId: session.sessionId,
			sourceEntryId,
			createdBy,
		},
	});
	s.memoryPresentation.recordDirectCreation(scope, {
		backendMemoryId: record.id,
		sourcePiEntryId: sourceEntryId,
		createdBy,
	});
	return { memoryId: record.id, sourceEntryId, createdBy };
}

function piEntryText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || !("text" in part)) return "";
			const type = part.type;
			const text = part.text;
			return type === "text" && typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function memoryBackendScope(s: HostCompositionContext): MemoryBankScope {
	return {
		...s.memoryScope,
		companionId: getActiveCompanionId(s),
	};
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

function presentationByMemoryId(
	store: MemoryPresentationStore,
	scope: MemoryBankScope,
	records: readonly MemoryRecord[],
): ReadonlyMap<string, MemoryPresentationMetadata> {
	return new Map(
		store.list(
			scope,
			records.map((record) => record.id),
		).map((metadata) => [metadata.backendMemoryId, metadata]),
	);
}

function projectMemoryEntry(
	record: MemoryRecord,
	presentation: MemoryPresentationMetadata | undefined,
): MemoryEntry {
	const metadata = record.metadata;
	const kind = typeof metadata.kind === "string" ? metadata.kind : "fact";
	const scope: MemoryEntry["scope"] =
		metadata.scope === "self" || metadata.scope === "scene" ? metadata.scope : "relationship";
	const status: MemoryEntry["status"] =
		record.status === "invalidated" ? "invalidated" : "active";
	const presentationSourceEntryId = presentation?.sourcePiEntryId;
	const sourceEntryId = presentationSourceEntryId ?? metadata.sourceEntryId;
	const presentationCreatedBy = presentation?.createdBy;
	const createdBy: MemoryEntry["createdBy"] = presentationCreatedBy
		? presentationCreatedBy
		: metadata.createdBy === "user_capture" ||
			metadata.createdBy === "assistant_tool" ||
			metadata.createdBy === "auto_episode" ||
			metadata.createdBy === "imported"
			? metadata.createdBy
			: "imported";
	return {
		id: record.id,
		kind,
		scope,
		text: record.text,
		pinned: record.importance >= 1,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		importance: record.importance,
		status,
		createdBy: createdBy as MemoryEntry["createdBy"],
		...(sourceEntryId ? { sourceEntryId: sourceEntryId as string } : {}),
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
