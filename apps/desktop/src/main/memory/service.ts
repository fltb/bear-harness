/**
 * MemoryService — relationship memory candidates, approval, and recall.
 *
 * Candidates are proposed (by the user or the extractor), then decided by
 * the user (approve / approve_edited / reject). Every decision is appended
 * to `memory_decisions`; approved text lands in `relationship_memory_entries`
 * as an active entry. Entries can be forgotten (hard removal from recall),
 * excluded (hidden from recall but still visible), edited (new row, old one
 * excluded to keep history), and pinned (boosted recall order). All state
 * changes are committed to the canonical DB first, then published on the
 * event bus. Recall is a simple LIKE ladder over normalized text (exact →
 * prefix → substring), gated by the `enabled` flag — the caller owns the
 * memory-enabled decision.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";

export type MemoryKind = "fact" | "preference" | "event" | "self_canon_summary";
export type MemoryScope = "self" | "relationship" | "scene";
export type MemorySourceKind = "user_button" | "user_request" | "companion_suggestion" | "extractor";
export type CandidateStatus = "pending" | "approved" | "rejected" | "expired";

export interface MemoryServiceOptions {
	/** Injectable clock for deterministic tests. */
	msToNow?: () => Date;
}

export interface MemoryCandidateProposal {
	companionId: string;
	kind: MemoryKind;
	sourceMessageVersionId?: string;
	sourceBranchId?: string;
	sourceConversationId?: string;
	sourceKind: MemorySourceKind;
	text: string;
	why?: string;
	suggestedScope: MemoryScope;
}

export interface MemoryDecision {
	candidateId: string;
	decision: "approve" | "approve_edited" | "reject";
	editedText?: string;
	decidedScope?: MemoryScope;
}

export interface MemoryRecallParams {
	companionId: string;
	query: string;
	scope?: MemoryScope;
	enabled: boolean;
	limit?: number;
}

export interface MemoryEntrySummary {
	id: string;
	kind: MemoryKind;
	scope: MemoryScope;
	text: string;
	sourceConversationTitle: string;
	pinned: boolean;
	createdAt: string;
}

export interface MemoryCandidateSummary {
	id: string;
	companionId: string;
	kind: MemoryKind;
	scope: MemoryScope;
	text: string;
	why: string;
	status: CandidateStatus;
	createdAt: string;
	decidedAt: string | null;
}

interface CandidateRow {
	id: string;
	companion_id: string;
	kind: MemoryKind;
	status: CandidateStatus;
	source_message_version_id: string | null;
	source_branch_id: string | null;
	source_conversation_id: string | null;
	source_kind: MemorySourceKind;
	normalized_text: string;
	suggested_scope: MemoryScope;
}

interface EntryRow {
	id: string;
	companion_id: string;
	kind: MemoryKind;
	scope: MemoryScope;
	source_message_version_id: string | null;
	source_branch_id: string | null;
	source_conversation_id: string | null;
	source_kind: MemorySourceKind;
	scene_id: string | null;
}

export class MemoryService {
	private db: DatabaseSync;
	private eventBus: EventBus;
	private options?: MemoryServiceOptions;

	constructor(db: DatabaseSync, eventBus: EventBus, options?: MemoryServiceOptions) {
		this.db = db;
		this.eventBus = eventBus;
		this.options = options;
	}

	/** Current timestamp as an ISO string (injectable via `msToNow`). */
	private now(): string {
		const date = this.options?.msToNow ? this.options.msToNow() : new Date();
		return date.toISOString();
	}

	/** Normalize text: NFKC, then trim and collapse whitespace runs. */
	private normalize(text: string): string {
		return text.normalize("NFKC").replace(/\s+/g, " ").trim();
	}

	/** Escape LIKE wildcards so the user's query matches literally. */
	private escapeLike(term: string): string {
		return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
	}

	/** Fetch a candidate row, throwing not_found when missing. */
	private getCandidate(candidateId: string): CandidateRow {
		const row = this.db
			.prepare(
				`SELECT id, companion_id, kind, status, source_message_version_id, source_branch_id,
				        source_conversation_id, source_kind, normalized_text, suggested_scope
				 FROM memory_candidates WHERE id = ?`,
			)
			.get(candidateId) as CandidateRow | undefined;
		if (!row) throw { kind: "not_found", reason: "candidate_not_found" };
		return row;
	}

	/** Fetch a memory entry's identity, throwing not_found when missing. */
	private getEntry(entryId: string): { id: string; companion_id: string } {
		const row = this.db
			.prepare("SELECT id, companion_id FROM relationship_memory_entries WHERE id = ?")
			.get(entryId) as { id: string; companion_id: string } | undefined;
		if (!row) throw { kind: "not_found", reason: "memory_entry_not_found" };
		return row;
	}

