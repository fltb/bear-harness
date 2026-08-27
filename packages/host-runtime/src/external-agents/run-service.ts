import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { EventPayloadSchemas } from "@bear-harness/protocol/schema";
import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type {
	ConversationAttachmentService,
	ConversationAttachmentSummary,
} from "../conversation-attachments/service.js";
import type {
	ExecutorEvent,
	ExecutorPermissionOption,
	ExecutorRouter,
	ExecutorRun,
} from "../executors/router.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import { conversations, events, evidence, runs } from "../storage/schema.js";

export const MAX_ACTIVE_RUNS = 2;
const MAX_RUN_CLEANUP_ENTRIES = 10_000;
const MAX_RUN_CLEANUP_DEPTH = 64;
export type RunStatus =
	| "enqueued"
	| "running"
	| "needs_user"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "forced_termination";
export type TerminalRunStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "forced_termination";
const ACTIVE: readonly RunStatus[] = ["enqueued", "running", "needs_user"];
const ORPHANABLE: readonly RunStatus[] = [...ACTIVE, "interrupted"];

type RunRow = typeof runs.$inferSelect;
export interface RunSummary {
	id: string;
	conversationId: string;
	triggerEntryId: string;
	executorProfile: string;
	title: string;
	status: RunStatus;
	startedAt: string | null;
	completedAt: string | null;
	summary: string | null;
}
export interface DelegateParams {
	conversationId: string;
	triggerEntryId: string;
	agent: "pi" | "codex";
	attachmentIds: string[];
	workspaceAttachmentId?: string;
	instruction: string;
}
export interface DelegateResult {
	runId: string;
	status: "enqueued" | "running";
}
export interface TerminalRunResult {
	run: RunSummary;
	outputs: ConversationAttachmentSummary[];
	needsResultReport: boolean;
	needsMemoryCapture: boolean;
}
export interface TerminalReconcileResult {
	resultReported: boolean;
	memoryCaptured: boolean;
}
export interface ReconciliationAttemptOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface ReconciliationAttempt {
	controller: AbortController;
	promise: Promise<void>;
}

const DEFAULT_RECONCILIATION_TIMEOUT_MS = 15_000;

/** Direct external-agent ownership/FSM boundary. There is no proposal or approval phase. */
export class ExternalAgentRunService {
	private readonly reconciliationTasks = new Map<string, ReconciliationAttempt>();
	private readonly detachedTasks = new Set<Promise<void>>();
	private closePromise: Promise<void> | undefined;
	private closed = false;
	constructor(
		private readonly db: AppDatabase,
		private readonly eventBus: EventBus,
		private readonly executorRouter: ExecutorRouter,
		private readonly attachments: ConversationAttachmentService,
		private readonly runRoot: string,
		private readonly resolveProfile: (agent: "pi" | "codex") => Promise<string>,
		private readonly resolvePiModel: (
			conversationId: string,
		) => Promise<{ providerId: string; modelId: string; apiKey?: string } | undefined>,
		private readonly onTerminal?: (
			result: TerminalRunResult,
			signal: AbortSignal,
		) => TerminalReconcileResult | Promise<TerminalReconcileResult>,
		private readonly reconciliationTimeoutMs = DEFAULT_RECONCILIATION_TIMEOUT_MS,
	) {
		mkdirSync(runRoot, { recursive: true });
	}

