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
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import {
	conversations,
	memoryCandidates,
	memoryDecisions,
	relationshipMemoryEntries,
} from "../storage/schema.js";

export type MemoryKind = "fact" | "preference" | "event" | "self_canon_summary";
export type MemoryScope = "self" | "relationship" | "scene";
export type MemorySourceKind =
	| "user_button"
	| "user_request"
	| "companion_suggestion"
	| "extractor";
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
	normalizedText: string;
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
	companionId: string;
	kind: MemoryKind;
	status: CandidateStatus;
	sourceMessageVersionId: string | null;
	sourceBranchId: string | null;
	sourceConversationId: string | null;
	sourceKind: MemorySourceKind;
	normalizedText: string;
	suggestedScope: MemoryScope;
}

interface EntryRow {
	id: string;
	companionId: string;
	kind: MemoryKind;
	scope: MemoryScope;
	sourceMessageVersionId: string | null;
	sourceBranchId: string | null;
	sourceConversationId: string | null;
	sourceKind: MemorySourceKind;
	sceneId: string | null;
}

export class MemoryService {
	private db: AppDatabase;
	private eventBus: EventBus;
	private options?: MemoryServiceOptions;

	constructor(db: AppDatabase, eventBus: EventBus, options?: MemoryServiceOptions) {
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

	/** Fetch a candidate row, throwing not_found when missing. */
	private getCandidate(candidateId: string): CandidateRow {
		const row = this.db
			.select({
				id: memoryCandidates.id,
				companionId: memoryCandidates.companionId,
				kind: memoryCandidates.kind,
				status: memoryCandidates.status,
				sourceMessageVersionId: memoryCandidates.sourceMessageVersionId,
				sourceBranchId: memoryCandidates.sourceBranchId,
				sourceConversationId: memoryCandidates.sourceConversationId,
				sourceKind: memoryCandidates.sourceKind,
				normalizedText: memoryCandidates.normalizedText,
				suggestedScope: memoryCandidates.suggestedScope,
			})
			.from(memoryCandidates)
			.where(eq(memoryCandidates.id, candidateId))
			.get() as CandidateRow | undefined;
		if (!row) throw { kind: "not_found", reason: "candidate_not_found" };
		return row;
	}

	/** Fetch a memory entry's identity, throwing not_found when missing. */
	private getEntry(entryId: string): { id: string; companionId: string } {
		const row = this.db
			.select({
				id: relationshipMemoryEntries.id,
				companionId: relationshipMemoryEntries.companionId,
			})
			.from(relationshipMemoryEntries)
			.where(eq(relationshipMemoryEntries.id, entryId))
			.get();
		if (!row) throw { kind: "not_found", reason: "memory_entry_not_found" };
		return row;
	}

	/** Record a candidate memory for later user approval. */
	proposeCandidate(params: MemoryCandidateProposal): string {
		const id = randomUUID();
		const normalizedText = this.normalize(params.text);
		this.db
			.insert(memoryCandidates)
			.values({
				id,
				companionId: params.companionId,
				kind: params.kind,
				sourceMessageVersionId: params.sourceMessageVersionId ?? null,
				sourceBranchId: params.sourceBranchId ?? null,
				sourceConversationId: params.sourceConversationId ?? null,
				sourceKind: params.sourceKind,
				normalizedText,
				why: params.why ?? "",
				suggestedScope: params.suggestedScope,
				status: "pending",
			})
			.run();
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
				: candidate.normalizedText;
		const normalizedText = this.normalize(text);

		let entryId: string | null = null;
		try {
			this.db.transaction((transaction) => {
				transaction
					.update(memoryCandidates)
					.set({ status: approved ? "approved" : "rejected", decidedAt: now })
					.where(eq(memoryCandidates.id, params.candidateId))
					.run();
				transaction
					.insert(memoryDecisions)
					.values({
						id: randomUUID(),
						candidateId: params.candidateId,
						decision: params.decision,
						editedText: params.decision === "approve_edited" ? (params.editedText ?? null) : null,
						decidedScope:
							params.decision === "approve_edited" ? (params.decidedScope ?? null) : null,
						decidedAt: now,
					})
					.run();
				if (approved) {
					entryId = this.insertEntry(
						{
							companionId: candidate.companionId,
							kind: candidate.kind,
							scope: params.decidedScope ?? candidate.suggestedScope,
							text,
							normalizedText,
							sourceMessageVersionId: candidate.sourceMessageVersionId,
							sourceBranchId: candidate.sourceBranchId,
							sourceConversationId: candidate.sourceConversationId,
							sourceKind: candidate.sourceKind,
							sceneId: null,
							now,
						},
						transaction,
					);
				}
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}

		this.eventBus.publish("memory.candidate_decided", {
			candidateId: params.candidateId,
			companionId: candidate.companionId,
			decision: params.decision,
			entryId,
		});
	}

	/**
	 * Insert an active entry, or refresh `updated_at` when an active entry
	 * with the same normalized text already exists for the companion.
	 */
	private insertEntry(
		params: {
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
		},
		db: Pick<AppDatabase, "select" | "insert" | "update"> = this.db,
	): string {
		const existing = db
			.select({ id: relationshipMemoryEntries.id })
			.from(relationshipMemoryEntries)
			.where(
				and(
					eq(relationshipMemoryEntries.companionId, params.companionId),
					eq(relationshipMemoryEntries.normalizedText, params.normalizedText),
					eq(relationshipMemoryEntries.status, "active"),
				),
			)
			.limit(1)
			.get();
		if (existing) {
			db.update(relationshipMemoryEntries)
				.set({ updatedAt: params.now })
				.where(eq(relationshipMemoryEntries.id, existing.id))
				.run();
			return existing.id;
		}

		const entryId = randomUUID();
		db.insert(relationshipMemoryEntries)
			.values({
				id: entryId,
				companionId: params.companionId,
				kind: params.kind,
				scope: params.scope,
				text: params.text,
				normalizedText: params.normalizedText,
				sourceMessageVersionId: params.sourceMessageVersionId,
				sourceBranchId: params.sourceBranchId,
				sourceConversationId: params.sourceConversationId,
				sourceKind: params.sourceKind,
				status: "active",
				sceneId: params.sceneId,
				createdAt: params.now,
				updatedAt: params.now,
			})
			.run();
		return entryId;
	}

	/** Forget an entry: mark forgotten (FTS stays in sync via the trigger). */
	forget(entryId: string): void {
		const entry = this.getEntry(entryId);
		this.db
			.update(relationshipMemoryEntries)
			.set({ status: "forgotten", forgottenAt: this.now() })
			.where(eq(relationshipMemoryEntries.id, entryId))
			.run();
		this.eventBus.publish("memory.entry_forgotten", { entryId, companionId: entry.companionId });
	}

	/** Exclude (or re-include) an entry. Excluded entries stay visible but are not recalled. */
	exclude(entryId: string, excluded: boolean): void {
		const entry = this.getEntry(entryId);
		this.db
			.update(relationshipMemoryEntries)
			.set({ status: excluded ? "excluded" : "active" })
			.where(eq(relationshipMemoryEntries.id, entryId))
			.run();
		this.eventBus.publish("memory.entry_excluded", {
			entryId,
			companionId: entry.companionId,
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
			.select({
				id: relationshipMemoryEntries.id,
				companionId: relationshipMemoryEntries.companionId,
				kind: relationshipMemoryEntries.kind,
				scope: relationshipMemoryEntries.scope,
				sourceMessageVersionId: relationshipMemoryEntries.sourceMessageVersionId,
				sourceBranchId: relationshipMemoryEntries.sourceBranchId,
				sourceConversationId: relationshipMemoryEntries.sourceConversationId,
				sourceKind: relationshipMemoryEntries.sourceKind,
				sceneId: relationshipMemoryEntries.sceneId,
			})
			.from(relationshipMemoryEntries)
			.where(eq(relationshipMemoryEntries.id, entryId))
			.get() as EntryRow | undefined;
		if (!row) throw { kind: "not_found", reason: "memory_entry_not_found" };

		const newEntryId = randomUUID();
		const now = this.now();
		const normalizedText = this.normalize(newText);

		try {
			this.db.transaction((transaction) => {
				transaction
					.insert(relationshipMemoryEntries)
					.values({
						id: newEntryId,
						companionId: row.companionId,
						kind: row.kind,
						scope: row.scope,
						text: newText,
						normalizedText,
						sourceMessageVersionId: row.sourceMessageVersionId,
						sourceBranchId: row.sourceBranchId,
						sourceConversationId: row.sourceConversationId,
						sourceKind: row.sourceKind,
						status: "active",
						sceneId: row.sceneId,
						createdAt: now,
						updatedAt: now,
					})
					.run();
				transaction
					.update(relationshipMemoryEntries)
					.set({ status: "excluded", updatedAt: now })
					.where(eq(relationshipMemoryEntries.id, entryId))
					.run();
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}

		this.eventBus.publish("memory.entry_edited", {
			entryId: newEntryId,
			previousEntryId: entryId,
			companionId: row.companionId,
		});
		return newEntryId;
	}

	/** Pin or unpin an entry (pinned entries sort first in recall). */
	pin(entryId: string, pinned: boolean): void {
		const entry = this.getEntry(entryId);
		this.db
			.update(relationshipMemoryEntries)
			.set({ pinnedAt: pinned ? this.now() : null })
			.where(eq(relationshipMemoryEntries.id, entryId))
			.run();
		this.eventBus.publish("memory.entry_pinned", {
			entryId,
			companionId: entry.companionId,
			pinned,
		});
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

		const rows = this.db
			.select({
				id: relationshipMemoryEntries.id,
				kind: relationshipMemoryEntries.kind,
				scope: relationshipMemoryEntries.scope,
				text: relationshipMemoryEntries.text,
				normalizedText: relationshipMemoryEntries.normalizedText,
				pinnedAt: relationshipMemoryEntries.pinnedAt,
				createdAt: relationshipMemoryEntries.createdAt,
				sourceConversationTitle: conversations.title,
			})
			.from(relationshipMemoryEntries)
			.leftJoin(conversations, eq(conversations.id, relationshipMemoryEntries.sourceConversationId))
			.where(
				and(
					eq(relationshipMemoryEntries.companionId, params.companionId),
					eq(relationshipMemoryEntries.status, "active"),
					params.scope ? eq(relationshipMemoryEntries.scope, params.scope) : undefined,
					sql`instr(${relationshipMemoryEntries.normalizedText}, ${query}) > 0`,
				),
			)
			.orderBy(desc(relationshipMemoryEntries.pinnedAt), desc(relationshipMemoryEntries.updatedAt))
			.limit(limit)
			.all();

		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			scope: row.scope,
			text: row.text,
			normalizedText: row.normalizedText,
			sourceConversationTitle: row.sourceConversationTitle ?? "",
			pinned: row.pinnedAt !== null,
			createdAt: row.createdAt,
		}));
	}

	/** List candidates for a companion (pending by default). */
	listCandidates(params: {
		companionId: string;
		status?: CandidateStatus;
	}): MemoryCandidateSummary[] {
		const status = params.status ?? "pending";
		const rows = this.db
			.select()
			.from(memoryCandidates)
			.where(
				and(
					eq(memoryCandidates.companionId, params.companionId),
					eq(memoryCandidates.status, status),
				),
			)
			.orderBy(desc(memoryCandidates.createdAt))
			.all();

		return rows.map((row) => ({
			id: row.id,
			companionId: row.companionId,
			kind: row.kind,
			scope: row.suggestedScope,
			text: row.normalizedText,
			why: row.why,
			status: row.status,
			createdAt: row.createdAt,
			decidedAt: row.decidedAt,
		}));
	}
}
