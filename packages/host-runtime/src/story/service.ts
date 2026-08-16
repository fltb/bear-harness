import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { storyChangeEvents, storyChangeProposals, storyChanges } from "../storage/schema.js";

export type StoryChangeScope = "global" | "branch";
export type StoryChangeSource = "user_explicit" | "story_event" | "user_confirmed";

export interface StoryChange {
	id: string;
	text: string;
	scope: StoryChangeScope;
	source: StoryChangeSource;
	conversationId?: string;
	branchId?: string;
	createdAt: string;
}

export interface StoryChangeProposal {
	id: string;
	conversationId: string;
	branchId: string;
	text: string;
	createdAt: string;
}

export type StoryTextResult =
	| { action: "applied"; change: StoryChange }
	| { action: "reverted"; changeId?: string }
	| { action: "reset"; count: number }
	| { action: "ignored" }
	| { action: "ambiguous" };

export class StoryService {
	constructor(
		private readonly db: AppDatabase,
		private readonly eventBus: EventBus,
	) {}

	list(params: { companionId: string; branchId?: string }): StoryChange[] {
		const rows = this.db
			.select()
			.from(storyChanges)
			.where(
				and(
					eq(storyChanges.companionId, params.companionId),
					eq(storyChanges.status, "active"),
					or(
						eq(storyChanges.scope, "global"),
						params.branchId
							? eq(storyChanges.branchId, params.branchId)
							: isNull(storyChanges.branchId),
					),
				),
			)
			.orderBy(asc(storyChanges.createdAt))
			.all();
		return rows.map((row) => ({
			id: row.id,
			text: row.text,
			scope: row.scope,
			source: row.source,
			...(row.conversationId ? { conversationId: row.conversationId } : {}),
			...(row.branchId ? { branchId: row.branchId } : {}),
			createdAt: row.createdAt,
		}));
	}

	listProposals(params: { companionId: string; conversationId?: string }): StoryChangeProposal[] {
		const rows = this.db
			.select()
			.from(storyChangeProposals)
			.where(
				and(
					eq(storyChangeProposals.companionId, params.companionId),
					eq(storyChangeProposals.status, "pending"),
					params.conversationId
						? eq(storyChangeProposals.conversationId, params.conversationId)
						: undefined,
				),
			)
			.orderBy(asc(storyChangeProposals.createdAt))
			.all();
		return rows.map((row) => ({
			id: row.id,
			conversationId: row.conversationId,
			branchId: row.branchId,
			text: row.text,
			createdAt: row.createdAt,
		}));
	}

	propose(params: {
		companionId: string;
		conversationId: string;
		branchId: string;
		text: string;
	}): StoryChangeProposal {
		const existing = this.db
			.select({ id: storyChangeProposals.id })
			.from(storyChangeProposals)
			.where(
				and(
					eq(storyChangeProposals.conversationId, params.conversationId),
					eq(storyChangeProposals.text, normalize(params.text)),
					eq(storyChangeProposals.status, "pending"),
				),
			)
			.limit(1)
			.get();
		if (existing) return this.getProposal(existing.id);
		const id = randomUUID();
		this.db
			.insert(storyChangeProposals)
			.values({
				id,
				companionId: params.companionId,
				conversationId: params.conversationId,
				branchId: params.branchId,
				text: normalize(params.text),
			})
			.run();
		const proposal = this.getProposal(id);
		this.eventBus.publish("story.change_needs_confirmation", { proposal });
		return proposal;
	}

	resolveProposal(params: { proposalId: string; accept: boolean }): StoryChange | undefined {
		const proposal = this.getProposal(params.proposalId);
		const result = this.db
			.update(storyChangeProposals)
			.set({ status: params.accept ? "accepted" : "dismissed", decidedAt: sql`datetime('now')` })
			.where(
				and(
					eq(storyChangeProposals.id, params.proposalId),
					eq(storyChangeProposals.status, "pending"),
				),
			)
			.run();
		if (result.changes === 0) throw { kind: "conflict", reason: "story_proposal_already_decided" };
		if (!params.accept) {
			this.eventBus.publish("story.change_confirmation_dismissed", {
				proposalId: params.proposalId,
			});
			return undefined;
		}
		const companion = this.db
			.select({ companionId: storyChangeProposals.companionId })
			.from(storyChangeProposals)
			.where(eq(storyChangeProposals.id, params.proposalId))
			.get();
		if (!companion) throw { kind: "not_found", reason: "story_proposal_not_found" };
		return this.apply({
			companionId: companion.companionId,
			conversationId: proposal.conversationId,
			branchId: proposal.branchId,
			text: proposal.text,
			scope: "global",
			source: "user_confirmed",
		});
	}

