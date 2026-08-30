import { rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PiLiveState, PiTimeline } from "@bear-harness/protocol/schema";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { PiSessionMessageEntry } from "../companion/pi-session-store.js";
import { PiSessionStore } from "../companion/pi-session-store.js";
import type { AppDatabase } from "../storage/database.js";
import {
	activeConversations,
	conversationAttachments,
	conversationSessions,
	conversations,
	events,
	memoryCandidates,
	relationshipMemoryEntries,
} from "../storage/schema.js";

export interface ConversationSummary {
	id: string;
	title: string;
	unread: false;
	updatedAt: string;
}

export interface ConversationProjection {
	activeConversationId: string;
	id: string;
	title: string;
	piTimeline: PiTimeline;
	piSessionId: string;
	piLiveState: PiLiveState;
}
export interface ConversationSearchHit {
	conversationId: string;
	title: string;
	updatedAt: string;
	entryId: string;
	role: "user" | "assistant";
	excerpt: string;
}

export interface ConversationRepositoryOptions {
	/** Product-owned directory for Pi session files. */
	readonly sessionDir?: string;
	/** Working directory recorded in the Pi session header. */
	readonly sessionCwd?: string;
}

const TIMELINE_PAGE_SIZE = 100;

/** Resolves a conversation to its product-owned Pi session store. */
export interface ConversationSessionResolver {
	get(conversationId: string): PiSessionStore | undefined;
}

/** Supervisor-owned live Pi session projection with no transcript write capability. */
export interface PiSessionHandleProjection {
	readonly sessionId: string;
	readonly sessionManager: PiSessionStore["sessionManager"];
	readPiLiveState(): unknown;
}

export interface LiveSessionResolver {
	get(conversationId: string): PiSessionHandleProjection | undefined;
}

type SessionMetadataRow = {
	piSessionId: string;
	sessionFilePath: string;
};

export class ConversationRepository {
	private readonly sessionDir?: string;
	private readonly sessionCwd?: string;
	private liveSessionResolver: LiveSessionResolver | undefined;
	private readonly sessions = new Map<string, PiSessionStore>();

	constructor(
		private readonly db: AppDatabase,
		options: ConversationRepositoryOptions = {},
	) {
		this.sessionDir = options.sessionDir;
		this.sessionCwd = options.sessionCwd;
	}

	setLiveSessionResolver(resolver: LiveSessionResolver): void {
		this.liveSessionResolver = resolver;
	}

	/** Return the product-owned Pi store for a conversation. */
	getSession(conversationId: string): PiSessionStore {
		const metadata = this.db
			.select({
				piSessionId: conversationSessions.piSessionId,
				sessionFilePath: conversationSessions.sessionFilePath,
			})
			.from(conversationSessions)
			.where(eq(conversationSessions.conversationId, conversationId))
			.get() as SessionMetadataRow | undefined;
		if (!metadata) {
			throw { kind: "conflict", reason: "conversation_pi_session_missing" };
		}
		const cached = this.sessions.get(conversationId);
		if (cached) return cached;
		try {
			const store = PiSessionStore.open({
				sessionDir: this.sessionDir ?? resolve(metadata.sessionFilePath, ".."),
				cwd: this.sessionCwd ?? this.sessionDir ?? resolve(metadata.sessionFilePath, ".."),
				sessionFile: metadata.sessionFilePath,
			});
			this.sessions.set(conversationId, store);
			return store;
		} catch {
			throw { kind: "conflict", reason: "conversation_pi_session_invalid" };
		}
	}

	/** Expose the Pi session lookup without the repository's companion-scoped API. */
	getSessionResolver(): ConversationSessionResolver {
		return {
			get: (conversationId) => this.getSession(conversationId),
		};
	}

