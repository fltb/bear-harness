import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import {
	type PendingTurnImage,
	type PendingTurnRecord,
	PendingTurnStore,
} from "./pending-turn-store.js";
import type { CompanionSupervisor, PiSessionHandle } from "./supervisor.js";

type PromptImages = NonNullable<Parameters<AgentSession["prompt"]>[1]>["images"];
type NativeEntry = ReturnType<PiSessionHandle["sessionManager"]["getEntry"]>;

type CommandError = { kind: string; reason: string };

/** The accepted send receipt. The transcript itself is owned by Pi. */
export interface TurnResult {
	accepted: true;
	sessionId: string;
	entryId: string;
}

export interface PendingTurnSendOptions {
	attachmentIds?: readonly string[];
	attachmentSendNonce?: string;
	onAccepted?: (turnId: string) => void;
}

export interface TurnPipelineOptions {
	pendingTurns?: PendingTurnStore;
	finishAttachmentSend?: (conversationId: string, nonce: string, nativeUserEntryId: string) => void;
	onCorrectedTurn?: (turn: {
		conversationId: string;
		userText: string;
		assistantText: string;
		correction: string;
	}) => Promise<void>;
}

export interface ExternalAgentFollowUp {
	entryId: string;
	text: string;
}
export interface TurnReconciliationOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
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

const NOTIFY_REASONS = ["message", "turn", "agent", "tool", "compaction", "queue"] as const;
type NotifyReason = (typeof NOTIFY_REASONS)[number];
const DEFAULT_RECONCILIATION_TIMEOUT_MS = 15_000;

function commandError(kind: string, reason: string): never {
	throw { kind, reason } satisfies CommandError;
}

function isMessageEntry(
	entry: NativeEntry,
): entry is Extract<NonNullable<NativeEntry>, { type: "message" }> {
	return Boolean(
		entry && entry.type === "message" && entry.message && typeof entry.message === "object",
	);
}

function entryRole(entry: NativeEntry): string | undefined {
	if (!isMessageEntry(entry)) return undefined;
	return "role" in entry.message && typeof entry.message.role === "string"
		? entry.message.role
		: undefined;
}

/**
 * PiSessionCommands is the Host authorization adapter for message commands.
 * SessionManager/AgentSession are the only transcript and branch authorities;
 * this class deliberately has no message, version, branch, or turn writes.
 */
export class TurnPipeline {
	private readonly supervisor: CompanionSupervisor;
	private readonly eventBus: EventBus;
	private readonly subscriptions = new Map<string, () => void>();
	private readonly pendingNotifications = new Map<string, Set<NotifyReason>>();
	private readonly notificationTasks = new Set<string>();
	private readonly pendingTurns: PendingTurnStore;
	private readonly finishAttachmentSend?: TurnPipelineOptions["finishAttachmentSend"];
	private readonly onCorrectedTurn?: TurnPipelineOptions["onCorrectedTurn"];
	private readonly reconciliationTasks = new Map<string, Promise<void>>();
	private disposed = false;

	// The database is used only for durable product directives; transcript,
	// branch, version, and turn tables are never touched by this adapter.
	constructor(
		_db: AppDatabase,
		supervisor: CompanionSupervisor,
		eventBus: EventBus,
		options: TurnPipelineOptions = {},
	) {
		this.supervisor = supervisor;
		this.eventBus = eventBus;
		this.pendingTurns = options.pendingTurns ?? new PendingTurnStore(_db);
		this.finishAttachmentSend = options.finishAttachmentSend;
		this.onCorrectedTurn = options.onCorrectedTurn;
	}

	dispose(): void {
		this.disposed = true;
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		this.pendingNotifications.clear();
		this.notificationTasks.clear();
		this.reconciliationTasks.clear();
	}

