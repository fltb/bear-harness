/**
 * First-meeting onboarding FSM — the Host side of "becoming the same companion".
 *
 * Progresses through a strict chain: door_closed → introduced → naming →
 * relation → memory_decision → voice_ready → complete. State lives in the
 * canonical DB (`onboarding_state`, migration id 3); every legal transition
 * commits state + state_json and then publishes `onboarding.state_changed`,
 * so the renderer's optimistic projection stays in sync via the event bus.
 *
 * Companion-facing facts are written to their canonical homes as well as
 * into state_json: the name also lands on `companion_identity.nickname`.
 * Completing onboarding seeds the first conversation + branch (title
 * 「初次见面」, scene from productConfig) so the chat surface has a place
 * to start — and re-runs of complete() never double-seed.
 *
 * Reset is destructive by design: it clears the onboarding row, records the
 * decision in `user_decisions`, and orphans existing conversations (the next
 * complete() seeds a fresh one).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";
import { loadCharacter } from "./character-loader.js";

export type OnboardingState =
	| "door_closed"
	| "introduced"
	| "naming"
	| "relation"
	| "memory_decision"
	| "voice_ready"
	| "complete";

export type RelationKind = "shelter" | "partner" | "ward" | "biding";

export interface OnboardingStateRow {
	state: OnboardingState;
	stateJson: Record<string, unknown>;
}

/** Legal FSM edges — every state may also transition to itself (idempotent). */
const TRANSITIONS: Record<OnboardingState, readonly OnboardingState[]> = {
	door_closed: ["introduced"],
	introduced: ["naming"],
	naming: ["relation"],
	relation: ["memory_decision"],
	memory_decision: ["voice_ready"],
	voice_ready: ["complete"],
	complete: [],
};

/** States in which a companion name may be (re)set. */
const NAME_STATES: Record<string, true> = {
	naming: true,
	relation: true,
	memory_decision: true,
	voice_ready: true,
	complete: true,
};

/** States in which a relation kind may be (re)set. */
const RELATION_STATES: Record<string, true> = {
	relation: true,
	memory_decision: true,
	voice_ready: true,
	complete: true,
};

/** States in which the memory decision may be (re)set. */
const MEMORY_STATES: Record<string, true> = {
	memory_decision: true,
	voice_ready: true,
	complete: true,
};

/** Upsert the onboarding row (create on first visit, update afterwards). */
const UPSERT_STATE_SQL = `
	INSERT INTO onboarding_state (companion_id, state, state_json, updated_at)
	VALUES (?, ?, ?, datetime('now'))
	ON CONFLICT(companion_id) DO UPDATE SET
		state = excluded.state,
		state_json = excluded.state_json,
		updated_at = datetime('now')
`;

export class FirstMeetingMachine {
	private db: DatabaseSync;
	private eventBus: EventBus;

	constructor(db: DatabaseSync, eventBus: EventBus) {
		this.db = db;
		this.eventBus = eventBus;
	}

	/** Read the current onboarding state; a companion with no row is door_closed. */
	getState(companionId: string): OnboardingStateRow {
		const row = this.db
			.prepare("SELECT state, state_json FROM onboarding_state WHERE companion_id = ?")
			.get(companionId) as { state: string; state_json: string } | undefined;
		if (!row) {
			return { state: "door_closed", stateJson: {} };
		}
		return {
			state: row.state as OnboardingState,
			stateJson: JSON.parse(row.state_json) as Record<string, unknown>,
		};
	}

	/**
	 * Transition to `to` if legal. Same-state transitions are idempotent —
	 * a no-op unless `data` is supplied (then state_json is merged).
	 * Persists first, publishes `onboarding.state_changed` after commit.
	 */
	transition(
		companionId: string,
		to: OnboardingState,
		data?: Record<string, unknown>,
	): OnboardingStateRow {
		const current = this.getState(companionId);
		const hasData = data !== undefined && Object.keys(data).length > 0;

		if (to === current.state) {
			if (!hasData) return current; // idempotent no-op
		} else if (!TRANSITIONS[current.state].includes(to)) {
			throw { kind: "conflict", reason: "illegal_onboarding_transition" };
		}

		const merged = hasData ? { ...current.stateJson, ...data } : current.stateJson;
		this.persist(companionId, to, merged);
		this.eventBus.publish("onboarding.state_changed", { companionId, state: to });
		return { state: to, stateJson: merged };
	}

	/** Set the companion's chosen name; auto-advances naming → relation. */
	setName(companionId: string, name: string): OnboardingStateRow {
		const current = this.getState(companionId);
		if (!NAME_STATES[current.state]) {
			throw { kind: "conflict", reason: "illegal_onboarding_transition" };
		}
		const identity = this.db
			.prepare("SELECT id FROM companion_identity WHERE id = ?")
			.get(companionId);
		if (!identity) throw { kind: "not_found", reason: "companion_not_found" };

		const nextState: OnboardingState = current.state === "naming" ? "relation" : current.state;
		const merged = { ...current.stateJson, name };

		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("UPDATE companion_identity SET nickname = ? WHERE id = ?")
				.run(name, companionId);
			this.db.prepare(UPSERT_STATE_SQL).run(companionId, nextState, JSON.stringify(merged));
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		this.eventBus.publish("onboarding.state_changed", { companionId, state: nextState });
		return { state: nextState, stateJson: merged };
	}