	list(companionId: string, archived = false): ConversationSummary[] {
		return this.db
			.select({
				id: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.companionId, companionId),
					archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt),
				),
			)
			.orderBy(desc(conversations.updatedAt), sql`conversations.rowid desc`)
			.limit(100)
			.all()
			.map((row) => ({ ...row, unread: false as const }));
	}
	get(id: string, companionId: string): ConversationProjection | undefined {
		const row = this.db
			.select({
				id: conversations.id,
				title: conversations.title,
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
		return row ? this.project(row.id, row.title) : undefined;
	}

	rename(id: string, companionId: string, title: string): boolean {
		const result = this.db
			.update(conversations)
			.set({ title, updatedAt: sql`datetime('now')` })
			.where(and(eq(conversations.id, id), eq(conversations.companionId, companionId)))
			.run();
		return result.changes > 0;
	}

	search(
		companionId: string,
		query: string,
		options: { excludeConversationId?: string; includeArchived?: boolean; limit?: number } = {},
	): ConversationSearchHit[] {
		const needle = query.trim();
		if (!needle) return [];
		const limit = options.limit ?? 6;
		const conversationRows = this.db
			.select({
				id: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(
				and(
					eq(conversations.companionId, companionId),
					options.excludeConversationId
						? sql`${conversations.id} <> ${options.excludeConversationId}`
						: undefined,
					options.includeArchived ? undefined : isNull(conversations.archivedAt),
				),
			)
			.orderBy(desc(conversations.updatedAt), sql`conversations.rowid desc`)
			.all();
		const hits: ConversationSearchHit[] = [];
		for (const conversation of conversationRows) {
			if (hits.length >= limit) break;
			let session: PiSessionStore;
			try {
				session = this.getSession(conversation.id);
			} catch (error) {
				console.warn(`conversation search: skipping session for ${conversation.id}`, error);
				continue;
			}
			const entries = session.buildPiTimeline().entries;
			for (const entry of [...entries].reverse()) {
				if (
					entry.kind !== "message" ||
					(entry.role !== "user" && entry.role !== "assistant") ||
					entry.text === undefined ||
					!entry.text.includes(needle)
				) {
					continue;
				}
				hits.push({
					conversationId: conversation.id,
					title: conversation.title,
					updatedAt: conversation.updatedAt,
					entryId: entry.id,
					role: entry.role,
					excerpt: excerpt(entry.text, needle),
				});
				if (hits.length >= limit) break;
			}
		}
		return hits;
	}
	createAndSelect(input: {
		id: string;
		companionId: string;
		title: string;
		session?: PiSessionStore;
		onCommit?: (transaction: Pick<AppDatabase, "insert" | "update">) => void;
	}): ConversationProjection {
		if (!this.sessionDir) {
			throw new Error("conversation session directory is required");
		}
		const session =
			input.session ??
			(this.sessionDir
				? PiSessionStore.create({
						sessionDir: this.sessionDir,
						cwd: this.sessionCwd ?? this.sessionDir,
					})
				: undefined);
		try {
			this.db.transaction((transaction) => {
				transaction
					.insert(conversations)
					.values({
						id: input.id,
						companionId: input.companionId,
						title: input.title,
					})
					.run();
				if (session) {
					const metadata = session.metadata;
					transaction
						.insert(conversationSessions)
						.values({
							conversationId: input.id,
							piSessionId: metadata.sessionId,
							sessionFilePath: metadata.sessionFile,
						})
						.run();
				}
				transaction
					.insert(activeConversations)
					.values({ companionId: input.companionId, conversationId: input.id })
					.onConflictDoUpdate({
						target: activeConversations.companionId,
						set: {
							conversationId: input.id,
							updatedAt: sql`datetime('now')`,
						},
					})
					.run();
				input.onCommit?.(transaction);
			});
		} catch (error) {
			if (session) rmSync(session.sessionFile, { force: true });
			throw error;
		}
		if (session) this.sessions.set(input.id, session);
		return this.project(input.id, input.title);
	}

	active(companionId: string): ConversationProjection | undefined {
		const row = this.db
			.select({
				id: conversations.id,
				title: conversations.title,
			})
			.from(activeConversations)
			.innerJoin(conversations, eq(conversations.id, activeConversations.conversationId))
			.where(
				and(eq(activeConversations.companionId, companionId), isNull(conversations.archivedAt)),
			)
			.get();
		return row ? this.project(row.id, row.title) : undefined;
	}

	select(id: string, companionId: string): ConversationProjection | undefined {
		const selected = this.db.transaction((transaction) => {
			const conversation = transaction
				.select({ id: conversations.id })
				.from(conversations)
				.where(
					and(
						eq(conversations.id, id),
						eq(conversations.companionId, companionId),
						isNull(conversations.archivedAt),
					),
				)
				.get();
			if (!conversation) return undefined;
			transaction
				.insert(activeConversations)
				.values({ companionId, conversationId: id })
				.onConflictDoUpdate({
					target: activeConversations.companionId,
					set: { conversationId: id, updatedAt: sql`datetime('now')` },
				})
				.run();
			return id;
		});
		return selected ? this.get(selected, companionId) : undefined;
	}

	archiveAndResolve(
		id: string,
		companionId: string,
		archived: boolean,
	): { found: boolean; active?: ConversationProjection } {
		const result = this.db.transaction((transaction) => {
			const conversation = transaction
				.select({ id: conversations.id, archivedAt: conversations.archivedAt })
				.from(conversations)
				.where(and(eq(conversations.id, id), eq(conversations.companionId, companionId)))
				.get();
			if (!conversation) return { found: false as const };

			const current = transaction
				.select({ conversationId: activeConversations.conversationId })
				.from(activeConversations)
				.where(eq(activeConversations.companionId, companionId))
				.get();
			transaction
				.update(conversations)
				.set({
					archivedAt: archived ? new Date().toISOString() : null,
					updatedAt: sql`datetime('now')`,
				})
				.where(eq(conversations.id, id))
				.run();

			let activeId = current?.conversationId;
			if (activeId === id) {
				if (archived) {
					activeId = transaction
						.select({ id: conversations.id })
						.from(conversations)
						.where(
							and(eq(conversations.companionId, companionId), isNull(conversations.archivedAt)),
						)
						.orderBy(desc(conversations.updatedAt), sql`conversations.rowid desc`)
						.get()?.id;
				} else {
					activeId = id;
				}
			} else if (!activeId && !archived) {
				activeId = id;
			}

			if (activeId) {
				transaction
					.insert(activeConversations)
					.values({ companionId, conversationId: activeId })
					.onConflictDoUpdate({
						target: activeConversations.companionId,
						set: { conversationId: activeId, updatedAt: sql`datetime('now')` },
					})
					.run();
			} else {
				transaction
					.delete(activeConversations)
					.where(eq(activeConversations.companionId, companionId))
					.run();
			}
			return { found: true as const, activeId };
		});
		if (!result.found || !result.activeId) return { found: result.found };
		const active = this.get(result.activeId, companionId);
		return active ? { found: true, active } : { found: true };
	}

	deleteAndResolve(
		id: string,
		companionId: string,
	): { found: boolean; active?: ConversationProjection } {
		const result = this.db.transaction((transaction) => {
			const conversation = transaction
				.select({ id: conversations.id })
				.from(conversations)
				.where(and(eq(conversations.id, id), eq(conversations.companionId, companionId)))
				.get();
			if (!conversation) return { found: false as const };
			const current = transaction
				.select({ conversationId: activeConversations.conversationId })
				.from(activeConversations)
				.where(eq(activeConversations.companionId, companionId))
				.get();
			const sessionMetadata = transaction
				.select({ sessionFilePath: conversationSessions.sessionFilePath })
				.from(conversationSessions)
				.where(eq(conversationSessions.conversationId, id))
				.get();
			transaction
				.update(relationshipMemoryEntries)
				.set({ sourceConversationId: null })
				.where(eq(relationshipMemoryEntries.sourceConversationId, id))
				.run();
			transaction
				.update(memoryCandidates)
				.set({ sourceConversationId: null })
				.where(eq(memoryCandidates.sourceConversationId, id))
				.run();
			transaction
				.delete(conversationSessions)
				.where(eq(conversationSessions.conversationId, id))
				.run();
			transaction.delete(conversations).where(eq(conversations.id, id)).run();

			let activeId = current?.conversationId;
			if (activeId === id) {
				activeId = transaction
					.select({ id: conversations.id })
					.from(conversations)
					.where(and(eq(conversations.companionId, companionId), isNull(conversations.archivedAt)))
					.orderBy(desc(conversations.updatedAt), sql`conversations.rowid desc`)
					.get()?.id;
			}
			if (activeId) {
				transaction
					.insert(activeConversations)
					.values({ companionId, conversationId: activeId })
					.onConflictDoUpdate({
						target: activeConversations.companionId,
						set: { conversationId: activeId, updatedAt: sql`datetime('now')` },
					})
					.run();
			} else if (current?.conversationId === id) {
				transaction
					.delete(activeConversations)
					.where(eq(activeConversations.companionId, companionId))
					.run();
			}
			return { found: true as const, activeId, sessionFilePath: sessionMetadata?.sessionFilePath };
		});
		if (!result.found) return { found: false };
		this.sessions.delete(id);
		if (result.sessionFilePath) this.removeSessionFile(result.sessionFilePath);
		if (!result.activeId) return { found: true };
		const active = this.get(result.activeId, companionId);
		return active ? { found: true, active } : { found: true };
	}

	private removeSessionFile(sessionFilePath: string): void {
		const sessionFile = resolve(sessionFilePath);
		const root = this.sessionDir ? resolve(this.sessionDir) : undefined;
		const relativePath = root ? relative(root, sessionFile) : "";
		if (
			!root ||
			(relativePath !== ".." && !relativePath.startsWith("..") && !isAbsolute(relativePath))
		) {
			rmSync(sessionFile, { force: true });
		}
	}

	project(id: string, title: string): ConversationProjection {
		return this.projectPi(id, title, this.getSession(id));
	}

	timelinePage(id: string, companionId: string, beforeOffset?: number): PiTimeline | undefined {
		const row = this.db
			.select({ id: conversations.id })
			.from(conversations)
			.where(and(eq(conversations.id, id), eq(conversations.companionId, companionId)))
			.get();
		if (!row) return undefined;
		return this.projectTimelineWindow(id, this.getSession(id), beforeOffset);
	}

	/** Resolve a selected-branch Pi timeline entry by its native SessionManager ID. */
	getCurrentPiEntryForMessage(
		conversationId: string,
		messageId: string,
	): PiSessionMessageEntry | undefined {
		const session = this.getSession(conversationId);
		if (!session) return undefined;
		if (!session.buildPiTimeline().entries.some((entry) => entry.id === messageId))
			return undefined;
		return session.getMessageEntry(messageId);
	}
	private projectPi(id: string, title: string, session: PiSessionStore): ConversationProjection {
		const live = this.liveSessionResolver?.get(id);
		const piTimeline = this.projectTimelineWindow(id, session);
		return {
			activeConversationId: id,
			id,
			title,
			piSessionId: live?.sessionId ?? session.sessionId,
			piLiveState: projectPiLiveState(live?.readPiLiveState()),
			piTimeline,
		};
	}

	private projectTimelineWindow(
		id: string,
		session: PiSessionStore,
		beforeOffset?: number,
	): PiTimeline {
		const nativeTimeline = session.buildPiTimeline();
		const groupedAttachments = new Map<
			string,
			Array<{
				id: string;
				name: string;
				kind: "file" | "folder" | "generated";
				bytes: number;
				fileCount: number;
				originEntryId: string;
			}>
		>();
		for (const attachment of this.db
			.select()
			.from(conversationAttachments)
			.where(eq(conversationAttachments.conversationId, id))
			.all()) {
			if (!attachment.originEntryId) continue;
			const current = groupedAttachments.get(attachment.originEntryId) ?? [];
			current.push({
				id: attachment.id,
				name: attachment.name,
				kind: attachment.kind,
				bytes: attachment.totalBytes,
				fileCount: attachment.fileCount,
				originEntryId: attachment.originEntryId,
			});
			groupedAttachments.set(attachment.originEntryId, current);
		}
		const totalEntries = nativeTimeline.entries.length;
		const endOffset = Math.min(beforeOffset ?? totalEntries, totalEntries);
		const startOffset = Math.max(0, endOffset - TIMELINE_PAGE_SIZE);
		const entries = nativeTimeline.entries
			.slice(startOffset, endOffset)
			.map((entry) =>
				entry.kind === "message" && (entry.role === "user" || entry.role === "assistant")
					? { ...entry, attachments: groupedAttachments.get(entry.id) ?? [] }
					: entry,
			);
		return {
			entries,
			...(nativeTimeline.activeLeafId &&
			entries.some((entry) => entry.id === nativeTimeline.activeLeafId)
				? { activeLeafId: nativeTimeline.activeLeafId }
				: {}),
			startOffset,
			totalEntries,
			hasMoreBefore: startOffset > 0,
		};
	}
}

function projectPiLiveState(value: unknown): PiLiveState {
	if (!value || typeof value !== "object") return { isStreaming: false };
	const state = value as {
		isStreaming?: unknown;
		errorMessage?: unknown;
		streamingMessage?: unknown;
	};
	const streamingMessage =
		state.streamingMessage && typeof state.streamingMessage === "object"
			? projectPiLiveAssistantMessage(state.streamingMessage)
			: undefined;
	return {
		isStreaming: state.isStreaming === true,
		...(streamingMessage ? { streamingMessage } : {}),
		...(typeof state.errorMessage === "string"
			? { errorMessage: state.errorMessage.slice(0, 4096) }
			: {}),
	};
}

function projectPiLiveAssistantMessage(
	value: object,
): NonNullable<PiLiveState["streamingMessage"]> {
	const message = value as {
		content?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
	};
	const text =
		typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content
						.flatMap((part) =>
							part &&
							typeof part === "object" &&
							"type" in part &&
							part.type === "text" &&
							"text" in part &&
							typeof part.text === "string"
								? [part.text]
								: [],
						)
						.join("")
				: undefined;
	const stopReason =
		message.stopReason === "stop" ||
		message.stopReason === "length" ||
		message.stopReason === "toolUse" ||
		message.stopReason === "error" ||
		message.stopReason === "aborted" ||
		message.stopReason === "deferred"
			? message.stopReason
			: "pending";
	return {
		...(text ? { text: text.slice(0, 65536) } : {}),
		stopReason,
		...(typeof message.errorMessage === "string"
			? { errorMessage: message.errorMessage.slice(0, 4096) }
			: {}),
	};
}

function excerpt(content: string, query: string): string {
	const index = content.indexOf(query);
	if (index < 0) return content.slice(0, 1000);
	const start = Math.max(0, index - 160);
	const end = Math.min(content.length, index + query.length + 160);
	return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
}