	/** Send through Pi and acknowledge only after its native user entry exists. */
	async sendUserMessage(
		conversationId: string,
		text: string,
		currentMessageImages: Array<{
			attachmentId: string;
			data: Buffer;
			mimeType: string;
		}> = [],
		options: PendingTurnSendOptions = {},
	): Promise<TurnResult> {
		if (!this.supervisor.isRunning) commandError("unavailable", "companion_unavailable");
		const session = await this.ensureSession(conversationId);
		this.rejectIfStreaming(session);
		if (!(await this.supervisor.selectModelForConversation(conversationId, session))) {
			commandError("unavailable", "provider_auth_required");
		}
		this.ensureSessionNotifications(conversationId, session);
		const images: PendingTurnImage[] = currentMessageImages.map((image) => ({
			attachmentId: image.attachmentId,
			data: Buffer.from(image.data),
			mimeType: image.mimeType,
		}));
		const turn = this.pendingTurns.createAccepted({
			id: randomUUID(),
			conversationId,
			framedText: text,
			images,
			attachmentIds: options.attachmentIds ?? [],
			attachmentSendNonce: options.attachmentSendNonce,
		});
		options.onAccepted?.(turn.id);

		try {
			const dispatched = await this.dispatchPendingTurn(session, turn);
			this.publishChanged(conversationId, session, "message");
			return { accepted: true, sessionId: session.sessionId, entryId: dispatched.entryId };
		} catch (error) {
			this.recordPendingError(turn, error);
			throw error;
		}
	}