	/** Set the relation kind; auto-advances relation → memory_decision. */
	setRelation(companionId: string, kind: RelationKind): OnboardingStateRow {
		const current = this.getState(companionId);
		if (!RELATION_STATES[current.state]) {
			throw { kind: "conflict", reason: "illegal_onboarding_transition" };
		}
		const nextState: OnboardingState = current.state === "relation" ? "memory_decision" : current.state;
		const merged = { ...current.stateJson, relation: kind };
		this.persist(companionId, nextState, merged);
		this.eventBus.publish("onboarding.state_changed", { companionId, state: nextState });
		return { state: nextState, stateJson: merged };
	}

	/** Set whether relationship memory is enabled; auto-advances memory_decision → voice_ready. */
	setMemoryDecision(companionId: string, enabled: boolean): OnboardingStateRow {
		const current = this.getState(companionId);
		if (!MEMORY_STATES[current.state]) {
			throw { kind: "conflict", reason: "illegal_onboarding_transition" };
		}
		const nextState: OnboardingState = current.state === "memory_decision" ? "voice_ready" : current.state;
		const merged = { ...current.stateJson, memoryEnabled: enabled };
		this.persist(companionId, nextState, merged);
		this.eventBus.publish("onboarding.state_changed", { companionId, state: nextState });
		return { state: nextState, stateJson: merged };
	}

	/** Mark the voice stack as ready — the last gate before completion. */
	markVoiceReady(companionId: string): OnboardingStateRow {
		return this.transition(companionId, "complete");
	}

	/** Complete onboarding: voice_ready → complete, seeding the first conversation + branch. */
	complete(companionId: string): OnboardingStateRow {
		const current = this.getState(companionId);
		if (current.state !== "voice_ready" && current.state !== "complete") {
			throw { kind: "conflict", reason: "illegal_onboarding_transition" };
		}
		// Same-state re-entry is idempotent (any → same): never re-seed, never re-publish.
		const advancing = current.state === "voice_ready";
		const conversationId = randomUUID();
		const branchId = randomUUID();
		const character = loadCharacter(companionId);
		if (!character) throw { kind: "unavailable", reason: "character_package_missing" };
		const sceneTitle = character.character.scene_title;
		let conversationCreated = false;

		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (advancing) {
				this.db.prepare(UPSERT_STATE_SQL).run(companionId, "complete", JSON.stringify(current.stateJson));
			}
			const existing = this.hasActiveConversation(companionId);
			if (!existing) {
				this.db
					.prepare(
						"INSERT INTO conversations (id, companion_id, title, scene_title) VALUES (?, ?, '初次见面', ?)",
					)
					.run(conversationId, companionId, sceneTitle);
				this.db
					.prepare(
						"INSERT INTO branches (id, conversation_id, parent_branch_id, label, adopted) VALUES (?, ?, NULL, 'main', 1)",
					)
					.run(branchId, conversationId);
				conversationCreated = true;
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		if (advancing) {
			this.eventBus.publish("onboarding.state_changed", { companionId, state: "complete" });
		}
		if (conversationCreated) {
			this.eventBus.publish("conversation.created", {
				conversationId,
				companionId,
				title: "初次见面",
				sceneTitle,
			});
		}
		return { state: "complete", stateJson: current.stateJson };
	}

	/** Resume point: the current state, for replaying the onboarding flow. */
	replay(companionId: string): OnboardingStateRow {
		return this.getState(companionId);
	}

	/**
	 * Destructive onboarding reset. Requires explicit confirmation; clears the
	 * onboarding row, records the reset in `user_decisions`, and orphans the
	 * companion's existing conversations (a fresh one is seeded on the next
	 * complete()).
	 */
	reset(companionId: string, options: { confirm: boolean }): void {
		if (!options.confirm) {
			throw { kind: "invalid_request", reason: "reset_not_confirmed" };
		}
		const conversations = (
			this.db
				.prepare("SELECT id FROM conversations WHERE companion_id = ?")
				.all(companionId) as Array<{ id: string }>
		).map((r) => r.id);
		const resetId = randomUUID();

		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM onboarding_state WHERE companion_id = ?").run(companionId);
			this.db
				.prepare(
					"INSERT INTO user_decisions (id, kind, decision_data) VALUES (?, 'onboarding_reset', ?)",
				)
				.run(
					resetId,
					JSON.stringify({
						companionId,
						resetAt: new Date().toISOString(),
						conversations,
					}),
				);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		this.eventBus.publish("onboarding.reset", { companionId });
	}

	/**
	 * True if the companion has a conversation that is not closed by an
	 * onboarding reset. Reset orphans the conversation rows (they are listed
	 * in the `onboarding_reset` user decision), so a post-reset complete()
	 * seeds a fresh conversation instead of reusing a closed one.
	 */
	private hasActiveConversation(companionId: string): boolean {
		const resets = this.db
			.prepare(
				"SELECT decision_data FROM user_decisions WHERE kind = 'onboarding_reset' ORDER BY created_at DESC",
			)
			.all() as Array<{ decision_data: string }>;
		const closed = new Set<string>();
		for (const r of resets) {
			const data = JSON.parse(r.decision_data) as {
				companionId?: string;
				conversations?: string[];
			};
			if (data.companionId !== companionId) continue;
			for (const id of data.conversations ?? []) closed.add(id);
		}
		const convs = this.db
			.prepare("SELECT id FROM conversations WHERE companion_id = ?")
			.all(companionId) as Array<{ id: string }>;
		return convs.some((c) => !closed.has(c.id));
	}

	/** Persist an onboarding row (create or update) inside its own transaction. */
	private persist(companionId: string, state: OnboardingState, json: Record<string, unknown>): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare(UPSERT_STATE_SQL).run(companionId, state, JSON.stringify(json));
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
	}
}
