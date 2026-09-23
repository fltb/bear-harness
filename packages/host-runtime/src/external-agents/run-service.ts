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
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
	RunGetRequest,
	RunGetResponse,
	RunListRequest,
	RunListResponse,
	RunSteerResponse,
	Run as WireRun,
} from "@bear-harness/protocol";
import { RunPermission } from "@bear-harness/protocol/schema";
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import PQueue from "p-queue";
import {
	type ArtifactCaptureLimits,
	captureArtifacts,
	DEFAULT_ARTIFACT_CAPTURE_LIMITS,
	outputCaptureFailure,
} from "../artifacts/capture.js";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/index.js";
import { readAcpRecovery } from "../executors/acp-recovery.js";
import type {
	ExecutorEvent,
	ExecutorPermissionOption,
	ExecutorRouter,
	ExecutorRun,
	ExecutorTask,
} from "../executors/router.js";
import type { AppDatabase } from "../storage/database.js";
import { conversations, evidence, runManifests, runs } from "../storage/schema.js";

export const MAX_CONCURRENT_RUNS = 2;
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

/** Shared by live and unopened runtime deletion; uncertainty never authorizes file removal. */
export function assertRuntimeDeletable(db: AppDatabase): void {
	const unfinished = db
		.select({ id: runs.id })
		.from(runs)
		.where(and(inArray(runs.status, EXECUTOR_RESOURCE_STATUSES), isNull(runs.completedAt)))
		.limit(1)
		.get();
	if (unfinished) throw { kind: "conflict", reason: "external_agent_controller_unavailable" };
}

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
	runnerId?: string;
	conversationId: string;
	triggerEntryId: string;
	toolCallId: string;
	inputPaths: string[];
	instruction: string;
}
export interface DelegateResult {
	runId: string;
	accepted: true;
	executor: "pi" | "codex" | "custom";
	runnerId: string;
}
export interface TerminalRunResult {
	run: RunSummary;
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

interface OutputCapture {
	conversationId: string;
	controller: AbortController;
	promise: Promise<void>;
}

/** Direct external-agent ownership/FSM boundary. There is no proposal or approval phase. */
export class ExternalAgentRunService {
	private readonly events = new PQueue({ concurrency: 1 });
	private readonly changeListeners = new Set<(run: WireRun) => void>();
	private readonly reconciliationTasks = new Map<string, ReconciliationAttempt>();
	/** Owned file operations, drained before the exact Run directory or database is released. */
	private readonly captures = new Map<string, OutputCapture>();
	private readonly detachedTasks = new Set<Promise<void>>();
	private readonly admissions = new Set<Promise<DelegateResult>>();
	private readonly controls = new Map<Promise<unknown>, string>();
	private readonly launches = new Map<
		string,
		{ cancelled: boolean; started: boolean; promise: Promise<void> }
	>();
	private readonly deletingConversations = new Set<string>();
	private closePromise: Promise<void> | undefined;
	private recoveryPromise: Promise<number> | undefined;
	private closed = false;
	constructor(
		private readonly db: AppDatabase,
		private readonly executorRouter: ExecutorRouter,
		private readonly artifacts: ArtifactStore,
		private readonly runRoot: string,
		private readonly resolvePiModel: (
			conversationId: string,
			pinned?: { providerId: string; modelId: string },
		) => Promise<ExecutorTask["modelRoute"]>,
		private readonly onTerminal?: (
			result: TerminalRunResult,
			signal: AbortSignal,
		) => TerminalReconcileResult | Promise<TerminalReconcileResult>,
		private readonly reconciliationTimeoutMs = DEFAULT_RECONCILIATION_TIMEOUT_MS,
		private readonly observeExecutor?: (
			runId: string,
			conversationId: string,
			event: ExecutorEvent,
		) => void,
		private readonly captureLimits: Readonly<ArtifactCaptureLimits> = DEFAULT_ARTIFACT_CAPTURE_LIMITS,
	) {
		mkdirSync(runRoot, { recursive: true });
	}

	subscribeChanges(listener: (run: WireRun) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	delegate(params: DelegateParams): Promise<DelegateResult> {
		const task = this.admit(params);
		this.admissions.add(task);
		void task.then(
			() => this.admissions.delete(task),
			() => this.admissions.delete(task),
		);
		return task;
	}

	private assertAdmissionOpen(conversationId: string): void {
		if (this.closed) throw { kind: "unavailable", reason: "run_service_closed" };
		if (this.deletingConversations.has(conversationId))
			throw { kind: "conflict", reason: "conversation_deleting" };
		if (
			!this.db
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.id, conversationId))
				.get()
		)
			throw { kind: "not_found", reason: "conversation_not_found" };
	}

