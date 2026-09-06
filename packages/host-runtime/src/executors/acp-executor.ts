/**
 * Shared ACP controller for independent external-agent runs.
 *
 * The transport owns lifecycle, permission forwarding, and bounded evidence.
 * External agents use their own native filesystem and terminal tools; Bear
 * deliberately advertises no Host filesystem or terminal callbacks.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { RunAction, RunSteerResponse } from "@bear-harness/protocol";
import {
	type AcpPermissionRequest,
	type AcpProcessExit,
	type AcpProcessSpec,
	AcpRunClient,
} from "./acp-client.js";
import type {
	ExecutorController,
	ExecutorLaunchRequest,
	ExecutorPermissionResponse,
	ExecutorRecovery,
	ExecutorRun,
} from "./router.js";

const MAX_SUMMARY_CHARS = 12_000;

/** Prompt used to re-prompt a paused run after an interrupt (session keeps its history). */
const CONTINUATION_PROMPT =
	"Continue the requested work from where you left off and report the result concisely when done.";

type ActiveRun = {
	request: ExecutorLaunchRequest;
	client: AcpRunClient;
	pendingPermissionIds: Set<string>;
	toolCallTitles: Map<string, string>;
	messageText: string;
	settled: boolean;
	/** A user interrupt is in flight; the next cancelled turn must pause, not settle. */
	interruptRequested: boolean;
	/** The run's turn has been paused by interrupt and awaits `resume`. */
	paused: boolean;
	turn: Promise<void> | null;
	release: Promise<void> | null;
	evidenceCount: number;
};

/** Host-side ACP filesystem implementation for one approved run. */

/**
 * Base implementation for one ACP agent process per run. Subclasses only
 * choose a verified command line; protocol, evidence, cancellation, and
 * permission response behavior are shared.
 */
export abstract class AcpExecutorController implements ExecutorController {
	private readonly activeRuns = new Map<string, ActiveRun>();

	async launch(request: ExecutorLaunchRequest): Promise<void> {
		if (this.activeRuns.has(request.run.runId)) {
			throw { kind: "conflict", reason: "executor_run_already_active" };
		}

		let active: ActiveRun;
		const client = new AcpRunClient(this.processSpec(request), {
			onSessionUpdate: (notification) => this.handleSessionUpdate(active, notification),
			onPermissionRequest: (permission) => this.handlePermissionRequest(active, permission),
			onExit: (result) => this.handleProcessExit(active, result),
		});
		active = {
			request,
			client,
			pendingPermissionIds: new Set(),
			toolCallTitles: new Map(),
			messageText: "",
			settled: false,
			interruptRequested: false,
			paused: false,
			turn: null,
			release: null,
			evidenceCount: 0,
		};
		this.activeRuns.set(request.run.runId, active);

		try {
			await client.start();
		} catch (error) {
			if (active.client.recoveryState() === "confirmed_lost")
				this.activeRuns.delete(request.run.runId);
			throw error;
		}

		if (active.settled || active.release) return;
		request.emit({ type: "started" });
		active.turn = this.runPrompt(active);
	}

	async recover(run: ExecutorRun): Promise<ExecutorRecovery> {
		const active = this.activeRuns.get(run.runId);
		if (active) return active.client.recoveryState();
		// ACP is an anonymous stdio transport. After a Host restart there is no
		// inherited pipe, reattach token, or durable process identity to query.
		// Absence from this process-local map therefore proves nothing about the
		// earlier worker and must fail closed as unknown.
		return "unknown";
	}

	runtime(run: ExecutorRun): { controller: ExecutorRecovery; actions: RunAction[] } {
		const active = this.activeRuns.get(run.runId);
		if (!active) return { controller: "unknown", actions: [] };
		const controller = active.client.recoveryState();
		if (controller !== "attached" || active.settled || active.release)
			return { controller, actions: [] };
		const actions: RunAction[] = ["cancel"];
		if (active.client.shutdownRequested) return { controller, actions };
		if (active.pendingPermissionIds.size) actions.push("respondPermission");
		else if (active.paused) actions.push("resume");
		else if (active.turn && !active.interruptRequested) actions.push("steer", "interrupt");
		return { controller, actions };
	}

	async close(): Promise<void> {
		await Promise.all([...this.activeRuns.values()].map((active) => this.stop(active.request.run)));
	}

	async stop(run: ExecutorRun): Promise<void> {
		const active = this.activeRuns.get(run.runId);
		if (!active) return;
		active.release ??= active.client.stop();
		try {
			await active.release;
		} catch (error) {
			active.release = null;
			throw error;
		}
		active.settled = true;
		this.activeRuns.delete(run.runId);
	}

	async cancel(run: ExecutorRun): Promise<void> {
		const active = this.requireActive(run.runId);
		if (active.settled) throw { kind: "conflict", reason: "executor_not_running" };
		await this.stop(run);
		active.request.emit({ type: "cancelled" });
	}

