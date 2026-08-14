/**
 * Context Pack compiler — four-layer tagged context blocks.
 *
 * Composes, per turn:
 *   1. Identity Core (short, non-compressible)
 *   2. Self Canon revision (current adopted)
 *   3. Scene State + conversation directive (short-term)
 *   4. Relationship Canon (only when memory enabled, scoped)
 * Plus any Real Context summaries projected by operational services.
 *
 * The four layers are source-tagged and cannot write into each other.
 * Only adopted versions on active branches are included.
 */

import type { DatabaseSync } from "node:sqlite";

export interface ContextPackBlock {
	layer: "identity" | "canon" | "scene" | "relationship" | "real_context";
	content: string;
}

export interface ContextPack {
	blocks: ContextPackBlock[];
	charge: {
		turns: number;
		messages: number;
		memoryEntries: number;
		truncated: boolean;
	};
}

export class ContextPackCompiler {
	private db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** Compile the Context Pack for a given conversation. */
	compile(conversationId: string, options?: { includeRelationshipMemory?: boolean }): ContextPack {
		const blocks: ContextPackBlock[] = [];
		let relationshipEntryCount = 0;

		// 1. Identity Core — short, always present
		const identity = this.getIdentityCore(conversationId);
		blocks.push({ layer: "identity", content: identity });

		// 2. Self Canon revision (current adopted)
		const canon = this.getSelfCanon(conversationId);
		if (canon) {
			blocks.push({ layer: "canon", content: canon });
		}

		// 3. Scene State + conversation directive
		const scene = this.getSceneState(conversationId);
		if (scene) {
			blocks.push({ layer: "scene", content: scene });
		}

		// 4. Relationship Canon (only when memory enabled)
		if (options?.includeRelationshipMemory !== false) {
			const relationship = this.getRelationshipMemory(conversationId);
			relationshipEntryCount = relationship.entries.length;
			if (relationship.entries.length > 0) {
				blocks.push({
					layer: "relationship",
					content: `[共同经历（仅当前已批准的条目）]\n${relationship.entries.join("\n")}`,
				});
			}
		}

		// Token budget accounting
		const totalChars = blocks.reduce((sum, b) => sum + b.content.length, 0);
		const truncated = totalChars > 8000; // rough budget marker (M2 wire)

		return {
			blocks,
			charge: {
				turns: 0,
				messages: 0,
				memoryEntries: relationshipEntryCount,
				truncated,
			},
		};
	}

	/** Render the context pack as a single system prompt string. */
	render(ctx: ContextPack): string {
		return ctx.blocks
			.map((b) => {
				const tag = `【${b.layer}】`;
				return `${tag}\n${b.content}`;
			})
			.join("\n\n");
	}

	private getIdentityCore(conversationId: string): string {
		// Companion identity from companion_identity
		const row = this.db
			.prepare(
				`SELECT ci.name, ci.self_canon
				 FROM conversations c
				 JOIN companion_identity ci ON ci.id = c.companion_id
				 WHERE c.id = ?`,
			)
			.get(conversationId) as { name: string; self_canon: string } | undefined;

		if (!row) {
			return "你是极昼，旧极光站的守护核心。我们正在对话。";
		}

		return [
			`你是${row.name}。`,
			row.self_canon.slice(0, 2000),
			"你与用户的关系和称呼由对方确认。",
			"角色语言与系统事实分离：不替用户说话、行动或决定。",
		].join("\n");
	}

	private getSelfCanon(conversationId: string): string | null {
		const row = this.db
			.prepare(
				`SELECT scv.canon
				 FROM conversations c
				 JOIN companion_identity ci ON ci.id = c.companion_id
				 JOIN self_canon_versions scv ON scv.companion_id = ci.id
				 WHERE c.id = ? AND scv.version = (SELECT MAX(version) FROM self_canon_versions WHERE companion_id = ci.id)`,
			)
			.get(conversationId) as { canon: string } | undefined;
		return row?.canon ?? null;
	}

	private getSceneState(conversationId: string): string | null {
		const row = this.db
			.prepare(
				"SELECT scene, state_json FROM scene_state WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1",
			)
			.get(conversationId) as { scene: string; state_json: string } | undefined;
		if (!row) return null;
		return `当前场景：${row.scene}\n${row.state_json}`;
	}

	private getRelationshipMemory(conversationId: string): { entries: string[] } {
		const rows = this.db
			.prepare(
				`SELECT rme.text
				 FROM relationship_memory_entries rme
				 WHERE rme.status = 'active'
				 AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = ? AND c.companion_id = rme.companion_id)
				 ORDER BY rme.pinned_at DESC NULLS LAST, rme.updated_at DESC
				 LIMIT 12`,
			)
			.all(conversationId) as Array<{ text: string }>;
		return { entries: rows.map((r) => r.text) };
	}
}