	async delegate(params: DelegateParams): Promise<DelegateResult> {
		const instruction = params.instruction.trim();
		if (!instruction || instruction.length > 12_000)
			throw { kind: "validation_failed", reason: "external_agent_instruction_invalid" };
		if (
			params.attachmentIds.length === 0 ||
			params.attachmentIds.length > 10 ||
			new Set(params.attachmentIds).size !== params.attachmentIds.length
		)
			throw { kind: "validation_failed", reason: "attachment_ids_invalid" };
		const owner = this.db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.id, params.conversationId))
			.get();
		if (!owner) throw { kind: "not_found", reason: "conversation_not_found" };
		const profile = await this.resolveProfile(params.agent);
		this.executorRouter.validateProfile(profile);
		const modelRoute =
			params.agent === "pi" ? await this.resolvePiModel(params.conversationId) : undefined;
		if (params.agent === "pi" && !modelRoute)
			throw { kind: "unavailable", reason: "pi_model_unavailable" };
		const active = this.db
			.select({ n: count() })
			.from(runs)
			.where(inArray(runs.status, ACTIVE))
			.get();
		if (Number(active?.n ?? 0) >= MAX_ACTIVE_RUNS)
			throw { kind: "conflict", reason: "max_active_runs" };

		const runId = randomUUID();
		const runDirectory = join(this.runRoot, runId);
		const prepared = this.attachments.prepareRunInputs({
			conversationId: params.conversationId,
			attachmentIds: params.attachmentIds,
			workspaceAttachmentId: params.workspaceAttachmentId,
			runDirectory,
		});
		const title =
			instruction
				.split(/\r?\n/)
				.find((line) => line.trim())
				?.trim()
				.slice(0, 80) ?? "External agent task";
		this.db
			.insert(runs)
			.values({
				id: runId,
				conversationId: params.conversationId,
				triggerEntryId: params.triggerEntryId,
				executorProfile: profile,
				title,
				instruction,
				inputAttachmentIds: params.attachmentIds,
				workspaceAttachmentId: params.workspaceAttachmentId ?? null,
				status: "enqueued",
			})
			.run();
		this.eventBus.publish("run.enqueued", {
			runId,
			conversationId: params.conversationId,
			triggerEntryId: params.triggerEntryId,
			executorProfile: profile,
		});
		const run: ExecutorRun = {
			runId,
			triggerEntryId: params.triggerEntryId,
			executorProfile: profile,
		};
		const pathReplacements = [
			...prepared.inputs.map((input) => input.path),
			prepared.workspace,
			prepared.outputDirectory,
		];
		try {
			await this.executorRouter.launch(
				run,
				{
					instruction: executionInstruction(instruction, prepared.inputs, prepared.outputDirectory),
					workspace: prepared.workspace,
					outputDirectory: prepared.outputDirectory,
					readOnlyPaths: prepared.inputs.map((input) => input.path),
					...(modelRoute ? { modelRoute } : {}),
				},
				(event) => {
					if (this.closed) return;
					const task = this.handleExecutorEvent(
						runId,
						event,
						prepared.outputDirectory,
						pathReplacements,
					).catch((error) => {
						if (this.closed) return;
						try {
							this.recordEvidence(runId, "executor.event_failed", {
								reason: reconciliationError(error),
							});
						} catch {
							// Executor callbacks are detached; diagnostics failure
							// must not become an unhandled rejection.
						}
					});
					this.trackDetached(task);
				},
			);
		} catch (error) {
			const reason = safeReason(error, pathReplacements);
			this.recordEvidence(runId, "executor.launch_failed", { reason });
			if (!this.getRun(runId).completedAt) await this.terminate(runId, "failed", reason, []);
			throw error;
		}
		const persisted = this.getRun(runId);
		return { runId, status: persisted.status === "running" ? "running" : "enqueued" };
	}

	private async handleExecutorEvent(
		runId: string,
		event: ExecutorEvent,
		outputDirectory: string,
		paths: string[],
	): Promise<void> {
		const run = this.getRun(runId);
		if (run.completedAt) return;
		switch (event.type) {
			case "started":
				if (run.status !== "enqueued")
					throw { kind: "conflict", reason: "executor_started_invalid_run_state" };
				this.db
					.update(runs)
					.set({ status: "running", startedAt: new Date().toISOString() })
					.where(eq(runs.id, runId))
					.run();
				this.eventBus.publish("run.started", { runId });
				return;
			case "evidence":
				this.recordEvidence(runId, event.kind, sanitizeValue(event.data, paths));
				return;
			case "needs_user":
				if (run.status === "running")
					this.needsUser(runId, sanitizeText(event.prompt, paths), event.requestId, event.options);
				else if (run.status !== "needs_user")
					throw { kind: "conflict", reason: "executor_needs_user_invalid_run_state" };
				return;
			case "completed": {
				const normalizedSummary = event.summary
					? sanitizeText(event.summary, paths).slice(0, 12_000)
					: null;
				try {
					const outputs = await this.attachments.captureOutputs(
						run.conversationId,
						runId,
						outputDirectory,
					);
					await this.terminate(runId, "completed", normalizedSummary, outputs);
				} catch {
					this.recordEvidence(runId, "executor.failed", { reason: "output_snapshot_failed" });
					await this.terminate(runId, "failed", "output_snapshot_failed", []);
				}
				return;
			}
			case "failed":
				await this.terminate(runId, "failed", safeReason(event.reason, paths), []);
				return;
			case "cancelled":
				await this.terminate(
					runId,
					"cancelled",
					event.reason ? safeReason(event.reason, paths) : null,
					[],
				);
				return;
		}
	}

	private async terminate(
		runId: string,
		status: TerminalRunStatus,
		summary: string | null,
		outputs: ConversationAttachmentSummary[],
	): Promise<RunSummary> {
		const run = this.getRun(runId);
		if (run.completedAt) return summarize(run);
		this.db
			.update(runs)
			.set({ status, summary, completedAt: new Date().toISOString() })
			.where(eq(runs.id, runId))
			.run();
		this.eventBus.publish("run.completed", { runId, status });
		const result = summarize(this.getRun(runId));
		void this.reconcileRun(runId, outputs);
		return result;
	}

	private getRun(runId: string): RunRow {
		const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
		if (!row) throw { kind: "not_found", reason: "run_not_found" };
		return row;
	}

	private reconcileRun(
		runId: string,
		capturedOutputs?: ConversationAttachmentSummary[],
		options: ReconciliationAttemptOptions = {},
	): Promise<void> {
		if (this.closed) return Promise.resolve();
		const pending = this.reconciliationTasks.get(runId);
		if (pending) return pending.promise;
		const controller = new AbortController();
		const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) controller.abort();
		const timeoutMs = options.timeoutMs ?? this.reconciliationTimeoutMs;
		const task = (async () => {
			try {
				const row = this.getRun(runId);
				if (
					!row.completedAt ||
					(row.resultReportedAt && row.memoryCapturedAt) ||
					!this.onTerminal
				) {
					return;
				}
				const needsResultReport = !row.resultReportedAt;
				const needsMemoryCapture = !row.memoryCapturedAt;
				const outcome = await waitForReconciliationAttempt(
					Promise.resolve(
						this.onTerminal(
							{
								run: summarize(row),
								outputs:
									capturedOutputs ?? this.attachments.generatedForRun(row.conversationId, row.id),
								needsResultReport,
								needsMemoryCapture,
							},
							controller.signal,
						),
					),
					controller.signal,
					timeoutMs,
				);
				if (controller.signal.aborted || this.closed) return;
				const update: {
					resultReportedAt?: string;
					memoryCapturedAt?: string;
				} = {};
				const now = new Date().toISOString();
				if (needsResultReport && outcome.resultReported) update.resultReportedAt = now;
				if (needsMemoryCapture && outcome.memoryCaptured) update.memoryCapturedAt = now;
				if (Object.keys(update).length > 0) {
					this.db.update(runs).set(update).where(eq(runs.id, runId)).run();
				}
			} catch (error) {
				// Null reconciliation timestamps are the durable pending state. Keep
				// a bounded failure record without rewriting the settled raw result.
				if (!this.closed && !controller.signal.aborted) {
					try {
						this.recordEvidence(runId, "run.reconciliation_pending", {
							reason: reconciliationError(error),
						});
					} catch {
						// The null timestamps remain the durable retry signal even
						// when diagnostics persistence itself is unavailable.
					}
				}
			}
		})().finally(() => {
			options.signal?.removeEventListener("abort", abort);
			const current = this.reconciliationTasks.get(runId);
			if (current?.promise === task) this.reconciliationTasks.delete(runId);
		});
		this.reconciliationTasks.set(runId, { controller, promise: task });
		return task;
	}

	async reconcilePending(
		conversationId?: string,
		options: ReconciliationAttemptOptions = {},
	): Promise<number> {
		if (this.closed || options.signal?.aborted) return 0;
		const pending = this.db
			.select({ id: runs.id })
			.from(runs)
			.where(
				and(
					inArray(runs.status, [
						"completed",
						"failed",
						"cancelled",
						"interrupted",
						"forced_termination",
					]),
					isNotNull(runs.completedAt),
					or(isNull(runs.resultReportedAt), isNull(runs.memoryCapturedAt)),
					...(conversationId ? [eq(runs.conversationId, conversationId)] : []),
				),
			)
			.all();
		await Promise.all(pending.map(({ id }) => this.reconcileRun(id, undefined, options)));
		return pending.length;
	}
	private executorRun(row: RunRow): ExecutorRun {
		return {
			runId: row.id,
			triggerEntryId: row.triggerEntryId,
			executorProfile: row.executorProfile,
		};
	}
	private recordEvidence(runId: string, kind: string, data: unknown): void {
		const evidenceId = randomUUID();
		this.db
			.insert(evidence)
			.values({ id: evidenceId, runId, kind: kind.slice(0, 128), data })
			.run();
		this.eventBus.publish("evidence.collected", { runId, evidenceId, kind: kind.slice(0, 128) });
	}

	needsUser(
		runId: string,
		prompt: string,
		requestId?: string,
		options: ExecutorPermissionOption[] = [],
	): RunSummary {
		const run = this.getRun(runId);
		if (run.status !== "running") throw { kind: "conflict", reason: "run_not_active" };
		this.db.update(runs).set({ status: "needs_user" }).where(eq(runs.id, runId)).run();
		this.eventBus.publish("run.needs_user", { runId, prompt, requestId, options });
		return summarize(this.getRun(runId));
	}
	async steerRun(runId: string, instruction: string): Promise<void> {
		const run = this.getRun(runId);
		if (run.status !== "running" && run.status !== "needs_user")
			throw { kind: "conflict", reason: "run_not_steerable" };
		await this.executorRouter.steer(this.executorRun(run), instruction);
		this.eventBus.publish("run.steered", { runId, instruction });
	}
	async interruptRun(runId: string): Promise<RunSummary> {
		const run = this.getRun(runId);
		if (run.status !== "running" && run.status !== "needs_user")
			throw { kind: "conflict", reason: "run_not_interruptible" };
		await this.executorRouter.interrupt(this.executorRun(run));
		this.db.update(runs).set({ status: "interrupted" }).where(eq(runs.id, runId)).run();
		this.eventBus.publish("run.interrupted", { runId });
		return summarize(this.getRun(runId));
	}
	async resumeRun(runId: string): Promise<RunSummary> {
		const run = this.getRun(runId);
		if (run.status !== "interrupted" || run.completedAt)
			throw { kind: "conflict", reason: "run_not_resumable" };
		await this.executorRouter.resume(this.executorRun(run));
		this.db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();
		this.eventBus.publish("run.resumed", { runId });
		return summarize(this.getRun(runId));
	}
	async respondToExecutorPermission(
		runId: string,
		requestId: string,
		optionId: string,
	): Promise<RunSummary> {
		const run = this.getRun(runId);
		if (run.status !== "needs_user" || run.completedAt)
			throw { kind: "conflict", reason: "run_not_awaiting_permission" };
		await this.executorRouter.resume(this.executorRun(run), { requestId, optionId });
		this.db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();
		this.eventBus.publish("run.resumed", { runId });
		return summarize(this.getRun(runId));
	}
	async cancelRun(runId: string): Promise<RunSummary> {
		const run = this.getRun(runId);
		if (
			run.completedAt ||
			!["enqueued", "running", "needs_user", "interrupted"].includes(run.status)
		)
			throw { kind: "conflict", reason: "run_not_cancellable" };
		await this.executorRouter.cancel(this.executorRun(run));
		return this.terminate(runId, "cancelled", null, []);
	}
	pendingPermissions(companionId: string) {
		return this.list(companionId)
			.filter((run) => run.status === "needs_user")
			.flatMap((run) => {
				const row = this.db
					.select({ payload: events.payload })
					.from(events)
					.where(
						and(
							eq(events.kind, "run.needs_user"),
							sql`json_extract(${events.payload}, '$.runId') = ${run.id}`,
						),
					)
					.orderBy(desc(events.seq))
					.limit(1)
					.get();
				return row ? [EventPayloadSchemas["run.needs_user"].parse(row.payload)] : [];
			});
	}

	list(companionId?: string): RunSummary[] {
		const rows = companionId
			? this.db
					.select({ run: runs })
					.from(runs)
					.innerJoin(conversations, eq(runs.conversationId, conversations.id))
					.where(eq(conversations.companionId, companionId))
					.orderBy(desc(runs.createdAt))
					.limit(10)
					.all()
					.map((row) => row.run)
			: this.db.select().from(runs).orderBy(desc(runs.createdAt)).limit(10).all();
		return rows.map(summarize);
	}
	private trackDetached(task: Promise<void>): void {
		let trackedTask: Promise<void>;
		trackedTask = task.finally(() => {
			this.detachedTasks.delete(trackedTask);
		});
		this.detachedTasks.add(trackedTask);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = this.drainDetachedTasks();
		return this.closePromise;
	}

	private async drainDetachedTasks(): Promise<void> {
		const attempts = [...this.reconciliationTasks.values()];
		for (const attempt of attempts) attempt.controller.abort();
		await Promise.allSettled([
			...attempts.map((attempt) => attempt.promise),
			...this.detachedTasks,
		]);
		this.reconciliationTasks.clear();
		this.detachedTasks.clear();
		const active = this.db
			.select({ n: count() })
			.from(runs)
			.where(inArray(runs.status, ACTIVE))
			.get();
		if (Number(active?.n ?? 0) === 0) removeExternalAgentRunRoot(this.runRoot);
	}

	markOrphansInterrupted(): number {
		const result = this.db
			.update(runs)
			.set({
				status: "interrupted",
				completedAt: new Date().toISOString(),
				summary: "External agent process was interrupted by Host restart.",
			})
			.where(and(inArray(runs.status, ORPHANABLE), isNull(runs.completedAt)))
			.run();
		removeExternalAgentRunRoot(this.runRoot);
		return Number(result.changes);
	}
}