	/** Steering support is explicit; unsupported extensions are never new prompts. */
	async steer(run: ExecutorRun, instruction: string): Promise<RunSteerResponse> {
		const active = this.requireActive(run.runId);
		if (
			active.settled ||
			active.release ||
			active.paused ||
			active.interruptRequested ||
			!active.turn
		)
			throw { kind: "conflict", reason: "executor_not_running" };
		return active.client.steerTurn(instruction);
	}

	/**
	 * Pause an active run without killing it.
	 *
	 * Sends the ACP `session/cancel` notification: the worker aborts the
	 * current turn and the in-flight prompt resolves with `stopReason:
	 * "cancelled"`, but the agent process and session stay alive so `resume`
	 * can re-prompt on the same session. Profile behavior: the Pi worker marks
	 * the session cancelled and aborts the turn; codex-acp cancels the active
	 * turn the same way.
	 */
	async interrupt(run: ExecutorRun): Promise<void> {
		const active = this.requireActive(run.runId);
		if (
			active.settled ||
			active.release ||
			active.paused ||
			active.interruptRequested ||
			!active.turn
		)
			throw { kind: "conflict", reason: "executor_not_running" };
		active.interruptRequested = true;
		try {
			await active.client.cancel();
			await active.turn;
			if (!active.paused) throw { kind: "conflict", reason: "executor_pause_not_confirmed" };
		} catch (error) {
			active.interruptRequested = false;
			throw error;
		}
	}

	/**
	 * Resume a paused run, or resolve a pending permission request.
	 *
	 * With `response`, resolves the matching ACP permission request (the
	 * `needs_user` path). Without one, requires the run to be paused by an
	 * interrupt and re-prompts the same session with a continuation
	 * instruction; the worker's session history supplies the remaining
	 * context. Profile behavior: the Pi worker continues the same agent
	 * session with a follow-up prompt; codex-acp resumes on the same session.
	 */
	async resume(
		run: ExecutorRun,
		response?: ExecutorPermissionResponse,
		instruction?: string,
	): Promise<void> {
		const active = this.requireActive(run.runId);
		if (active.settled || active.release || active.client.shutdownRequested)
			throw { kind: "conflict", reason: "executor_not_running" };
		if (response) {
			if (!active.pendingPermissionIds.has(response.requestId))
				throw { kind: "not_found", reason: "executor_permission_not_found" };
			active.client.respondToPermission(response.requestId, response.optionId);
			active.pendingPermissionIds.delete(response.requestId);
			return;
		}
		if (!active.paused) throw { kind: "conflict", reason: "executor_not_paused" };
		active.paused = false;
		active.turn = this.runPrompt(active, instruction ?? CONTINUATION_PROMPT);
	}

	protected abstract processSpec(request: ExecutorLaunchRequest): AcpProcessSpec;

	private async runPrompt(
		active: ActiveRun,
		text = executionPrompt(active.request),
	): Promise<void> {
		try {
			const response = await active.client.prompt(text);
			if (active.settled || active.release) return;
			if (response.stopReason === "cancelled") {
				if (active.interruptRequested) {
					// The turn was paused by a user interrupt: keep the process and
					// session alive so `resume` can re-prompt on the same session.
					active.interruptRequested = false;
					active.paused = true;
					active.request.emit({
						type: "evidence",
						kind: "run.paused",
						data: { runId: active.request.run.runId },
					});
					return;
				}
				await this.settle(active, { type: "cancelled" });
			} else if (response.stopReason === "end_turn") {
				await this.settle(active, {
					type: "completed",
					summary: active.messageText.trim() || undefined,
				});
			} else {
				await this.settle(active, {
					type: "failed",
					reason: `acp_stop_reason:${response.stopReason}`,
				});
			}
		} catch (error) {
			await this.settle(active, { type: "failed", reason: executorFailureCode(error) });
		}
	}

