/**
 * Host composition — wires all domain services to the instance dispatcher.
 *
 * Called from `HostRuntime` construction after the database is open. Each
 * domain registers its handlers via `dispatcher.registerHandler(channel,
 * handler)`. Handlers run inside the dispatcher's schema-validation envelope
 * and receive no `BrowserWindow` argument: everything they need lives on the
 * instance-scoped composition context.
 *
 * The handler set mirrors the legacy `wireAllHandlers` exactly: currently
 * unwired protocol channels (e.g. `artifact.list:v1`) are deliberately not
 * registered and keep returning `handler_not_registered`.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ArtifactStore } from "./artifacts/index.js";
import type { CanonHubService } from "./canon/service.js";
import type { CommissionService } from "./commissions/service.js";
import type { CharacterLoader } from "./companion/character-loader.js";
import type { FirstMeetingMachine } from "./companion/first-meeting.js";
import type { CompanionSupervisor } from "./companion/supervisor.js";
import type { TurnPipeline } from "./companion/turn-pipeline.js";
import type { VoiceStackManager } from "./companion/voice-stack.js";
import type { Dispatcher } from "./dispatcher.js";
import type { MemoryService } from "./memory/service.js";
import type { ProviderCatalog } from "./providers/catalog.js";
import type { EventBus } from "./storage/event-bus.js";
import type { StoryService } from "./story/service.js";

/** Domain services and runtime-owned inputs the handlers read and mutate. */
export interface HostCompositionContext {
	db: DatabaseSync;
	eventBus: EventBus;
	onboarding: FirstMeetingMachine;
	turns: TurnPipeline;
	voice: VoiceStackManager;
	memory: MemoryService;
	commissions: CommissionService;
	artifacts: ArtifactStore;
	story: StoryService;
	canon: CanonHubService;
	supervisor: CompanionSupervisor;
	providers: ProviderCatalog;
	characterLoader: CharacterLoader;
	defaultCharacterId: string;
}

