import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { conversationDirectives } from "../storage/schema.js";
import type { CompanionSupervisor, PiSessionHandle } from "./supervisor.js";

type PromptImages = NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"];
type NativeEntry = ReturnType<PiSessionHandle["sessionManager"]["getEntry"]>;

type CommandError = { kind: string; reason: string };

/** The accepted send receipt. The transcript itself is owned by Pi. */
export interface TurnResult {
	accepted: true;
	sessionId: string;
}

/**
 * Kept as a source-compatible constructor option for the capture pipeline.
 * TurnPipeline no longer invokes it: assistant/user text must be read from
 * the native Pi projection by downstream consumers.
 */
export interface TurnCommittedSink {
	onTurnCommitted?: (turn: {
		conversationId: string;
		userText: string;
		assistantText: string;
		startedAt?: number;
	}) => void;
}

const CORRECT_PREFIX = "用户刚刚指出上一条回复的问题：";
const NOTIFY_REASONS = ["message", "turn", "agent", "tool", "compaction", "queue"] as const;
type NotifyReason = (typeof NOTIFY_REASONS)[number];

function commandError(kind: string, reason: string): never {
	throw { kind, reason } satisfies CommandError;
}

function isMessageEntry(entry: NativeEntry): entry is Extract<NonNullable<NativeEntry>, { type: "message" }> {
	return Boolean(entry && entry.type === "message" && entry.message && typeof entry.message === "object");
}

function entryRole(entry: NativeEntry): string | undefined {
	if (!isMessageEntry(entry)) return undefined;
	return "role" in entry.message && typeof entry.message.role === "string" ? entry.message.role : undefined;
}

/**
 * PiSessionCommands is the Host authorization adapter for message commands.
 * SessionManager/AgentSession are the only transcript and branch authorities;
 * this class deliberately has no message, version, branch, or turn writes.
 */
export class TurnPipeline {
	private readonly db: AppDatabase;
	private readonly supervisor: CompanionSupervisor;
	private readonly eventBus: EventBus;
	private readonly subscriptions = new Map<string, () => void>();
	private readonly pendingNotifications = new Map<string, Set<NotifyReason>>();
	private readonly notificationTasks = new Set<string>();

	// The database is used only for durable product directives; transcript,
	// branch, version, and turn tables are never touched by this adapter.
	constructor(
		db: AppDatabase,
		supervisor: CompanionSupervisor,
		eventBus: EventBus,
		_sessionResolver?: unknown,
		_sink?: TurnCommittedSink,
	) {
		this.db = db;
		this.supervisor = supervisor;
		this.eventBus = eventBus;
	}

	dispose(): void {
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		this.pendingNotifications.clear();
		this.notificationTasks.clear();
	}

	/** Send text through the long-lived AgentSession and return its preflight receipt. */
	async sendUserMessage(
		conversationId: string,
		text: string,
		attachments: Array<{ name: string; mime: string; base64: string }> = [],
	): Promise<TurnResult> {
		if (!this.supervisor.isRunning) commandError("unavailable", "companion_unavailable");
		const session = await this.ensureSession(conversationId);
		this.rejectIfStreaming(session);
		if (!(await this.supervisor.selectModelForConversation(conversationId, session))) {
			commandError("unavailable", "provider_auth_required");
		}
		this.ensureSessionNotifications(conversationId, session);

		const images = attachments.map((attachment) => ({
			type: "image" as const,
			data: attachment.base64,
			mimeType: attachment.mime,
		}));
		// Host owns model/context/image injection; Pi owns every resulting
		// native entry. The route was authenticated above, so dispatch is
		// accepted and later Pi failures arrive through its live projection.
		this.supervisor.promptConversation(
			conversationId,
			text,
			images.length > 0 ? (images as PromptImages) : undefined,
		);
		this.publishChanged(conversationId, session, "message");
		return { accepted: true, sessionId: session.sessionId };
	}

	/** Abort is idempotent and never creates a missing live session. */
	async abort(conversationId: string): Promise<void> {
		const session = this.liveSession(conversationId);
		if (!session || session.isIdle) return;
		await session.abort();
	}

	/** Regenerate an assistant entry by branching before its native entry. */
	async regenerate(conversationId: string, entryId: string): Promise<void> {
		const session = this.commandSession(conversationId);
		this.rejectIfStreaming(session);
		const entry = this.requireCurrentEntry(session, entryId);
		if (entryRole(entry) !== "assistant") commandError("invalid_request", "message_regenerate_assistant_only");
		this.branchBefore(session, entryId);
		session.reloadFromSessionManager();
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
		this.runInBackground(session.continue(), "Pi regenerate failed");
	}

	/** Select a native Pi leaf; no model call is made. */
	async switchVersion(conversationId: string, leafId: string): Promise<void> {
		const session = this.commandSession(conversationId);
		this.rejectIfStreaming(session);
		this.requireEntry(session, leafId);
		session.sessionManager.branch(leafId);
		session.reloadFromSessionManager();
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
	}

	/** Edit is deliberately user-only and uses AgentSession.navigateTree(). */
	async edit(conversationId: string, entryId: string, text: string, _isUserMessage = true): Promise<void> {
		const session = this.commandSession(conversationId);
		this.rejectIfStreaming(session);
		const entry = this.requireCurrentEntry(session, entryId);
		if (entryRole(entry) !== "user") commandError("invalid_request", "message_edit_user_only");
		const result = await session.agentSession.navigateTree(entryId, { summarize: false });
		if (result.cancelled || result.editorText === undefined) {
			commandError("invalid_request", "message_edit_user_only");
		}
		// The RPC text is the authoritative edited value; navigateTree's editorText
		// is required by the public API to establish the native user branch.
		const editedText = text || result.editorText;
		session.reloadFromSessionManager();
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
		this.runInBackground(session.agentSession.sendUserMessage(editedText), "Pi edit failed");
	}

