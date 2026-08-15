import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";

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
		private readonly db: DatabaseSync,
		private readonly eventBus: EventBus,
	) {}

	list(params: { companionId: string; branchId?: string }): StoryChange[] {
		const rows = this.db
			.prepare(
				`SELECT id, text, scope, source, conversation_id, branch_id, created_at
				 FROM story_changes
				 WHERE companion_id = ? AND status = 'active'
				   AND (scope = 'global' OR branch_id = ?)
				 ORDER BY created_at`,
			)
			.all(params.companionId, params.branchId ?? null) as Array<{
			id: string;
			text: string;
			scope: StoryChangeScope;
			source: StoryChangeSource;
			conversation_id: string | null;
			branch_id: string | null;
			created_at: string;
		}>;
		return rows.map((row) => ({
			id: row.id,
			text: row.text,
			scope: row.scope,
			source: row.source,
			...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
			...(row.branch_id ? { branchId: row.branch_id } : {}),
			createdAt: row.created_at,
		}));
	}

	listProposals(params: { companionId: string; conversationId?: string }): StoryChangeProposal[] {
		const rows = this.db
			.prepare(
				`SELECT id, conversation_id, branch_id, text, created_at
				 FROM story_change_proposals
				 WHERE companion_id = ? AND status = 'pending'
				   AND (? IS NULL OR conversation_id = ?)
				 ORDER BY created_at`,
			)
			.all(
				params.companionId,
				params.conversationId ?? null,
				params.conversationId ?? null,
			) as Array<{
			id: string;
			conversation_id: string;
			branch_id: string;
			text: string;
			created_at: string;
		}>;
		return rows.map((row) => ({
			id: row.id,
			conversationId: row.conversation_id,
			branchId: row.branch_id,
			text: row.text,
			createdAt: row.created_at,
		}));
	}

	propose(params: {
		companionId: string;
		conversationId: string;
		branchId: string;
		text: string;
	}): StoryChangeProposal {
		const existing = this.db
			.prepare(
				"SELECT id FROM story_change_proposals WHERE conversation_id = ? AND text = ? AND status = 'pending' LIMIT 1",
			)
			.get(params.conversationId, normalize(params.text)) as { id: string } | undefined;
		if (existing) return this.getProposal(existing.id);
		const id = randomUUID();
		this.db
			.prepare(
				"INSERT INTO story_change_proposals (id, companion_id, conversation_id, branch_id, text) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, params.companionId, params.conversationId, params.branchId, normalize(params.text));
		const proposal = this.getProposal(id);
		this.eventBus.publish("story.change_needs_confirmation", { proposal });
		return proposal;
	}

	resolveProposal(params: { proposalId: string; accept: boolean }): StoryChange | undefined {
		const proposal = this.getProposal(params.proposalId);
		const result = this.db
			.prepare(
				"UPDATE story_change_proposals SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'",
			)
			.run(params.accept ? "accepted" : "dismissed", params.proposalId);
		if (result.changes === 0) throw { kind: "conflict", reason: "story_proposal_already_decided" };
		if (!params.accept) {
			this.eventBus.publish("story.change_confirmation_dismissed", {
				proposalId: params.proposalId,
			});
			return undefined;
		}
		const companion = this.db
			.prepare("SELECT companion_id FROM story_change_proposals WHERE id = ?")
			.get(params.proposalId) as { companion_id: string };
		return this.apply({
			companionId: companion.companion_id,
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
			.prepare(
				"SELECT id FROM story_changes WHERE companion_id = ? AND normalized_text = ? AND status = 'active' AND scope = ? AND COALESCE(branch_id, '') = COALESCE(?, '') LIMIT 1",
			)
			.get(params.companionId, text, params.scope, params.branchId ?? null) as
			| { id: string }
			| undefined;
		if (existing) {
			return this.get(existing.id);
		}
		const id = randomUUID();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					`INSERT INTO story_changes
					 (id, companion_id, conversation_id, branch_id, text, normalized_text, scope, source)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					params.companionId,
					params.conversationId ?? null,
					params.scope === "branch" ? (params.branchId ?? null) : null,
					text,
					text,
					params.scope,
					params.source,
				);
			this.db
				.prepare(
					"INSERT INTO story_change_events (change_id, action, conversation_id) VALUES (?, 'applied', ?)",
				)
				.run(id, params.conversationId ?? null);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
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
			.prepare(
				`SELECT id FROM story_changes
				 WHERE companion_id = ? AND status = 'active'
				   AND (? IS NULL OR conversation_id = ?)
				   AND (? IS NULL OR branch_id = ? OR scope = 'global')
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(
				params.companionId,
				params.conversationId ?? null,
				params.conversationId ?? null,
				params.branchId ?? null,
				params.branchId ?? null,
			) as { id: string } | undefined;
		if (!row) return undefined;
		this.revert(row.id, params.conversationId);
		return row.id;
	}

	revert(changeId: string, conversationId?: string): void {
		const result = this.db
			.prepare(
				"UPDATE story_changes SET status = 'reverted', reverted_at = datetime('now') WHERE id = ? AND status = 'active'",
			)
			.run(changeId);
		if (result.changes === 0) throw { kind: "not_found", reason: "story_change_not_found" };
		this.db
			.prepare(
				"INSERT INTO story_change_events (change_id, action, conversation_id) VALUES (?, 'reverted', ?)",
			)
			.run(changeId, conversationId ?? null);
		this.eventBus.publish("story.change_reverted", { changeId, conversationId });
	}

	reset(params: { companionId: string; conversationId?: string; branchId?: string }): number {
		const result = this.db
			.prepare(
				`UPDATE story_changes SET status = 'reverted', reverted_at = datetime('now')
				 WHERE companion_id = ? AND status = 'active'
				   AND (? IS NULL OR branch_id = ? OR scope = 'global')`,
			)
			.run(params.companionId, params.branchId ?? null, params.branchId ?? null);
		this.db
			.prepare(
				"INSERT INTO story_change_events (change_id, action, conversation_id) VALUES (NULL, 'reset', ?)",
			)
			.run(params.conversationId ?? null);
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
		const row = this.db
			.prepare(
				"SELECT id, text, scope, source, conversation_id, branch_id, created_at FROM story_changes WHERE id = ?",
			)
			.get(id) as
			| {
					id: string;
					text: string;
					scope: StoryChangeScope;
					source: StoryChangeSource;
					conversation_id: string | null;
					branch_id: string | null;
					created_at: string;
			  }
			| undefined;
		if (!row) throw { kind: "not_found", reason: "story_change_not_found" };
		return {
			id: row.id,
			text: row.text,
			scope: row.scope,
			source: row.source,
			...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
			...(row.branch_id ? { branchId: row.branch_id } : {}),
			createdAt: row.created_at,
		};
	}

	private getProposal(id: string): StoryChangeProposal {
		const row = this.db
			.prepare(
				"SELECT id, conversation_id, branch_id, text, created_at FROM story_change_proposals WHERE id = ?",
			)
			.get(id) as
			| {
					id: string;
					conversation_id: string;
					branch_id: string;
					text: string;
					created_at: string;
			  }
			| undefined;
		if (!row) throw { kind: "not_found", reason: "story_proposal_not_found" };
		return {
			id: row.id,
			conversationId: row.conversation_id,
			branchId: row.branch_id,
			text: row.text,
			createdAt: row.created_at,
		};
	}
}

function normalize(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}
