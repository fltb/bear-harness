/**
 * Shared ACP executor controller and Host-owned filesystem boundary.
 *
 * ACP workers may ask for files, but only this client performs I/O. Every
 * worker update becomes bounded Host evidence; raw tool inputs and outputs are
 * deliberately not persisted because they can contain user material or keys.
 */

import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { type AcpPermissionRequest, type AcpProcessSpec, AcpRunClient } from "./acp-client.js";
import type {
	ExecutorController,
	ExecutorLaunchRequest,
	ExecutorPermissionResponse,
	ExecutorRun,
} from "./router.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 12_000;

/** Prompt used to re-prompt a paused run after an interrupt (session keeps its history). */
const CONTINUATION_PROMPT =
	"Continue the approved action from where you left off. Work only within the approved scope and report the result concisely when done.";

type AllowedRoot = {
	lexical: string;
	canonical: string | null;
};

type ActiveRun = {
	request: ExecutorLaunchRequest;
	client: AcpRunClient;
	pendingPermissionIds: Set<string>;
	messageParts: string[];
	settled: boolean;
	/** A user interrupt is in flight; the next cancelled turn must pause, not settle. */
	interruptRequested: boolean;
	/** The run's turn has been paused by interrupt and awaits `resume`. */
	paused: boolean;
};

/** Host-side ACP filesystem implementation for one approved run. */
export class ApprovedFileAccess {
	private readonly readRoots: AllowedRoot[];
	private readonly writeRoots: AllowedRoot[];
	private readonly record: (kind: string, data: Record<string, unknown>) => void;

	constructor(params: {
		reads: string[];
		writes: string[];
		record(kind: string, data: Record<string, unknown>): void;
	}) {
		this.readRoots = params.reads.map((path) => toAllowedRoot(path, "read"));
		this.writeRoots = params.writes.map((path) => toAllowedRoot(path, "write"));
		this.record = params.record;
	}

