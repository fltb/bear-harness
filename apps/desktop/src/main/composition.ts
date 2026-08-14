/**
 * Host composition — wires all domain services to the IPC router.
 *
 * Called from main boot after the database is open. Each domain registers
 * its handlers via `registerHandler(channel, handler)`. Handlers run inside
 * the router's schema-validation envelope.
 */

import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "./storage/event-bus.js";
import type { ArtifactStore } from "./artifacts/index.js";
import type { CompanionSupervisor } from "./companion/supervisor.js";
import { registerHandler } from "./ipc-router.js";
import { MemoryService } from "./memory/service.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { TurnPipeline } from "./companion/turn-pipeline.js";
import { VoiceStackManager } from "./companion/voice-stack.js";
import { CommissionService } from "./commissions/service.js";
import { CredentialStore } from "./providers/credential-store.js";
import { ProviderCatalog } from "./providers/catalog.js";

export interface HostServices {
	db: DatabaseSync;
	eventBus: EventBus;
	artifactStore: ArtifactStore;
	supervisor: CompanionSupervisor;
	memory: MemoryService;
	onboarding: FirstMeetingMachine;
	turns: TurnPipeline;
	voice: VoiceStackManager;
	commissions: CommissionService;
	credentials: CredentialStore;
	providers: ProviderCatalog;
}

let services: HostServices | null = null;

export function getServices(): HostServices {
	if (!services) throw new Error("host services not initialized");
	return services;
}