	private async admit(params: DelegateParams): Promise<DelegateResult> {
		this.assertAdmissionOpen(params.conversationId);
		if (!params.toolCallId || params.toolCallId.length > 256)
			throw { kind: "validation_failed", reason: "tool_call_id_invalid" };
		const existing = () =>
			this.db
				.select({ id: runs.id, executorProfile: runs.executorProfile })
				.from(runs)
				.where(
					and(
						eq(runs.conversationId, params.conversationId),
						eq(runs.toolCallId, params.toolCallId),
					),
				)
				.get();
		const admitted = existing();
		if (admitted)
			return {
				accepted: true,
				runId: admitted.id,
				runnerId: admitted.executorProfile,
				executor: this.executorRouter.profileType(admitted.executorProfile),
			};
		const instruction = params.instruction.trim();
		if (!instruction)
			throw { kind: "validation_failed", reason: "external_agent_instruction_invalid" };
		const inputPaths = validateInputPaths(params.inputPaths);
		const profile = this.executorRouter.validateProfile(params.runnerId ?? "pi-default");
		const modelRoute =
			profile.type === "pi" ? await this.resolvePiModel(params.conversationId) : undefined;
		if (profile.type === "pi" && !modelRoute)
			throw { kind: "unavailable", reason: "pi_model_unavailable" };
		return this.enqueueEvent(() => {
			this.assertAdmissionOpen(params.conversationId);
			const duplicate = existing();
			if (duplicate)
				return {
					accepted: true as const,
					runId: duplicate.id,
					runnerId: duplicate.executorProfile,
					executor: this.executorRouter.profileType(duplicate.executorProfile),
				};
			const resourceOwners = this.db
				.select({ n: count() })
				.from(runs)
				.where(and(inArray(runs.status, EXECUTOR_RESOURCE_STATUSES), isNull(runs.completedAt)))
				.get();
			if (Number(resourceOwners?.n ?? 0) >= MAX_CONCURRENT_RUNS)
				throw { kind: "conflict", reason: "max_concurrent_runs" };
			const runId = randomUUID();
			this.db
				.insert(runs)
				.values({
					id: runId,
					conversationId: params.conversationId,
					triggerEntryId: params.triggerEntryId,
					toolCallId: params.toolCallId,
					executorProfile: profile.id,
					title:
						instruction
							.split(/\r?\n/)
							.find((line) => line.trim())
							?.trim()
							.slice(0, 80) ?? "Worker task",
					instruction,
					inputPaths,
					status: "enqueued",
				})
				.run();
			const launch = { cancelled: false, started: false, promise: Promise.resolve() };
			launch.promise = new Promise<void>((resolve) => setImmediate(resolve))
				.then(async () => {
					if (
						launch.cancelled ||
						this.closed ||
						this.deletingConversations.has(params.conversationId)
					) {
						launch.cancelled = true;
						return;
					}
					const row = this.getRun(runId);
					if (row.completedAt) return;
					const prepared = prepareRunDirectories(join(this.runRoot, runId), inputPaths);
					const paths = [...inputPaths, prepared.workspace, prepared.outputDirectory];
					launch.started = true;
					await this.executorRouter.launch(
						this.executorRun(row),
						{
							instruction: executionInstruction(
								instruction,
								prepared.inputs,
								prepared.outputDirectory,
							),
							workspace: prepared.workspace,
							outputDirectory: prepared.outputDirectory,
							readOnlyPaths: inputPaths,
							modelRoute,
						},
						(event) => {
							if (
								this.closed ||
								launch.cancelled ||
								this.deletingConversations.has(params.conversationId)
							)
								return;
							this.trackDetached(
								this.enqueueEvent(() =>
									this.applyExecutorEvent(
										runId,
										event,
										prepared.outputDirectory,
										prepared.canonicalOutputDirectory,
										paths,
									),
								).catch(() => {
									if (!this.closed && !this.deletingConversations.has(params.conversationId))
										this.recordEvidence(runId, "executor.event_failed", {
											reason: "executor_event_failed",
										});
								}),
							);
						},
						profile,
					);
				})
				.catch(async (error) => {
					if (
						launch.cancelled ||
						this.closed ||
						this.deletingConversations.has(params.conversationId)
					)
						return;
					await this.enqueueEvent(() => {
						if (this.getRun(runId).completedAt) return;
						const reason = safeExecutorFailureReason(safeReason(error, inputPaths));
						this.recordEvidence(runId, "executor.launch_failed", { reason });
						this.terminate(runId, "failed", reason);
					});
				})
				.finally(() => {
					if (!launch.cancelled) this.launches.delete(runId);
				});
			this.launches.set(runId, launch);
			// Startup failures stay attached to the admitted identity, never reject its receipt.
			void launch.promise.catch(() => undefined);
			this.changed(runId);
			return { accepted: true as const, runId, runnerId: profile.id, executor: profile.type };
		});
	}

	private async applyExecutorEvent(
		runId: string,
		event: ExecutorEvent,
		outputDirectory: string,
		canonicalOutputDirectory: string,
		paths: string[],
	): Promise<void> {
		const run = this.getRun(runId);
		try {
			this.observeExecutor?.(runId, run.conversationId, event);
		} catch {
			/* Diagnostics never controls execution. */
		}
		if (run.completedAt) return;
		switch (event.type) {
			case "restored":
				this.db
					.update(runs)
					.set({ status: "interrupted", permissionJson: null })
					.where(eq(runs.id, runId))
					.run();
				this.recordEvidence(runId, "run.restored", { executorProfile: run.executorProfile });
				this.changed(runId);
				return;
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
				this.recordEvidence(runId, event.kind, boundedEvidence(event.data, paths));
				return;
			case "needs_user":
				if (run.status === "running") {
					this.needsUser(runId, sanitizeText(event.prompt, paths), event.requestId, event.options);
				} else if (run.status !== "needs_user")
					throw { kind: "conflict", reason: "executor_needs_user_invalid_run_state" };
				return;
			case "completed": {
				if (this.closed || this.deletingConversations.has(run.conversationId)) {
					this.terminate(
						runId,
						this.closed ? "forced_termination" : "cancelled",
						"output_capture_stopped",
					);
					return;
				}
				const normalizedSummary = event.summary
					? sanitizeText(event.summary, paths).slice(0, 12_000)
					: null;
				this.captureResult(run, outputDirectory, canonicalOutputDirectory, normalizedSummary);
				return;
			}
			case "failed":
				this.terminate(runId, "failed", safeExecutorFailureReason(event.reason));
				return;
			case "cancelled":
				this.terminate(runId, "cancelled", event.reason ? safeReason(event.reason, paths) : null);
				return;
		}
	}

