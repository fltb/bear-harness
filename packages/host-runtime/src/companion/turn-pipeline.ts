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
import type { CompanionSupervisor } from "./supervisor.js";

export interface TurnResult {
	messageId: string;
	versionId: string;
	status: "completed" | "failed" | "aborted";
}

export class TurnPipeline {
	private db: AppDatabase;
	private supervisor: CompanionSupervisor;
	private eventBus: EventBus;
	private activeTurns = new Map<
		string,
		{ userMessageId: string; assistantMessageId?: string; assistantVersionId?: string }
	>();
	private readonly unsubscribe: () => void;

	constructor(db: AppDatabase, supervisor: CompanionSupervisor, eventBus: EventBus) {
		this.db = db;
		this.supervisor = supervisor;
		this.eventBus = eventBus;
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
					.set({ updatedAt: sql`datetime('now')` })
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
		// Locate the user parent (the message before the assistant message)
		const row = this.db
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
		const parent = this.db
			.select({ id: turns.userMessageId })
			.from(turns)
			.where(and(eq(turns.conversationId, conversationId), eq(turns.assistantMessageId, messageId)))
			.orderBy(desc(turns.createdAt))
			.limit(1)
			.get();
		const userParent = parent;
		if (!userParent) throw { kind: "not_found", reason: "parent_message_not_found" };

		// Create a sibling assistant version, then actually ask the model again.
		const newVersionId = randomUUID();
		this.db.transaction((transaction) => {
			transaction
				.update(messageVersions)
				.set({ adopted: 0 })
				.where(eq(messageVersions.messageId, messageId))
				.run();
			transaction
				.insert(messageVersions)
				.values({ id: newVersionId, messageId, content: "", editedByUser: 0, adopted: 1 })
				.run();
		});

		this.eventBus.publish("message.regenerated", {
			conversationId,
			messageId,
			versionId: newVersionId,
		});
		this.activeTurns.set(conversationId, {
			userMessageId: userParent.id,
			assistantMessageId: messageId,
			assistantVersionId: newVersionId,
		});
		const parentText = this.db
			.select({ content: messageVersions.content })
			.from(messageVersions)
			.where(and(eq(messageVersions.messageId, userParent.id), eq(messageVersions.adopted, 1)))
			.orderBy(desc(messageVersions.createdAt))
			.limit(1)
			.get();
		this.supervisor.sendCommand({
			type: "prompt",
			conversationId,
			message: parentText?.content ?? "请重新回答上一条消息。",
		});
		return { messageId, versionId: newVersionId, status: "completed" };
	}

	/** Switch the adopted version of a message (no model call). */
	async switchVersion(conversationId: string, messageId: string, versionId: string): Promise<void> {
		const exists = this.db
			.select({ id: messageVersions.id })
			.from(messageVersions)
			.where(and(eq(messageVersions.id, versionId), eq(messageVersions.messageId, messageId)))
			.get();
		if (!exists) throw { kind: "not_found", reason: "version_not_found" };

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
							forkMessageId: messageId,
							label: "edited",
							adopted: 1,
						})
						.run();
					transaction
						.update(branches)
						.set({ adopted: 0 })
						.where(and(eq(branches.conversationId, conversationId), ne(branches.id, branchId)))
						.run();
					transaction
						.insert(messageVersions)
						.values({ id: newVersionId, messageId, content: text, editedByUser: 1, adopted: 1 })
						.run();
					transaction
						.update(messageVersions)
						.set({ adopted: 0 })
						.where(
							and(eq(messageVersions.messageId, messageId), ne(messageVersions.id, newVersionId)),
						)
						.run();
				} else {
					transaction
						.insert(messageVersions)
						.values({ id: newVersionId, messageId, content: text, editedByUser: 1, adopted: 1 })
						.run();
					transaction
						.update(messageVersions)
						.set({ adopted: 0 })
						.where(
							and(eq(messageVersions.messageId, messageId), ne(messageVersions.id, newVersionId)),
						)
						.run();
				}
			});
		} catch (e) {
			throw { kind: "internal", reason: (e as Error)?.message ?? String(e) };
		}
		this.eventBus.publish("message.edited", {
			conversationId,
			messageId,
			versionId: newVersionId,
			editedByUser: true,
		});
		if (isUserMessage) {
			this.activeTurns.set(conversationId, { userMessageId: messageId });
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
		this.supervisor.sendCommand({ type: "prompt", conversationId, message: "[继续]" });
		this.eventBus.publish("message.continued", { conversationId });
	}

	/** Correct: apply a non-narrative correction at the last stable context pack. */
	async correct(
		conversationId: string,
		reason: string,
		applyScope: "once" | "session" | "always",
	): Promise<void> {
		this.db
			.insert(conversationDirectives)
			.values({ id: randomUUID(), conversationId, directive: reason, scope: applyScope })
			.run();
		if (this.supervisor.isRunning) {
			this.supervisor.sendCommand({ type: "prompt", conversationId, message: reason });
		}
		this.eventBus.publish("message.corrected", { conversationId, reason, applyScope });
	}

	/** Create a narrative branch at a specified message. */
	async branch(conversationId: string, messageId: string): Promise<string> {
		const branchId = randomUUID();
		try {
			this.db.transaction((transaction) => {
				transaction
					.insert(branches)
					.values({
						id: branchId,
						conversationId,
						forkMessageId: messageId,
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
		this.eventBus.publish("conversation.branched", { conversationId, messageId, branchId });
		return branchId;
	}

	/** True if a conversation has an active turn. */
	hasActiveTurn(conversationId: string): boolean {
		return this.activeTurns.has(conversationId);
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
		const assistantVersionId = active.assistantVersionId ?? randomUUID();
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
					.set({ updatedAt: sql`datetime('now')` })
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