/** Wire all RPC handlers to domain services. Call once per dispatcher. */
export function wireHostHandlers(dispatcher: Dispatcher, s: HostCompositionContext): void {
	// Load and seed the active character package from the character root once.
	ensureCharacterSeeded(s);

	// --- character package -----------------------------------------------------
	dispatcher.registerHandler("character.get:v1", async () => {
		const companionId = await getCompanionId(s);
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		return { character: s.characterLoader.display(character) };
	});
	dispatcher.registerHandler("character.list:v1", async () => ({
		characters: s.characterLoader.list(s.db, s.defaultCharacterId),
	}));
	dispatcher.registerHandler("character.activate:v1", async (_p) => {
		const { characterId } = _p as { characterId: string };
		const character = s.characterLoader.load(characterId);
		if (!character) throw { kind: "not_found", reason: "character_package_not_found" };
		if ((await getCompanionId(s)) === characterId) {
			return { character: s.characterLoader.display(character) };
		}
		s.characterLoader.activate(s.db, s.eventBus, character);
		await s.supervisor.stop();
		s.supervisor.configureRuntime(s.characterLoader.piResources(character));
		await s.supervisor.start();
		return { character: s.characterLoader.display(character) };
	});

	// --- role-defined onboarding -----------------------------------------------
	dispatcher.registerHandler("onboarding.get:v1", async () => {
		const companionId = await getCompanionId(s);
		return { ...s.onboarding.getState(companionId), eventSeq: s.eventBus.currentSeq };
	});
	dispatcher.registerHandler("onboarding.submit:v1", async (_p) => {
		const { stepId, answer } = _p as { stepId: string; answer?: string };
		const companionId = await getCompanionId(s);
		return {
			...s.onboarding.submit(companionId, stepId, answer),
			eventSeq: s.eventBus.currentSeq,
		};
	});

	// --- conversation ---------------------------------------------------------
	dispatcher.registerHandler("conversation.list:v1", async () => {
		const companionId = await getCompanionId(s);
		const rows = s.db
			.prepare(
				"SELECT id, title, scene_title, updated_at FROM conversations WHERE companion_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100",
			)
			.all(companionId) as Array<{
			id: string;
			title: string;
			scene_title: string;
			updated_at: string;
		}>;
		return {
			conversations: rows.map((r) => ({
				id: r.id,
				title: r.title,
				sceneTitle: r.scene_title,
				unread: false,
				updatedAt: r.updated_at,
			})),
		};
	});
	dispatcher.registerHandler("conversation.create:v1", async (_p) => {
		const companionId = await getCompanionId(s);
		const id = crypto.randomUUID();
		const branchId = crypto.randomUUID();
		const title = (_p as { title?: string }).title ?? "新对话";
		const character = s.characterLoader.load(companionId);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		const sceneTitle = character.character.scene_title;
		s.db.exec("BEGIN IMMEDIATE");
		try {
			s.db
				.prepare(
					"INSERT INTO conversations (id, companion_id, title, scene_title) VALUES (?, ?, ?, ?)",
				)
				.run(id, companionId, title, sceneTitle);
			s.db
				.prepare(
					"INSERT INTO branches (id, conversation_id, label, adopted) VALUES (?, ?, 'main', 1)",
				)
				.run(branchId, id);
			s.db.exec("COMMIT");
		} catch (e) {
			s.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		s.eventBus.publish("conversation.created", { conversationId: id });
		return { id };
	});
	dispatcher.registerHandler("conversation.select:v1", async (_p) => {
		const { id } = _p as { id: string };
		const companionId = await getCompanionId(s);
		const row = s.db
			.prepare(
				"SELECT id, title, scene_title FROM conversations WHERE id = ? AND companion_id = ? AND archived_at IS NULL",
			)
			.get(id, companionId) as { id: string; title: string; scene_title: string } | undefined;
		if (!row) throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.selected", { id });
		return conversationProjection(s.db, row.id, row.title, row.scene_title);
	});
	dispatcher.registerHandler("conversation.rename:v1", async (_p) => {
		const { id, title } = _p as { id: string; title: string };
		const companionId = await getCompanionId(s);
		const result = s.db
			.prepare(
				"UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND companion_id = ?",
			)
			.run(title.trim(), id, companionId);
		if (result.changes === 0) throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.renamed", { conversationId: id, title: title.trim() });
		return {};
	});
	dispatcher.registerHandler("conversation.archive:v1", async (_p) => {
		const { id, archived } = _p as { id: string; archived: boolean };
		const companionId = await getCompanionId(s);
		const result = s.db
			.prepare(
				"UPDATE conversations SET archived_at = ?, updated_at = datetime('now') WHERE id = ? AND companion_id = ?",
			)
			.run(archived ? new Date().toISOString() : null, id, companionId);
		if (result.changes === 0) throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.archived", { conversationId: id, archived });
		return {};
	});
	dispatcher.registerHandler("conversation.delete:v1", async (_p) => {
		const { id } = _p as { id: string };
		const companionId = await getCompanionId(s);
		const exists = s.db
			.prepare("SELECT id FROM conversations WHERE id = ? AND companion_id = ?")
			.get(id, companionId);
		if (!exists) throw { kind: "not_found", reason: "conversation_not_found" };
		s.db.exec("BEGIN IMMEDIATE");
		try {
			s.db
				.prepare("UPDATE commissions SET conversation_id = NULL WHERE conversation_id = ?")
				.run(id);
			s.db
				.prepare(
					"UPDATE relationship_memory_entries SET source_message_version_id = NULL, source_branch_id = NULL, source_conversation_id = NULL WHERE source_conversation_id = ?",
				)
				.run(id);
			s.db
				.prepare(
					"UPDATE memory_candidates SET source_message_version_id = NULL, source_branch_id = NULL, source_conversation_id = NULL WHERE source_conversation_id = ?",
				)
				.run(id);
			s.db
				.prepare("UPDATE story_change_events SET conversation_id = NULL WHERE conversation_id = ?")
				.run(id);
			s.db
				.prepare(
					"UPDATE story_changes SET status = 'reverted', reverted_at = datetime('now'), conversation_id = NULL, branch_id = NULL WHERE conversation_id = ? OR branch_id IN (SELECT id FROM branches WHERE conversation_id = ?)",
				)
				.run(id, id);
			s.db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(id);
			s.db
				.prepare(
					"DELETE FROM message_versions WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)",
				)
				.run(id);
			s.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
			s.db.prepare("DELETE FROM scene_state WHERE conversation_id = ?").run(id);
			s.db.prepare("DELETE FROM conversation_directives WHERE conversation_id = ?").run(id);
			s.db.prepare("DELETE FROM branches WHERE conversation_id = ?").run(id);
			s.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
			s.db.exec("COMMIT");
		} catch (error) {
			s.db.exec("ROLLBACK");
			throw { kind: "conflict", reason: "conversation_has_linked_work" };
		}
		s.eventBus.publish("conversation.deleted", { conversationId: id });
		return {};
	});

	// --- message ----------------------------------------------------------------
	dispatcher.registerHandler("message.send:v1", async (_p) => {
		const { conversationId, text } = _p as { conversationId: string; text: string };
		return s.turns.sendUserMessage(conversationId, text);
	});
	dispatcher.registerHandler("message.abort:v1", async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await s.turns.abort(conversationId);
		return {};
	});
	dispatcher.registerHandler("message.regenerate:v1", async (_p) => {
		const { conversationId, messageId } = _p as { conversationId: string; messageId: string };
		return s.turns.regenerate(conversationId, messageId);
	});
	dispatcher.registerHandler("message.switchVersion:v1", async (_p) => {
		const { conversationId, messageId, versionId } = _p as {
			conversationId: string;
			messageId: string;
			versionId: string;
		};
		await s.turns.switchVersion(conversationId, messageId, versionId);
		return {};
	});
	dispatcher.registerHandler("message.edit:v1", async (_p) => {
		const { conversationId, messageId, text, isUserMessage } = _p as {
			conversationId: string;
			messageId: string;
			text: string;
			isUserMessage: boolean;
		};
		await s.turns.edit(conversationId, messageId, text, isUserMessage);
		return {};
	});
	dispatcher.registerHandler("message.continue:v1", async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await s.turns.continue(conversationId);
		return {};
	});
	dispatcher.registerHandler("message.correct:v1", async (_p) => {
		const { conversationId, reason, applyScope } = _p as {
			conversationId: string;
			reason: string;
			applyScope: "once" | "session" | "always";
		};
		await s.turns.correct(conversationId, reason, applyScope);
		return {};
	});
	dispatcher.registerHandler("message.branch:v1", async (_p) => {
		const { conversationId, messageId } = _p as { conversationId: string; messageId: string };
		const branchId = await s.turns.branch(conversationId, messageId);
		return { branchId };
	});

	// --- memory ------------------------------------------------------------------
	const memory = s.memory;
	dispatcher.registerHandler("memory.listCandidates:v1", async () => {
		const companionId = await getCompanionId(s);
		return { candidates: memory.listCandidates({ companionId }) };
	});
	dispatcher.registerHandler("memory.decideCandidate:v1", async (_p) => {
		const params = _p as {
			candidateId: string;
			decision: "approve" | "approve_edited" | "reject";
			editedText?: string;
			scope?: string;
		};
		memory.decideCandidate({
			candidateId: params.candidateId,
			decision: params.decision,
			editedText: params.editedText,
			decidedScope: params.scope as never,
		});
		return {};
	});
	dispatcher.registerHandler("memory.search:v1", async (_p) => {
		const { query, scope } = _p as { query: string; scope?: string };
		const companionId = await getCompanionId(s);
		return { entries: memory.recall({ companionId, query, scope: scope as never, enabled: true }) };
	});
	dispatcher.registerHandler("memory.list:v1", async (_p) => {
		const { scope, limit } = _p as { scope?: string; limit?: number };
		const companionId = await getCompanionId(s);
		return {
			entries: memory.recall({
				companionId,
				query: "",
				scope: scope as never,
				enabled: true,
				limit: limit ?? 50,
			}),
		};
	});
	dispatcher.registerHandler("memory.pin:v1", async (_p) => {
		const { entryId, pinned } = _p as { entryId: string; pinned: boolean };
		memory.pin(entryId, pinned);
		return {};
	});
	dispatcher.registerHandler("memory.forget:v1", async (_p) => {
		const { entryId } = _p as { entryId: string };
		memory.forget(entryId);
		return {};
	});
	dispatcher.registerHandler("memory.exclude:v1", async (_p) => {
		const { entryId, excluded } = _p as { entryId: string; excluded: boolean };
		memory.exclude(entryId, excluded);
		return {};
	});
	dispatcher.registerHandler("memory.edit:v1", async (_p) => {
		const { entryId, newText } = _p as { entryId: string; newText: string };
		memory.edit(entryId, newText);
		return {};
	});

	// --- story archive -------------------------------------------------------------
	dispatcher.registerHandler("story.listChanges:v1", async (_p) => {
		const { branchId } = _p as { branchId?: string };
		return { changes: s.story.list({ companionId: await getCompanionId(s), branchId }) };
	});
	dispatcher.registerHandler("story.applyChange:v1", async (_p) => {
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
	dispatcher.registerHandler("story.revertChange:v1", async (_p) => {
		const { changeId, conversationId } = _p as { changeId: string; conversationId?: string };
		s.story.revert(changeId, conversationId);
		return {};
	});
	dispatcher.registerHandler("story.reset:v1", async (_p) => {
		const { conversationId, branchId } = _p as { conversationId?: string; branchId?: string };
		return {
			count: s.story.reset({
				companionId: await getCompanionId(s),
				conversationId,
				branchId,
			}),
		};
	});
	dispatcher.registerHandler("story.listProposals:v1", async (_p) => {
		const { conversationId } = _p as { conversationId?: string };
		return {
			proposals: s.story.listProposals({
				companionId: await getCompanionId(s),
				conversationId,
			}),
		};
	});
	dispatcher.registerHandler("story.resolveProposal:v1", async (_p) => {
		const { proposalId, accept } = _p as { proposalId: string; accept: boolean };
		return { change: s.story.resolveProposal({ proposalId, accept }) };
	});

	// --- canon hub (advanced authoring) ---------------------------------------------
	dispatcher.registerHandler("canon.listSources:v1", async () => ({
		sources: s.canon.listSources(await getCompanionId(s)),
	}));
	dispatcher.registerHandler("canon.addSource:v1", async (_p) => {
		const { logicalName, content } = _p as { logicalName: string; content: string };
		return { source: s.canon.addSource(await getCompanionId(s), logicalName, content) };
	});
	dispatcher.registerHandler("canon.search:v1", async (_p) => ({
		chunks: s.canon.search(await getCompanionId(s), (_p as { query: string }).query),
	}));
	dispatcher.registerHandler("canon.removeSource:v1", async (_p) => {
		s.canon.removeSource(await getCompanionId(s), (_p as { sourceId: string }).sourceId);
		return {};
	});
	dispatcher.registerHandler("canon.listModules:v1", async () => ({
		modules: s.canon.listModules(await getCompanionId(s)),
	}));
	dispatcher.registerHandler("canon.upsertModule:v1", async (_p) => ({
		module: s.canon.upsertModule({
			...(_p as Parameters<CanonHubService["upsertModule"]>[0]),
			companionId: await getCompanionId(s),
		}),
	}));
	dispatcher.registerHandler("canon.deleteModule:v1", async (_p) => {
		s.canon.deleteModule(await getCompanionId(s), (_p as { id: string }).id);
		return {};
	});

	// --- provider ------------------------------------------------------------------
	dispatcher.registerHandler("provider.list:v1", async () => {
		return { providers: await s.providers.listProviders() };
	});
	dispatcher.registerHandler("provider.customUpsert:v1", async (_p) => {
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
	dispatcher.registerHandler("provider.overrideBaseUrl:v1", async (_p) => {
		const input = _p as { providerId: string; baseUrl: string };
		await s.providers.overrideProviderBaseUrl(input);
		await s.supervisor.stop();
		await s.supervisor.start();
		return {};
	});
	dispatcher.registerHandler("provider.setApiKey:v1", async (_p) => {
		const { providerId, apiKey, sessionOnly } = _p as {
			providerId: string;
			apiKey: string;
			sessionOnly?: boolean;
		};
		const status = await s.providers.setApiKey(providerId, apiKey, sessionOnly);
		return { status };
	});
	dispatcher.registerHandler("provider.login:v1", async (_p) => {
		const { providerId } = _p as { providerId: string };
		return s.providers.startOAuth(providerId);
	});
	dispatcher.registerHandler("provider.loginStatus:v1", async (_p) => {
		return s.providers.getOAuthSession((_p as { providerId: string }).providerId);
	});
	dispatcher.registerHandler("provider.loginAnswer:v1", async (_p) => {
		const { providerId, answer } = _p as { providerId: string; answer: string };
		return s.providers.answerOAuth(providerId, answer);
	});
	dispatcher.registerHandler("provider.logout:v1", async (_p) => {
		const { providerId } = _p as { providerId: string };
		await s.providers.logout(providerId);
		return {};
	});

	// --- voice ------------------------------------------------------------------------
	dispatcher.registerHandler("voice.list:v1", async () => {
		const companionId = await getCompanionId(s);
		return { stacks: s.voice.list(companionId) };
	});
	dispatcher.registerHandler("voice.switch:v1", async (_p) => {
		const { stackId, scope } = _p as { stackId: string; scope: "next_scene" | "branch_only" };
		const companionId = await getCompanionId(s);
		const stack = s.voice.switchScope(companionId, stackId, scope);
		return { stack };
	});
	dispatcher.registerHandler("voice.pin:v1", async (_p) => {
		const { providerId, modelId, label } = _p as {
			providerId: string;
			modelId: string;
			label?: string;
		};
		const provider = (await s.providers.listProviders()).find((item) => item.id === providerId);
		if (!provider) throw { kind: "not_found", reason: "provider_not_found" };
		if (!provider.availableModels.some((model) => model.id === modelId)) {
			throw { kind: "not_found", reason: "model_not_found" };
		}
		return { stack: s.voice.pin(await getCompanionId(s), providerId, modelId, label) };
	});

	// --- run ------------------------------------------------------------------------
	dispatcher.registerHandler("run.list:v1", async () => {
		const rows = s.db
			.prepare(
				"SELECT id, commission_id, executor_profile, status, started_at, completed_at FROM runs ORDER BY created_at DESC LIMIT 10",
			)
			.all() as Array<{
			id: string;
			commission_id: string;
			executor_profile: string;
			status: string;
			started_at: string | null;
			completed_at: string | null;
		}>;
		return {
			runs: rows.map((r) => ({
				id: r.id,
				commissionId: r.commission_id,
				executorProfile: r.executor_profile,
				status: r.status,
				startedAt: r.started_at ?? undefined,
				completedAt: r.completed_at ?? undefined,
			})),
		};
	});
	dispatcher.registerHandler("commission.list:v1", async () => {
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
	dispatcher.registerHandler("commission.draft:v1", async (_p) => {
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
	dispatcher.registerHandler("commission.approve:v1", async (_p) => {
		const { commissionId, approvedHash } = _p as { commissionId: string; approvedHash: string };
		s.commissions.approve(commissionId, approvedHash);
		return {};
	});
	dispatcher.registerHandler("commission.reject:v1", async (_p) => {
		s.commissions.reject((_p as { commissionId: string }).commissionId);
		return {};
	});
	dispatcher.registerHandler("commission.launch:v1", async (_p) => {
		const { commissionId, executorProfile } = _p as {
			commissionId: string;
			executorProfile: string;
		};
		return s.commissions.launch({ commissionId, executorProfile });
	});
	dispatcher.registerHandler("run.steer:v1", async (_p) => {
		const { runId, instruction } = _p as { runId: string; instruction: string };
		await s.commissions.steerRun(runId, instruction);
		return {};
	});
	dispatcher.registerHandler("run.cancel:v1", async (_p) => {
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
	dispatcher.registerHandler("run.respondPermission:v1", async (_p) => {
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
	dispatcher.registerHandler("artifact.list:v1", async () => ({
		artifacts: s.artifacts.list().map((artifact) => ({
			...artifact,
			producerRunId: artifact.producerRunId ?? undefined,
		})),
	}));
	dispatcher.registerHandler("artifact.read:v1", async (_p) => {
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
	dispatcher.registerHandler("settings.get:v1", async () => {
		const companionId = await getCompanionId(s);
		const stateData = s.onboarding.getState(companionId).stateData;
		return {
			settings: {
				relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
				...modelRouteSettings(s.db, companionId),
			},
		};
	});
	dispatcher.registerHandler("settings.set:v1", async (_p) => {
		const { settings } = _p as { settings: Record<string, unknown> };
		const companionId = await getCompanionId(s);
		if ("relationshipMemoryEnabled" in settings) {
			s.onboarding.setRelationshipMemory(companionId, Boolean(settings.relationshipMemoryEnabled));
		}
		const currentRoutes = modelRouteSettings(s.db, companionId);
		const textFallback = (
			"textFallback" in settings ? settings.textFallback : currentRoutes.textFallback
		) as { providerId: string; modelId: string } | null | undefined;
		const multimodalFallback = (
			"multimodalFallback" in settings
				? settings.multimodalFallback
				: currentRoutes.multimodalFallback
		) as { providerId: string; modelId: string } | null | undefined;
		if ("textFallback" in settings || "multimodalFallback" in settings) {
			s.db
				.prepare(
					`INSERT INTO model_route_settings
					 (companion_id, text_provider_id, text_model_id, multimodal_provider_id, multimodal_model_id)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(companion_id) DO UPDATE SET
					 text_provider_id=excluded.text_provider_id, text_model_id=excluded.text_model_id,
					 multimodal_provider_id=excluded.multimodal_provider_id,
					 multimodal_model_id=excluded.multimodal_model_id, updated_at=datetime('now')`,
				)
				.run(
					companionId,
					textFallback?.providerId ?? null,
					textFallback?.modelId ?? null,
					multimodalFallback?.providerId ?? null,
					multimodalFallback?.modelId ?? null,
				);
		}
		const stateData = s.onboarding.getState(companionId).stateData;
		const nextSettings = {
			relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
			...modelRouteSettings(s.db, companionId),
		};
		s.eventBus.publish("settings.changed", { settings: nextSettings });
		return { settings: nextSettings };
	});

	// --- events -----------------------------------------------------------------------
	dispatcher.registerHandler("events.subscribe:v1", async (_p) => {
		const { afterSeq } = _p as { afterSeq?: number };
		const rows = s.db
			.prepare("SELECT seq, kind, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 100")
			.all(afterSeq ?? 0) as Array<{ seq: number; kind: string; payload: string }>;
		return {
			events: rows.map((r) => ({ seq: r.seq, kind: r.kind, payload: JSON.parse(r.payload) })),
		};
	});
	dispatcher.registerHandler("snapshot.get:v1", async () => {
		const companionId = await getCompanionId(s);
		const onboarding = s.onboarding.getState(companionId);
		const character = s.characterLoader.load(companionId);
		if (!character) {
			throw { kind: "unavailable", reason: "character_package_missing" };
		}
		const allowedSceneIds = new Set(character.scenes.map((scene) => scene.id));
		const allowedVisualStates = new Set(Object.keys(character.visual.presence));
		const convRows = s.db
			.prepare(
				"SELECT id, title, scene_title, updated_at FROM conversations WHERE companion_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100",
			)
			.all(companionId) as Array<{
			id: string;
			title: string;
			scene_title: string;
			updated_at: string;
		}>;
		const conversationIds = new Set(convRows.map((row) => row.id));
		const characterRuntimeByConversation: Record<string, { sceneId: string; visualState: string }> =
			{};
		const sceneRows = s.db
			.prepare(
				"SELECT conversation_id, scene, state_json FROM scene_state ORDER BY updated_at DESC",
			)
			.all() as Array<{ conversation_id: string; scene: string; state_json: string }>;
		for (const row of sceneRows) {
			if (
				!conversationIds.has(row.conversation_id) ||
				characterRuntimeByConversation[row.conversation_id]
			) {
				continue;
			}
			try {
				const state = JSON.parse(row.state_json) as unknown;
				if (
					state &&
					typeof state === "object" &&
					!Array.isArray(state) &&
					"visualState" in state &&
					typeof state.visualState === "string" &&
					allowedSceneIds.has(row.scene) &&
					allowedVisualStates.has(state.visualState) &&
					typeof row.scene === "string"
				) {
					characterRuntimeByConversation[row.conversation_id] = {
						sceneId: row.scene,
						visualState: state.visualState,
					};
				}
			} catch {
				// Invalid historical state is omitted; package defaults remain visible.
			}
		}
		const eventSeq = s.eventBus.currentSeq;
		const activeRow = convRows[0];
		return {
			eventSeq,
			onboarding: { ...onboarding, eventSeq },
			character: s.characterLoader.display(character),
			conversation: {
				conversations: convRows.map((r) => ({
					id: r.id,
					title: r.title,
					sceneTitle: r.scene_title,
					unread: false,
					updatedAt: r.updated_at,
				})),
				...(activeRow
					? conversationProjection(s.db, activeRow.id, activeRow.title, activeRow.scene_title)
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
						? (conversationProjection(s.db, activeRow.id, activeRow.title, activeRow.scene_title)
								.activeBranchId as string | undefined)
						: undefined,
				}),
			},
			characterRuntime: { byConversation: characterRuntimeByConversation },
			settings: {
				relationshipMemoryEnabled:
					onboarding.stateData.decisions.relationship_memory_enabled ?? false,
				...modelRouteSettings(s.db, companionId),
			},
		};
	});
}

function modelRouteSettings(db: DatabaseSync, companionId: string) {
	const row = db
		.prepare(
			"SELECT text_provider_id, text_model_id, multimodal_provider_id, multimodal_model_id FROM model_route_settings WHERE companion_id = ?",
		)
		.get(companionId) as
		| {
				text_provider_id: string | null;
				text_model_id: string | null;
				multimodal_provider_id: string | null;
				multimodal_model_id: string | null;
		  }
		| undefined;
	return {
		...(row?.text_provider_id && row.text_model_id
			? { textFallback: { providerId: row.text_provider_id, modelId: row.text_model_id } }
			: {}),
		...(row?.multimodal_provider_id && row.multimodal_model_id
			? {
					multimodalFallback: {
						providerId: row.multimodal_provider_id,
						modelId: row.multimodal_model_id,
					},
				}
			: {}),
	};
}

function conversationProjection(db: DatabaseSync, id: string, title: string, sceneTitle: string) {
	const branch = db
		.prepare(
			"SELECT id FROM branches WHERE conversation_id = ? AND adopted = 1 ORDER BY created_at DESC LIMIT 1",
		)
		.get(id) as { id: string } | undefined;
	const messages = db
		.prepare(
			`SELECT m.id, m.role, m.created_at, v.id AS version_id, v.content,
				v.edited_by_user, v.adopted, v.created_at AS version_created_at
			 FROM messages m
			 JOIN message_versions v ON v.message_id = m.id
			 WHERE m.conversation_id = ? AND (
			   ? IS NULL
			   OR m.branch_id = ?
			   OR m.rowid <= COALESCE((
			     SELECT fork.rowid
			     FROM branches active_branch
			     JOIN messages fork ON fork.id = active_branch.fork_message_id
			     WHERE active_branch.id = ?
			   ), -1)
			 )
			 ORDER BY m.rowid, v.rowid`,
		)
		.all(id, branch?.id ?? null, branch?.id ?? null, branch?.id ?? null) as Array<{
		id: string;
		role: "user" | "assistant" | "system";
		created_at: string;
		version_id: string;
		content: string;
		edited_by_user: number;
		adopted: number;
		version_created_at: string;
	}>;
	const grouped = new Map<
		string,
		{
			id: string;
			role: "user" | "assistant" | "system";
			adoptedVersionId?: string;
			versions: Array<{
				id: string;
				role: "user" | "assistant" | "system";
				content: string;
				editedByUser: boolean;
				createdAt: string;
				adopted: boolean;
			}>;
			createdAt: string;
		}
	>();
	for (const row of messages) {
		let message = grouped.get(row.id);
		if (!message) {
			message = { id: row.id, role: row.role, versions: [], createdAt: row.created_at };
			grouped.set(row.id, message);
		}
		message.versions.push({
			id: row.version_id,
			role: row.role,
			content: row.content,
			editedByUser: Boolean(row.edited_by_user),
			createdAt: row.version_created_at,
			adopted: Boolean(row.adopted),
		});
		if (row.adopted) message.adoptedVersionId = row.version_id;
	}
	return {
		activeConversationId: id,
		activeBranchId: branch?.id,
		id,
		title,
		sceneTitle,
		messages: [...grouped.values()],
	};
}

async function getCompanionId(s: HostCompositionContext): Promise<string> {
	const packageId = s.characterLoader.getActiveCharacterId(s.db, s.defaultCharacterId);
	ensureCharacterSeeded(s);
	const seeded = s.db.prepare("SELECT id FROM companion_identity WHERE id = ?").get(packageId) as
		| { id: string }
		| undefined;
	if (!seeded) throw { kind: "unavailable", reason: "character_package_missing" };
	return seeded.id;
}

/** Seed the active character package if it has not been seeded yet. */
function ensureCharacterSeeded(s: HostCompositionContext): void {
	const activeId = s.characterLoader.getActiveCharacterId(s.db, s.defaultCharacterId);
	const character = s.characterLoader.load(activeId);
	if (!character) throw new Error(`character package missing: ${activeId}`);
	s.characterLoader.seed(s.db, s.eventBus, character);
	const active = s.db
		.prepare("SELECT character_id FROM active_character WHERE singleton = 1")
		.get();
	if (!active) s.characterLoader.activate(s.db, s.eventBus, character);
}
