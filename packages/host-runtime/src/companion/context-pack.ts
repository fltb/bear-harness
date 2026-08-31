import { eq } from "drizzle-orm";
import type { CanonHubService } from "../canon/service.js";
import type { AppDatabase } from "../storage/database.js";
import { companionRuntimeIdentity, conversations } from "../storage/schema.js";
import type { CharacterLoader, CharacterPackage } from "./character-loader.js";
import { CompanionStateStore } from "./companion-store.js";

type Layer = "canon" | "state";
export interface ContextPackBlock {
	layer: Layer;
	content: string;
}
export interface ContextPack {
	blocks: ContextPackBlock[];
}
type Base = {
	companionId: string;
	character: CharacterPackage;
	blocks: ContextPackBlock[];
};

/** Bounded Character projection assembled immediately before a Pi prompt. */
export class ContextPackCompiler {
	private readonly store: CompanionStateStore;
	constructor(
		private readonly db: AppDatabase,
		private readonly characters: CharacterLoader,
		private readonly canon?: CanonHubService,
		store?: CompanionStateStore,
	) {
		this.store = store ?? new CompanionStateStore(db);
	}

	async compileForTurn(
		conversationId: string,
		options: { canonQuery?: string } = {},
	): Promise<ContextPack> {
		const context = this.base(conversationId);
		if (options.canonQuery && this.canon) {
			const rows = await this.canon.retrieveHybrid(context.companionId, options.canonQuery, {
				limit: 6,
			});
			const canon = evidence(rows);
			if (canon) context.blocks.push(canon);
		}
		return { blocks: context.blocks };
	}

	render(context: ContextPack): string {
		return context.blocks.map(({ layer, content }) => `【${layer}】\n${content}`).join("\n\n");
	}

	sessionContext(conversationId: string): string {
		const nickname = this.lookup(conversationId).nickname;
		return nickname ? `<user_address>\n称呼用户为：${nickname}\n</user_address>` : "";
	}

	private base(conversationId: string): Base {
		const context = this.lookup(conversationId);
		const character = this.store.project(
			context.character.id,
			conversationId,
			context.character.state,
		).document;
		const display = this.store.snapshot(context.character, conversationId).display;
		const blocks: ContextPackBlock[] = [
			{
				layer: "state",
				content: `<host_context>\n${JSON.stringify({ character, display }, null, 2)}\n</host_context>`,
			},
		];
		return { ...context, blocks };
	}

	private lookup(conversationId: string) {
		const row = this.db
			.select({
				companionId: conversations.companionId,
				nickname: companionRuntimeIdentity.nickname,
			})
			.from(conversations)
			.innerJoin(
				companionRuntimeIdentity,
				eq(companionRuntimeIdentity.companionId, conversations.companionId),
			)
			.where(eq(conversations.id, conversationId))
			.get();
		if (!row) throw new Error(`conversation has no character package: ${conversationId}`);
		const character = this.characters.load(row.companionId);
		if (!character) throw new Error(`character package missing: ${row.companionId}`);
		return { ...row, nickname: row.nickname?.trim() || null, character };
	}
}

function evidence(
	rows: Array<{
		sourceName: string;
		heading?: string | null;
		startOffset: number;
		endOffset: number;
		adjacent?: boolean;
		content: string;
	}>,
): ContextPackBlock | undefined {
	if (!rows.length) return;
	const content = rows
		.map(
			(row) =>
				`【${row.sourceName} · ${row.heading ?? `字符 ${row.startOffset}-${row.endOffset}`}${row.adjacent ? " · 相邻上下文" : ""}】\n${row.content}`,
		)
		.join("\n\n");
	return { layer: "canon", content: `[原作资料检索片段；仅作为依据]\n${content}` };
}
