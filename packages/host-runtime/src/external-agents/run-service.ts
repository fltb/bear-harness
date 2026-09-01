import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Run as WireRun } from "@bear-harness/protocol";
import { RunPermission } from "@bear-harness/protocol/schema";
import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import PQueue from "p-queue";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/index.js";
import type {
	ExecutorEvent,
	ExecutorPermissionOption,
	ExecutorRouter,
	ExecutorRun,
} from "../executors/router.js";
import type { AppDatabase } from "../storage/database.js";
import { conversations, evidence, runs } from "../storage/schema.js";

export const MAX_CONCURRENT_RUNS = 2;
const MAX_RUN_CLEANUP_ENTRIES = 10_000;
const MAX_RUN_CLEANUP_DEPTH = 64;
const MAX_RUN_OUTPUT_ENTRIES = 1_000;
const MAX_RUN_OUTPUT_DEPTH = 32;
const MAX_RUN_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_RUN_OUTPUT_BYTES = 1024 * 1024 * 1024;
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
/** Resource occupancy only; this does not reclassify interrupted as running or active. */
const EXECUTOR_RESOURCE_STATUSES: readonly RunStatus[] = [
	"enqueued",
	"running",
	"needs_user",
	"interrupted",
];
const UNRECOVERABLE_AFTER_RESTART = EXECUTOR_RESOURCE_STATUSES;

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
	artifacts: ArtifactRecord[];
}
export interface DelegateParams {
	conversationId: string;
	triggerEntryId: string;
	agent: "pi" | "codex";
	inputPaths: string[];
	instruction: string;
}
export interface DelegateResult {
	runId: string;
	status: "enqueued" | "running";
}
export interface TerminalRunResult {
	run: RunSummary;
	outputs: ArtifactRecord[];
	needsResultReport: boolean;
}
export interface TerminalReconcileResult {
	resultReported: boolean;
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
	private readonly events = new PQueue({ concurrency: 1 });
	private readonly changeListeners = new Set<(run: WireRun) => void>();
	private readonly reconciliationTasks = new Map<string, ReconciliationAttempt>();
	private readonly detachedTasks = new Set<Promise<void>>();
	private closePromise: Promise<void> | undefined;
	private closed = false;
	constructor(
		private readonly db: AppDatabase,
		private readonly executorRouter: ExecutorRouter,
		private readonly artifacts: ArtifactStore,
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

	subscribeChanges(listener: (run: WireRun) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	async delegate(params: DelegateParams): Promise<DelegateResult> {
		const instruction = params.instruction.trim();
		if (!instruction || instruction.length > 12_000)
			throw { kind: "validation_failed", reason: "external_agent_instruction_invalid" };
		const inputPaths = validateInputPaths(params.inputPaths);
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
		const runId = randomUUID();
		const runDirectory = join(this.runRoot, runId);
		const title =
			instruction
				.split(/\r?\n/)
				.find((line) => line.trim())
				?.trim()
				.slice(0, 80) ?? "External agent task";
		const prepared = await this.enqueueEvent(() => {
			const resourceOwners = this.db
				.select({ n: count() })
				.from(runs)
				.where(and(inArray(runs.status, EXECUTOR_RESOURCE_STATUSES), isNull(runs.completedAt)))
				.get();
			if (Number(resourceOwners?.n ?? 0) >= MAX_CONCURRENT_RUNS)
				throw { kind: "conflict", reason: "max_concurrent_runs" };
			const directories = prepareRunDirectories(runDirectory, inputPaths);
			this.db
				.insert(runs)
				.values({
					id: runId,
					conversationId: params.conversationId,
					triggerEntryId: params.triggerEntryId,
					executorProfile: profile,
					title,
					instruction,
					inputPaths,
					status: "enqueued",
				})
				.run();
			this.changed(runId);
			return directories;
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
					const task = this.enqueueEvent(() =>
						this.applyExecutorEvent(
							runId,
							event,
							prepared.outputDirectory,
							prepared.canonicalOutputDirectory,
							pathReplacements,
						),
					).catch(async (error) => {
						if (this.closed) return;
						try {
							await this.enqueueEvent(() => {
								this.recordEvidence(runId, "executor.event_failed", {
									reason: reconciliationError(error),
								});
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
			await this.enqueueEvent(async () => {
				this.recordEvidence(runId, "executor.launch_failed", { reason });
				this.terminate(runId, "failed", reason, []);
			});
			throw error;
		}
		const persisted = this.getRun(runId);
		return { runId, status: persisted.status === "running" ? "running" : "enqueued" };
	}

	private async applyExecutorEvent(
		runId: string,
		event: ExecutorEvent,
		outputDirectory: string,
		canonicalOutputDirectory: string,
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
				this.changed(runId);
				return;
			case "evidence":
				this.recordEvidence(runId, event.kind, sanitizeValue(event.data, paths));
				return;
			case "needs_user":
				if (run.status === "running") {
					this.needsUser(runId, sanitizeText(event.prompt, paths), event.requestId, event.options);
				} else if (run.status !== "needs_user")
					throw { kind: "conflict", reason: "executor_needs_user_invalid_run_state" };
				return;
			case "completed": {
				const normalizedSummary = event.summary
					? sanitizeText(event.summary, paths).slice(0, 12_000)
					: null;
				try {
					const outputs = captureArtifacts(
						this.artifacts,
						runId,
						outputDirectory,
						canonicalOutputDirectory,
					);
					this.terminate(runId, "completed", normalizedSummary, outputs);
				} catch {
					this.recordEvidence(runId, "executor.failed", { reason: "output_snapshot_failed" });
					this.terminate(runId, "failed", "output_snapshot_failed", []);
				}
				return;
			}
			case "failed":
				this.terminate(runId, "failed", safeExecutorFailureReason(event.reason), []);
				return;
			case "cancelled":
				this.terminate(
					runId,
					"cancelled",
					event.reason ? safeReason(event.reason, paths) : null,
					[],
				);
				return;
		}
	}

	private terminate(
		runId: string,
		status: TerminalRunStatus,
		summary: string | null,
		outputs: ArtifactRecord[],
	): RunSummary {
		const run = this.getRun(runId);
		if (run.completedAt) return summarize(run);
		const update = this.db
			.update(runs)
			.set({ status, summary, permissionJson: null, completedAt: new Date().toISOString() })
			.where(and(eq(runs.id, runId), isNull(runs.completedAt)))
			.run();
		if (!update.changes) return summarize(this.getRun(runId));
		this.changed(runId);
		const result = summarize(this.getRun(runId));
		void this.reconcileRun(runId, outputs);
		return result;
	}

	project(run: RunSummary): WireRun {
		const row = this.getRun(run.id);
		const permission = row.permissionJson ? RunPermission.safeParse(row.permissionJson) : undefined;
		return {
			id: run.id,
			conversationId: run.conversationId,
			triggerEntryId: run.triggerEntryId,
			executorProfile: run.executorProfile,
			title: run.title,
			status: run.status,
			artifacts: run.artifacts.map((artifact) => ({
				id: artifact.id,
				name: artifact.logicalName,
				mime: artifact.mime,
				bytes: artifact.bytes,
				sha256: artifact.sha256,
				status: artifact.status,
				createdAt: artifact.createdAt,
			})),
			...(run.summary ? { summary: safeRunText(run.summary, 4_096) } : {}),
			evidence: this.db
				.select({ kind: evidence.kind, data: evidence.data, createdAt: evidence.createdAt })
				.from(evidence)
				.where(eq(evidence.runId, run.id))
				.orderBy(desc(evidence.createdAt))
				.limit(20)
				.all()
				.reverse()
				.map((item) => {
					const summary = summarizeEvidence(item.data);
					return {
						kind: safeRunText(item.kind, 128) || "evidence",
						...(summary ? { summary } : {}),
						createdAt: item.createdAt,
					};
				}),
			...(permission?.success ? { permission: permission.data } : {}),
			...(run.startedAt ? { startedAt: run.startedAt } : {}),
			...(run.completedAt ? { completedAt: run.completedAt } : {}),
		};
	}

	private changed(runId: string): void {
		const wire = this.project(summarize(this.getRun(runId), this.artifacts.list(runId)));
		for (const listener of [...this.changeListeners]) {
			try {
				listener(wire);
			} catch {
				// A live projection consumer cannot interrupt the committed Run transition.
			}
		}
	}

	private async enqueueEvent<T>(event: () => T | Promise<T>): Promise<T> {
		const result = await this.events.add(event);
		return result as T;
	}

	private getRun(runId: string): RunRow {
		const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
		if (!row) throw { kind: "not_found", reason: "run_not_found" };
		return row;
	}

	private reconcileRun(
		runId: string,
		capturedOutputs?: ArtifactRecord[],
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
				if (!row.completedAt || row.resultReportedAt || !this.onTerminal) {
					return;
				}
				const needsResultReport = !row.resultReportedAt;
				const outcome = await waitForReconciliationAttempt(
					Promise.resolve(
						this.onTerminal(
							{
								run: summarize(row),
								outputs: capturedOutputs ?? this.artifacts.list(row.id),
								needsResultReport,
							},
							controller.signal,
						),
					),
					controller.signal,
					timeoutMs,
				);
				if (controller.signal.aborted || this.closed) return;
				const update: { resultReportedAt?: string } = {};
				const now = new Date().toISOString();
				if (needsResultReport && outcome.resultReported) update.resultReportedAt = now;
				if (Object.keys(update).length > 0)
					await this.enqueueEvent(() => {
						this.db
							.update(runs)
							.set(update)
							.where(and(eq(runs.id, runId), isNull(runs.resultReportedAt)))
							.run();
					});
			} catch (error) {
				// Null reconciliation timestamps are the durable pending state. Keep
				// a bounded failure record without rewriting the settled raw result.
				if (!this.closed && !controller.signal.aborted) {
					try {
						await this.enqueueEvent(() => {
							this.recordEvidence(runId, "run.reconciliation_pending", {
								reason: reconciliationError(error),
							});
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
		const pending = await this.enqueueEvent(() =>
			this.db
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
						isNull(runs.resultReportedAt),
						...(conversationId ? [eq(runs.conversationId, conversationId)] : []),
					),
				)
				.all(),
		);
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
		this.changed(runId);
	}

	private needsUser(
		runId: string,
		prompt: string,
		requestId: string,
		options: ExecutorPermissionOption[] = [],
	): RunSummary {
		const run = this.getRun(runId);
		if (run.status !== "running") throw { kind: "conflict", reason: "run_not_active" };
		const permission = RunPermission.parse({ runId, prompt, requestId, options });
		this.db
			.update(runs)
			.set({ status: "needs_user", permissionJson: permission })
			.where(eq(runs.id, runId))
			.run();
		this.changed(runId);
		return summarize(this.getRun(runId));
	}
	async steerRun(runId: string, instruction: string): Promise<void> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "running" && current.status !== "needs_user")
				throw { kind: "conflict", reason: "run_not_steerable" };
			return current;
		});
		await this.executorRouter.steer(this.executorRun(run), instruction);
		this.changed(runId);
	}
	async interruptRun(runId: string): Promise<RunSummary> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "running" && current.status !== "needs_user")
				throw { kind: "conflict", reason: "run_not_interruptible" };
			return current;
		});
		await this.executorRouter.interrupt(this.executorRun(run));
		return this.enqueueEvent(() => {
			const update = this.db
				.update(runs)
				.set({ status: "interrupted", permissionJson: null })
				.where(
					and(
						eq(runs.id, runId),
						inArray(runs.status, ["running", "needs_user"]),
						isNull(runs.completedAt),
					),
				)
				.run();
			if (update.changes) this.changed(runId);
			return summarize(this.getRun(runId));
		});
	}
	async resumeRun(runId: string): Promise<RunSummary> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "interrupted" || current.completedAt)
				throw { kind: "conflict", reason: "run_not_resumable" };
			return current;
		});
		await this.executorRouter.resume(this.executorRun(run));
		return this.enqueueEvent(() => {
			const update = this.db
				.update(runs)
				.set({ status: "running", permissionJson: null })
				.where(and(eq(runs.id, runId), eq(runs.status, "interrupted"), isNull(runs.completedAt)))
				.run();
			if (update.changes) this.changed(runId);
			return summarize(this.getRun(runId));
		});
	}
	async respondToExecutorPermission(
		runId: string,
		requestId: string,
		optionId: string,
	): Promise<RunSummary> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "needs_user" || current.completedAt)
				throw { kind: "conflict", reason: "run_not_awaiting_permission" };
			const permission = RunPermission.parse(current.permissionJson);
			if (
				permission.requestId !== requestId ||
				!permission.options.some((option) => option.optionId === optionId)
			)
				throw { kind: "conflict", reason: "run_permission_response_invalid" };
			return current;
		});
		await this.executorRouter.resume(this.executorRun(run), { requestId, optionId });
		return this.enqueueEvent(() => {
			const current = this.getRun(runId);
			const permission = current.permissionJson
				? RunPermission.safeParse(current.permissionJson)
				: undefined;
			const matches =
				permission?.success === true &&
				permission.data.requestId === requestId &&
				permission.data.options.some((option) => option.optionId === optionId);
			const update = matches
				? this.db
						.update(runs)
						.set({ status: "running", permissionJson: null })
						.where(and(eq(runs.id, runId), eq(runs.status, "needs_user"), isNull(runs.completedAt)))
						.run()
				: { changes: 0 };
			if (update.changes) this.changed(runId);
			return summarize(this.getRun(runId));
		});
	}
	async cancelRun(runId: string): Promise<RunSummary> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (
				current.completedAt ||
				!["enqueued", "running", "needs_user", "interrupted"].includes(current.status)
			)
				throw { kind: "conflict", reason: "run_not_cancellable" };
			return current;
		});
		await this.executorRouter.cancel(this.executorRun(run));
		return this.enqueueEvent(() => this.terminate(runId, "cancelled", null, []));
	}
	pendingPermissions(companionId: string) {
		return this.list(companionId)
			.filter((run) => run.status === "needs_user")
			.flatMap((run) => {
				const permission = this.getRun(run.id).permissionJson;
				return permission ? [RunPermission.parse(permission)] : [];
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
		return rows.map((row) => summarize(row, this.artifacts.list(row.id)));
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
		this.closePromise = this.stopExecutorsAndDrain();
		return this.closePromise;
	}

	private async stopExecutorsAndDrain(): Promise<void> {
		const unfinished = await this.enqueueEvent(() =>
			this.db
				.select()
				.from(runs)
				.where(and(inArray(runs.status, UNRECOVERABLE_AFTER_RESTART), isNull(runs.completedAt)))
				.all(),
		);
		const attached = new Set<string>();
		const confirmedLost = new Set<string>();
		for (const row of unfinished) {
			try {
				const recovery = await this.executorRouter.recover(this.executorRun(row));
				if (recovery === "attached") attached.add(row.id);
				if (recovery === "confirmed_lost") confirmedLost.add(row.id);
			} catch {
				// A failed probe has the same fail-closed meaning as unknown.
			}
		}

		let failure: unknown;
		try {
			await this.executorRouter.close();
		} catch (error) {
			failure = error;
		}
		await this.drainDetachedTasks();
		const stoppableIds = [
			...confirmedLost,
			// A successful close proves that handles attached to this Host were
			// stopped. If close failed, their final process state is unknown.
			...(failure ? [] : attached),
		];
		await this.enqueueEvent(() => {
			const stopped =
				stoppableIds.length > 0
					? this.db
							.select({ id: runs.id })
							.from(runs)
							.where(
								and(
									inArray(runs.id, stoppableIds),
									inArray(runs.status, UNRECOVERABLE_AFTER_RESTART),
									isNull(runs.completedAt),
								),
							)
							.all()
					: [];
			if (stopped.length > 0) {
				this.db
					.update(runs)
					.set({
						status: "forced_termination",
						completedAt: new Date().toISOString(),
						summary: "External agent execution stopped because Host closed.",
					})
					.where(
						and(
							inArray(
								runs.id,
								stopped.map(({ id }) => id),
							),
							inArray(runs.status, UNRECOVERABLE_AFTER_RESTART),
							isNull(runs.completedAt),
						),
					)
					.run();
				for (const { id } of stopped) removeExternalAgentRunRoot(join(this.runRoot, id));
			}
			const remaining = this.db
				.select({ n: count() })
				.from(runs)
				.where(and(inArray(runs.status, EXECUTOR_RESOURCE_STATUSES), isNull(runs.completedAt)))
				.get();
			if (Number(remaining?.n ?? 0) === 0) removeExternalAgentRunRoot(this.runRoot);
		});
		if (failure) throw failure;
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
	}

	async recoverUnfinishedRuns(): Promise<number> {
		const unrecoverable = await this.enqueueEvent(() =>
			this.db
				.select()
				.from(runs)
				.where(and(inArray(runs.status, UNRECOVERABLE_AFTER_RESTART), isNull(runs.completedAt)))
				.all(),
		);
		let forced = 0;
		for (const row of unrecoverable) {
			const run = this.executorRun(row);
			let recovery: "attached" | "confirmed_lost" | "unknown";
			try {
				recovery = await this.executorRouter.recover(run);
			} catch (error) {
				await this.enqueueEvent(() => {
					this.recordEvidence(row.id, "run.recovery_deferred", { reason: safeReason(error, []) });
				});
				continue;
			}
			if (recovery !== "confirmed_lost") continue;
			const result = await this.enqueueEvent(() =>
				this.db
					.update(runs)
					.set({
						status: "forced_termination",
						completedAt: new Date().toISOString(),
						summary: "External agent execution could not be recovered after Host restart.",
					})
					.where(and(eq(runs.id, row.id), isNull(runs.completedAt)))
					.run(),
			);
			if (!result.changes) continue;
			forced += Number(result.changes);
		}
		await this.enqueueEvent(() => {
			const remaining = this.db
				.select({ n: count() })
				.from(runs)
				.where(and(inArray(runs.status, UNRECOVERABLE_AFTER_RESTART), isNull(runs.completedAt)))
				.get();
			if (Number(remaining?.n ?? 0) === 0) removeExternalAgentRunRoot(this.runRoot);
		});
		return forced;
	}

	async prepareConversationDeletion(conversationId: string): Promise<void> {
		const owned = await this.enqueueEvent(() =>
			this.db.select().from(runs).where(eq(runs.conversationId, conversationId)).all(),
		);
		const unfinished = owned.filter(
			(row) => !row.completedAt && UNRECOVERABLE_AFTER_RESTART.includes(row.status as RunStatus),
		);
		for (const row of unfinished) {
			const run = this.executorRun(row);
			try {
				await this.executorRouter.cancel(run);
			} catch {
				// A missing live handle is still stopped idempotently below.
			}
			await this.executorRouter.stop(run);
		}
		await this.events.onIdle();
		await this.enqueueEvent(() => {
			if (unfinished.length > 0) {
				this.db
					.update(runs)
					.set({
						status: "cancelled",
						completedAt: new Date().toISOString(),
						summary: "External agent execution stopped because its conversation was deleted.",
					})
					.where(
						and(
							inArray(
								runs.id,
								unfinished.map(({ id }) => id),
							),
							isNull(runs.completedAt),
						),
					)
					.run();
			}
			for (const { id } of owned) removeExternalAgentRunRoot(join(this.runRoot, id));
		});
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
		const current = pending.pop();
		if (!current) break;
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
	const title = sanitizeExternalAgentMemoryText(result.run.title, 512);
	const summary = sanitizeExternalAgentMemoryText(result.run.summary ?? "No result text.", 4_000);
	const artifacts = result.outputs
		.slice(0, 50)
		.map((output) => sanitizeExternalAgentMemoryText(output.logicalName, 256));
	return sanitizeExternalAgentMemoryText(
		[
			`External work ${result.run.status}: ${title}`,
			summary,
			...artifacts.map((name) => `Artifact: ${name}`),
		].join("\n\n"),
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

const SAFE_EVIDENCE_KEYS = ["kind", "name", "status", "title", "used", "size", "cost"] as const;

function summarizeEvidence(data: unknown): string | undefined {
	if (typeof data === "string" || typeof data === "number" || typeof data === "boolean")
		return safeRunText(String(data), 512) || undefined;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	const parts = SAFE_EVIDENCE_KEYS.flatMap((key) => {
		const value = record[key];
		return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
			? [`${key}: ${String(value)}`]
			: [];
	});
	return parts.length ? safeRunText(parts.join(" · "), 512) || undefined : undefined;
}

function safeRunText(value: string, maxBytes: number): string {
	return sanitizeExternalAgentMemoryText(value, maxBytes)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*\b/gi, "Bearer <redacted>")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
		.replace(
			/\b(authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
			"$1: <redacted>",
		)
		.trim();
}

function summarize(row: RunRow, outputArtifacts: ArtifactRecord[] = []): RunSummary {
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
		artifacts: outputArtifacts,
	};
}

function executionInstruction(
	instruction: string,
	inputs: Array<{ name: string; path: string; source: "local" }>,
	outputDirectory: string,
): string {
	const described = inputs.map((input) => `- ${input.name}: ${input.path}`).join("\n");
	return `${instruction}\n\nLocal input paths:\n${described || "(none)"}\n\nWrite deliverables beneath ${outputDirectory}.`;
}

function validateInputPaths(paths: readonly string[]): string[] {
	if (paths.length > 10 || new Set(paths).size !== paths.length)
		throw { kind: "validation_failed", reason: "input_paths_invalid" };
	return paths.map((path) => {
		if (!isAbsolute(path) || path.length > 4096)
			throw { kind: "validation_failed", reason: "input_path_invalid" };
		try {
			statSync(path);
		} catch {
			throw { kind: "not_found", reason: "input_path_not_found" };
		}
		return resolve(path);
	});
}

function prepareRunDirectories(runDirectory: string, paths: readonly string[]) {
	const workspace = join(runDirectory, "workspace");
	const outputDirectory = join(runDirectory, "outputs");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(outputDirectory, { recursive: true });
	return {
		workspace,
		outputDirectory,
		canonicalOutputDirectory: realpathSync.native(outputDirectory),
		inputs: paths.map((path) => ({ name: basename(path), path, source: "local" as const })),
	};
}

function captureArtifacts(
	store: ArtifactStore,
	runId: string,
	outputDirectory: string,
	expectedRoot: string,
): ArtifactRecord[] {
	const initialRoot = lstatSync(outputDirectory);
	if (initialRoot.isSymbolicLink() || !initialRoot.isDirectory()) {
		throw new Error("run_output_root_invalid");
	}
	const root = realpathSync.native(outputDirectory);
	if (root !== expectedRoot) throw new Error("run_output_root_changed");
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("run_output_root_invalid");
	}
	const pending = [{ path: root, depth: 0 }];
	const files: Array<{ path: string; logicalName: string; stat: Stats }> = [];
	let visited = 0;
	let totalBytes = 0;
	while (pending.length) {
		const directory = pending.pop();
		if (!directory) break;
		const directoryStat = lstatSync(directory.path);
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
			throw new Error("run_output_directory_invalid");
		}
		if (!within(root, realpathSync.native(directory.path))) throw new Error("run_output_escape");
		for (const entry of readdirSync(directory.path, { withFileTypes: true })) {
			visited += 1;
			if (visited > MAX_RUN_OUTPUT_ENTRIES) throw new Error("run_output_entry_limit_exceeded");
			const path = join(directory.path, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (directory.depth >= MAX_RUN_OUTPUT_DEPTH) {
					throw new Error("run_output_depth_limit_exceeded");
				}
				pending.push({ path, depth: directory.depth + 1 });
				continue;
			}
			if (!stat.isFile()) throw new Error("run_output_entry_invalid");
			const canonical = realpathSync.native(path);
			if (!within(root, canonical)) throw new Error("run_output_escape");
			if (stat.size > MAX_RUN_ARTIFACT_BYTES) throw new Error("run_output_file_too_large");
			totalBytes += stat.size;
			if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RUN_OUTPUT_BYTES) {
				throw new Error("run_output_total_too_large");
			}
			files.push({
				path: canonical,
				logicalName: relative(root, canonical).replaceAll("\\", "/"),
				stat,
			});
		}
	}
	return files
		.sort((a, b) => a.logicalName.localeCompare(b.logicalName))
		.map((file) => {
			const current = lstatSync(file.path);
			if (!sameFile(current, file.stat)) throw new Error("run_output_changed_before_capture");
			const artifact = store.createFromPathSync({
				logicalName: file.logicalName,
				path: file.path,
				mime: "application/octet-stream",
				sniffMime: (header) => outputMime(file.path, header),
				producerRunId: runId,
				maxBytes: MAX_RUN_ARTIFACT_BYTES,
			});
			store.markVerified(artifact.id);
			return { ...artifact, status: "verified" as const };
		});
}