	private captureResult(
		run: RunRow,
		outputDirectory: string,
		canonicalOutputDirectory: string,
		summary: string | null,
	): void {
		if (
			this.closed ||
			this.deletingConversations.has(run.conversationId) ||
			this.captures.has(run.id)
		)
			return;
		const controller = new AbortController();
		const capture: OutputCapture = {
			conversationId: run.conversationId,
			controller,
			promise: Promise.resolve(),
		};
		// Completion has released the executor. Files are copied outside the
		// Run transition queue so other Runs can still be controlled while copying.
		capture.promise = captureArtifacts(
			this.artifacts,
			run.id,
			outputDirectory,
			canonicalOutputDirectory,
			this.captureLimits,
			controller.signal,
		)
			.then(() =>
				this.enqueueEvent(() => {
					if (
						!controller.signal.aborted &&
						!this.closed &&
						!this.deletingConversations.has(run.conversationId)
					)
						this.terminate(run.id, "completed", summary);
				}),
			)
			.catch(async (error) => {
				if (
					controller.signal.aborted ||
					this.closed ||
					this.deletingConversations.has(run.conversationId)
				)
					return;
				await this.enqueueEvent(() => {
					const reason = outputCaptureFailure(error);
					this.recordEvidence(run.id, "executor.failed", { reason });
					this.terminate(run.id, "failed", reason);
				});
			})
			.finally(() => this.captures.delete(run.id));
		this.captures.set(run.id, capture);
		this.trackDetached(capture.promise);
	}

	private terminate(runId: string, status: TerminalRunStatus, summary: string | null): RunSummary {
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
		void this.reconcileRun(runId);
		return result;
	}

