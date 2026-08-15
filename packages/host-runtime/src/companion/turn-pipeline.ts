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
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";
import type { CompanionSupervisor } from "./supervisor.js";

export interface TurnResult {
	messageId: string;
	versionId: string;
	status: "completed" | "failed" | "aborted";
}

export class TurnPipeline {
	private db: DatabaseSync;
	private supervisor: CompanionSupervisor;
	private eventBus: EventBus;
	private activeTurns = new Map<
		string,
		{ userMessageId: string; assistantMessageId?: string; assistantVersionId?: string }
	>();
	private readonly unsubscribe: () => void;

	constructor(db: DatabaseSync, supervisor: CompanionSupervisor, eventBus: EventBus) {
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
	async sendUserMessage(conversationId: string, text: string): Promise<TurnResult> {
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
			.prepare(
				"SELECT id FROM branches WHERE conversation_id = ? AND adopted = 1 ORDER BY created_at DESC LIMIT 1",
			)
			.get(conversationId) as { id: string } | undefined;
		const branchId = branchRow?.id ?? conversationId;

		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					"INSERT INTO messages (id, conversation_id, branch_id, role) VALUES (?, ?, ?, 'user')",
				)
				.run(messageId, conversationId, branchId);
			this.db
				.prepare(
					"INSERT INTO message_versions (id, message_id, content, edited_by_user, adopted) VALUES (?, ?, ?, 0, 1)",
				)
				.run(versionId, messageId, text);
			this.db
				.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
				.run(conversationId);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
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
			.prepare("SELECT id, role FROM messages WHERE id = ? AND conversation_id = ?")
			.get(messageId, conversationId) as { id: string; role: string } | undefined;
		if (!row) throw { kind: "not_found", reason: "message_not_found" };

		if (this.activeTurns.has(conversationId)) {
			throw { kind: "conflict", reason: "turn_already_active" };
		}
		if (row.role !== "assistant") {
			throw { kind: "conflict", reason: "assistant_message_required" };
		}
		const parent = this.db
			.prepare(
				`SELECT user_message_id AS id
				 FROM turns
				 WHERE conversation_id = ? AND assistant_message_id = ?
				 ORDER BY rowid DESC LIMIT 1`,
			)
			.get(conversationId, messageId) as { id: string } | undefined;
		const legacyParent = parent
			? undefined
			: (this.db
					.prepare(
						`SELECT parent.id
						 FROM messages AS parent
						 JOIN messages AS assistant ON assistant.id = ?
						 WHERE parent.conversation_id = ?
						   AND parent.role = 'user'
						   AND parent.rowid < assistant.rowid
						 ORDER BY parent.rowid DESC LIMIT 1`,
					)
					.get(messageId, conversationId) as { id: string } | undefined);
		const userParent = parent ?? legacyParent;
		if (!userParent) throw { kind: "not_found", reason: "parent_message_not_found" };

		// Create a sibling assistant version, then actually ask the model again.
		const newVersionId = randomUUID();
		this.db.prepare("UPDATE message_versions SET adopted = 0 WHERE message_id = ?").run(messageId);
		this.db
			.prepare(
				"INSERT INTO message_versions (id, message_id, content, edited_by_user, adopted) VALUES (?, ?, '', 0, 1)",
			)
			.run(newVersionId, messageId);

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
			.prepare(
				"SELECT content FROM message_versions WHERE message_id = ? AND adopted = 1 ORDER BY created_at DESC LIMIT 1",
			)
			.get(userParent.id) as { content: string } | undefined;
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
			.prepare("SELECT id FROM message_versions WHERE id = ? AND message_id = ?")
			.get(versionId, messageId);
		if (!exists) throw { kind: "not_found", reason: "version_not_found" };

		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("UPDATE message_versions SET adopted = 0 WHERE message_id = ?")
				.run(messageId);
			this.db.prepare("UPDATE message_versions SET adopted = 1 WHERE id = ?").run(versionId);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
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
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (isUserMessage) {
				// Editing a user message creates a new branch from this point
				const branchId = randomUUID();
				this.db
					.prepare(
						"INSERT INTO branches (id, conversation_id, parent_branch_id, fork_message_id, label, adopted) VALUES (?, ?, NULL, ?, 'edited', 1)",
					)
					.run(branchId, conversationId, messageId);
				this.db
					.prepare("UPDATE branches SET adopted = 0 WHERE conversation_id = ? AND id != ?")
					.run(conversationId, branchId);
				this.db
					.prepare(
						"INSERT INTO message_versions (id, message_id, content, edited_by_user, adopted) VALUES (?, ?, ?, 1, 1)",
					)
					.run(newVersionId, messageId, text);
				this.db
					.prepare("UPDATE message_versions SET adopted = 0 WHERE message_id = ? AND id != ?")
					.run(messageId, newVersionId);
			} else {
				this.db
					.prepare(
						"INSERT INTO message_versions (id, message_id, content, edited_by_user, adopted) VALUES (?, ?, ?, 1, 1)",
					)
					.run(newVersionId, messageId, text);
				this.db
					.prepare("UPDATE message_versions SET adopted = 0 WHERE message_id = ? AND id != ?")
					.run(messageId, newVersionId);
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
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
			.prepare(
				"INSERT INTO conversation_directives (id, conversation_id, directive, scope) VALUES (?, ?, ?, ?)",
			)
			.run(randomUUID(), conversationId, reason, applyScope);
		if (this.supervisor.isRunning) {
			this.supervisor.sendCommand({ type: "prompt", conversationId, message: reason });
		}
		this.eventBus.publish("message.corrected", { conversationId, reason, applyScope });
	}

	/** Create a narrative branch at a specified message. */
	async branch(conversationId: string, messageId: string): Promise<string> {
		const branchId = randomUUID();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					"INSERT INTO branches (id, conversation_id, parent_branch_id, fork_message_id, label, adopted) VALUES (?, ?, NULL, ?, 'branch', 1)",
				)
				.run(branchId, conversationId, messageId);
			this.db
				.prepare("UPDATE branches SET adopted = 0 WHERE conversation_id = ? AND id != ?")
				.run(conversationId, branchId);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
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
			.prepare(
				"SELECT id FROM branches WHERE conversation_id = ? AND adopted = 1 ORDER BY created_at DESC LIMIT 1",
			)
			.get(conversationId) as { id: string } | undefined;
		if (!branch) return;

		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!active.assistantMessageId) {
				this.db
					.prepare(
						"INSERT INTO messages (id, conversation_id, branch_id, role) VALUES (?, ?, ?, 'assistant')",
					)
					.run(assistantMessageId, conversationId, branch.id);
				this.db
					.prepare(
						"INSERT INTO message_versions (id, message_id, content, edited_by_user, adopted) VALUES (?, ?, ?, 0, 1)",
					)
					.run(assistantVersionId, assistantMessageId, text);
			} else {
				this.db
					.prepare("UPDATE message_versions SET content = ? WHERE id = ? AND message_id = ?")
					.run(text, assistantVersionId, assistantMessageId);
			}
			this.db
				.prepare(
					"INSERT INTO turns (id, conversation_id, user_message_id, assistant_message_id, status) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					randomUUID(),
					conversationId,
					active.userMessageId,
					assistantMessageId,
					failed ? "failed" : "completed",
				);
			this.db
				.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
				.run(conversationId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
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
