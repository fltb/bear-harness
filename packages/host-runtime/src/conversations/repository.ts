import { rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { PiSessionMessage } from "../companion/pi-session-store.js";
import { PiSessionStore } from "../companion/pi-session-store.js";
import type { AppDatabase } from "../storage/database.js";
import {
	branches,
	commissions,
	conversationDirectives,
	conversationSessions,
	conversations,
	memoryCandidates,
	messages,
	messageVersions,
	relationshipMemoryEntries,
	sceneState,
	storyChangeEvents,
	storyChanges,
	turns,
} from "../storage/schema.js";

export interface ConversationSummary {
	id: string;
	title: string;
	sceneTitle: string;
	unread: false;
	updatedAt: string;
}

export interface ConversationProjection {
	activeConversationId: string;
	activeBranchId?: string;
	id: string;
	title: string;
	sceneTitle: string;
	messages: Array<{
		id: string;
		role: "user" | "assistant" | "system";
		adoptedVersionId?: string;
		versions: Array<{
			id: string;
			role: "user" | "assistant" | "system";
			content: string;
			editedByUser: boolean;
			createdAt: string;
			adopted: boolean;
		}>;
		createdAt: string;
	}>;
}

export interface ConversationSearchHit {
	conversationId: string;
	title: string;
	updatedAt: string;
	messageId: string;
	versionId: string;
	role: "user" | "assistant";
	excerpt: string;
}

export interface ConversationRepositoryOptions {
	/** Product-owned directory for Pi session files. */
	readonly sessionDir?: string;
	/** Working directory recorded in the Pi session header. */
	readonly sessionCwd?: string;
}

type SessionMetadataRow = {
	piSessionId: string;
	sessionFilePath: string;
	activeLeafId: string | null;
};

function sessionContent(message: PiSessionMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return JSON.stringify(message.content) ?? "";
	return message.content
		.map((part) => {
			if (part && typeof part === "object") {
				if ("text" in part && typeof part.text === "string") return part.text;
				if ("thinking" in part && typeof part.thinking === "string") return part.thinking;
			}
			return JSON.stringify(part) ?? "";
		})
		.join("");
}

export class ConversationRepository {
	private readonly sessionDir?: string;
	private readonly sessionCwd?: string;
	private readonly sessions = new Map<string, PiSessionStore>();

	constructor(
		private readonly db: AppDatabase,
		options: ConversationRepositoryOptions = {},
	) {
		this.sessionDir = options.sessionDir;
		this.sessionCwd = options.sessionCwd;
	}

	/** Return the live Pi store for a migrated conversation. */
	getSession(conversationId: string): PiSessionStore | undefined {
		const cached = this.sessions.get(conversationId);
		if (cached) return cached;
		const metadata = this.db
			.select({
				piSessionId: conversationSessions.piSessionId,
				sessionFilePath: conversationSessions.sessionFilePath,
				activeLeafId: conversationSessions.activeLeafId,
			})
			.from(conversationSessions)
			.where(eq(conversationSessions.conversationId, conversationId))
			.get() as SessionMetadataRow | undefined;
		if (!metadata) return undefined;
		const store = PiSessionStore.open({
			sessionDir: this.sessionDir ?? resolve(metadata.sessionFilePath, ".."),
			cwd: this.sessionCwd ?? this.sessionDir ?? resolve(metadata.sessionFilePath, ".."),
			sessionFile: metadata.sessionFilePath,
		});
		this.sessions.set(conversationId, store);
		return store;
	}

	list(companionId: string): ConversationSummary[] {
		return this.db
			.select({
				id: conversations.id,
				title: conversations.title,
				sceneTitle: conversations.sceneTitle,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(and(eq(conversations.companionId, companionId), isNull(conversations.archivedAt)))
			.orderBy(desc(conversations.updatedAt), sql`conversations.rowid desc`)
			.limit(100)
			.all()
			.map((row) => ({ ...row, unread: false as const }));
	}

	search(
		companionId: string,
		query: string,
		options: { excludeConversationId?: string; includeArchived?: boolean; limit?: number } = {},
	): ConversationSearchHit[] {
		const needle = query.trim();
		if (!needle) return [];
		const rows = this.db
			.select({
				conversationId: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
				messageId: messages.id,
				versionId: messageVersions.id,
				role: messages.role,
				content: messageVersions.content,
			})
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversationId))
			.innerJoin(
				messageVersions,
				and(eq(messageVersions.messageId, messages.id), eq(messageVersions.adopted, 1)),
			)
			.innerJoin(branches, and(eq(branches.id, messages.branchId), eq(branches.adopted, 1)))
			.where(
				and(
					eq(conversations.companionId, companionId),
					options.excludeConversationId
						? sql`${conversations.id} <> ${options.excludeConversationId}`
						: undefined,
					options.includeArchived ? undefined : isNull(conversations.archivedAt),
					inArray(messages.role, ["user", "assistant"]),
					sql`instr(${messageVersions.content}, ${needle}) > 0`,
				),
			)
			.orderBy(desc(conversations.updatedAt))
			.limit(options.limit ?? 6)
			.all();
		return rows.map((row) => ({
			conversationId: row.conversationId,
			title: row.title,
			updatedAt: row.updatedAt,
			messageId: row.messageId,
			versionId: row.versionId,
			role: row.role as "user" | "assistant",
			excerpt: excerpt(row.content, needle),
		}));
	}

	create(input: {
		id: string;
		branchId: string;
		companionId: string;
		title: string;
		sceneTitle: string;
	}) {
		const session = this.sessionDir
			? PiSessionStore.create({
					sessionDir: this.sessionDir,
					cwd: this.sessionCwd ?? this.sessionDir,
				})
			: undefined;
		try {
			this.db.transaction((transaction) => {
				transaction
					.insert(conversations)
					.values({
						id: input.id,
						companionId: input.companionId,
						title: input.title,
						sceneTitle: input.sceneTitle,
					})
					.run();
				transaction
					.insert(branches)
					.values({ id: input.branchId, conversationId: input.id, label: "main", adopted: 1 })
					.run();
				if (session) {
					const metadata = session.metadata;
					transaction
						.insert(conversationSessions)
						.values({
							conversationId: input.id,
							piSessionId: metadata.sessionId,
							sessionFilePath: metadata.sessionFile,
							activeLeafId: metadata.leafId,
						})
						.run();
				}
			});
		} catch (error) {
			if (session) rmSync(session.sessionFile, { force: true });
			throw error;
		}
		if (session) this.sessions.set(input.id, session);
	}

	get(id: string, companionId: string): ConversationProjection | undefined {
		const row = this.db
			.select({
				id: conversations.id,
				title: conversations.title,
				sceneTitle: conversations.sceneTitle,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.id, id),
					eq(conversations.companionId, companionId),
					isNull(conversations.archivedAt),
				),
			)
			.get();
		return row ? this.project(row.id, row.title, row.sceneTitle) : undefined;
	}

	rename(id: string, companionId: string, title: string): boolean {
		return (
			this.db
				.update(conversations)
				.set({ title, updatedAt: sql`datetime('now')` })
				.where(and(eq(conversations.id, id), eq(conversations.companionId, companionId)))
				.run().changes > 0
		);
	}

	archive(id: string, companionId: string, archived: boolean): boolean {
		return (
			this.db
				.update(conversations)
				.set({
					archivedAt: archived ? new Date().toISOString() : null,
					updatedAt: sql`datetime('now')`,
				})
				.where(and(eq(conversations.id, id), eq(conversations.companionId, companionId)))
				.run().changes > 0
		);
	}

	delete(id: string, companionId: string): boolean {
		const exists = this.db
			.select({ id: conversations.id })
			.from(conversations)
			.where(and(eq(conversations.id, id), eq(conversations.companionId, companionId)))
			.get();
		if (!exists) return false;
		const sessionMetadata = this.db
			.select({ sessionFilePath: conversationSessions.sessionFilePath })
			.from(conversationSessions)
			.where(eq(conversationSessions.conversationId, id))
			.get();
		this.db.transaction((transaction) => {
			const branchIds = transaction
				.select({ id: branches.id })
				.from(branches)
				.where(eq(branches.conversationId, id))
				.all()
				.map((row) => row.id);
			transaction
				.update(commissions)
				.set({ conversationId: null })
				.where(eq(commissions.conversationId, id))
				.run();
			transaction
				.update(relationshipMemoryEntries)
				.set({ sourceMessageVersionId: null, sourceBranchId: null, sourceConversationId: null })
				.where(eq(relationshipMemoryEntries.sourceConversationId, id))
				.run();
			transaction
				.update(memoryCandidates)
				.set({ sourceMessageVersionId: null, sourceBranchId: null, sourceConversationId: null })
				.where(eq(memoryCandidates.sourceConversationId, id))
				.run();
			transaction
				.update(storyChangeEvents)
				.set({ conversationId: null })
				.where(eq(storyChangeEvents.conversationId, id))
				.run();
			transaction
				.update(storyChanges)
				.set({
					status: "reverted",
					revertedAt: sql`datetime('now')`,
					conversationId: null,
					branchId: null,
				})
				.where(
					branchIds.length > 0
						? or(eq(storyChanges.conversationId, id), inArray(storyChanges.branchId, branchIds))
						: eq(storyChanges.conversationId, id),
				)
				.run();
			transaction.delete(turns).where(eq(turns.conversationId, id)).run();
			const messageIds = transaction
				.select({ id: messages.id })
				.from(messages)
				.where(eq(messages.conversationId, id))
				.all()
				.map((row) => row.id);
			if (messageIds.length > 0) {
				transaction
					.delete(messageVersions)
					.where(inArray(messageVersions.messageId, messageIds))
					.run();
			}
			transaction.delete(messages).where(eq(messages.conversationId, id)).run();
			transaction.delete(sceneState).where(eq(sceneState.conversationId, id)).run();
			transaction
				.delete(conversationDirectives)
				.where(eq(conversationDirectives.conversationId, id))
				.run();
			transaction
				.delete(conversationSessions)
				.where(eq(conversationSessions.conversationId, id))
				.run();
			transaction.delete(branches).where(eq(branches.conversationId, id)).run();
			transaction.delete(conversations).where(eq(conversations.id, id)).run();
		});
		this.sessions.delete(id);
		if (sessionMetadata?.sessionFilePath) {
			const sessionFile = resolve(sessionMetadata.sessionFilePath);
			const root = this.sessionDir ? resolve(this.sessionDir) : undefined;
			const relativePath = root ? relative(root, sessionFile) : "";
			if (!root || (relativePath !== ".." && !relativePath.startsWith("..") && !isAbsolute(relativePath))) {
				rmSync(sessionFile, { force: true });
			}
		}
		return true;
	}

	project(id: string, title: string, sceneTitle: string): ConversationProjection {
		const session = this.getSession(id);
		if (session) return this.projectPi(id, title, sceneTitle, session);

		return this.projectLegacy(id, title, sceneTitle);
	}

	private projectPi(
		id: string,
		title: string,
		sceneTitle: string,
		session: PiSessionStore,
	): ConversationProjection {
		const now = new Date().toISOString();
		const messages = session.readMessages().map((message, index) => {
			const role: "user" | "assistant" = message.role === "user" ? "user" : "assistant";
			const messageId = `pi-${index}`;
			const versionId = `${messageId}-v1`;
			const content = sessionContent(message);
			return {
				id: messageId,
				role,
				adoptedVersionId: versionId,
				versions: [{ id: versionId, role, content, editedByUser: false, createdAt: now, adopted: true }],
				createdAt: now,
			};
		});
		return {
			activeConversationId: id,
			...(session.leafId ? { activeBranchId: session.leafId } : {}),
			id,
			title,
			sceneTitle,
			messages,
		};
	}

	private projectLegacy(id: string, title: string, sceneTitle: string): ConversationProjection {
		const branch = this.db
			.select({ id: branches.id })
			.from(branches)
			.where(and(eq(branches.conversationId, id), eq(branches.adopted, 1)))
			.orderBy(desc(branches.createdAt))
			.limit(1)
			.get();
		const activeBranchId = branch?.id;
		const rows = this.db
			.select({
				id: messages.id,
				role: messages.role,
				createdAt: messages.createdAt,
				versionId: messageVersions.id,
				content: messageVersions.content,
				editedByUser: messageVersions.editedByUser,
				adopted: messageVersions.adopted,
				versionCreatedAt: messageVersions.createdAt,
			})
			.from(messages)
			.innerJoin(messageVersions, eq(messageVersions.messageId, messages.id))
			.where(
				and(
					eq(messages.conversationId, id),
					activeBranchId
						? or(
								eq(messages.branchId, activeBranchId),
								sql`messages.rowid <= coalesce((select fork.rowid from branches active_branch join messages fork on fork.id = active_branch.fork_message_id where active_branch.id = ${activeBranchId}), -1)`,
							)
						: undefined,
				),
			)
			.orderBy(sql`messages.rowid`, sql`message_versions.rowid`)
			.all();
		const grouped = new Map<string, ConversationProjection["messages"][number]>();
		for (const row of rows) {
			if (row.role !== "user" && row.role !== "assistant" && row.role !== "system") {
				throw new Error(`invalid persisted message role: ${row.role}`);
			}
			let message = grouped.get(row.id);
			if (!message) {
				message = { id: row.id, role: row.role, versions: [], createdAt: row.createdAt };
				grouped.set(row.id, message);
			}
			message.versions.push({
				id: row.versionId,
				role: row.role,
				content: row.content,
				editedByUser: Boolean(row.editedByUser),
				createdAt: row.versionCreatedAt,
				adopted: Boolean(row.adopted),
			});
			if (row.adopted) message.adoptedVersionId = row.versionId;
		}
		return {
			activeConversationId: id,
			...(activeBranchId ? { activeBranchId } : {}),
			id,
			title,
			sceneTitle,
			messages: [...grouped.values()],
		};
	}
}

function excerpt(content: string, query: string): string {
	const index = content.indexOf(query);
	if (index < 0) return content.slice(0, 1000);
	const start = Math.max(0, index - 160);
	const end = Math.min(content.length, index + query.length + 160);
	return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
}
