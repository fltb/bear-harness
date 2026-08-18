/**
 * Turn pipeline — the Host-commanded conversation engine.
 *
 * User messages are written to the canonical DB first, then sent to the
 * Companion runtime. Assistant streaming writes bounded draft checkpoints;
 * after `message_end` the immutable final version is persisted. All of
 * send/abort/regenerate/continue/correct/branch/edit are Host commands that
 * can never modify approval, run, file, evidence, artifact, result, or
 * billing facts.
 *
 * Exactly one active turn per conversation. Regenerate creates a sibling
 * assistant version from the same user parent; switching versions never calls
 * the model. Only the adopted version enters later context.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import {
	branches,
	conversationDirectives,
	conversations,
	messages,
	messageVersions,
	turns,
} from "../storage/schema.js";
import type { PiSessionMessage } from "./pi-session-store.js";
import type { CompanionSupervisor } from "./supervisor.js";

const REGENERATE_INSTRUCTION =
	"请基于上面的对话重新生成对上一条用户消息的回复。直接自然地回答，不要提及重新生成或比较旧回复。";
const CONTINUE_INSTRUCTION = "请继续上一条回复。不要重复已经说过的内容，直接接着完成。";

export interface TurnResult {
	messageId: string;
	versionId: string;
	status: "completed" | "failed" | "aborted";
}

export interface TurnPipelineSessionAppender {
	appendMessage(message: PiSessionMessage): string;
	appendUserMessage?(text: string, timestamp?: number): string;
	appendSyntheticAssistant?(text: string): string;
	findMessageEntry?(
		role: "user" | "assistant",
		content: string,
		options?: { branchOnly?: boolean },
	): { id: string; message: PiSessionMessage } | undefined;
	getMessageEntry?(entryId: string): { id: string; message: PiSessionMessage } | undefined;
	findParentUserEntry?(entryId: string): { id: string; message: PiSessionMessage } | undefined;
	branchBefore?(entryId: string): void;
	selectBranch?(leafId: string): void;
	currentLeaf?: unknown;
}

/** Resolves the Pi session for a conversation without exposing Host history. */
export interface TurnPipelineSessionResolver {
	get(conversationId: string): TurnPipelineSessionAppender | undefined;
}

export class TurnPipeline {
	private db: AppDatabase;
	private supervisor: CompanionSupervisor;
	private eventBus: EventBus;
	private readonly sessionResolver?: TurnPipelineSessionResolver;
	private activeTurns = new Map<
		string,
		{
			userMessageId: string;
			assistantMessageId?: string;
			assistantVersionId?: string;
		}
	>();
	private readonly unsubscribe: () => void;

	constructor(
		db: AppDatabase,
		supervisor: CompanionSupervisor,
		eventBus: EventBus,
		sessionResolver?: TurnPipelineSessionResolver,
	) {
		this.db = db;
		this.supervisor = supervisor;
		this.eventBus = eventBus;
		this.sessionResolver = sessionResolver;
		this.unsubscribe = eventBus.subscribe((event) => {
			if (event.kind === "message_end") this.commitAssistantReply(event.payload);
		});
	}

	dispose(): void {
		this.unsubscribe();
	}