	/**
	 * Reconcile the durable Host outbox after Pi is locally ready. Failures are
	 * retained on the pending record so startup stays available and a later
	 * restart can retry.
	 */
	async reconcilePendingTurns(options: TurnReconciliationOptions = {}): Promise<void> {
		const attempt = {
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS,
		};
		for (const pending of this.pendingTurns.listIncomplete()) {
			if (this.disposed || attempt.signal?.aborted) return;
			try {
				const session = await waitForTurnReconciliation(
					this.supervisor.ensureSession(pending.conversationId),
					attempt,
				);
				this.ensureSessionNotifications(pending.conversationId, session);
				let current = this.reconcileNativeTurn(session, pending);
				if (current.state === "completed") continue;
				this.rejectIfStreaming(session);
				if (
					!(await waitForTurnReconciliation(
						this.supervisor.selectModelForConversation(pending.conversationId, session),
						attempt,
					))
				) {
					throw new Error("provider_auth_required");
				}

				if (current.state === "accepted" || current.state === "dispatched") {
					const dispatched = await this.dispatchPendingTurn(session, current, attempt);
					current = this.pendingTurns.get(current.conversationId, current.id) ?? current;
					if (dispatched.prompted) {
						const assistant = waitForNativeAssistant(session, dispatched.entryId);
						try {
							await waitForTurnReconciliation(assistant.promise, attempt);
						} finally {
							assistant.cancel();
						}
						this.reconcileNativeTurn(session, current);
						continue;
					}
				}

				current = this.reconcileNativeTurn(session, current);
				if (current.state !== "user_persisted" || !current.piEntryId) continue;
				if (findNativeAssistant(session, current.piEntryId)) {
					this.reconcileNativeTurn(session, current);
					continue;
				}
				const nativeUser = session.sessionManager.getEntry(current.piEntryId);
				if (entryRole(nativeUser) !== "user") {
					throw new Error("pending_turn_native_user_missing");
				}
				session.sessionManager.branch(current.piEntryId);
				session.reloadFromSessionManager();
				const assistant = waitForNativeAssistant(session, current.piEntryId);
				try {
					await waitForTurnReconciliation(session.continue(), attempt);
					await waitForTurnReconciliation(assistant.promise, attempt);
				} finally {
					assistant.cancel();
				}
				current = this.reconcileNativeTurn(session, current);
				if (current.state !== "completed") {
					throw new Error("pending_turn_native_assistant_missing");
				}
			} catch (error) {
				if (!this.disposed) this.recordPendingError(pending, error);
			}
		}
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
		if (entryRole(entry) !== "assistant")
			commandError("invalid_request", "message_regenerate_assistant_only");
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
	async edit(
		conversationId: string,
		entryId: string,
		text: string,
		_isUserMessage = true,
	): Promise<void> {
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
		const last = session.state.messages.at(-1);
		if (!last || last.role === "assistant") {
			commandError("conflict", "message_continue_requires_pending_input");
		}
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
		this.runInBackground(session.continue(), "Pi continue failed");
	}

	/** Replace one assistant answer using a role-package-owned hidden correction prompt. */
	async correct(conversationId: string, entryId: string, instruction: string): Promise<void> {
		const session = this.commandSession(conversationId);
		this.rejectIfStreaming(session);
		const rejected = this.requireCurrentEntry(session, entryId);
		if (entryRole(rejected) !== "assistant")
			commandError("invalid_request", "message_correct_assistant_only");
		const parentUser = session.sessionManager
			.getBranch(entryId)
			.slice(0, -1)
			.reverse()
			.find((entry) => entryRole(entry) === "user");
		if (!parentUser) commandError("conflict", "message_correct_user_context_missing");
		this.branchBefore(session, entryId);
		session.sessionManager.appendCustomMessageEntry("bear_correction", instruction, false, {
			rejectedEntryId: entryId,
		});
		session.reloadFromSessionManager();
		this.ensureSessionNotifications(conversationId, session);
		this.publishChanged(conversationId, session, "message");
		const correctionEntryId = session.sessionManager.getLeafId();
		if (!correctionEntryId) commandError("internal", "correction_entry_missing");
		const corrected = waitForNativeAssistant(session, correctionEntryId);
		this.runInBackground(
			(async () => {
				try {
					await session.continue();
					await corrected.promise;
				} catch (error) {
					session.sessionManager.branch(entryId);
					session.reloadFromSessionManager();
					this.publishChanged(conversationId, session, "message");
					throw error;
				} finally {
					corrected.cancel();
				}
				const assistant = findNativeAssistant(session, correctionEntryId);
				if (!assistant || !this.onCorrectedTurn) return;
				try {
					await this.onCorrectedTurn({
						conversationId,
						userText: nativeMessageText(parentUser),
						assistantText: nativeMessageText(assistant),
						correction: instruction,
					});
				} catch (error) {
					console.warn("Automatic memory capture after correction failed", error);
				}
			})(),
			"Pi correction failed",
		);
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
		return Boolean(
			session && (session.isStreaming || session.agentSession.pendingMessageCount > 0),
		);
	}

	/**
	 * Deliver one hidden, Host-owned external-agent result to the active role
	 * session and return the native assistant entry produced for it.
	 *
	 * The run id in custom-message details is the durable idempotency key. A
	 * restart after Pi persisted the custom message therefore continues that
	 * turn instead of appending a second result notification.
	 */
	async deliverExternalAgentResult(
		conversationId: string,
		runId: string,
		content: string,
		options: TurnReconciliationOptions = {},
	): Promise<ExternalAgentFollowUp> {
		if (!this.supervisor.isRunning) commandError("unavailable", "companion_unavailable");
		const attempt = {
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS,
		};
		const session = await waitForTurnReconciliation(
			this.supervisor.ensureSession(conversationId),
			attempt,
		);
		const existing = externalAgentFollowUp(session, runId);
		if (existing) return existing;
		if (
			!(await waitForTurnReconciliation(
				this.supervisor.selectModelForConversation(conversationId, session),
				attempt,
			))
		) {
			commandError("unavailable", "provider_auth_required");
		}
		this.ensureSessionNotifications(conversationId, session);

		const hasNotification = session.sessionManager
			.getEntries()
			.some((entry) => isExternalAgentNotification(entry, runId));
		const completion = waitForExternalAgentFollowUp(session, runId);
		try {
			if (hasNotification) {
				await waitForTurnReconciliation(session.continue(), attempt);
			} else {
				await waitForTurnReconciliation(
					session.agentSession.sendCustomMessage(
						{
							customType: "host_external_agent_result",
							content,
							display: false,
							details: { runId },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					),
					attempt,
				);
			}
			const settled = externalAgentFollowUp(session, runId);
			if (settled) {
				completion.cancel();
				return settled;
			}
			return await waitForTurnReconciliation(completion.promise, attempt);
		} catch (error) {
			completion.cancel();
			throw error;
		}
	}

	private async dispatchPendingTurn(
		session: PiSessionHandle,
		pending: PendingTurnRecord,
		reconciliation?: TurnReconciliationOptions,
	): Promise<{ entryId: string; prompted: boolean }> {
		let current = this.reconcileNativeTurn(session, pending);
		if (current.piEntryId) return { entryId: current.piEntryId, prompted: false };

		let marker = findPendingTurnMarker(session, current.id);
		if (!marker) {
			await waitForTurnReconciliation(
				session.agentSession.sendCustomMessage(
					{
						customType: "host_pending_turn",
						content: "",
						display: false,
						details: { turnId: current.id },
					},
					{ triggerTurn: false },
				),
				reconciliation,
			);
			marker = findPendingTurnMarker(session, current.id);
			if (!marker) throw new Error("pending_turn_native_marker_missing");
		}
		if (current.state === "accepted") {
			current = this.pendingTurns.transition({
				id: current.id,
				conversationId: current.conversationId,
				to: "dispatched",
			});
		}

		const existingUser = findNativeUser(session, current, marker);
		if (existingUser) {
			current = this.persistNativeUser(current, existingUser.id);
			return { entryId: existingUser.id, prompted: false };
		}

		const completion = waitForNativeUser(session, current.id);
		try {
			const images = current.images.map((image) => ({
				type: "image" as const,
				data: image.data.toString("base64"),
				mimeType: image.mimeType,
			}));
			this.supervisor.promptConversation(
				current.conversationId,
				current.framedText,
				images.length > 0 ? (images as PromptImages) : undefined,
			);
			const entryId = await waitForTurnReconciliation(completion.promise, reconciliation);
			this.persistNativeUser(current, entryId);
			this.queueNativeReconciliation(current.conversationId, session);
			return { entryId, prompted: true };
		} finally {
			completion.cancel();
		}
	}

	private persistNativeUser(pending: PendingTurnRecord, entryId: string): PendingTurnRecord {
		let current = this.pendingTurns.get(pending.conversationId, pending.id) ?? pending;
		if (current.state === "accepted") {
			current = this.pendingTurns.transition({
				id: current.id,
				conversationId: current.conversationId,
				to: "dispatched",
			});
		}
		if (current.state === "dispatched") {
			current = this.pendingTurns.transition({
				id: current.id,
				conversationId: current.conversationId,
				to: "user_persisted",
				piEntryId: entryId,
			});
		}
		if (current.piEntryId !== entryId) throw new Error("pending_turn_native_user_conflict");
		this.finishAttachmentBinding(current);
		return current;
	}

	private reconcileNativeTurn(
		session: PiSessionHandle,
		pending: PendingTurnRecord,
	): PendingTurnRecord {
		let current = this.pendingTurns.get(pending.conversationId, pending.id) ?? pending;
		const marker = findPendingTurnMarker(session, current.id);
		if (current.state === "accepted" && marker) {
			current = this.pendingTurns.transition({
				id: current.id,
				conversationId: current.conversationId,
				to: "dispatched",
			});
		}
		const user = findNativeUser(session, current, marker);
		if (user && (current.state === "accepted" || current.state === "dispatched")) {
			current = this.persistNativeUser(current, user.id);
		} else if (current.piEntryId) {
			this.finishAttachmentBinding(current);
		}
		if (
			current.state === "user_persisted" &&
			current.piEntryId &&
			findNativeAssistant(session, current.piEntryId)
		) {
			current = this.pendingTurns.transition({
				id: current.id,
				conversationId: current.conversationId,
				to: "completed",
			});
		}
		return current;
	}

	private finishAttachmentBinding(pending: PendingTurnRecord): void {
		if (!pending.attachmentSendNonce || !pending.piEntryId || !this.finishAttachmentSend) return;
		this.finishAttachmentSend(
			pending.conversationId,
			pending.attachmentSendNonce,
			pending.piEntryId,
		);
	}

	private queueNativeReconciliation(conversationId: string, session: PiSessionHandle): void {
		const previous = this.reconciliationTasks.get(conversationId) ?? Promise.resolve();
		const task = previous
			.catch(() => undefined)
			.then(() => {
				for (const pending of this.pendingTurns.listIncomplete(conversationId)) {
					try {
						this.reconcileNativeTurn(session, pending);
					} catch (error) {
						this.recordPendingError(pending, error);
					}
				}
			})
			.finally(() => {
				if (this.reconciliationTasks.get(conversationId) === task) {
					this.reconciliationTasks.delete(conversationId);
				}
			});
		this.reconciliationTasks.set(conversationId, task);
	}

	private recordPendingError(pending: PendingTurnRecord, error: unknown): void {
		const current = this.pendingTurns.get(pending.conversationId, pending.id);
		if (!current || current.state === "completed") return;
		const message =
			error instanceof Error
				? error.message
				: typeof error === "object" && error !== null && "reason" in error
					? String(error.reason)
					: String(error);
		this.pendingTurns.recordError(current.conversationId, current.id, message.slice(0, 1_024));
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
			if (event.type === "message_end" || event.type === "entry_appended") {
				queueMicrotask(() => this.queueNativeReconciliation(conversationId, session));
			}
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

	private publishChanged(
		conversationId: string,
		session: PiSessionHandle,
		reason: NotifyReason,
	): void {
		this.scheduleChanged(conversationId, session.sessionId, reason);
	}
}

async function waitForTurnReconciliation<T>(
	work: Promise<T>,
	options?: TurnReconciliationOptions,
): Promise<T> {
	if (!options) return work;
	if (options.signal?.aborted) throw new Error("turn_reconciliation_cancelled");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("turn_reconciliation_cancelled"));
		options.signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(
			() => reject(new Error("turn_reconciliation_timeout")),
			Math.max(1, options.timeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS),
		);
	});
	try {
		return await Promise.race([work, interrupted]);
	} finally {
		clearTimeout(timer);
		if (abort) options.signal?.removeEventListener("abort", abort);
	}
}