/**
 * Host-only teardown for ephemeral external-agent state. The walk is bounded
 * and uses lstat for every entry so links are unlinked, never traversed.
 */
export function removeExternalAgentRunRoot(runRoot: string): void {
	const root = resolve(runRoot);
	const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
	let visited = 0;
	while (pending.length > 0) {
		const current = pending.pop()!;
		visited += 1;
		if (visited > MAX_RUN_CLEANUP_ENTRIES || current.depth > MAX_RUN_CLEANUP_DEPTH) {
			throw new Error("external_agent_run_cleanup_limit_exceeded");
		}
		let stat: Stats;
		try {
			stat = lstatSync(current.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			chmodSync(current.path, stat.mode | 0o700);
			for (const entry of readdirSync(current.path, { withFileTypes: true })) {
				pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
			}
		} else {
			chmodSync(current.path, stat.mode | 0o600);
		}
	}
	rmSync(root, { recursive: true, force: true });
}

async function waitForReconciliationAttempt<T>(
	work: Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<T> {
	if (signal.aborted) throw new Error("external_agent_reconciliation_cancelled");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new Error("external_agent_reconciliation_cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(
			() => reject(new Error("external_agent_reconciliation_timeout")),
			Math.max(1, timeoutMs),
		);
	});
	try {
		return await Promise.race([work, interrupted]);
	} finally {
		clearTimeout(timer);
		if (abort) signal.removeEventListener("abort", abort);
	}
}

