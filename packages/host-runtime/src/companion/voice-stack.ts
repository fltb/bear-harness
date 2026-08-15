/**
 * Voice Stack manager — pins and switches the provider/model stack for a companion.
 *
 * A companion has exactly one active voice stack (provider + model, per
 * revision). Pinning a new stack demotes all previous stacks (active=0) and
 * inserts a fresh row with the next revision number. Switching scope is how a
 * pinned stack becomes the active stack for the next scene, or is adopted for
 * a branch only (without touching the global active flag — the conversation
 * branch adoption map is handled elsewhere).
 *
 * All state changes are committed to the canonical `voice_stack_versions`
 * table first, then published on the event bus.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";

export interface VoiceStackRecord {
	id: string;
	companionId: string;
	providerId: string;
	modelId: string;
	revision: number;
	label: string;
	active: boolean;
	createdAt: string;
}

export interface AuditionResult {
	auditionId: string;
	prompts: string[];
	note: string;
}

type VoiceStackRow = {
	id: string;
	companion_id: string;
	provider_id: string;
	model_id: string;
	revision: number;
	label: string;
	active: number;
	created_at: string;
};

export class VoiceStackManager {
	private db: DatabaseSync;
	private eventBus: EventBus;

	constructor(db: DatabaseSync, eventBus: EventBus) {
		this.db = db;
		this.eventBus = eventBus;
	}

	/** Get the currently active voice stack for a companion, if pinned. */
	current(companionId: string): VoiceStackRecord | null {
		const row = this.db
			.prepare(
				"SELECT * FROM voice_stack_versions WHERE companion_id = ? AND active = 1 ORDER BY revision DESC LIMIT 1",
			)
			.get(companionId) as VoiceStackRow | undefined;
		return row ? this.toRecord(row) : null;
	}

	/** Pin a new voice stack: demote all previous stacks and insert the next revision. */
	pin(companionId: string, providerId: string, modelId: string, label?: string): VoiceStackRecord {
		if (!this.companionExists(companionId)) {
			throw { kind: "not_found", reason: "companion_not_found" };
		}

		const stackId = randomUUID();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("UPDATE voice_stack_versions SET active = 0 WHERE companion_id = ?")
				.run(companionId);
			const maxRow = this.db
				.prepare(
					"SELECT COALESCE(MAX(revision), -1) AS m FROM voice_stack_versions WHERE companion_id = ?",
				)
				.get(companionId) as { m: number };
			const revision = maxRow.m + 1;
			this.db
				.prepare(
					"INSERT INTO voice_stack_versions (id, companion_id, provider_id, model_id, revision, label, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
				)
				.run(stackId, companionId, providerId, modelId, revision, label ?? "");
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}

		const record = this.getById(companionId, stackId)!;
		this.eventBus.publish("voice.stack_pinned", { ...record });
		return record;
	}

	/** List all voice stacks for a companion, newest revision first. */
	list(companionId: string): VoiceStackRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM voice_stack_versions WHERE companion_id = ? ORDER BY revision DESC")
			.all(companionId) as VoiceStackRow[];
		return rows.map((row) => this.toRecord(row));
	}

	/** True when an older revision exists below the currently active stack. */
	rollbackAvailable(companionId: string): boolean {
		const active = this.db
			.prepare("SELECT revision FROM voice_stack_versions WHERE companion_id = ? AND active = 1")
			.get(companionId) as { revision: number } | undefined;
		if (!active) return false;
		const older = this.db
			.prepare(
				"SELECT id FROM voice_stack_versions WHERE companion_id = ? AND revision < ? LIMIT 1",
			)
			.get(companionId, active.revision);
		return older !== undefined;
	}

	/**
	 * Switch the active scope to a pinned stack.
	 *
	 * `next_scene`: demote all stacks, activate the target, and record a
	 * `voice.stack_switched` checkpoint. `branch_only`: the global active flag
	 * is untouched; only the event is published — branch adoption is owned
	 * elsewhere.
	 */
	switchScope(
		companionId: string,
		stackId: string,
		scope: "next_scene" | "branch_only",
	): VoiceStackRecord {
		const stack = this.getById(companionId, stackId);
		if (!stack) throw { kind: "not_found", reason: "stack_not_found" };

		if (scope === "next_scene") {
			this.db.exec("BEGIN IMMEDIATE");
			try {
				this.db
					.prepare("UPDATE voice_stack_versions SET active = 0 WHERE companion_id = ?")
					.run(companionId);
				this.db
					.prepare("UPDATE voice_stack_versions SET active = 1 WHERE id = ? AND companion_id = ?")
					.run(stackId, companionId);
				this.db.exec("COMMIT");
			} catch (e) {
				this.db.exec("ROLLBACK");
				throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
			}
		}

		this.eventBus.publish("voice.stack_switched", { stackId, scope, companionId });
		const updated = this.getById(companionId, stackId)!;
		return updated;
	}

	/**
	 * NON-CANON audition scaffold: no DB writes, no memory/commission writes.
	 * Runs a canned prompt set against the candidate stack and reports back.
	 */
	audition(
		companionId: string,
		candidateStack: { providerId: string; modelId: string; label?: string },
		options?: { prompts?: string[] },
	): AuditionResult {
		return {
			auditionId: randomUUID(),
			prompts: options?.prompts ?? ["闲聊", "共同经历召回", "现实工作/权限边界", "当前消息"],
			note: "non-canonical; no memory/commission writes",
		};
	}

	private companionExists(companionId: string): boolean {
		return (
			this.db.prepare("SELECT id FROM companion_identity WHERE id = ?").get(companionId) !==
			undefined
		);
	}

	private getById(companionId: string, stackId: string): VoiceStackRecord | null {
		const row = this.db
			.prepare("SELECT * FROM voice_stack_versions WHERE id = ? AND companion_id = ?")
			.get(stackId, companionId) as VoiceStackRow | undefined;
		return row ? this.toRecord(row) : null;
	}

	private toRecord(row: VoiceStackRow): VoiceStackRecord {
		return {
			id: row.id,
			companionId: row.companion_id,
			providerId: row.provider_id,
			modelId: row.model_id,
			revision: row.revision,
			label: row.label,
			active: row.active === 1,
			createdAt: row.created_at,
		};
	}
}