	apply(params: {
		companionId: string;
		conversationId?: string;
		branchId?: string;
		text: string;
		scope: StoryChangeScope;
		source: StoryChangeSource;
	}): StoryChange {
		const text = normalize(params.text);
		if (!text) throw { kind: "invalid_request", reason: "story_change_empty" };
		if (params.scope === "branch" && !params.branchId) {
			throw { kind: "invalid_request", reason: "story_branch_required" };
		}
		const existing = this.db
			.select({ id: storyChanges.id })
			.from(storyChanges)
			.where(
				and(
					eq(storyChanges.companionId, params.companionId),
					eq(storyChanges.normalizedText, text),
					eq(storyChanges.status, "active"),
					eq(storyChanges.scope, params.scope),
					params.branchId
						? eq(storyChanges.branchId, params.branchId)
						: isNull(storyChanges.branchId),
				),
			)
			.limit(1)
			.get();
		if (existing) {
			return this.get(existing.id);
		}
		const id = randomUUID();
		this.db.transaction((transaction) => {
			transaction
				.insert(storyChanges)
				.values({
					id,
					companionId: params.companionId,
					conversationId: params.conversationId ?? null,
					branchId: params.scope === "branch" ? (params.branchId ?? null) : null,
					text,
					normalizedText: text,
					scope: params.scope,
					source: params.source,
				})
				.run();
			transaction
				.insert(storyChangeEvents)
				.values({ changeId: id, action: "applied", conversationId: params.conversationId ?? null })
				.run();
		});
		const change = this.get(id);
		this.eventBus.publish("story.change_applied", { change });
		return change;
	}

	revertLatest(params: {
		companionId: string;
		conversationId?: string;
		branchId?: string;
	}): string | undefined {
		const row = this.db
			.select({ id: storyChanges.id })
			.from(storyChanges)
			.where(
				and(
					eq(storyChanges.companionId, params.companionId),
					eq(storyChanges.status, "active"),
					params.conversationId
						? eq(storyChanges.conversationId, params.conversationId)
						: undefined,
					params.branchId
						? or(eq(storyChanges.branchId, params.branchId), eq(storyChanges.scope, "global"))
						: undefined,
				),
			)
			.orderBy(desc(storyChanges.createdAt))
			.limit(1)
			.get();
		if (!row) return undefined;
		this.revert(row.id, params.conversationId);
		return row.id;
	}

	revert(changeId: string, conversationId?: string): void {
		const result = this.db
			.update(storyChanges)
			.set({ status: "reverted", revertedAt: sql`datetime('now')` })
			.where(and(eq(storyChanges.id, changeId), eq(storyChanges.status, "active")))
			.run();
		if (result.changes === 0) throw { kind: "not_found", reason: "story_change_not_found" };
		this.db
			.insert(storyChangeEvents)
			.values({ changeId, action: "reverted", conversationId: conversationId ?? null })
			.run();
		this.eventBus.publish("story.change_reverted", { changeId, conversationId });
	}

	reset(params: { companionId: string; conversationId?: string; branchId?: string }): number {
		const result = this.db
			.update(storyChanges)
			.set({ status: "reverted", revertedAt: sql`datetime('now')` })
			.where(
				and(
					eq(storyChanges.companionId, params.companionId),
					eq(storyChanges.status, "active"),
					params.branchId
						? or(eq(storyChanges.branchId, params.branchId), eq(storyChanges.scope, "global"))
						: undefined,
				),
			)
			.run();
		this.db
			.insert(storyChangeEvents)
			.values({ changeId: null, action: "reset", conversationId: params.conversationId ?? null })
			.run();
		this.eventBus.publish("story.reset", {
			conversationId: params.conversationId,
			count: result.changes,
		});
		return Number(result.changes);
	}

	handleUserText(params: {
		companionId: string;
		conversationId: string;
		branchId: string;
		text: string;
	}): StoryTextResult {
		const input = normalize(params.text);
		if (/^(?:刚才|上一条).*(?:不算|撤销)|^撤销刚才/.test(input)) {
			return { action: "reverted", changeId: this.revertLatest(params) };
		}
		if (/恢复原作|回到原作设定|清除故事变更/.test(input)) {
			return { action: "reset", count: this.reset(params) };
		}
		if (/[？?]$/.test(input) || /^(?:如果|假如|假设|讨论一下|原作里)/.test(input)) {
			return { action: "ignored" };
		}
		const explicit = input.match(
			/^(?:故事设定|设定|在这个故事里|从现在起|记住这个设定)[：:,，\s]*(.+)$/,
		);
		const changed = input.match(/^把(.{1,120}?)(?:改成|设为|设定为)(.+)$/);
		const text = explicit?.[1] ?? (changed ? `${changed[1]}改为${changed[2]}` : undefined);
		if (!text)
			return /(?:其实|应该是|算作)/.test(input) ? { action: "ambiguous" } : { action: "ignored" };
		const scope: StoryChangeScope = /只限(?:这个|当前)分支/.test(input) ? "branch" : "global";
		return {
			action: "applied",
			change: this.apply({ ...params, text, scope, source: "user_explicit" }),
		};
	}

	private get(id: string): StoryChange {
		const row = this.db.select().from(storyChanges).where(eq(storyChanges.id, id)).get();
		if (!row) throw { kind: "not_found", reason: "story_change_not_found" };
		return {
			id: row.id,
			text: row.text,
			scope: row.scope,
			source: row.source,
			...(row.conversationId ? { conversationId: row.conversationId } : {}),
			...(row.branchId ? { branchId: row.branchId } : {}),
			createdAt: row.createdAt,
		};
	}

	private getProposal(id: string): StoryChangeProposal {
		const row = this.db
			.select()
			.from(storyChangeProposals)
			.where(eq(storyChangeProposals.id, id))
			.get();
		if (!row) throw { kind: "not_found", reason: "story_proposal_not_found" };
		return {
			id: row.id,
			conversationId: row.conversationId,
			branchId: row.branchId,
			text: row.text,
			createdAt: row.createdAt,
		};
	}
}

function normalize(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}