function reconciliationError(error: unknown): string {
	if (error instanceof Error) return error.message.slice(0, 1_024);
	if (typeof error === "object" && error !== null && "reason" in error) {
		return String(error.reason).slice(0, 1_024);
	}
	return String(error).slice(0, 1_024);
}

export function externalAgentResultMessage(
	result: Pick<TerminalRunResult, "run" | "outputs">,
): string {
	const payload = {
		runId: result.run.id,
		status: result.run.status,
		title: sanitizeExternalAgentMemoryText(result.run.title, 512),
		summary: sanitizeExternalAgentMemoryText(result.run.summary ?? "", 4_000),
		attachments: result.outputs.slice(0, 50).map((output) => ({
			id: output.id,
			name: sanitizeExternalAgentMemoryText(output.name, 256),
			bytes: output.bytes,
			fileCount: output.fileCount,
		})),
	};
	return sanitizeExternalAgentMemoryText(
		"An external agent run has finished. Give the user one concise role-appropriate " +
			"follow-up based only on this result. Generated attachments are already available " +
			"to the conversation; do not expose local paths or internal execution logs.\n" +
			JSON.stringify(payload),
		6_000,
	);
}

function stripControlSequences(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; ) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) break;
		const width = codePoint > 0xffff ? 2 : 1;
		if (codePoint === 0x1b && value.charCodeAt(index + width) === 0x5b) {
			index += width + 1;
			while (index < value.length) {
				const next = value.charCodeAt(index++);
				if (next >= 0x40 && next <= 0x7e) break;
			}
			continue;
		}
		if (
			(codePoint >= 0 && codePoint <= 8) ||
			codePoint === 11 ||
			codePoint === 12 ||
			(codePoint >= 14 && codePoint <= 31) ||
			codePoint === 127 ||
			codePoint === 155
		) {
			index += width;
			continue;
		}
		result += value.slice(index, index + width);
		index += width;
	}
	return result;
}