	private handleSessionUpdate(active: ActiveRun, notification: acp.SessionNotification): void {
		if (active.settled) return;
		const update = notification.update;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (typeof update._meta?.bearError === "string") {
					active.request.emit({
						type: "evidence",
						kind: "acp.error",
						data: { message: update._meta.bearError.slice(0, 2_000) },
					});
					return;
				}
				if (update.content.type === "text") {
					active.messageText = (active.messageText + update.content.text).slice(-MAX_SUMMARY_CHARS);
					if (active.evidenceCount++ < 2_000)
						active.request.emit({
							type: "evidence",
							kind: "acp.message",
							data: { text: update.content.text.slice(0, MAX_SUMMARY_CHARS) },
						});
				}
				return;
			case "tool_call":
				if (active.evidenceCount++ >= 2_000) return;
				this.rememberToolCall(active, update);
				active.request.emit({
					type: "evidence",
					kind: "acp.tool_call",
					data: compactToolUpdate(update),
				});
				return;
			case "tool_call_update":
				if (active.evidenceCount++ >= 2_000) return;
				this.rememberToolCall(active, update);
				active.request.emit({
					type: "evidence",
					kind: "acp.tool_call_update",
					data: compactToolUpdate(update),
				});
				return;
			case "usage_update":
				if (active.evidenceCount++ >= 2_000) return;
				active.request.emit({
					type: "evidence",
					kind: "acp.usage",
					data: { used: update.used, size: update.size, cost: update.cost ?? null },
				});
				return;
			default:
				return;
		}
	}

	private rememberToolCall(
		active: ActiveRun,
		update: { toolCallId: string; title?: string | null; name?: string | null },
	): void {
		const label = update.title ?? update.name;
		if (label && active.toolCallTitles.size < 256)
			active.toolCallTitles.set(update.toolCallId, label);
	}

	private handlePermissionRequest(active: ActiveRun, request: AcpPermissionRequest): void {
		if (active.settled) return;
		active.pendingPermissionIds.add(request.requestId);
		active.request.emit({
			type: "needs_user",
			requestId: request.requestId,
			prompt:
				request.toolCall.title ??
				request.toolCall.name ??
				active.toolCallTitles.get(request.toolCall.toolCallId) ??
				"The worker needs permission to continue.",
			options: request.options.map((option) => ({
				optionId: option.optionId,
				kind: option.kind,
				name: option.name,
			})),
		});
		active.request.emit({
			type: "evidence",
			kind: "acp.permission_requested",
			data: {
				requestId: request.requestId,
				toolCallId: request.toolCall.toolCallId,
				kind: request.toolCall.kind ?? null,
				title: request.toolCall.title ?? null,
				options: request.options.map((option) => ({
					optionId: option.optionId,
					kind: option.kind,
					name: option.name,
				})),
			},
		});
	}

	private handleProcessExit(active: ActiveRun, result: AcpProcessExit): void {
		if (active.settled || active.release) return;
		void this.settle(active, {
			type: "failed",
			reason: acpExitReason(result),
		});
	}

	private async settle(
		active: ActiveRun,
		event: Parameters<ExecutorLaunchRequest["emit"]>[0],
	): Promise<void> {
		if (active.settled || active.release) return;
		active.settled = true;
		active.release ??= active.client.stop();
		try {
			await active.release;
			this.activeRuns.delete(active.request.run.runId);
			active.request.emit(event);
		} catch {
			active.release = null;
			active.request.emit({ type: "failed", reason: "acp_process_release_failed" });
		}
	}

	private requireActive(runId: string): ActiveRun {
		const active = this.activeRuns.get(runId);
		if (!active) throw { kind: "conflict", reason: "executor_not_running" };
		return active;
	}
}

function executionPrompt(request: ExecutorLaunchRequest): string {
	return (
		`${request.task.instruction}\n\nYou are an independent external agent. Use your native tools and policy. ` +
		`Your cwd is a private writable workspace; supplied input snapshots are read-only. Process access is sandboxed. ` +
		`Write chat deliverables only beneath BEAR_OUTPUT_DIR and report the result concisely.`
	);
}

function compactToolUpdate(update: {
	toolCallId: string;
	kind?: string | null;
	status?: string | null;
	title?: string | null;
	name?: string | null;
	rawInput?: unknown;
	rawOutput?: unknown;
	content?: unknown;
}): Record<string, unknown> {
	return {
		toolCallId: update.toolCallId,
		kind: update.kind ?? null,
		status: update.status ?? null,
		title: update.title ?? null,
		name: update.name ?? null,
		rawInput: boundedEvidence(update.rawInput),
		rawOutput: boundedEvidence(update.rawOutput),
		content: boundedEvidence(update.content),
	};
}

/** Bound public tool payloads without exposing binary blobs or thinking signatures. */
function boundedEvidence(value: unknown, depth = 0, budget = { left: 12_000 }): unknown {
	if (budget.left <= 0) return "[truncated]";
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		const text = value.slice(0, budget.left);
		budget.left -= text.length;
		return text;
	}
	if (depth >= 6) return "[truncated]";
	if (Array.isArray(value))
		return value.slice(0, 64).map((item) => boundedEvidence(item, depth + 1, budget));
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).slice(0, 64)) {
			if (/signature|thinking|token|secret|password|authorization|api.?key|^data$/i.test(key))
				continue;
			if (budget.left <= 0) break;
			budget.left -= key.length;
			result[key] = boundedEvidence(item, depth + 1, budget);
		}
		return result;
	}
	return null;
}

function executorFailureCode(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"reason" in error &&
		(error.reason === "acp_start_failed" || error.reason === "acp_process_spawn_failed")
	)
		return error.reason;
	return "acp_executor_failed";
}

function acpExitReason(result: AcpProcessExit): string {
	if (result.errorCode) return result.errorCode;
	if (result.code !== null && Number.isSafeInteger(result.code))
		return `acp_agent_exit_code:${result.code}`;
	if (result.signal) return "acp_agent_terminated_by_signal";
	return "acp_agent_exit_unknown";
}
