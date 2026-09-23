import { type AcpRecoveryRecord, readAcpRecovery, writeAcpRecovery } from "./acp-recovery.js";

/**
 * Shared ACP controller for independent external-agent runs.
 *
 * The transport owns lifecycle, permission forwarding, and bounded evidence.
 * Standard filesystem and terminal callbacks are confined to each Run.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { RunAction, RunSteerResponse } from "@bear-harness/protocol";
import {
	type AcpPermissionRequest,
	type AcpProcessExit,
	type AcpProcessSpec,
	AcpRunClient,
} from "./acp-client.js";
import { type AcpResultReader, standardAcpDialect } from "./acp-dialect.js";
import { AcpRunIo } from "./acp-run-io.js";
import type {
	ExecutorController,
	ExecutorLaunchRequest,
	ExecutorPermissionResponse,
	ExecutorRecovery,
	ExecutorRun,
} from "./router.js";

/** Prompt used to re-prompt a paused run after an interrupt (session keeps its history). */
const CONTINUATION_PROMPT =
	"Continue the requested work from where you left off and report the result concisely when done.";

type ActiveRun = {
	request: ExecutorLaunchRequest;
	client: AcpRunClient;
	io: AcpRunIo;
	pendingPermissionIds: Set<string>;
	toolCallTitles: Map<string, string>;
	/** Current ACP response segment for peers without Pi's native final-response receipt. */
	result: AcpResultReader;
	settled: boolean;
	/** A user interrupt is in flight; the next cancelled turn must pause, not settle. */
	interruptRequested: boolean;
	/** The run's turn has been paused by interrupt and awaits `resume`. */
	paused: boolean;
	turn: Promise<void> | null;
	release: Promise<void> | null;
	recovery?: AcpRecoveryRecord;
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
		await this.open(request);
	}

	private async open(request: ExecutorLaunchRequest, recovery?: AcpRecoveryRecord): Promise<void> {
		if (this.activeRuns.has(request.run.runId)) {
			throw { kind: "conflict", reason: "executor_run_already_active" };
		}

		await this.prepareLaunch(request);
		let active: ActiveRun;
		const spec = this.processSpec(request);
		let client!: AcpRunClient;
		const io = new AcpRunIo(spec, () => client.activeSessionId);
		client = new AcpRunClient(spec, {
			...io.handlers(),
			onSessionUpdate: (notification) => this.handleSessionUpdate(active, notification),
			onPermissionRequest: (permission) => this.handlePermissionRequest(active, permission),
			onExit: (result) => this.handleProcessExit(active, result),
		});
		active = {
			request,
			client,
			io,
			pendingPermissionIds: new Set(),
			toolCallTitles: new Map(),
			result: (spec.dialect ?? standardAcpDialect).result(),
			settled: false,
			interruptRequested: false,
			paused: false,
			turn: null,
			release: null,
		};
		this.activeRuns.set(request.run.runId, active);

		try {
			await client.start(recovery ? { sessionId: recovery.sessionId } : {});
			if (
				client.activeSessionId &&
				(client.capabilities.loadSession || client.capabilities.resume)
			) {
				active.recovery = {
					schemaVersion: 1,
					runId: request.run.runId,
					sessionId: client.activeSessionId,
					profile: request.profile,
					released: false,
					...(request.task.modelRoute
						? {
								modelRoute: {
									providerId: request.task.modelRoute.providerId,
									modelId: request.task.modelRoute.modelId,
								},
							}
						: {}),
				};
				writeAcpRecovery(request, active.recovery);
			}
		} catch (error) {
			active.release ??= this.release(active);
			await active.release;
			if (active.client.recoveryState() === "confirmed_lost")
				this.activeRuns.delete(request.run.runId);
			throw error;
		}

		if (active.settled || active.release) return;
		if (recovery) {
			active.paused = true;
			request.emit({ type: "restored" });
		} else {
			request.emit({ type: "started" });
			active.turn = this.runPrompt(active);
		}
	}

	async restore(request: ExecutorLaunchRequest): Promise<ExecutorRecovery> {
		const active = this.activeRuns.get(request.run.runId);
		if (active) return active.client.recoveryState();
		const record = readAcpRecovery(request);
		if (!record?.released) return "unknown";
		const restored = { ...request, profile: record.profile };
		// Claim before spawn; a crash during startup cannot license a second worker.
		writeAcpRecovery(restored, { ...record, released: false });
		try {
			await this.open(restored, record);
			return "attached";
		} catch (error) {
			if (!this.activeRuns.has(request.run.runId)) writeAcpRecovery(restored, record);
			if (
				error &&
				typeof error === "object" &&
				"reason" in error &&
				error.reason === "runner_recovery_unsupported"
			)
				return "confirmed_lost";
			return "unknown";
		}
	}
	/** Graceful Host shutdown preserves loadable native sessions after a proven release. */
	async suspend(): Promise<string[]> {
		const preserved: string[] = [];
		for (const active of [...this.activeRuns.values()]) {
			const record = active.recovery;
			if (record && !active.settled && !active.release) {
				active.release = this.release(active);
				try {
					await active.release;
					writeAcpRecovery(active.request, { ...record, released: true });
					active.settled = true;
					this.activeRuns.delete(active.request.run.runId);
					preserved.push(active.request.run.runId);
				} catch (error) {
					active.release = null;
					throw error;
				}
			} else await this.stop(active.request.run);
		}
		return preserved;
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
		else if (active.turn && !active.interruptRequested) {
			actions.push("interrupt");
			if (active.client.capabilities.steer) actions.push("steer");
		}
		return { controller, actions };
	}

	async close(): Promise<void> {
		await Promise.all([...this.activeRuns.values()].map((active) => this.stop(active.request.run)));
	}

	async stop(run: ExecutorRun): Promise<void> {
		const active = this.activeRuns.get(run.runId);
		if (!active) return;
		active.release ??= this.release(active);
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

	private async release(active: ActiveRun): Promise<void> {
		const results = await Promise.allSettled([active.client.stop(), active.io.close()]);
		const errors = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (errors.length) throw new AggregateError(errors, "ACP resources could not be released");
	}
	protected async prepareLaunch(_request: ExecutorLaunchRequest): Promise<void> {}
	async test(request: ExecutorLaunchRequest, signal?: AbortSignal) {
		await this.prepareLaunch(request);
		const spec = this.processSpec(request);
		let client!: AcpRunClient;
		const io = new AcpRunIo(spec, () => client.activeSessionId);
		client = new AcpRunClient(spec, {
			...io.handlers(),
			onSessionUpdate() {},
			onPermissionRequest() {},
			onExit() {},
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			void client.stop().catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) throw new Error("runner_probe_cancelled");
			await Promise.race([
				client.start(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject({ kind: "unavailable", reason: "runner_probe_timeout" }),
						15000,
					);
				}),
			]);
			return client.connectionInfo;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			await Promise.all([client.stop(), io.close()]);
		}
	}
	protected abstract processSpec(request: ExecutorLaunchRequest): AcpProcessSpec;

	private async runPrompt(
		active: ActiveRun,
		text = executionPrompt(active.request),
	): Promise<void> {
		active.result.reset();
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
				const summary = active.result.finish(response);
				await this.settle(active, {
					type: "completed",
					summary: typeof summary === "string" ? summary.trim() || undefined : undefined,
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
		const normalized = active.result.update(update);
		if (normalized?.evidence)
			active.request.emit({
				type: "evidence",
				kind: normalized.evidence.kind,
				data: boundedEvidence(normalized.evidence.data),
			});
		if (normalized?.suppress) return;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") {
					active.request.emit({
						type: "evidence",
						kind: "acp.message",
						data: { text: update.content.text },
					});
				}
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
					data: compactToolUpdate({
						...update,
						title: update.title ?? active.toolCallTitles.get(update.toolCallId),
					}),
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
		active.release ??= this.release(active);
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

/** Filter private fields while preserving public tool payloads. */
function boundedEvidence(value: unknown, seen = new Set<object>()): unknown {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	)
		return value;
	if (value && typeof value === "object") {
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		const result = Array.isArray(value)
			? value.map((item) => boundedEvidence(item, seen))
			: Object.fromEntries(
					Object.entries(value)
						.filter(
							([key]) =>
								!/signature|thinking|token|secret|password|authorization|api.?key|^data$/i.test(
									key,
								),
						)
						.map(([key, item]) => [key, boundedEvidence(item, seen)]),
				);
		seen.delete(value);
		return result;
	}
	return null;
}

function executorFailureCode(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"reason" in error &&
		typeof error.reason === "string" &&
		/^(?:acp_start_failed|acp_process_spawn_failed|runner_startup_timeout|runner_authentication_required|runner_auth_method_unavailable|runner_credential_missing|runner_recovery_unsupported|runner_final_result_missing)$/.test(
			error.reason,
		)
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