export function sanitizeExternalAgentMemoryText(value: string, maxBytes: number): string {
	const sanitized = stripControlSequences(value).replace(
		/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|private|var|Volumes|opt|usr|etc)\/)[^\s"'<>]*/g,
		"<redacted-path>",
	);
	if (Buffer.byteLength(sanitized, "utf8") <= maxBytes) return sanitized;
	let end = Math.min(sanitized.length, maxBytes);
	while (end > 0 && Buffer.byteLength(sanitized.slice(0, end), "utf8") > maxBytes) end -= 1;
	return sanitized.slice(0, end);
}

function summarize(row: RunRow): RunSummary {
	return {
		id: row.id,
		conversationId: row.conversationId,
		triggerEntryId: row.triggerEntryId,
		executorProfile: row.executorProfile,
		title: row.title,
		status: row.status,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		summary: row.summary,
	};
}
function executionInstruction(
	instruction: string,
	inputs: Array<{ name: string; path: string; source: "snapshot" }>,
	outputDirectory: string,
): string {
	const described = inputs
		.map((input) => `- ${input.name}: ${input.path} (immutable snapshot copy)`)
		.join("\n");
	return `${instruction}\n\nInputs:\n${described}\n\nWrite chat deliverables beneath ${outputDirectory}. Snapshot-copy edits must be copied there to be returned.`;
}
function sanitizeText(value: string, paths: string[]): string {
	let text = stripControlSequences(value);
	for (const path of [...paths].sort((a, b) => b.length - a.length))
		text = text.split(path).join(path.endsWith("outputs") ? "<outputs>" : "<workspace>");
	return text;
}
function sanitizeValue(value: unknown, paths: string[]): unknown {
	if (typeof value === "string") return sanitizeText(value, paths);
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, paths));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.slice(0, 100)
				.map(([key, item]) => [key, sanitizeValue(item, paths)]),
		);
	return value;
}
function safeReason(error: unknown, paths: string[]): string {
	if (typeof error === "string") return sanitizeText(error, paths).slice(0, 512);
	if (error instanceof Error && error.message)
		return sanitizeText(error.message, paths).slice(0, 512);
	if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string")
		return sanitizeText(error.reason, paths).slice(0, 512);
	return "executor_failed";
}