function findPendingTurnMarker(
	session: PiSessionHandle,
	turnId: string,
): NonNullable<NativeEntry> | undefined {
	return session.sessionManager.getEntries().find((entry) => {
		if (!entry || entry.type !== "custom_message" || entry.customType !== "host_pending_turn") {
			return false;
		}
		const details = entry.details;
		return Boolean(
			details && typeof details === "object" && "turnId" in details && details.turnId === turnId,
		);
	});
}

function findNativeUser(
	session: PiSessionHandle,
	pending: PendingTurnRecord,
	marker = findPendingTurnMarker(session, pending.id),
): NonNullable<NativeEntry> | undefined {
	if (pending.piEntryId) {
		const mapped = session.sessionManager.getEntry(pending.piEntryId);
		if (mapped && entryRole(mapped) === "user") return mapped;
	}
	if (!marker) return undefined;
	return session.sessionManager
		.getEntries()
		.find((entry) => entryRole(entry) === "user" && descendsFrom(session, entry, marker.id));
}

function findNativeAssistant(
	session: PiSessionHandle,
	nativeUserEntryId: string,
): NonNullable<NativeEntry> | undefined {
	return session.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entryRole(entry) === "assistant" && descendsFrom(session, entry, nativeUserEntryId),
		);
}

function descendsFrom(session: PiSessionHandle, entry: NativeEntry, ancestorId: string): boolean {
	let parentId = entry?.parentId ?? null;
	while (parentId) {
		if (parentId === ancestorId) return true;
		parentId = session.sessionManager.getEntry(parentId)?.parentId ?? null;
	}
	return false;
}

