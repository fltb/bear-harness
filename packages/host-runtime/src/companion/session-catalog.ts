import { unlink } from "node:fs/promises";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { conversations } from "../storage/schema.js";
import type { PiRuntime } from "./pi-runtime.js";

export interface SessionCatalogQuery {
	archived?: boolean;
	title?: string;
}

/** Total-session management. It never reads or reconstructs Pi messages. */
export class SessionCatalog {
	constructor(
		private readonly db: AppDatabase,
		private readonly pi: PiRuntime,
	) {}

	async list(companionId: string, query: SessionCatalogQuery = {}) {
		const rows = this.db
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.companionId, companionId),
					query.archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
				),
			)
			.all();
		const allowed = new Set(rows.map((row) => row.id));
		const words = query.title?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
		return (await this.pi.list())
			.filter((session) => allowed.has(session.id))
			.filter((session) => {
				const name = session.name?.toLocaleLowerCase() ?? "";
				return words.every((word) => name.includes(word));
			})
			.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	async create(companionId: string, title = "") {
		let sessionId: string | undefined;
		try {
			return await this.pi.create(title, (id) => {
				sessionId = id;
				this.db.insert(conversations).values({ id, companionId }).run();
			});
		} catch (error) {
			if (sessionId) this.db.delete(conversations).where(eq(conversations.id, sessionId)).run();
			throw error;
		}
	}

	async select(companionId: string, sessionId: string) {
		this.requireOwned(companionId, sessionId);
		return this.pi.select(sessionId);
	}

	async rename(companionId: string, sessionId: string, title: string) {
		await this.select(companionId, sessionId);
		this.pi.setName(title);
	}

	async fork(companionId: string, sourceSessionId: string, entryId: string) {
		await this.select(companionId, sourceSessionId);
		const session = await this.pi.fork(entryId);
		this.db.insert(conversations).values({ id: session.sessionId, companionId }).run();
		return session;
	}

	async archive(companionId: string, sessionId: string, archived: boolean) {
		this.requireOwned(companionId, sessionId);
		this.db
			.update(conversations)
			.set({ archivedAt: archived ? new Date().toISOString() : null })
			.where(eq(conversations.id, sessionId))
			.run();
		if (archived && this.pi.snapshot()?.sessionId === sessionId) await this.pi.close();
		return this.pi.snapshot();
	}

	async delete(companionId: string, sessionId: string) {
		this.requireOwned(companionId, sessionId);
		const session = (await this.pi.list()).find((candidate) => candidate.id === sessionId);
		if (!session) throw { kind: "not_found", reason: "pi_session_not_found" };
		if (this.pi.snapshot()?.sessionId === sessionId) await this.pi.close();
		await unlink(session.path);
		this.db.delete(conversations).where(eq(conversations.id, sessionId)).run();
		return this.pi.snapshot();
	}

	private requireOwned(companionId: string, sessionId: string) {
		const row = this.db
			.select({ id: conversations.id })
			.from(conversations)
			.where(and(eq(conversations.id, sessionId), eq(conversations.companionId, companionId)))
			.get();
		if (!row) throw { kind: "not_found", reason: "conversation_not_found" };
	}
}