	/** Continue via the same Agent core; no second AgentSession is created. */
	async continue(conversationId: string): Promise<void> {
		const session = this.commandSession(conversationId);
		this.rejectIfStreaming(session);
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
		this.runInBackground(session.continue(), "Pi continue failed");
	}

	/** Persist a product directive, then send the correction through Pi. */
	async correct(
		conversationId: string,
		reason: string,
		applyScope: "once" | "session" | "always",
	): Promise<void> {
		const session = this.commandSession(conversationId);
		this.rejectIfStreaming(session);
		this.db.insert(conversationDirectives).values({
			id: randomUUID(),
			conversationId,
			directive: reason,
			scope: applyScope,
		}).run();
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
		const instruction = `${CORRECT_PREFIX}“${reason}”。请据此重写回应，直接给出修正后的内容，不要提及这条校正指令。`;
		this.runInBackground(session.agentSession.sendUserMessage(instruction), "Pi correction failed");
	}

	/** Create/select a native branch and return its native leaf ID. */
	async branch(conversationId: string, entryId: string): Promise<{ leafId: string }> {
		const session = this.commandSession(conversationId);
		this.rejectIfStreaming(session);
		this.requireCurrentEntry(session, entryId);
		session.sessionManager.branch(entryId);
		session.reloadFromSessionManager();
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
		const leafId = session.sessionManager.getLeafId();
		if (!leafId) commandError("internal", "pi_branch_leaf_missing");
		return { leafId };
	}

	hasActiveTurn(conversationId: string): boolean {
		const session = this.liveSession(conversationId);
		return Boolean(session && (session.isStreaming || session.agentSession.pendingMessageCount > 0));
	}


	private async ensureSession(conversationId: string): Promise<PiSessionHandle> {
		try {
			return await this.supervisor.ensureSession(conversationId);
		} catch {
			commandError("unavailable", "conversation_pi_session_missing");
		}
	}

	private liveSession(conversationId: string): PiSessionHandle | undefined {
		return this.supervisor.getLiveSessionResolver().get(conversationId);
	}

	private commandSession(conversationId: string): PiSessionHandle {
		const session = this.liveSession(conversationId);
		if (!session) commandError("unavailable", "conversation_pi_session_missing");
		return session;
	}

	private rejectIfStreaming(session: PiSessionHandle): void {
		if (session.isStreaming || session.agentSession.pendingMessageCount > 0) {
			commandError("conflict", "session_streaming");
		}
	}

	private requireEntry(session: PiSessionHandle, entryId: string): NonNullable<NativeEntry> {
		const entry = session.sessionManager.getEntry(entryId);
		if (!entry) commandError("not_found", "message_entry_not_found");
		return entry;
	}

	private requireCurrentEntry(session: PiSessionHandle, entryId: string): NonNullable<NativeEntry> {
		const entry = this.requireEntry(session, entryId);
		if (!session.sessionManager.getBranch().some((candidate) => candidate.id === entryId)) {
			commandError("conflict", "message_not_current_branch");
		}
		return entry;
	}

	private branchBefore(session: PiSessionHandle, entryId: string): void {
		const branch = session.sessionManager.getBranch(entryId);
		if (branch.length === 0 || branch.at(-1)?.id !== entryId) {
			commandError("conflict", "message_not_current_branch");
		}
		const parent = branch.at(-2);
		if (parent) session.sessionManager.branch(parent.id);
		else session.sessionManager.resetLeaf();
	}

	private runInBackground(task: Promise<void>, label: string): void {
		void task.catch((error) => console.warn(label, error));
	}

	private ensureSessionNotifications(conversationId: string, session: PiSessionHandle): void {
		if (this.subscriptions.has(conversationId)) return;
		const unsubscribe = session.subscribe((event) => {
			const reason = eventReason(event.type);
			if (reason) this.scheduleChanged(conversationId, session.sessionId, reason);
		});
		this.subscriptions.set(conversationId, unsubscribe);
	}

	private scheduleChanged(conversationId: string, sessionId: string, reason: NotifyReason): void {
		const pending = this.pendingNotifications.get(conversationId) ?? new Set<NotifyReason>();
		pending.add(reason);
		this.pendingNotifications.set(conversationId, pending);
		if (this.notificationTasks.has(conversationId)) return;
		this.notificationTasks.add(conversationId);
		queueMicrotask(() => {
			this.notificationTasks.delete(conversationId);
			const reasons = this.pendingNotifications.get(conversationId);
			this.pendingNotifications.delete(conversationId);
			if (!reasons || reasons.size === 0) return;
			const selected = NOTIFY_REASONS.find((candidate) => reasons.has(candidate)) ?? "message";
			this.eventBus.publish("pi.session.changed", { conversationId, sessionId, reason: selected });
		});
	}

	private publishChanged(conversationId: string, session: PiSessionHandle, reason: NotifyReason): void {
		this.scheduleChanged(conversationId, session.sessionId, reason);
	}
}

function eventReason(type: string): NotifyReason | undefined {
	if (type === "entry_appended" || type.startsWith("message_")) return "message";
	if (type.startsWith("turn_")) return "turn";
	if (type.startsWith("agent_")) return "agent";
	if (type.startsWith("tool_execution_")) return "tool";
	if (type.startsWith("compaction_") || type.startsWith("summarization_")) return "compaction";
	if (type === "queue_update") return "queue";
	return undefined;
}