	async readTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
		const target = this.resolveReadable(request.path);
		const bytes = statSync(target).size;
		if (bytes > MAX_FILE_BYTES) throw new Error("approved_file_too_large");
		const content = readFileSync(target, "utf8");
		const line = request.line ?? 1;
		const limit = request.limit ?? 2000;
		if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("invalid_file_range");
		}
		const sliced = content
			.split(/\r?\n/)
			.slice(line - 1, line - 1 + Math.min(limit, 2000))
			.join("\n");
		this.record("acp.file_read", {
			name: basename(target),
			bytes,
			line,
			limit: Math.min(limit, 2000),
		});
		return { content: sliced };
	}

	async writeTextFile(request: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
		if (Buffer.byteLength(request.content, "utf8") > MAX_FILE_BYTES) {
			throw new Error("approved_file_too_large");
		}
		const target = this.resolveWritable(request.path);
		writeFileSync(target, request.content, "utf8");
		this.record("acp.file_write", {
			name: basename(target),
			bytes: Buffer.byteLength(request.content, "utf8"),
		});
		return {};
	}

	private resolveReadable(path: string): string {
		const target = this.assertLexicallyAllowed(path, this.readRoots, "read");
		let canonical: string;
		try {
			canonical = realpathSync(target);
			if (!statSync(canonical).isFile()) throw new Error("approved_path_not_file");
		} catch (error) {
			if (error instanceof Error && error.message === "approved_path_not_file") throw error;
			throw new Error("approved_file_not_found");
		}
		if (!this.readRoots.some((root) => root.canonical && isInside(root.canonical, canonical))) {
			throw new Error("approved_path_symlink_escape");
		}
		return canonical;
	}

	private resolveWritable(path: string): string {
		const target = this.assertLexicallyAllowed(path, this.writeRoots, "write");
		const parent = nearestExistingParent(target);
		const canonicalParent = realpathSync(parent);
		const permitted = this.writeRoots.some((root) => {
			if (root.canonical && isInside(root.canonical, canonicalParent)) return true;
			return (
				root.lexical === target && isInside(realpathSync(dirname(root.lexical)), canonicalParent)
			);
		});
		if (!permitted) throw new Error("approved_path_symlink_escape");
		return target;
	}

	private assertLexicallyAllowed(
		path: string,
		roots: AllowedRoot[],
		access: "read" | "write",
	): string {
		if (!isAbsolute(path)) throw new Error("ACP file paths must be absolute");
		const target = resolve(path);
		if (!roots.some((root) => isInside(root.lexical, target))) {
			throw new Error(`approved_${access}_path_denied`);
		}
		return target;
	}
}

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
		const reads = request.commission.resources
			.filter((grant) =>
				grant.operations.some((operation) => operation === "read" || operation === "list"),
			)
			.map((grant) => grant.resolvedPath);
		const writes = [
			...request.commission.resources
				.filter((grant) =>
					grant.operations.some((operation) => operation !== "read" && operation !== "list"),
				)
				.map((grant) => grant.resolvedPath),
			...request.commission.outputs.map((grant) => grant.resolvedPath),
		];
		const files = new ApprovedFileAccess({
			reads,
			writes,
			record: (kind, data) => request.emit({ type: "evidence", kind, data }),
		});
		const client = new AcpRunClient(this.processSpec(request), {
			onSessionUpdate: (notification) => this.handleSessionUpdate(active, notification),
			onPermissionRequest: (permission) => this.handlePermissionRequest(active, permission),
			onExit: (result) => this.handleProcessExit(active, result),
			readTextFile: (params) => files.readTextFile(params),
			writeTextFile: (params) => files.writeTextFile(params),
		});
		active = {
			request,
			client,
			pendingPermissionIds: new Set(),
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

	async cancel(run: ExecutorRun): Promise<void> {
		const active = this.requireActive(run.runId);
		await active.client.cancel();
	}

	/**
	 * Deliver a steering instruction to the live agent turn.
	 *
	 * Profile behavior: both registered profiles (Pi `product-managed` worker
	 * and Codex) speak ACP and share this implementation. The instruction is
	 * sent as the `_session/steering` extension — the Pi worker enqueues it as
	 * a synthetic user message into the running session (delivered before the
	 * next LLM call), and codex-acp injects it into the live turn natively.
	 * Agents without the extension receive a follow-up `session/prompt`, which
	 * the Pi worker also handles as a queued follow-up. Steering is a pure
	 * signal: no run state changes.
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
			this.settle(active, { type: "failed", reason: errorMessage(error) });
		}
	}

	private handleSessionUpdate(active: ActiveRun, notification: acp.SessionNotification): void {
		const update = notification.update;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") appendCapped(active.messageParts, update.content.text);
				return;
			case "tool_call":
				active.request.emit({
					type: "evidence",
					kind: "acp.tool_call",
					data: compactToolUpdate(update),
				});
				return;
			case "tool_call_update":
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

	private handlePermissionRequest(active: ActiveRun, request: AcpPermissionRequest): void {
		active.pendingPermissionIds.add(request.requestId);
		active.request.emit({
			type: "needs_user",
			requestId: request.requestId,
			prompt:
				request.toolCall.title ??
				request.toolCall.name ??
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

	private handleProcessExit(
		active: ActiveRun,
		result: { code: number | null; signal: NodeJS.Signals | null; error?: string },
	): void {
		if (active.settled) return;
		this.settle(active, {
			type: "failed",
			reason: result.error ?? `acp_agent_exited:${result.code ?? result.signal ?? "unknown"}`,
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
	const scope = [
		`Approved resources: ${request.commission.resources.map((grant) => `${grant.resolvedPath} (${grant.operations.join(",")})`).join("; ") || "none"}.`,
		`Approved outputs: ${request.commission.outputs.map((grant) => grant.resolvedPath).join(", ") || "none"}.`,
		`Allowed tools: ${request.commission.toolNames.join(", ") || "read/write only"}.`,
		`Network access: ${request.commission.networkPolicy.allowed ? "allowed" : "not allowed"}.`,
		`Acceptance criteria: ${request.commission.acceptanceCriteria.join("; ") || "none"}.`,
	].join("\n");
	return `Complete this user-approved action.\n\nTitle: ${request.commission.title}\nDescription: ${request.commission.description}\n\n${scope}\n\nWork only within this scope. Report the result concisely.`;
}

function toAllowedRoot(path: string, access: "read" | "write"): AllowedRoot {
	if (!isAbsolute(path))
		throw { kind: "validation_failed", reason: `executor_${access}_root_not_absolute` };
	const lexical = resolve(path);
	let canonical: string | null = null;
	try {
		canonical = realpathSync(lexical);
	} catch {
		// A declared write target may not exist yet. The write path guard also
		// checks the nearest canonical parent before creating it.
	}
	return { lexical, canonical };
}

function nearestExistingParent(path: string): string {
	let current = dirname(path);
	for (;;) {
		try {
			if (statSync(current).isDirectory()) return current;
		} catch {
			// Continue toward the filesystem root.
		}
		const parent = dirname(current);
		if (parent === current) throw new Error("approved_parent_not_found");
		current = parent;
	}
}

function isInside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message.slice(0, 500);
	if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string") {
		return error.reason.slice(0, 500);
	}
	return "acp_executor_failed";
}
