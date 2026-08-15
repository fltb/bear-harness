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
import type { CommissionService } from "./commissions/service.js";
import type { CharacterLoader } from "./companion/character-loader.js";
import type { FirstMeetingMachine } from "./companion/first-meeting.js";
import type { TurnPipeline } from "./companion/turn-pipeline.js";
import type { VoiceStackManager } from "./companion/voice-stack.js";
import type { Dispatcher } from "./dispatcher.js";
import type { MemoryService } from "./memory/service.js";
import type { ProviderCatalog } from "./providers/catalog.js";
import type { EventBus } from "./storage/event-bus.js";

/** Domain services and runtime-owned inputs the handlers read and mutate. */
export interface HostCompositionContext {
	db: DatabaseSync;
	eventBus: EventBus;
	onboarding: FirstMeetingMachine;
	turns: TurnPipeline;
	voice: VoiceStackManager;
	memory: MemoryService;
	commissions: CommissionService;
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
		const rows = s.db
			.prepare(
				"SELECT id, title, scene_title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100",
			)
			.all() as Array<{ id: string; title: string; scene_title: string; updated_at: string }>;
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
		s.eventBus.publish("conversation.created", { id });
		return { id };
	});
	dispatcher.registerHandler("conversation.select:v1", async (_p) => {
		const { id } = _p as { id: string };
		const row = s.db
			.prepare("SELECT id, title, scene_title FROM conversations WHERE id = ?")
			.get(id) as { id: string; title: string; scene_title: string } | undefined;
		if (!row) throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.selected", { id });
		return { id, title: row.title, sceneTitle: row.scene_title };
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

	// --- provider ------------------------------------------------------------------
	dispatcher.registerHandler("provider.list:v1", async () => {
		return { providers: await s.providers.listProviders() };
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
		const result = await s.providers.loginOAuth(providerId, {
			prompt: async () => {
				// The dialog would surface this; for now, placeholder prompt handling.
				throw { kind: "unavailable", reason: "oauth_dialog_not_wired" };
			},
			notify: (ev) => {
				s.eventBus.publish("provider.oauth_event", { providerId, event: ev });
			},
		});
		return result;
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

	// --- settings ----------------------------------------------------------------------
	dispatcher.registerHandler("settings.get:v1", async () => {
		const companionId = await getCompanionId(s);
		const stateData = s.onboarding.getState(companionId).stateData;
		return {
			settings: {
				relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
			},
		};
	});
	dispatcher.registerHandler("settings.set:v1", async (_p) => {
		const { settings } = _p as { settings: Record<string, unknown> };
		const companionId = await getCompanionId(s);
		if ("relationshipMemoryEnabled" in settings) {
			s.onboarding.setRelationshipMemory(companionId, Boolean(settings.relationshipMemoryEnabled));
		}
		const stateData = s.onboarding.getState(companionId).stateData;
		const nextSettings = {
			relationshipMemoryEnabled: stateData.decisions.relationship_memory_enabled ?? false,
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
				"SELECT id, title, scene_title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100",
			)
			.all() as Array<{ id: string; title: string; scene_title: string; updated_at: string }>;
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
			},
			characterRuntime: { byConversation: characterRuntimeByConversation },
			settings: {
				relationshipMemoryEnabled:
					onboarding.stateData.decisions.relationship_memory_enabled ?? false,
			},
		};
	});
}

async function getCompanionId(s: HostCompositionContext): Promise<string> {
	const row = s.db.prepare("SELECT id FROM companion_identity LIMIT 1").get() as
		| { id: string }
		| undefined;
	if (row) return row.id;
	const packageId = s.defaultCharacterId;
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
}
