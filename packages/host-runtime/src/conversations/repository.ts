import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import {
	branches,
	commissions,
	conversationDirectives,
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

export class ConversationRepository {
	constructor(private readonly db: AppDatabase) {}

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

	create(input: {
		id: string;
		branchId: string;
		companionId: string;
		title: string;
		sceneTitle: string;
	}) {
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
		});
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
			transaction.delete(branches).where(eq(branches.conversationId, id)).run();
			transaction.delete(conversations).where(eq(conversations.id, id)).run();
		});
		return true;
	}

	project(id: string, title: string, sceneTitle: string): ConversationProjection {
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