function within(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child === "" ||
		(!isAbsolute(child) && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\"))
	);
}

function sameFile(left: Stats, right: Stats): boolean {
	return (
		left.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

function outputMime(path: string, header: Uint8Array): string {
	const bytes = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
		return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
		bytes.subarray(0, 6).toString("ascii") === "GIF89a"
	)
		return "image/gif";
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WAVE"
	)
		return "audio/wav";
	if (
		bytes.subarray(0, 3).toString("ascii") === "ID3" ||
		(bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
	)
		return "audio/mpeg";
	if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
	if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
	const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1);
	return (
		(
			{
				txt: "text/plain",
				md: "text/markdown",
				json: "application/json",
				csv: "text/csv",
				...(zip
					? {
							docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
							xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
							pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
						}
					: {}),
			} as Record<string, string>
		)[extension] ?? "application/octet-stream"
	);
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

function safeExecutorFailureReason(reason: string): string {
	if (
		/^(?:acp_executor_failed|acp_start_failed|acp_process_spawn_failed|acp_process_stdio_failed|acp_agent_terminated_by_signal|acp_agent_exit_unknown)$/.test(
			reason,
		) ||
		/^acp_agent_exit_code:-?\d{1,10}$/.test(reason)
	)
		return reason;
	return "executor_failed";
}
