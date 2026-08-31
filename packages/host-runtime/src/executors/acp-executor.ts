/**
 * Shared ACP controller for independent external-agent runs.
 *
 * The transport owns lifecycle, permission forwarding, and bounded evidence.
 * External agents use their own native filesystem and terminal tools; Bear
 * deliberately advertises no Host filesystem or terminal callbacks.
 */
import type * as acp from "@agentclientprotocol/sdk";
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
	messageParts: string[];
	settled: boolean;
	/** A user interrupt is in flight; the next cancelled turn must pause, not settle. */
	interruptRequested: boolean;
	/** The run's turn has been paused by interrupt and awaits `resume`. */
	paused: boolean;
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
			messageParts: [],
			settled: false,
			interruptRequested: false,
			paused: false,
		};
		this.activeRuns.set(request.run.runId, active);

		try {
			await client.start();
		} catch (error) {
			this.activeRuns.delete(request.run.runId);
			throw error;
		}

		request.emit({ type: "started" });
		void this.runPrompt(active);
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

	async close(): Promise<void> {
		const activeRuns = [...this.activeRuns.values()];
		for (const active of activeRuns) {
			active.settled = true;
			this.activeRuns.delete(active.request.run.runId);
		}
		await Promise.all(activeRuns.map((active) => active.client.stop()));
	}

	async stop(run: ExecutorRun): Promise<void> {
		const active = this.activeRuns.get(run.runId);
		if (!active) return;
		active.settled = true;
		this.activeRuns.delete(run.runId);
		await active.client.stop();
	}

	async cancel(run: ExecutorRun): Promise<void> {
		const active = this.requireActive(run.runId);
		await active.client.cancel();
	}

	/**
	 * Deliver a steering instruction to the live agent turn.
	 *
	 * Profile behavior: both registered profiles speak ACP and share this
	 * implementation. The instruction is sent as the `_session/steering`
	 * extension when supported, otherwise as a follow-up ACP prompt. Steering
	 * is a pure signal: no run state changes.
	 */
	async steer(run: ExecutorRun, instruction: string): Promise<void> {
		const active = this.requireActive(run.runId);
		if (active.settled) throw { kind: "conflict", reason: "executor_not_running" };
		await active.client.steerTurn(instruction);
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
		if (active.settled) throw { kind: "conflict", reason: "executor_not_running" };
		active.interruptRequested = true;
		await active.client.cancel();
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
	async resume(run: ExecutorRun, response?: ExecutorPermissionResponse): Promise<void> {
		const active = this.requireActive(run.runId);
		if (response) {
			if (!active.pendingPermissionIds.delete(response.requestId)) {
				throw { kind: "not_found", reason: "executor_permission_not_found" };
			}
			active.client.respondToPermission(response.requestId, response.optionId);
			return;
		}
		if (active.settled) throw { kind: "conflict", reason: "executor_not_running" };
		if (!active.paused) throw { kind: "conflict", reason: "executor_not_paused" };
		active.paused = false;
		void this.runPrompt(active, CONTINUATION_PROMPT);
	}

	protected abstract processSpec(request: ExecutorLaunchRequest): AcpProcessSpec;

	private async runPrompt(
		active: ActiveRun,
		text = executionPrompt(active.request),
	): Promise<void> {
		try {
			const response = await active.client.prompt(text);
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
				this.settle(active, { type: "cancelled" });
			} else {
				this.settle(active, {
					type: "completed",
					summary: active.messageParts.join("").trim() || undefined,
				});
			}
		} catch (error) {
			this.settle(active, { type: "failed", reason: executorFailureCode(error) });
		}
	}

	private handleSessionUpdate(active: ActiveRun, notification: acp.SessionNotification): void {
		const update = notification.update;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") appendCapped(active.messageParts, update.content.text);
				return;
			case "tool_call":
				this.rememberToolCall(active, update);
				active.request.emit({
					type: "evidence",
					kind: "acp.tool_call",
					data: compactToolUpdate(update),
				});
				return;
			case "tool_call_update":
				this.rememberToolCall(active, update);
				active.request.emit({
					type: "evidence",
					kind: "acp.tool_call_update",
					data: compactToolUpdate(update),
				});
				return;
			case "usage_update":
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
		if (label) active.toolCallTitles.set(update.toolCallId, label);
	}

	private handlePermissionRequest(active: ActiveRun, request: AcpPermissionRequest): void {
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
		if (active.settled) return;
		this.settle(active, {
			type: "failed",
			reason: acpExitReason(result),
		});
	}

	private settle(active: ActiveRun, event: Parameters<ExecutorLaunchRequest["emit"]>[0]): void {
		if (active.settled) return;
		active.settled = true;
		this.activeRuns.delete(active.request.run.runId);
		active.request.emit(event);
		void active.client.stop();
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
		`The supplied workspace and inputs are real local paths; Bear provides no sandbox or rollback. ` +
		`Write chat deliverables only beneath BEAR_OUTPUT_DIR and report the result concisely.`
	);
}

function appendCapped(parts: string[], value: string): void {
	const current = parts.reduce((size, part) => size + part.length, 0);
	if (current >= MAX_SUMMARY_CHARS) return;
	parts.push(value.slice(0, MAX_SUMMARY_CHARS - current));
}

function compactToolUpdate(update: {
	toolCallId: string;
	kind?: string | null;
	status?: string | null;
	title?: string | null;
	name?: string | null;
}): Record<string, string | null> {
	return {
		toolCallId: update.toolCallId,
		kind: update.kind ?? null,
		status: update.status ?? null,
		title: update.title ?? null,
		name: update.name ?? null,
	};
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