	project(run: RunSummary): WireRun {
		const row = this.getRun(run.id);
		const permission = row.permissionJson ? RunPermission.safeParse(row.permissionJson) : undefined;
		const runtime = this.executorRouter.runtime(this.executorRun(row));
		const actions: NonNullable<WireRun["actions"]> = row.completedAt
			? []
			: runtime.actions.filter(
					(action) =>
						action === "cancel" ||
						(action === "resume" && row.status === "interrupted") ||
						(action === "respondPermission" && row.status === "needs_user") ||
						((action === "steer" || action === "interrupt") &&
							(row.status === "running" || row.status === "needs_user")),
				);
		if (!row.completedAt && this.launches.has(row.id) && !actions.includes("cancel"))
			actions.push("cancel");
		if (row.completedAt && !row.resultReportedAt && this.onTerminal) actions.push("retryDelivery");
		return {
			id: run.id,
			conversationId: run.conversationId,
			triggerEntryId: run.triggerEntryId,
			executorProfile: run.executorProfile,
			title: run.title,
			status: run.status,
			controller: runtime.controller,
			actions: this.closed || this.deletingConversations.has(row.conversationId) ? [] : actions,
			...(row.resultReportedAt ? { resultReportedAt: row.resultReportedAt } : {}),
			artifacts: this.artifacts.list(row.id).map((artifact) => ({
				id: artifact.id,
				name: artifact.logicalName,
				mime: artifact.mime,
				bytes: artifact.bytes,
				sha256: artifact.sha256,
				verification: artifact.verification,
				saved: artifact.saved,
				adopted: artifact.adopted,
				createdAt: artifact.createdAt,
			})),
			...(run.summary ? { summary: safeRunText(run.summary, 4_096) } : {}),
			evidence: this.db
				.select({ kind: evidence.kind, data: evidence.data, createdAt: evidence.createdAt })
				.from(evidence)
				.where(eq(evidence.runId, run.id))
				.orderBy(desc(sql`${evidence}.rowid`))
				.limit(20)
				.all()
				.reverse()
				.map((item) => {
					const summary = summarizeEvidence(item.data);
					const metadata = evidenceRecord(item.data);
					const status = metadata?.status;
					return {
						kind: safeRunText(item.kind, 128) || "evidence",
						...(typeof metadata?.title === "string" && metadata.title
							? { title: safeRunText(metadata.title, 128) }
							: {}),
						...(status === "pending" ||
						status === "in_progress" ||
						status === "completed" ||
						status === "failed"
							? { status }
							: {}),
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
		const wire = this.project(summarize(this.getRun(runId)));
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

	private reconcileRun(runId: string, options: ReconciliationAttemptOptions = {}): Promise<void> {
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
					row.resultReportedAt ||
					!this.onTerminal ||
					this.deletingConversations.has(row.conversationId)
				) {
					return;
				}
				const needsResultReport = !row.resultReportedAt;
				const delivery = Promise.resolve(
					this.onTerminal(
						{
							run: summarize(
								row,
								this.artifacts
									.list(row.id)
									.filter((artifact) => artifact.verification === "verified"),
							),
							needsResultReport,
						},
						controller.signal,
					),
				);
				this.trackDetached(delivery.then(() => undefined));
				const outcome = await waitForReconciliationAttempt(delivery, controller.signal, timeoutMs);
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
						this.changed(runId);
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
		await Promise.all(pending.map(({ id }) => this.reconcileRun(id, options)));
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
		const text = evidenceRecord(data)?.text;
		if (kind === "acp.message" && typeof text === "string") {
			const previous = this.db
				.select({ id: evidence.id, kind: evidence.kind, data: evidence.data })
				.from(evidence)
				.where(eq(evidence.runId, runId))
				.orderBy(desc(sql`${evidence}.rowid`))
				.limit(1)
				.get();
			const previousText = evidenceRecord(previous?.data)?.text;
			if (
				previous?.kind === kind &&
				typeof previousText === "string" &&
				Buffer.byteLength(previousText, "utf8") + Buffer.byteLength(text, "utf8") <= 4_096
			) {
				this.db
					.update(evidence)
					.set({
						data: boundedEvidence({ text: previousText + text }),
						createdAt: new Date().toISOString(),
					})
					.where(eq(evidence.id, previous.id))
					.run();
				this.changed(runId);
				return;
			}
		}
		const evidenceId = randomUUID();
		this.db
			.insert(evidence)
			.values({
				id: evidenceId,
				runId,
				kind: kind.slice(0, 128),
				data: boundedEvidence(data),
				createdAt: new Date().toISOString(),
			})
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
	private ownControl<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject({ kind: "unavailable", reason: "run_service_closed" });
		const task = operation();
		this.controls.set(task, runId);
		void task.then(
			() => this.controls.delete(task),
			() => this.controls.delete(task),
		);
		return task;
	}

	steerRun(runId: string, instruction: string): Promise<RunSteerResponse> {
		return this.ownControl(runId, () => this.performSteer(runId, instruction));
	}
	interruptRun(runId: string): Promise<RunSummary> {
		return this.ownControl(runId, () => this.performInterrupt(runId));
	}
	resumeRun(runId: string, instruction?: string): Promise<RunSummary> {
		return this.ownControl(runId, () => this.performResume(runId, instruction));
	}
	respondToExecutorPermission(
		runId: string,
		requestId: string,
		optionId: string,
	): Promise<RunSummary> {
		return this.ownControl(runId, () => this.performPermissionResponse(runId, requestId, optionId));
	}
	cancelRun(runId: string): Promise<RunSummary> {
		return this.ownControl(runId, () => this.performCancel(runId));
	}
	retryDelivery(runId: string): Promise<RunSummary> {
		return this.ownControl(runId, () => this.performRetryDelivery(runId));
	}

	private async performSteer(runId: string, instruction: string): Promise<RunSteerResponse> {
		if (!instruction.trim())
			throw { kind: "validation_failed", reason: "external_agent_instruction_invalid" };
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "running" && current.status !== "needs_user")
				throw { kind: "conflict", reason: "run_not_steerable" };
			this.assertAction(current, "steer");
			return current;
		});
		const receipt = await this.executorRouter.steer(this.executorRun(run), instruction);
		this.changed(runId);
		return receipt;
	}
	private async performInterrupt(runId: string): Promise<RunSummary> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "running" && current.status !== "needs_user")
				throw { kind: "conflict", reason: "run_not_interruptible" };
			this.assertAction(current, "interrupt");
			return current;
		});
		try {
			await this.executorRouter.interrupt(this.executorRun(run));
		} catch (error) {
			const current = await this.enqueueEvent(() => this.getRun(runId));
			if (current.completedAt) return summarize(current, this.artifacts.list(runId));
			throw error;
		}
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
	private async performResume(runId: string, instruction?: string): Promise<RunSummary> {
		if (instruction !== undefined && !instruction.trim())
			throw { kind: "validation_failed", reason: "external_agent_instruction_invalid" };
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "interrupted" || current.completedAt)
				throw { kind: "conflict", reason: "run_not_resumable" };
			this.assertAction(current, "resume");
			return current;
		});
		await this.executorRouter.resume(this.executorRun(run), undefined, instruction);
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
	private async performPermissionResponse(
		runId: string,
		requestId: string,
		optionId: string,
	): Promise<RunSummary> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (current.status !== "needs_user" || current.completedAt)
				throw { kind: "conflict", reason: "run_not_awaiting_permission" };
			this.assertAction(current, "respondPermission");
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
	private async performCancel(runId: string): Promise<RunSummary> {
		const run = await this.enqueueEvent(() => {
			const current = this.getRun(runId);
			if (
				current.completedAt ||
				!["enqueued", "running", "needs_user", "interrupted"].includes(current.status)
			)
				throw { kind: "conflict", reason: "run_not_cancellable" };
			this.assertAction(current, "cancel");
			const launch = this.launches.get(runId);
			if (launch) launch.cancelled = true;
			return current;
		});
		const launch = this.launches.get(runId);
		try {
			if (!launch || launch.started) await this.executorRouter.cancel(this.executorRun(run));
			if (launch) await launch.promise;
		} catch (error) {
			if (launch) launch.cancelled = false;
			throw error;
		}
		this.launches.delete(runId);
		return this.enqueueEvent(() => this.terminate(runId, "cancelled", null));
	}

	private assertAction(row: RunRow, action: NonNullable<WireRun["actions"]>[number]): void {
		if (this.closed || this.deletingConversations.has(row.conversationId))
			throw { kind: "unavailable", reason: "run_service_unavailable" };
		if (!this.project(summarize(row)).actions?.includes(action))
			throw { kind: "conflict", reason: `run_${action}_unavailable` };
	}

	assertConversationRun(conversationId: string, runId: string): void {
		if (this.getRun(runId).conversationId !== conversationId)
			throw { kind: "not_found", reason: "run_not_found" };
	}

	assertCharacterRun(companionId: string, runId: string): void {
		const row = this.getRun(runId);
		const owner = this.db
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(eq(conversations.id, row.conversationId), eq(conversations.companionId, companionId)),
			)
			.get();
		if (!owner) throw { kind: "not_found", reason: "run_not_found" };
	}

	private async performRetryDelivery(runId: string): Promise<RunSummary> {
		const row = this.getRun(runId);
		this.assertAction(row, "retryDelivery");
		await this.reconcileRun(runId);
		if (!this.getRun(runId).resultReportedAt)
			throw { kind: "unavailable", reason: "run_result_delivery_pending" };
		return summarize(this.getRun(runId), this.artifacts.list(runId));
	}

	getDetail(runId: string, request: Partial<RunGetRequest> = {}): RunGetResponse {
		const row = this.getRun(runId);
		const limit = pageLimit(request.limit);
		const cursor = decodeCursor(request.cursor);
		const rows = this.db
			.select()
			.from(evidence)
			.where(
				and(
					eq(evidence.runId, runId),
					cursor
						? lt(
								sql`${evidence}.rowid`,
								sql`(SELECT rowid FROM ${evidence} WHERE ${evidence.id} = ${cursor.id} AND ${evidence.runId} = ${runId})`,
							)
						: undefined,
				),
			)
			.orderBy(desc(sql`${evidence}.rowid`))
			.limit(limit + 1)
			.all();
		const page = rows.slice(0, limit);
		return {
			run: this.project(summarize(row)),
			provenance: this.provenance(row),
			instruction: safeRunText(row.instruction, Number.POSITIVE_INFINITY),
			inputPaths: row.inputPaths.map((path) => safeRunText(basename(path), 1_024)),
			evidence: page.map((item) => ({
				id: item.id,
				kind: safeRunText(item.kind, 128),
				createdAt: item.createdAt,
				data: boundedEvidence(item.data),
			})),
			...(rows.length > limit && page.length
				? { nextCursor: encodeCursor(page[page.length - 1]!) }
				: {}),
		};
	}

	private provenance(run: RunRow): RunGetResponse["provenance"] {
		const rows = this.db
			.select({
				manifest: sql<
					string | null
				>`CASE WHEN length(${runManifests.manifestJson}) <= 4096 THEN ${runManifests.manifestJson} ELSE NULL END`,
			})
			.from(runManifests)
			.where(eq(runManifests.runId, run.id))
			.orderBy(desc(sql`${runManifests}.rowid`))
			.limit(21)
			.all();
		const entries: RunGetResponse["provenance"]["entries"] = [];
		let unavailableCount = 0;
		for (const { manifest } of rows.slice(0, 20)) {
			const entry = projectRunManifest(manifest, run);
			if (entry) entries.push(entry);
			else unavailableCount++;
		}
		return { entries, unavailableCount, hasMore: rows.length > 20 };
	}

	listPage(companionId: string, request: RunListRequest = {}): RunListResponse {
		if (request.conversationId) {
			const owner = this.db
				.select({ id: conversations.id })
				.from(conversations)
				.where(
					and(
						eq(conversations.id, request.conversationId),
						eq(conversations.companionId, companionId),
					),
				)
				.get();
			if (!owner) throw { kind: "not_found", reason: "conversation_not_found" };
		}
		const page = this.listRows(companionId, request);
		return {
			runs: page.rows.map((row) => this.project(summarize(row))),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
		};
	}

	private listRows(
		companionId?: string,
		request: RunListRequest = {},
	): { rows: RunRow[]; nextCursor?: string } {
		const limit = pageLimit(request.limit);
		const cursor = decodeCursor(request.cursor);
		const owner = and(
			companionId ? eq(conversations.companionId, companionId) : undefined,
			request.conversationId ? eq(runs.conversationId, request.conversationId) : undefined,
		);
		const unfinished =
			request.scope === "history"
				? []
				: this.db
						.select({ run: runs })
						.from(runs)
						.innerJoin(conversations, eq(runs.conversationId, conversations.id))
						.where(
							and(
								owner,
								isNull(runs.completedAt),
								inArray(runs.status, EXECUTOR_RESOURCE_STATUSES),
							),
						)
						.orderBy(desc(runs.createdAt), desc(runs.id))
						.limit(101)
						.all()
						.map(({ run }) => run);
		if (unfinished.length > 100)
			throw { kind: "conflict", reason: "unfinished_run_capacity_exceeded" };
		if (request.scope === "unfinished") return { rows: unfinished };
		const history = this.db
			.select({ run: runs })
			.from(runs)
			.innerJoin(conversations, eq(runs.conversationId, conversations.id))
			.where(
				and(
					owner,
					isNotNull(runs.completedAt),
					cursor
						? or(
								lt(runs.createdAt, cursor.createdAt),
								and(eq(runs.createdAt, cursor.createdAt), lt(runs.id, cursor.id)),
							)
						: undefined,
				),
			)
			.orderBy(desc(runs.createdAt), desc(runs.id))
			.limit(limit + 1)
			.all()
			.map(({ run }) => run);
		const page = history.slice(0, limit);
		return {
			rows: [...unfinished, ...page],
			...(history.length > limit && page.length
				? { nextCursor: encodeCursor(page[page.length - 1]!) }
				: {}),
		};
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
		return this.listRows(companionId).rows.map((row) =>
			summarize(row, this.artifacts.list(row.id)),
		);
	}
	private trackDetached(task: Promise<void>): void {
		let trackedTask: Promise<void>;
		trackedTask = task
			.catch(() => undefined)
			.finally(() => {
				this.detachedTasks.delete(trackedTask);
			});
		this.detachedTasks.add(trackedTask);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		for (const launch of this.launches.values()) launch.cancelled = true;
		const completedExecutors = new Set(this.captures.keys());
		for (const capture of this.captures.values()) capture.controller.abort();
		this.closePromise = this.stopExecutorsAndDrain(completedExecutors).catch((error) => {
			// Keep admissions closed, but let the owning runtime retry resource release.
			this.closePromise = undefined;
			throw error;
		});
		return this.closePromise;
	}

	/** Called after stop/drain and before a character runtime is physically deleted. */
	assertRuntimeDeletable(): void {
		assertRuntimeDeletable(this.db);
	}

	private async stopExecutorsAndDrain(completedExecutors: ReadonlySet<string>): Promise<void> {
		await Promise.allSettled([...this.admissions]);
		const unfinished = await this.enqueueEvent(() =>
			this.db
				.select()
				.from(runs)
				.where(and(inArray(runs.status, UNRECOVERABLE_AFTER_RESTART), isNull(runs.completedAt)))
				.all(),
		);
		const attached = new Set<string>();
		const confirmedLost = new Set(completedExecutors);
		const ownedStartups = new Set(this.launches.keys());
		for (const row of unfinished) {
			if (ownedStartups.has(row.id)) {
				if (this.launches.get(row.id)?.started === false) confirmedLost.add(row.id);
				continue;
			}
			try {
				const recovery = await this.executorRouter.recover(this.executorRun(row));
				if (recovery === "attached") attached.add(row.id);
				if (recovery === "confirmed_lost") confirmedLost.add(row.id);
			} catch {
				// A failed probe has the same fail-closed meaning as unknown.
			}
		}

		let failure: unknown;
		const preserved = new Set<string>();
		try {
			for (const id of await this.executorRouter.suspend()) preserved.add(id);
		} catch (error) {
			failure = error;
		}
		await Promise.allSettled([...this.launches.values()].map((launch) => launch.promise));
		if (!failure) this.launches.clear();
		for (const attempt of this.reconciliationTasks.values()) attempt.controller.abort();
		await Promise.allSettled([...this.controls.keys()]);
		await this.drainDetachedTasks();
		const stoppableIds = [
			...confirmedLost,
			// Successful close proves release of attached handles and locally
			// owned startups, including those still awaiting an ACP session.
			...(failure ? [] : [...attached, ...ownedStartups].filter((id) => !preserved.has(id))),
		];
		await this.enqueueEvent(() => {
			for (const id of preserved)
				this.db
					.update(runs)
					.set({ status: "interrupted", permissionJson: null })
					.where(and(eq(runs.id, id), isNull(runs.completedAt)))
					.run();
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
		await this.events.onIdle();
		await Promise.allSettled([
			...attempts.map((attempt) => attempt.promise),
			...this.detachedTasks,
		]);
		this.reconciliationTasks.clear();
		this.detachedTasks.clear();
	}

	recoverUnfinishedRuns(): Promise<number> {
		this.recoveryPromise ??= this.recoverExecutors().finally(() => {
			this.recoveryPromise = undefined;
		});
		return this.recoveryPromise;
	}

	private async recoverExecutors(): Promise<number> {
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
				const prepared = prepareRunDirectories(join(this.runRoot, row.id), row.inputPaths);
				const recoveryIdentity = readAcpRecovery({
					run,
					profile: this.executorRouter.profile(row.executorProfile),
					task: {
						instruction: row.instruction,
						workspace: prepared.workspace,
						outputDirectory: prepared.outputDirectory,
					},
					emit() {},
				});
				const modelRoute =
					this.executorRouter.profileType(row.executorProfile) === "pi"
						? await this.resolvePiModel(row.conversationId, recoveryIdentity?.modelRoute)
						: undefined;
				recovery = await this.executorRouter.restore(
					run,
					{
						instruction: row.instruction,
						workspace: prepared.workspace,
						outputDirectory: prepared.outputDirectory,
						readOnlyPaths: row.inputPaths,
						modelRoute,
					},
					(event) => {
						if (this.closed || this.deletingConversations.has(row.conversationId)) return;
						this.trackDetached(
							this.enqueueEvent(() =>
								this.applyExecutorEvent(
									row.id,
									event,
									prepared.outputDirectory,
									prepared.canonicalOutputDirectory,
									[...row.inputPaths, prepared.workspace, prepared.outputDirectory],
								),
							),
						);
					},
				);
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
		this.deletingConversations.add(conversationId);
		const captures = [...this.captures].filter(
			([, capture]) => capture.conversationId === conversationId,
		);
		const completedExecutors = new Set(captures.map(([id]) => id));
		for (const [, capture] of captures) capture.controller.abort();
		await Promise.all(captures.map(([, capture]) => capture.promise));
		await Promise.allSettled([...this.admissions]);
		const owned = await this.enqueueEvent(() =>
			this.db.select().from(runs).where(eq(runs.conversationId, conversationId)).all(),
		);
		const unfinished = owned.filter(
			(row) => !row.completedAt && UNRECOVERABLE_AFTER_RESTART.includes(row.status as RunStatus),
		);
		const recordStopped = async (runId: string) => {
			await this.enqueueEvent(() => {
				this.db
					.update(runs)
					.set({
						status: "cancelled",
						permissionJson: null,
						completedAt: new Date().toISOString(),
						summary: "External agent execution stopped for conversation deletion.",
					})
					.where(and(eq(runs.id, runId), isNull(runs.completedAt)))
					.run();
				this.changed(runId);
			});
		};
		try {
			for (const row of unfinished) {
				if (completedExecutors.has(row.id)) {
					await recordStopped(row.id);
					continue;
				}
				const launch = this.launches.get(row.id);
				if (launch) launch.cancelled = true;
				if (launch?.started) {
					// A pending local launch owns its controller even before ACP
					// session creation makes recovery report attached.
					await this.executorRouter.cancel(this.executorRun(row));
					await this.executorRouter.stop(this.executorRun(row));
				} else if (!launch) {
					const run = this.executorRun(row);
					const recovery = await this.executorRouter.recover(run);
					if (recovery === "unknown") throw { kind: "conflict", reason: "run_controller_unknown" };
					if (recovery === "attached") await this.executorRouter.cancel(run);
					await this.executorRouter.stop(run);
				}
				if (launch) await launch.promise;
				this.launches.delete(row.id);
				await recordStopped(row.id);
			}
		} catch (error) {
			for (const row of unfinished) {
				const launch = this.launches.get(row.id);
				if (!launch) continue;
				if (launch.started) {
					launch.cancelled = false;
				} else {
					launch.cancelled = true;
					await launch.promise;
					this.launches.delete(row.id);
					await recordStopped(row.id);
				}
			}
			this.deletingConversations.delete(conversationId);
			throw error;
		}
		for (const row of owned) {
			const pending = this.reconciliationTasks.get(row.id);
			if (pending) {
				pending.controller.abort();
				await pending.promise;
			}
		}
		const ownedIds = new Set(owned.map((row) => row.id));
		await Promise.allSettled(
			[...this.controls].filter(([, id]) => ownedIds.has(id)).map(([task]) => task),
		);
		await this.events.onIdle();
		await this.enqueueEvent(() => {
			for (const { id } of owned) removeExternalAgentRunRoot(join(this.runRoot, id));
		});
	}
}

function pageLimit(limit: number | undefined): number {
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
		throw { kind: "validation_failed", reason: "run_page_limit_invalid" };
	return limit ?? 20;
}

function encodeCursor(row: { id: string; createdAt: string }): string {
	return Buffer.from(JSON.stringify([row.createdAt, row.id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
	if (cursor === undefined) return undefined;
	try {
		if (!cursor || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			!Array.isArray(value) ||
			value.length !== 2 ||
			typeof value[0] !== "string" ||
			typeof value[1] !== "string" ||
			value[0].length > 40 ||
			!Number.isFinite(Date.parse(value[0])) ||
			!value[1] ||
			value[1].length > 128
		)
			throw new Error();
		return { createdAt: value[0], id: value[1] };
	} catch {
		throw { kind: "validation_failed", reason: "run_cursor_invalid" };
	}
}

function boundedEvidence(
	value: unknown,
	paths: string[] = [],
): RunGetResponse["evidence"][number]["data"] {
	type Json = RunGetResponse["evidence"][number]["data"];
	const seen = new Set<object>();
	const visit = (item: unknown, depth: number): Json => {
		if (item === null || typeof item === "boolean") return item;
		if (typeof item === "number") return Number.isFinite(item) ? item : null;
		if (typeof item === "string") {
			const text = safeRunText(sanitizeText(item, paths), Number.POSITIVE_INFINITY).replace(
				/(?:[A-Za-z]:[\\/]|\/)[\w.-]+(?:[\\/][^\s"'<>]*)/g,
				"<redacted-path>",
			);
			return text;
		}
		if (!item || typeof item !== "object") return null;
		if (seen.has(item)) return "[circular]";
		seen.add(item);
		if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
		const result: Record<string, Json> = {};
		for (const [key, child] of Object.entries(item)) {
			const safeKey = safeRunText(key, 128);
			if (!safeKey || safeKey === "__proto__" || safeKey === "constructor") continue;
			result[safeKey] =
				/authorization|api.?key|token|secret|password|credential|environment|signature/i.test(key)
					? "<redacted>"
					: visit(child, depth + 1);
		}
		return result;
	};
	return visit(value, 0);
}

/**
 * Host-only teardown for ephemeral external-agent state. The walk is iterative
 * and uses lstat for every entry so links are unlinked, never traversed.
 */
export function removeExternalAgentRunRoot(runRoot: string): void {
	const root = resolve(runRoot);
	const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
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

/** Only adapter-owned launch facts cross the boundary; raw manifests and local paths never do. */
function projectRunManifest(
	encoded: string | null,
	run: RunRow,
): RunGetResponse["provenance"]["entries"][number] | undefined {
	if (encoded === null) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(encoded);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const manifest = value as Record<string, unknown>;
	if (
		manifest.schemaVersion !== 1 ||
		(manifest.executor !== "pi-acp" &&
			manifest.executor !== "codex" &&
			manifest.executor !== "custom") ||
		manifest.runId !== run.id ||
		manifest.profileId !== run.executorProfile ||
		typeof manifest.profileId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(manifest.profileId) ||
		typeof manifest.launchedAt !== "string" ||
		manifest.launchedAt.length > 64 ||
		!Number.isFinite(Date.parse(manifest.launchedAt))
	)
		return undefined;
	const entry: RunGetResponse["provenance"]["entries"][number] = {
		executor: manifest.executor,
		profileId: manifest.profileId,
		launchedAt: new Date(manifest.launchedAt).toISOString(),
	};
	if (manifest.executor === "codex") {
		if (
			typeof manifest.version === "string" &&
			manifest.version.length <= 128 &&
			/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)
		)
			entry.version = manifest.version;
		if (typeof manifest.sha256 === "string" && /^[a-f0-9]{64}$/.test(manifest.sha256))
			entry.sha256 = manifest.sha256;
	}
	return entry;
}

function reconciliationError(error: unknown): string {
	if (error instanceof Error) return error.message.slice(0, 1_024);
	if (typeof error === "object" && error !== null && "reason" in error) {
		return String(error.reason).slice(0, 1_024);
	}
	return String(error).slice(0, 1_024);
}

export function externalAgentResultMessage(result: Pick<TerminalRunResult, "run">): string {
	const title = sanitizeExternalAgentMemoryText(result.run.title, 512);
	const summary = sanitizeExternalAgentMemoryText(result.run.summary ?? "No result text.", 4_000);
	const artifacts = result.run.artifacts
		.slice(0, 50)
		.map((output) => sanitizeExternalAgentMemoryText(output.logicalName, 256));
	return sanitizeExternalAgentMemoryText(
		[
			`External work ${result.run.status}: ${title}`,
			`Run: ${safeRunText(result.run.id, 128)} · Executor: ${safeRunText(result.run.executorProfile, 128)}`,
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

const SAFE_EVIDENCE_KEYS = [
	"kind",
	"name",
	"status",
	"title",
	"text",
	"message",
	"reason",
	"toolName",
	"used",
	"size",
	"cost",
] as const;

function evidenceRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function evidenceText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const record = evidenceRecord(value);
	if (!record) return undefined;
	if (Array.isArray(record.content))
		return record.content
			.map((part) => {
				const block = evidenceRecord(part);
				return block?.type === "text" && typeof block.text === "string" ? block.text : "";
			})
			.filter(Boolean)
			.join("\n");
	return undefined;
}

function summarizeEvidence(data: unknown): string | undefined {
	if (typeof data === "string" || typeof data === "number" || typeof data === "boolean")
		return safeRunText(String(data), 512) || undefined;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	const output = evidenceText(record.rawOutput);
	const input = evidenceRecord(record.rawInput);
	const content =
		output ||
		record.errorMessage ||
		record.finalError ||
		record.message ||
		record.text ||
		record.reason ||
		input?.command ||
		input?.path;
	if (typeof content === "string" && content) return safeRunText(content, 512) || undefined;
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
		);
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
	if (new Set(paths).size !== paths.length)
		throw { kind: "validation_failed", reason: "input_paths_invalid" };
	return paths.map((path) => {
		if (!isAbsolute(path)) throw { kind: "validation_failed", reason: "input_path_invalid" };
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

function sanitizeText(value: string, paths: string[]): string {
	let text = stripControlSequences(value);
	for (const path of [...paths].sort((a, b) => b.length - a.length))
		text = text.split(path).join(path.endsWith("outputs") ? "<outputs>" : "<workspace>");
	return text;
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
		/^(?:acp_executor_failed|acp_start_failed|acp_process_spawn_failed|acp_process_stdio_failed|acp_agent_terminated_by_signal|acp_agent_exit_unknown|runner_startup_timeout|runner_authentication_required|runner_auth_method_unavailable|runner_credential_missing|runner_recovery_unsupported|runner_final_result_missing)$/.test(
			reason,
		) ||
		/^acp_agent_exit_code:-?\d{1,10}$/.test(reason)
	)
		return reason;
	return "executor_failed";
}