/** Wire all IPC handlers to domain services. Call once after openDatabase(). */
export function wireAllHandlers(s: HostServices): void {
	services = s;

	// --- onboarding ----------------------------------------------------------
	registerHandler("onboarding.get:v1", async () => {
		const companionId = await getCompanionId(s);
		return s.onboarding.getState(companionId);
	});
	registerHandler("onboarding.advance:v1", async () => {
		const companionId = await getCompanionId(s);
		const { state } = s.onboarding.getState(companionId);
		const next: Record<string, string> = {
			door_closed: "introduced",
			introduced: "naming",
		};
		const target = next[state];
		if (target) {
			s.onboarding.transition(companionId, target as never);
			return s.onboarding.getState(companionId);
		}
		return s.onboarding.getState(companionId);
	});
	registerHandler("onboarding.setName:v1", async (_p, win) => {
		const companionId = await getCompanionId(s);
		const { name } = _p as { name: string };
		s.onboarding.setName(companionId, name);
		void win;
		return { ok: true, data: s.onboarding.getState(companionId) } as never;
	});
	registerHandler("onboarding.setRelation:v1", async (_p) => {
		const companionId = await getCompanionId(s);
		const { kind } = _p as { kind: string };
		s.onboarding.setRelation(companionId, kind as never);
		return s.onboarding.getState(companionId);
	});
	registerHandler("onboarding.setMemoryDecision:v1", async (_p) => {
		const companionId = await getCompanionId(s);
		const { enabled } = _p as { enabled: boolean };
		s.onboarding.setMemoryDecision(companionId, enabled);
		return s.onboarding.getState(companionId);
	});

	// --- conversation ---------------------------------------------------------
	registerHandler("conversation.list:v1", async () => {
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
	registerHandler("conversation.create:v1", async (_p) => {
		const companionId = await getCompanionId(s);
		const id = crypto.randomUUID();
		const branchId = crypto.randomUUID();
		const title = (_p as { title?: string }).title ?? "新对话";
		s.db.exec("BEGIN IMMEDIATE");
		try {
			s.db
				.prepare(
					"INSERT INTO conversations (id, companion_id, title, scene_title) VALUES (?, ?, ?, ?)",
				)
				.run(id, companionId, title, "极光书房");
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
	registerHandler("conversation.select:v1", async (_p) => {
		const { id } = _p as { id: string };
		const row = s.db
			.prepare("SELECT id, title, scene_title FROM conversations WHERE id = ?")
			.get(id) as { id: string; title: string; scene_title: string } | undefined;
		if (!row) throw { kind: "not_found", reason: "conversation_not_found" };
		s.eventBus.publish("conversation.selected", { id });
		return { id, title: row.title, sceneTitle: row.scene_title };
	});

	// --- message ----------------------------------------------------------------
	registerHandler("message.send:v1", async (_p) => {
		const { conversationId, text } = _p as { conversationId: string; text: string };
		return s.turns.sendUserMessage(conversationId, text);
	});
	registerHandler("message.abort:v1", async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await s.turns.abort(conversationId);
		return {};
	});
	registerHandler("message.regenerate:v1", async (_p) => {
		const { conversationId, messageId } = _p as { conversationId: string; messageId: string };
		return s.turns.regenerate(conversationId, messageId);
	});
	registerHandler("message.switchVersion:v1", async (_p) => {
		const { conversationId, messageId, versionId } = _p as {
			conversationId: string;
			messageId: string;
			versionId: string;
		};
		await s.turns.switchVersion(conversationId, messageId, versionId);
		return {};
	});
	registerHandler("message.edit:v1", async (_p) => {
		const { conversationId, messageId, text, isUserMessage } = _p as {
			conversationId: string;
			messageId: string;
			text: string;
			isUserMessage: boolean;
		};
		await s.turns.edit(conversationId, messageId, text, isUserMessage);
		return {};
	});
	registerHandler("message.continue:v1", async (_p) => {
		const { conversationId } = _p as { conversationId: string };
		await s.turns.continue(conversationId);
		return {};
	});
	registerHandler("message.correct:v1", async (_p) => {
		const { conversationId, reason, applyScope } = _p as {
			conversationId: string;
			reason: string;
			applyScope: "once" | "session" | "always";
		};
		await s.turns.correct(conversationId, reason, applyScope);
		return {};
	});
	registerHandler("message.branch:v1", async (_p) => {
		const { conversationId, messageId } = _p as { conversationId: string; messageId: string };
		const branchId = await s.turns.branch(conversationId, messageId);
		return { branchId };
	});

	// --- memory ------------------------------------------------------------------
	const memory = s.memory;
	registerHandler("memory.listCandidates:v1", async () => {
		const companionId = await getCompanionId(s);
		return { candidates: memory.listCandidates({ companionId }) };
	});
	registerHandler("memory.decideCandidate:v1", async (_p) => {
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
	registerHandler("memory.search:v1", async (_p) => {
		const { query, scope } = _p as { query: string; scope?: string };
		const companionId = await getCompanionId(s);
		return { entries: memory.recall({ companionId, query, scope: scope as never, enabled: true }) };
	});
	registerHandler("memory.list:v1", async (_p) => {
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
	registerHandler("memory.pin:v1", async (_p) => {
		const { entryId, pinned } = _p as { entryId: string; pinned: boolean };
		memory.pin(entryId, pinned);
		return {};
	});
	registerHandler("memory.forget:v1", async (_p) => {
		const { entryId } = _p as { entryId: string };
		memory.forget(entryId);
		return {};
	});
	registerHandler("memory.exclude:v1", async (_p) => {
		const { entryId, excluded } = _p as { entryId: string; excluded: boolean };
		memory.exclude(entryId, excluded);
		return {};
	});
	registerHandler("memory.edit:v1", async (_p) => {
		const { entryId, newText } = _p as { entryId: string; newText: string };
		memory.edit(entryId, newText);
		return {};
	});

	// --- provider ------------------------------------------------------------------
	registerHandler("provider.list:v1", async () => {
		return { providers: await s.providers.listProviders() };
	});
	registerHandler("provider.setApiKey:v1", async (_p) => {
		const { providerId, apiKey, sessionOnly } = _p as {
			providerId: string;
			apiKey: string;
			sessionOnly?: boolean;
		};
		const status = await s.providers.setApiKey(providerId, apiKey, sessionOnly);
		return { status };
	});
	registerHandler("provider.login:v1", async (_p, win) => {
		const { providerId } = _p as { providerId: string };
		const result = await s.providers.loginOAuth(providerId, {
			prompt: async (p) => {
				// The dialog would surface this; for now, placeholder prompt handling.
				throw { kind: "unavailable", reason: "oauth_dialog_not_wired" };
			},
			notify: (ev) => {
				s.eventBus.publish("provider.oauth_event", { providerId, event: ev });
			},
		});
		void win;
		return result;
	});
	registerHandler("provider.logout:v1", async (_p) => {
		const { providerId } = _p as { providerId: string };
		await s.providers.logout(providerId);
		return {};
	});

	// --- voice ------------------------------------------------------------------------
	registerHandler("voice.list:v1", async () => {
		const companionId = await getCompanionId(s);
		return { stacks: s.voice.list(companionId) };
	});
	registerHandler("voice.switch:v1", async (_p) => {
		const { stackId, scope } = _p as { stackId: string; scope: "next_scene" | "branch_only" };
		const companionId = await getCompanionId(s);
		const stack = s.voice.switchScope(companionId, stackId, scope);
		// Pinning a stack during voice_ready completes onboarding
		const onboardingState = s.onboarding.getState(companionId);
		if (onboardingState.state === "voice_ready") {
			s.onboarding.markVoiceReady(companionId);
			s.onboarding.complete(companionId);
		}
		return { stack };
	});

	// --- run ------------------------------------------------------------------------
	registerHandler("run.list:v1", async () => {
		const rows = s.db
			.prepare("SELECT id, commission_id, executor_profile, status, started_at, completed_at FROM runs ORDER BY created_at DESC LIMIT 10")
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
	registerHandler("commission.list:v1", async () => {
		const rows = s.db
			.prepare("SELECT id, draft_json, status, created_at FROM commissions ORDER BY created_at DESC LIMIT 30")
			.all() as Array<{ id: string; draft_json: string; status: string; created_at: string }>;
		return {
			commissions: rows.map((r) => {
				const draft = JSON.parse(r.draft_json ?? "{}") as Record<string, unknown>;
				return {
					id: r.id,
					status: r.status,
					createdAt: r.created_at,
					draft: {
						id: r.id,
						title: String(draft.title ?? ""),
						description: String(draft.description ?? ""),
						reads: (draft.reads as string[]) ?? [],
						writes: (draft.writes as string[]) ?? [],
						networkAllowed: Boolean(draft.networkAllowed),
						toolNames: (draft.toolNames as string[]) ?? [],
						hash: String(draft.draftHash ?? ""),
					},
				};
			}),
		};
	});

	// --- settings ----------------------------------------------------------------------
	registerHandler("settings.get:v1", async () => {
		const companionId = await getCompanionId(s);
		const state = s.onboarding.getState(companionId);
		const stateJson = state.stateJson as Record<string, unknown>;
		return {
			settings: {
				relationshipMemoryEnabled: Boolean(stateJson.memoryEnabled),
				pauseLearning: false,
				immersionLevel: "roleplay",
				currentScene: "极光书房",
				theme: "aurora-study",
			},
		};
	});
	registerHandler("settings.set:v1", async (_p) => {
		const { settings } = _p as { settings: Record<string, unknown> };
		if ("relationshipMemoryEnabled" in settings) {
			const companionId = await getCompanionId(s);
			s.onboarding.setMemoryDecision(companionId, Boolean(settings.relationshipMemoryEnabled));
		}
		s.eventBus.publish("settings.changed", { settings });
		return { settings };
	});

	// --- events -----------------------------------------------------------------------
	registerHandler("events.subscribe:v1", async (_p) => {
		const { afterSeq } = _p as { afterSeq?: number };
		const rows = s.db
			.prepare("SELECT seq, kind, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 100")
			.all(afterSeq ?? 0) as Array<{ seq: number; kind: string; payload: string }>;
		return { events: rows.map((r) => ({ seq: r.seq, kind: r.kind, payload: JSON.parse(r.payload) })) };
	});
	registerHandler("snapshot.get:v1", async () => {
		const companionId = await getCompanionId(s);
		const onboarding = s.onboarding.getState(companionId);
		const convRows = s.db
			.prepare("SELECT id, title, scene_title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100")
			.all() as Array<{ id: string; title: string; scene_title: string; updated_at: string }>;
		return {
			eventSeq: s.eventBus.currentSeq,
			onboarding,
			conversation: {
				conversations: convRows.map((r) => ({
					id: r.id,
					title: r.title,
					sceneTitle: r.scene_title,
					unread: false,
					updatedAt: r.updated_at,
				})),
			},
			settings: {
				relationshipMemoryEnabled: false,
				immersionLevel: "roleplay",
				currentScene: "极光书房",
				theme: "aurora-study",
			},
		};
	});
}

async function getCompanionId(s: HostServices): Promise<string> {
	const row = s.db.prepare("SELECT id FROM companion_identity LIMIT 1").get() as
		| { id: string }
		| undefined;
	if (row) return row.id;
	// Auto-seed the default companion from product config
	const productConfig = (await import("../../product.config.js")).productConfig;
	const c = productConfig.defaultCharacter;
	const id = c.id;
	s.db
		.prepare("INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, 'builtin', ?, ?)")
		.run(id, c.name, `你是${c.name}，${c.subtitle}。`);
	return id;
}