function waitForNativeUser(
	session: PiSessionHandle,
	turnId: string,
): { promise: Promise<string>; cancel(): void } {
	const pending = Promise.withResolvers<string>();
	let active = true;
	const timer = setTimeout(() => {
		if (!active) return;
		active = false;
		unsubscribe();
		pending.reject({ kind: "unavailable", reason: "native_user_entry_timeout" });
	}, 10_000);
	const unsubscribe = session.subscribe((event) => {
		if (!active || event.type !== "message_end" || event.message.role !== "user") return;
		queueMicrotask(() => {
			const marker = findPendingTurnMarker(session, turnId);
			if (!active || !marker) return;
			const entry = session.sessionManager
				.getEntries()
				.find(
					(candidate) =>
						entryRole(candidate) === "user" && descendsFrom(session, candidate, marker.id),
				);
			if (!entry) return;
			active = false;
			clearTimeout(timer);
			unsubscribe();
			pending.resolve(entry.id);
		});
	});
	return {
		promise: pending.promise,
		cancel: () => {
			if (!active) return;
			active = false;
			clearTimeout(timer);
			unsubscribe();
		},
	};
}

function waitForNativeAssistant(
	session: PiSessionHandle,
	nativeUserEntryId: string,
): { promise: Promise<void>; cancel(): void } {
	if (findNativeAssistant(session, nativeUserEntryId)) {
		return { promise: Promise.resolve(), cancel: () => undefined };
	}
	const pending = Promise.withResolvers<void>();
	let active = true;
	const timer = setTimeout(() => {
		if (!active) return;
		active = false;
		unsubscribe();
		pending.reject(new Error("native_assistant_entry_timeout"));
	}, 60_000);
	const unsubscribe = session.subscribe((event) => {
		if (!active || event.type !== "message_end" || event.message.role !== "assistant") return;
		queueMicrotask(() => {
			if (!active || !findNativeAssistant(session, nativeUserEntryId)) return;
			active = false;
			clearTimeout(timer);
			unsubscribe();
			pending.resolve();
		});
	});
	if (findNativeAssistant(session, nativeUserEntryId)) {
		active = false;
		clearTimeout(timer);
		unsubscribe();
		pending.resolve();
	}
	return {
		promise: pending.promise,
		cancel: () => {
			if (!active) return;
			active = false;
			clearTimeout(timer);
			unsubscribe();
		},
	};
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

function isExternalAgentNotification(entry: NativeEntry, runId: string): boolean {
	if (
		!entry ||
		entry.type !== "custom_message" ||
		entry.customType !== "host_external_agent_result"
	) {
		return false;
	}
	const details = entry.details;
	return Boolean(
		details && typeof details === "object" && "runId" in details && details.runId === runId,
	);
}

function externalAgentFollowUp(
	session: PiSessionHandle,
	runId: string,
): ExternalAgentFollowUp | undefined {
	const entries = session.sessionManager.getEntries();
	const notificationIds = new Set(
		entries.filter((entry) => isExternalAgentNotification(entry, runId)).map((entry) => entry.id),
	);
	if (notificationIds.size === 0) return undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry) continue;
		if (entryRole(entry) !== "assistant") continue;
		let parentId = entry.parentId;
		while (parentId) {
			if (notificationIds.has(parentId)) {
				return { entryId: entry.id, text: nativeMessageText(entry) };
			}
			parentId = session.sessionManager.getEntry(parentId)?.parentId ?? null;
		}
	}
	return undefined;
}

function nativeMessageText(entry: NativeEntry): string {
	if (!isMessageEntry(entry)) return "";
	const content = "content" in entry.message ? entry.message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
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
		.join("\n");
}

function waitForExternalAgentFollowUp(
	session: PiSessionHandle,
	runId: string,
): { promise: Promise<ExternalAgentFollowUp>; cancel(): void } {
	const pending = Promise.withResolvers<ExternalAgentFollowUp>();
	let active = true;
	const unsubscribe = session.subscribe((event) => {
		if (!active || event.type !== "message_end" || event.message.role !== "assistant") return;
		queueMicrotask(() => {
			const result = externalAgentFollowUp(session, runId);
			if (!active || !result) return;
			active = false;
			unsubscribe();
			pending.resolve(result);
		});
	});
	return {
		promise: pending.promise,
		cancel: () => {
			if (!active) return;
			active = false;
			unsubscribe();
		},
	};
}