	/** Send a user message and start a companion turn. */
	async sendUserMessage(
		conversationId: string,
		text: string,
		attachments: Array<{ name: string; mime: string; base64: string }> = [],
	): Promise<TurnResult> {
		// One active turn per conversation
		if (this.activeTurns.has(conversationId)) {
			throw { kind: "conflict", reason: "turn_already_active" };
		}
		if (!this.supervisor.isRunning) {
			throw { kind: "unavailable", reason: "companion_unavailable" };
		}

		// Write the user message transactionally FIRST
		const messageId = randomUUID();
		const versionId = randomUUID();
		const branchRow = this.db
			.select({ id: branches.id })
			.from(branches)
			.where(and(eq(branches.conversationId, conversationId), eq(branches.adopted, 1)))
			.orderBy(desc(branches.createdAt))
			.limit(1)
			.get();
		const branchId = branchRow?.id ?? conversationId;

		try {
			this.db.transaction((transaction) => {
				transaction
					.insert(messages)
					.values({ id: messageId, conversationId, branchId, role: "user" })
					.run();
				transaction
					.insert(messageVersions)
					.values({ id: versionId, messageId, content: text, editedByUser: 0, adopted: 1 })
					.run();
				transaction
					.update(conversations)
					.set({ updatedAt: new Date().toISOString() })
					.where(eq(conversations.id, conversationId))
					.run();
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}

		this.activeTurns.set(conversationId, { userMessageId: messageId });
		this.eventBus.publish("message.user_sent", { conversationId, messageId, versionId, text });

		// Send to the Companion runtime (fire-and-forget via postMessage);
		// the runtime streams `message_start` / `message_update` /
		// `message_end` events (M2 async receipt path).
		this.supervisor.sendCommand({
			type: "prompt",
			conversationId,
			message: text,
			images: attachments.map((attachment) => ({
				type: "image" as const,
				data: attachment.base64,
				mimeType: attachment.mime,
			})),
			streamingBehavior: "followUp",
		});

		return { messageId, versionId, status: "completed" };
	}

	/** Abort the active turn for a conversation. */
	async abort(conversationId: string): Promise<void> {
		if (!this.activeTurns.has(conversationId)) return;
		this.supervisor.sendCommand({ type: "abort", conversationId });
		this.activeTurns.delete(conversationId);
		this.eventBus.publish("message.aborted", { conversationId });
	}

	/** Regenerate: create a sibling assistant version from the same user parent. */
	async regenerate(conversationId: string, messageId: string): Promise<TurnResult> {
		const session = this.sessionResolver?.get(conversationId);
		const piTarget = session?.getMessageEntry?.(messageId);
		const row = piTarget
			? { id: messageId, role: piTarget.message.role }
			: this.db
					.select({ id: messages.id, role: messages.role })
					.from(messages)
					.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
					.get();
		if (!row) throw { kind: "not_found", reason: "message_not_found" };

		if (this.activeTurns.has(conversationId)) {
			throw { kind: "conflict", reason: "turn_already_active" };
		}
		if (row.role !== "assistant") {
			throw { kind: "conflict", reason: "assistant_message_required" };
		}
		const targetText = piTarget ? assistantMessageText(piTarget.message) : undefined;
		const hostAssistantId =
			piTarget && targetText
				? (this.findHostMessageId(conversationId, "assistant", targetText) ??
					this.ensureHostMessage(conversationId, "assistant", targetText))
				: messageId;
		const piParent = piTarget ? session?.findParentUserEntry?.(messageId) : undefined;
		const parent = piTarget
			? piParent
				? {
						id:
							this.findHostMessageId(
								conversationId,
								"user",
								assistantMessageText(piParent.message),
							) ??
							this.ensureHostMessage(
								conversationId,
								"user",
								assistantMessageText(piParent.message),
							),
					}
				: undefined
			: this.db
					.select({ id: turns.userMessageId })
					.from(turns)
					.where(
						and(eq(turns.conversationId, conversationId), eq(turns.assistantMessageId, messageId)),
					)
					.orderBy(desc(turns.createdAt))
					.limit(1)
					.get();
		if (!parent) throw { kind: "not_found", reason: "parent_message_not_found" };
		const assistantVersion = this.db
			.select({ content: messageVersions.content })
			.from(messageVersions)
			.where(and(eq(messageVersions.messageId, hostAssistantId), eq(messageVersions.adopted, 1)))
			.limit(1)
			.get();
		if (session && piTarget && session.branchBefore) session.branchBefore(piTarget.id);
		else if (session && assistantVersion?.content !== undefined) {
			const piAssistant =
				session.findMessageEntry?.("assistant", assistantVersion.content, { branchOnly: true }) ??
				session.findMessageEntry?.("assistant", assistantVersion.content);
			if (piAssistant && session.branchBefore) session.branchBefore(piAssistant.id);
		}
		// Create a sibling assistant version, then actually ask the model again.
		const newVersionId = randomUUID();
		this.db.transaction((transaction) => {
			transaction
				.update(messageVersions)
				.set({ adopted: 0 })
				.where(eq(messageVersions.messageId, hostAssistantId))
				.run();
			transaction
				.insert(messageVersions)
				.values({
					id: newVersionId,
					messageId: hostAssistantId,
					content: "",
					editedByUser: 0,
					adopted: 1,
				})
				.run();
		});
		this.eventBus.publish("message.regenerated", {
			conversationId,
			messageId,
			versionId: newVersionId,
		});
		this.activeTurns.set(conversationId, {
			userMessageId: parent.id,
			assistantMessageId: hostAssistantId,
			assistantVersionId: newVersionId,
		});
		this.supervisor.sendCommand({
			type: "prompt",
			conversationId,
			message: REGENERATE_INSTRUCTION,
		});
		return { messageId, versionId: newVersionId, status: "completed" };
	}

	/** Switch the adopted version of a message (no model call). */
	async switchVersion(conversationId: string, messageId: string, versionId: string): Promise<void> {
		const session = this.sessionResolver?.get(conversationId);
		const piTarget = session?.getMessageEntry?.(messageId);
		if (piTarget) {
			if (versionId !== `${messageId}-v1`) {
				throw { kind: "not_found", reason: "version_not_found" };
			}
			session?.selectBranch?.(messageId);
			this.eventBus.publish("message.version_switched", { conversationId, messageId, versionId });
			return;
		}
		const exists = this.db
			.select({ id: messageVersions.id })
			.from(messageVersions)
			.where(and(eq(messageVersions.id, versionId), eq(messageVersions.messageId, messageId)))
			.get();
		if (!exists) throw { kind: "not_found", reason: "version_not_found" };
		const version = this.db
			.select({ content: messageVersions.content })
			.from(messageVersions)
			.where(eq(messageVersions.id, versionId))
			.get();
		const message = this.db
			.select({ role: messages.role })
			.from(messages)
			.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
			.get();

		try {
			this.db.transaction((transaction) => {
				transaction
					.update(messageVersions)
					.set({ adopted: 0 })
					.where(eq(messageVersions.messageId, messageId))
					.run();
				transaction
					.update(messageVersions)
					.set({ adopted: 1 })
					.where(eq(messageVersions.id, versionId))
					.run();
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		if (
			session &&
			version?.content !== undefined &&
			(message?.role === "user" || message?.role === "assistant")
		) {
			const entry = session.findMessageEntry?.(message.role, version.content);
			if (entry && session.selectBranch) session.selectBranch(entry.id);
		}
		this.eventBus.publish("message.version_switched", { conversationId, messageId, versionId });
	}

	/** Edit a message (assistant → new version marked edited_by_user; user → new branch). */
	async edit(
		conversationId: string,
		messageId: string,
		text: string,
		isUserMessage: boolean,
	): Promise<void> {
		if (isUserMessage && this.activeTurns.has(conversationId)) {
			throw { kind: "conflict", reason: "turn_already_active" };
		}
		if (isUserMessage && !this.supervisor.isRunning) {
			throw { kind: "unavailable", reason: "companion_unavailable" };
		}
		const session = this.sessionResolver?.get(conversationId);
		const piSource = session?.getMessageEntry?.(messageId);
		// The UI may report a Host SQLite message id for a migrated user row;
		// the source entry was not rewritten in place, so resolve its current
		// Pi entry by the adopted content when the Pi entry ids are opaque.
		const resolvedPi =
			piSource ??
			(session
				? isUserMessage
					? this.findHostMessageEntry(conversationId, messageId, "user")
					: this.findHostMessageEntry(conversationId, messageId, "assistant")
				: undefined);
		const dbRole = this.db
			.select({ role: messages.role })
			.from(messages)
			.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
			.get();
		const role = resolvedPi?.message.role ?? dbRole?.role;
		if (!role) throw { kind: "not_found", reason: "message_not_found" };
		if (role !== "user" && role !== "assistant")
			throw { kind: "not_found", reason: "message_not_found" };
		const sourceText = resolvedPi ? assistantMessageText(resolvedPi.message) : undefined;
		const hostMessageId =
			resolvedPi && sourceText
				? (this.findHostMessageId(conversationId, role, sourceText) ??
					this.ensureHostMessage(conversationId, role, sourceText))
				: messageId;
		const newVersionId = randomUUID();
		try {
			this.db.transaction((transaction) => {
				if (isUserMessage) {
					// Editing a user message creates a new branch from this point
					const branchId = randomUUID();
					transaction
						.insert(branches)
						.values({
							id: branchId,
							conversationId,
							forkMessageId: hostMessageId,
							label: "edited",
							adopted: 1,
						})
						.run();
					transaction
						.update(branches)
						.set({ adopted: 0 })
						.where(and(eq(branches.conversationId, conversationId), ne(branches.id, branchId)))
						.run();
				}
				transaction
					.insert(messageVersions)
					.values({
						id: newVersionId,
						messageId: hostMessageId,
						content: text,
						editedByUser: 1,
						adopted: 1,
					})
					.run();
				transaction
					.update(messageVersions)
					.set({ adopted: 0 })
					.where(
						and(eq(messageVersions.messageId, hostMessageId), ne(messageVersions.id, newVersionId)),
					)
					.run();
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		if (session && resolvedPi) {
			if (isUserMessage) {
				session.branchBefore?.(resolvedPi.id);
				session.appendUserMessage?.(text);
			} else {
				session.branchBefore?.(resolvedPi.id);
				session.appendSyntheticAssistant?.(text);
			}
		}
		this.eventBus.publish("message.edited", {
			conversationId,
			messageId,
			versionId: newVersionId,
			editedByUser: true,
		});
		if (isUserMessage) {
			this.activeTurns.set(conversationId, { userMessageId: hostMessageId });
			this.supervisor.sendCommand({
				type: "prompt",
				conversationId,
				message: text,
				streamingBehavior: "followUp",
			});
		}
	}

	/** Continue the last assistant message. */
	async continue(conversationId: string): Promise<void> {
		if (!this.supervisor.isRunning) {
			throw { kind: "unavailable", reason: "companion_unavailable" };
		}
		if (this.activeTurns.has(conversationId)) {
			throw { kind: "conflict", reason: "turn_already_active" };
		}
		const userMessageId = this.latestTurnUserMessageId(conversationId);
		if (!userMessageId) throw { kind: "not_found", reason: "previous_turn_not_found" };
		this.activeTurns.set(conversationId, { userMessageId });
		this.supervisor.sendCommand({
			type: "prompt",
			conversationId,
			message: CONTINUE_INSTRUCTION,
		});
		this.eventBus.publish("message.continued", { conversationId });
	}

	/** Correct the response with a user-visible instruction and persist the revised turn. */
	async correct(
		conversationId: string,
		reason: string,
		applyScope: "once" | "session" | "always",
	): Promise<void> {
		if (!this.supervisor.isRunning) {
			throw { kind: "unavailable", reason: "companion_unavailable" };
		}
		if (this.activeTurns.has(conversationId)) {
			throw { kind: "conflict", reason: "turn_already_active" };
		}
		const userMessageId = this.latestTurnUserMessageId(conversationId);
		if (!userMessageId) throw { kind: "not_found", reason: "previous_turn_not_found" };
		this.db
			.insert(conversationDirectives)
			.values({ id: randomUUID(), conversationId, directive: reason, scope: applyScope })
			.run();
		this.activeTurns.set(conversationId, { userMessageId });
		this.supervisor.sendCommand({
			type: "prompt",
			conversationId,
			message: `用户刚刚指出上一条回复的问题：“${reason}”。请据此重写回应，直接给出修正后的内容，不要提及这条校正指令。`,
		});
		this.eventBus.publish("message.corrected", { conversationId, reason, applyScope });
	}

	/** Create a narrative branch at a specified message. */
	async branch(conversationId: string, messageId: string): Promise<string> {
		const branchId = randomUUID();
		const session = this.sessionResolver?.get(conversationId);
		const piSource = session?.getMessageEntry?.(messageId);
		// Resolve the Pi branch entry by adopted content when the caller passed
		// a Host SQLite message id; without a Pi session, fall back to the
		// legacy Host-only branch row.
		const resolvedPi =
			piSource ??
			(session
				? (this.findHostMessageEntry(conversationId, messageId, "assistant") ??
					this.findHostMessageEntry(conversationId, messageId, "user"))
				: undefined);
		const dbRole = this.db
			.select({ role: messages.role })
			.from(messages)
			.where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
			.get();
		const role = resolvedPi?.message.role ?? dbRole?.role;
		if (!role) throw { kind: "not_found", reason: "message_not_found" };
		if (role !== "user" && role !== "assistant")
			throw { kind: "not_found", reason: "message_not_found" };
		const sourceText = resolvedPi ? assistantMessageText(resolvedPi.message) : undefined;
		const hostMessageId =
			resolvedPi && sourceText
				? (this.findHostMessageId(conversationId, role, sourceText) ??
					this.ensureHostMessage(conversationId, role, sourceText))
				: messageId;
		try {
			this.db.transaction((transaction) => {
				transaction
					.insert(branches)
					.values({
						id: branchId,
						conversationId,
						forkMessageId: hostMessageId,
						label: "branch",
						adopted: 1,
					})
					.run();
				transaction
					.update(branches)
					.set({ adopted: 0 })
					.where(and(eq(branches.conversationId, conversationId), ne(branches.id, branchId)))
					.run();
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		if (resolvedPi && session?.selectBranch) session.selectBranch(resolvedPi.id);
		this.eventBus.publish("conversation.branched", { conversationId, messageId, branchId });
		return branchId;
	}

	/** True if a conversation has an active turn. */
	hasActiveTurn(conversationId: string): boolean {
		return this.activeTurns.has(conversationId);
	}
	private latestTurnUserMessageId(conversationId: string): string | undefined {
		return this.db
			.select({ userMessageId: turns.userMessageId })
			.from(turns)
			.where(and(eq(turns.conversationId, conversationId), eq(turns.status, "completed")))
			.orderBy(desc(turns.createdAt), desc(turns.id))
			.limit(1)
			.get()?.userMessageId;
	}

	/** Look up the minimal Host message row mirroring a Pi entry by role and text. */
	private findHostMessageId(
		conversationId: string,
		role: "user" | "assistant",
		content: string,
	): string | undefined {
		return this.db
			.select({ id: messages.id })
			.from(messages)
			.innerJoin(messageVersions, eq(messageVersions.messageId, messages.id))
			.where(
				and(
					eq(messages.conversationId, conversationId),
					eq(messages.role, role),
					eq(messageVersions.content, content),
					eq(messageVersions.adopted, 1),
				),
			)
			.orderBy(sql`messages.rowid desc`)
			.limit(1)
			.get()?.id;
	}

	/**
	 * Resolve the Pi branch entry standing in for a Host SQLite message id.
	 *
	 * The product UI reports Host message ids while the SessionManager tree is
	 * keyed by its own entry ids; the projection table never rewrites entries in
	 * place. When the caller did not pass a Pi entry id, locate the current
	 * entry whose adopted content is the given message's adopted version.
	 */
	private findHostMessageEntry(
		conversationId: string,
		messageId: string,
		role: "user" | "assistant",
	): { id: string; message: PiSessionMessage } | undefined {
		const version = this.db
			.select({ content: messageVersions.content })
			.from(messageVersions)
			.where(and(eq(messageVersions.messageId, messageId), eq(messageVersions.adopted, 1)))
			.limit(1)
			.get();
		if (version?.content === undefined) return undefined;
		const session = this.sessionResolver?.get(conversationId);
		return session?.findMessageEntry?.(role, version.content);
	}

	/** Materialize a minimal Host message row so Pi entry IDs never reach SQLite identifiers. */
	private ensureHostMessage(
		conversationId: string,
		role: "user" | "assistant",
		content: string,
	): string {
		const matches = this.db
			.select({ id: messages.id })
			.from(messages)
			.innerJoin(messageVersions, eq(messageVersions.messageId, messages.id))
			.where(
				and(
					eq(messages.conversationId, conversationId),
					eq(messages.role, role),
					eq(messageVersions.content, content),
				),
			)
			.orderBy(sql`messages.rowid desc`)
			.limit(1)
			.get()?.id;
		if (matches) return matches;
		const branch = this.db
			.select({ id: branches.id })
			.from(branches)
			.where(and(eq(branches.conversationId, conversationId), eq(branches.adopted, 1)))
			.orderBy(desc(branches.createdAt))
			.limit(1)
			.get();
		const branchId = branch?.id ?? conversationId;
		const messageId = randomUUID();
		const versionId = randomUUID();
		this.db.transaction((transaction) => {
			transaction.insert(messages).values({ id: messageId, conversationId, branchId, role }).run();
			transaction
				.insert(messageVersions)
				.values({ id: versionId, messageId, content, editedByUser: 0, adopted: 1 })
				.run();
		});
		return messageId;
	}

	private commitAssistantReply(payload: unknown): void {
		if (!payload || typeof payload !== "object" || !("conversationId" in payload)) return;
		const conversationId = payload.conversationId;
		if (typeof conversationId !== "string") return;
		const active = this.activeTurns.get(conversationId);
		if (!active) return;
		let text = "text" in payload && typeof payload.text === "string" ? payload.text.trim() : "";
		const failed = "failed" in payload && payload.failed === true;
		if (failed && !text) text = "这次回复没有完成。你可以稍后重试，或换一个模型服务。";
		const assistantMessageId = active.assistantMessageId ?? randomUUID();
		const piAssistant = "message" in payload ? asAssistantPiMessage(payload.message) : undefined;
		const assistantVersionId = active.assistantVersionId ?? randomUUID();
		const session = this.sessionResolver?.get(conversationId);
		if (session) projectAssistantEntry(session, piAssistant, text);

		const branch = this.db
			.select({ id: branches.id })
			.from(branches)
			.where(and(eq(branches.conversationId, conversationId), eq(branches.adopted, 1)))
			.orderBy(desc(branches.createdAt))
			.limit(1)
			.get();
		if (!branch) return;

		try {
			this.db.transaction((transaction) => {
				if (!active.assistantMessageId) {
					transaction
						.insert(messages)
						.values({
							id: assistantMessageId,
							conversationId,
							branchId: branch.id,
							role: "assistant",
						})
						.run();
					transaction
						.insert(messageVersions)
						.values({
							id: assistantVersionId,
							messageId: assistantMessageId,
							content: text,
							editedByUser: 0,
							adopted: 1,
						})
						.run();
				} else {
					transaction
						.update(messageVersions)
						.set({ content: text })
						.where(
							and(
								eq(messageVersions.id, assistantVersionId),
								eq(messageVersions.messageId, assistantMessageId),
							),
						)
						.run();
				}
				transaction
					.insert(turns)
					.values({
						id: randomUUID(),
						conversationId,
						userMessageId: active.userMessageId,
						assistantMessageId,
						status: failed ? "failed" : "completed",
					})
					.run();
				transaction
					.update(conversations)
					.set({ updatedAt: new Date().toISOString() })
					.where(eq(conversations.id, conversationId))
					.run();
			});
		} catch (error) {
			this.activeTurns.delete(conversationId);
			throw error;
		}
		this.activeTurns.delete(conversationId);
		this.eventBus.publish("message.assistant_committed", {
			conversationId,
			messageId: assistantMessageId,
			versionId: assistantVersionId,
			failed,
		});
	}
}

function isAssistantLeaf(value: unknown, text?: string): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; message?: unknown };
	if (candidate.type !== "message" || !isAssistantMessage(candidate.message)) return false;
	return text === undefined || assistantMessageText(candidate.message) === text;
}

function isAssistantMessage(value: unknown): value is PiSessionMessage {
	return Boolean(
		value && typeof value === "object" && "role" in value && value.role === "assistant",
	);
}

function assistantMessageText(message: PiSessionMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			),
		)
		.map((part) => part.text)
		.join("")
		.trim();
}

function projectAssistantEntry(
	session: TurnPipelineSessionAppender,
	message: PiSessionMessage | undefined,
	text: string,
): void {
	if (isAssistantLeaf(session.currentLeaf, text)) return;
	const existing = session.findMessageEntry?.("assistant", text, { branchOnly: true });
	if (existing && !session.currentLeaf) {
		session.selectBranch?.(existing.id);
		return;
	}
	if (!message) return;
	const entryId = session.appendMessage(message);
	session.selectBranch?.(entryId);
}

function asAssistantPiMessage(value: unknown): PiSessionMessage | undefined {
	if (!value || typeof value !== "object" || !("role" in value) || value.role !== "assistant") {
		return undefined;
	}
	return value as PiSessionMessage;
}