	/** Record a candidate memory for later user approval. */
	proposeCandidate(params: MemoryCandidateProposal): string {
		const id = randomUUID();
		const normalizedText = this.normalize(params.text);
		this.db
			.prepare(
				`INSERT INTO memory_candidates (
					id, companion_id, kind, source_message_version_id, source_branch_id,
					source_conversation_id, source_kind, normalized_text, why, suggested_scope, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
			)
			.run(
				id,
				params.companionId,
				params.kind,
				params.sourceMessageVersionId ?? null,
				params.sourceBranchId ?? null,
				params.sourceConversationId ?? null,
				params.sourceKind,
				normalizedText,
				params.why ?? "",
				params.suggestedScope,
			);
		this.eventBus.publish("memory.candidate_proposed", {
			candidateId: id,
			companionId: params.companionId,
			kind: params.kind,
			sourceKind: params.sourceKind,
			text: normalizedText,
			suggestedScope: params.suggestedScope,
		});
		return id;
	}

	/** Decide a pending candidate: approve / approve_edited / reject. */
	decideCandidate(params: MemoryDecision): void {
		const candidate = this.getCandidate(params.candidateId);
		if (candidate.status !== "pending") {
			throw { kind: "conflict", reason: "candidate_already_decided" };
		}

		const now = this.now();
		const approved = params.decision !== "reject";
		const text =
			params.decision === "approve_edited" && params.editedText !== undefined
				? params.editedText
				: candidate.normalized_text;
		const normalizedText = this.normalize(text);

		let entryId: string | null = null;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			// Finalize the candidate (any decision, including approve_edited)
			this.db
				.prepare("UPDATE memory_candidates SET status = ?, decided_at = ? WHERE id = ?")
				.run(approved ? "approved" : "rejected", now, params.candidateId);

			// Append-only decision log
			this.db
				.prepare(
					`INSERT INTO memory_decisions (
						id, candidate_id, decision, edited_text, decided_scope, decided_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					randomUUID(),
					params.candidateId,
					params.decision,
					params.decision === "approve_edited" ? params.editedText ?? null : null,
					params.decision === "approve_edited" ? params.decidedScope ?? null : null,
					now,
				);

			if (approved) {
				entryId = this.insertEntry({
					companionId: candidate.companion_id,
					kind: candidate.kind,
					scope: params.decidedScope ?? candidate.suggested_scope,
					text,
					normalizedText,
					sourceMessageVersionId: candidate.source_message_version_id,
					sourceBranchId: candidate.source_branch_id,
					sourceConversationId: candidate.source_conversation_id,
					sourceKind: candidate.source_kind,
					sceneId: null,
					now,
				});
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}

		this.eventBus.publish("memory.candidate_decided", {
			candidateId: params.candidateId,
			companionId: candidate.companion_id,
			decision: params.decision,
			entryId,
		});
	}

	/**
	 * Insert an active entry, or refresh `updated_at` when an active entry
	 * with the same normalized text already exists for the companion.
	 */
	private insertEntry(params: {
		companionId: string;
		kind: MemoryKind;
		scope: MemoryScope;
		text: string;
		normalizedText: string;
		sourceMessageVersionId: string | null;
		sourceBranchId: string | null;
		sourceConversationId: string | null;
		sourceKind: MemorySourceKind;
		sceneId: string | null;
		now: string;
	}): string {
		const existing = this.db
			.prepare(
				"SELECT id FROM relationship_memory_entries WHERE companion_id = ? AND normalized_text = ? AND status = 'active' LIMIT 1",
			)
			.get(params.companionId, params.normalizedText) as { id: string } | undefined;
		if (existing) {
			this.db
				.prepare("UPDATE relationship_memory_entries SET updated_at = ? WHERE id = ?")
				.run(params.now, existing.id);
			return existing.id;
		}

		const entryId = randomUUID();
		this.db
			.prepare(
				`INSERT INTO relationship_memory_entries (
					id, companion_id, kind, scope, text, normalized_text,
					source_message_version_id, source_branch_id, source_conversation_id, source_kind,
					status, scene_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
			)
			.run(
				entryId,
				params.companionId,
				params.kind,
				params.scope,
				params.text,
				params.normalizedText,
				params.sourceMessageVersionId,
				params.sourceBranchId,
				params.sourceConversationId,
				params.sourceKind,
				params.sceneId,
				params.now,
				params.now,
			);
		return entryId;
	}

	/** Forget an entry: mark forgotten (FTS stays in sync via the trigger). */
	forget(entryId: string): void {
		const entry = this.getEntry(entryId);
		this.db
			.prepare("UPDATE relationship_memory_entries SET status = 'forgotten', forgotten_at = ? WHERE id = ?")
			.run(this.now(), entryId);
		this.eventBus.publish("memory.entry_forgotten", { entryId, companionId: entry.companion_id });
	}

	/** Exclude (or re-include) an entry. Excluded entries stay visible but are not recalled. */
	exclude(entryId: string, excluded: boolean): void {
		const entry = this.getEntry(entryId);
		this.db
			.prepare("UPDATE relationship_memory_entries SET status = ? WHERE id = ?")
			.run(excluded ? "excluded" : "active", entryId);
		this.eventBus.publish("memory.entry_excluded", {
			entryId,
			companionId: entry.companion_id,
			excluded,
		});
	}

	/**
	 * Edit an entry: insert a new active row with the updated text and the
	 * old entry's source fields, then exclude the old row to keep history.
	 * Returns the new entry id.
	 */
	edit(entryId: string, newText: string): string {
		const row = this.db
			.prepare(
				`SELECT id, companion_id, kind, scope, source_message_version_id, source_branch_id,
				        source_conversation_id, source_kind, scene_id
				 FROM relationship_memory_entries WHERE id = ?`,
			)
			.get(entryId) as EntryRow | undefined;
		if (!row) throw { kind: "not_found", reason: "memory_entry_not_found" };

		const newEntryId = randomUUID();
		const now = this.now();
		const normalizedText = this.normalize(newText);

		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					`INSERT INTO relationship_memory_entries (
						id, companion_id, kind, scope, text, normalized_text,
						source_message_version_id, source_branch_id, source_conversation_id, source_kind,
						status, scene_id, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
				)
				.run(
					newEntryId,
					row.companion_id,
					row.kind,
					row.scope,
					newText,
					normalizedText,
					row.source_message_version_id,
					row.source_branch_id,
					row.source_conversation_id,
					row.source_kind,
					row.scene_id,
					now,
					now,
				);
			this.db
				.prepare("UPDATE relationship_memory_entries SET status = 'excluded', updated_at = ? WHERE id = ?")
				.run(now, entryId);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}

		this.eventBus.publish("memory.entry_edited", {
			entryId: newEntryId,
			previousEntryId: entryId,
			companionId: row.companion_id,
		});
		return newEntryId;
	}

	/** Pin or unpin an entry (pinned entries sort first in recall). */
	pin(entryId: string, pinned: boolean): void {
		const entry = this.getEntry(entryId);
		this.db
			.prepare("UPDATE relationship_memory_entries SET pinned_at = ? WHERE id = ?")
			.run(pinned ? this.now() : null, entryId);
		this.eventBus.publish("memory.entry_pinned", { entryId, companionId: entry.companion_id, pinned });
	}

	/**
	 * Recall active entries for a companion via a LIKE ladder over
	 * normalized text (exact → prefix → substring), pinned first.
	 * Returns [] when memory is disabled — the caller owns the gate.
	 */
	recall(params: MemoryRecallParams): MemoryEntrySummary[] {
		if (!params.enabled) return [];

		const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
		const query = this.normalize(params.query);
		const exact = query;
		const prefix = `${this.escapeLike(query)}%`;
		const substring = `%${this.escapeLike(query)}%`;

		const rows = this.db
			.prepare(
				`SELECT e.id, e.kind, e.scope, e.text, e.pinned_at, e.created_at,
				        c.title AS source_conversation_title
				 FROM relationship_memory_entries e
				 LEFT JOIN conversations c ON c.id = e.source_conversation_id
				 WHERE e.companion_id = ? AND e.status = 'active'
				   AND (? IS NULL OR e.scope = ?)
				   AND (e.normalized_text = ? OR e.normalized_text LIKE ? ESCAPE '\\' OR e.normalized_text LIKE ? ESCAPE '\\')
				 ORDER BY e.pinned_at DESC NULLS LAST, e.updated_at DESC
				 LIMIT ?`,
			)
			.all(
				params.companionId,
				params.scope ?? null,
				params.scope ?? null,
				exact,
				prefix,
				substring,
				limit,
			) as Array<{
			id: string;
			kind: MemoryKind;
			scope: MemoryScope;
			text: string;
			pinned_at: string | null;
			created_at: string;
			source_conversation_title: string | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			scope: row.scope,
			text: row.text,
			sourceConversationTitle: row.source_conversation_title ?? "",
			pinned: row.pinned_at !== null,
			createdAt: row.created_at,
		}));
	}

	/** List candidates for a companion (pending by default). */
	listCandidates(params: { companionId: string; status?: CandidateStatus }): MemoryCandidateSummary[] {
		const status = params.status ?? "pending";
		const rows = this.db
			.prepare(
				`SELECT id, companion_id, kind, suggested_scope, normalized_text, why, status, created_at, decided_at
				 FROM memory_candidates
				 WHERE companion_id = ? AND status = ?
				 ORDER BY created_at DESC`,
			)
			.all(params.companionId, status) as Array<{
			id: string;
			companion_id: string;
			kind: MemoryKind;
			suggested_scope: MemoryScope;
			normalized_text: string;
			why: string;
			status: CandidateStatus;
			created_at: string;
			decided_at: string | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			companionId: row.companion_id,
			kind: row.kind,
			scope: row.suggested_scope,
			text: row.normalized_text,
			why: row.why,
			status: row.status,
			createdAt: row.created_at,
			decidedAt: row.decided_at,
		}));
	}
}
