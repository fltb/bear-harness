/**
 * CommissionService — action drafts, approval, run FSM, and result adoption.
 *
 * The commission is the user's intent boundary: a draft is hashed at creation
 * (draft_hash over the canonical draft fields), the user approves that exact
 * hash, and only approved commissions may launch runs. The run is the
 * executor's truth: at most MAX_ACTIVE_RUNS runs may be active
 * (enqueued/running/needs_user), terminal statuses set completed_at, and
 * `interrupted` without completed_at remains resumable. Steering is a pure
 * signal — no state change — while needs_user/interrupt/resume/cancel move
 * the run FSM.
 *
 * Every transition commits to the canonical DB first, then publishes on the
 * event bus. All failures throw `{ kind, reason }`, surfaced as
 * `{ ok: false, error }` by the IPC router.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type {
	ExecutorCommission,
	ExecutorEvent,
	ExecutorPermissionOption,
	ExecutorRouter,
	ExecutorRun,
} from "../executors/router.js";
import type { AppDatabase } from "../storage/database.js";
import type { EventBus } from "../storage/event-bus.js";
import {
	approvals,
	type CommissionDraftData,
	commissions,
	conversations,
	evidence,
	messages,
	runs,
} from "../storage/schema.js";

/** Max runs that may be active at once (enqueued/running/needs_user). */
export const MAX_ACTIVE_RUNS = 2;

export type CommissionStatus =
	| "draft"
	| "awaiting_approval"
	| "approved"
	| "queued"
	| "running"
	| "needs_user"
	| "completed"
	| "failed"
	| "cancelled";

export type RunStatus =
	| "enqueued"
	| "running"
	| "needs_user"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "forced_termination";

/** Statuses completeRun may land a run in. */
export type TerminalRunStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	| "forced_termination";

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["enqueued", "running", "needs_user"];

export interface CommissionDraftParams {
	triggerMessageId: string;
	conversationId: string;
	title: string;
	description: string;
	reads?: string[];
	writes?: string[];
	networkAllowed?: boolean;
	toolNames?: string[];
}

export interface CommissionDraftResult {
	commissionId: string;
	draftHash: string;
}

export interface CommissionLaunchParams {
	commissionId: string;
	executorProfile: string;
}

export interface CommissionLaunchResult {
	runId: string;
	commissionId: string;
	executorProfile: string;
	status: RunStatus;
}

export interface RunSummary {
	id: string;
	commissionId: string;
	executorProfile: string;
	status: RunStatus;
	startedAt: string | null;
	completedAt: string | null;
}

export interface DraftSummary {
	id: string;
	title: string;
	description: string;
	reads: string[];
	writes: string[];
	networkAllowed: boolean;
	toolNames: string[];
	hash: string;
}

export interface CommissionSummary {
	id: string;
	triggerMessageId: string;
	conversationId: string | null;
	status: CommissionStatus;
	draft: DraftSummary;
	draftHash: string;
	createdAt: string;
	runs: RunSummary[];
}

export interface CommissionListParams {
	status?: CommissionStatus;
	/** Restrict projections to commissions owned by this active companion. */
	companionId?: string;
}

/** Draft fields stored in commissions.draft_json (snake_case columns below). */
interface DraftPayload extends CommissionDraftData {
	conversationId: string;
	title: string;
	description: string;
	reads: string[];
	writes: string[];
	networkAllowed: boolean;
	toolNames: string[];
}

type CommissionRow = {
	id: string;
	conversationId: string | null;
	triggerMessageId: string;
	status: CommissionStatus;
	draftJson: DraftPayload;
	approvalHash: string | null;
	createdAt: string;
};

type RunRow = {
	id: string;
	commissionId: string;
	executorProfile: string;
	status: RunStatus;
	startedAt: string | null;
	completedAt: string | null;
};

/** Row shape for `SELECT COUNT(*) AS n` queries. */
export class CommissionService {
	private db: AppDatabase;
	private eventBus: EventBus;
	private artifactStore: ArtifactStore;
	private executorRouter: ExecutorRouter;

	constructor(
		db: AppDatabase,
		eventBus: EventBus,
		artifactStore: ArtifactStore,
		executorRouter: ExecutorRouter,
	) {
		this.db = db;
		this.eventBus = eventBus;
		this.artifactStore = artifactStore;
		this.executorRouter = executorRouter;
	}

	/** Fetch a commission row, throwing not_found when missing. */
	private getCommission(commissionId: string): CommissionRow {
		const row = this.db.select().from(commissions).where(eq(commissions.id, commissionId)).get() as
			| CommissionRow
			| undefined;
		if (!row) throw { kind: "not_found", reason: "commission_not_found" };
		return row;
	}

	/** Fetch a run row, throwing not_found when missing. */
	private getRun(runId: string): RunRow {
		const row = this.db.select().from(runs).where(eq(runs.id, runId)).get() as RunRow | undefined;
		if (!row) throw { kind: "not_found", reason: "run_not_found" };
		return row;
	}

	/** Parse stored draft JSON with defensive defaults for legacy rows. */
	private parseDraft(draft: DraftPayload): DraftPayload {
		return draft;
	}

	/** Map a run row to its public summary shape. */
	private summarizeRun(row: RunRow): RunSummary {
		return {
			id: row.id,
			commissionId: row.commissionId,
			executorProfile: row.executorProfile,
			status: row.status,
			startedAt: row.startedAt,
			completedAt: row.completedAt,
		};
	}

	/** Convert a persisted run row to the narrow executor command shape. */
	private executorRun(row: RunRow): ExecutorRun {
		return {
			runId: row.id,
			commissionId: row.commissionId,
			executorProfile: row.executorProfile,
		};
	}

	/** Persist executor-produced evidence through the Host's canonical boundary. */
	private recordExecutorEvidence(runId: string, kind: string, data: unknown): void {
		const evidenceId = randomUUID();
		this.db.insert(evidence).values({ id: evidenceId, runId, kind, data }).run();
		this.eventBus.publish("evidence.collected", { runId, evidenceId, kind });
	}

	/**
	 * Accept an event emitted by the profile router. Controllers cannot update
	 * runs or evidence themselves; every accepted event is validated against
	 * the Host's FSM before persistence.
	 */
	handleExecutorEvent(runId: string, event: ExecutorEvent): void {
		const run = this.getRun(runId);
		if (run.completedAt !== null) return;

		switch (event.type) {
			case "started":
				if (run.status === "enqueued") this.startRun(runId);
				else if (run.status !== "running") {
					throw { kind: "conflict", reason: "executor_started_invalid_run_state" };
				}
				return;
			case "evidence":
				if (event.kind.length === 0 || event.kind.length > 128) {
					throw { kind: "validation_failed", reason: "executor_evidence_kind_invalid" };
				}
				this.recordExecutorEvidence(runId, event.kind, event.data);
				return;
			case "needs_user":
				if (run.status === "running")
					this.needsUser(runId, event.prompt, event.requestId, event.options);
				else if (run.status !== "needs_user") {
					throw { kind: "conflict", reason: "executor_needs_user_invalid_run_state" };
				}
				if (event.requestId) {
					this.recordExecutorEvidence(runId, "executor.permission_requested", {
						requestId: event.requestId,
						prompt: event.prompt,
						options: event.options ?? [],
					});
				}
				return;
			case "completed":
				if (run.status !== "running" && run.status !== "needs_user") {
					throw { kind: "conflict", reason: "executor_completed_invalid_run_state" };
				}
				if (event.summary)
					this.recordExecutorEvidence(runId, "executor.summary", { text: event.summary });
				this.collectRunArtifacts(runId, this.getCommission(run.commissionId));
				this.completeRun(runId, "completed");
				return;
			case "failed":
				this.recordExecutorEvidence(runId, "executor.failed", { reason: event.reason });
				this.completeRun(runId, "failed");
				return;
			case "cancelled":
				if (event.reason)
					this.recordExecutorEvidence(runId, "executor.cancelled", { reason: event.reason });
				this.completeRun(runId, "cancelled");
				return;
		}
	}

	private collectRunArtifacts(runId: string, commission: CommissionRow): void {
		const draft = this.parseDraft(commission.draftJson);
		let files = 0;
		let bytes = 0;
		const visit = (path: string): void => {
			if (files >= 50 || bytes >= 200 * 1024 * 1024) return;
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(path);
			} catch {
				return;
			}
			if (stat.isSymbolicLink()) return;
			if (stat.isDirectory()) {
				for (const entry of readdirSync(path, { withFileTypes: true })) {
					if (entry.isSymbolicLink()) continue;
					visit(join(path, entry.name));
				}
				return;
			}
			if (!stat.isFile() || stat.size > 50 * 1024 * 1024 || bytes + stat.size > 200 * 1024 * 1024)
				return;
			try {
				const artifact = this.artifactStore.create({
					logicalName: basename(path),
					buffer: readFileSync(path),
					mime: mimeForPath(path),
					producerRunId: runId,
				});
				this.artifactStore.markVerified(artifact.id);
				files += 1;
				bytes += stat.size;
				this.eventBus.publish("artifact.created", { artifactId: artifact.id, runId });
			} catch {
				this.recordExecutorEvidence(runId, "artifact.collection_failed", {
					path: basename(path),
				});
			}
		};
		for (const path of draft.writes) visit(path);
	}

	// -----------------------------------------------------------------------
	// Action drafts & approval
	// -----------------------------------------------------------------------

	/**
	 * Draft a new action. The hash covers the canonical draft fields only
	 * (no id/timestamp), so the user can approve the exact text they saw.
	 */
	draft(params: CommissionDraftParams): CommissionDraftResult {
		const trigger = this.db
			.select({
				id: messages.id,
				conversationId: messages.conversationId,
				role: messages.role,
			})
			.from(messages)
			.where(eq(messages.id, params.triggerMessageId))
			.get();
		if (!trigger || trigger.role !== "user" || trigger.conversationId !== params.conversationId) {
			throw { kind: "validation_failed", reason: "commission_trigger_message_invalid" };
		}
		const draft: DraftPayload = {
			conversationId: params.conversationId,
			title: params.title,
			description: params.description,
			reads: params.reads ?? [],
			writes: params.writes ?? [],
			networkAllowed: params.networkAllowed ?? false,
			toolNames: params.toolNames ?? [],
		};
		const draftHash = createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex");
		const commissionId = randomUUID();
		this.db
			.insert(commissions)
			.values({
				id: commissionId,
				triggerMessageId: params.triggerMessageId,
				conversationId: draft.conversationId,
				status: "draft",
				draftJson: draft,
				approvalHash: draftHash,
			})
			.run();
		this.eventBus.publish("commission.drafted", { commissionId, draftHash });
		return { commissionId, draftHash };
	}

	/** Approve the draft for the exact hash the user was shown. */
	approve(commissionId: string, approvedHash: string): void {
		const commission = this.getCommission(commissionId);
		if (commission.status !== "draft") {
			throw { kind: "conflict", reason: "commission_not_draft" };
		}
		if (commission.approvalHash !== approvedHash) {
			throw { kind: "conflict", reason: "draft_hash_mismatch" };
		}
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		this.db.transaction((transaction) => {
			transaction
				.update(commissions)
				.set({ status: "approved" })
				.where(eq(commissions.id, commissionId))
				.run();
			transaction
				.insert(approvals)
				.values({ id: randomUUID(), commissionId, draftHash: approvedHash, expiresAt })
				.run();
		});
		this.eventBus.publish("commission.approved", { commissionId, draftHash: approvedHash });
	}

	/** Reject a pending commission (draft/awaiting_approval/approved). */
	reject(commissionId: string): void {
		const commission = this.getCommission(commissionId);
		if (
			commission.status !== "draft" &&
			commission.status !== "awaiting_approval" &&
			commission.status !== "approved"
		) {
			throw { kind: "conflict", reason: "commission_not_rejectable" };
		}
		this.db
			.update(commissions)
			.set({ status: "cancelled" })
			.where(eq(commissions.id, commissionId))
			.run();
		this.eventBus.publish("commission.rejected", { commissionId });
	}

	// -----------------------------------------------------------------------
	// Run FSM
	// -----------------------------------------------------------------------

	/**
	 * Create an enqueued run, then hand it to the selected profile controller.
	 * The controller's first accepted event moves the run to `running`; a
	 * failed hand-off is persisted as a terminal failed run before surfacing
	 * the launcher error to the caller.
	 */
	async launch(params: CommissionLaunchParams): Promise<CommissionLaunchResult> {
		const launch = this.db.transaction((transaction) => {
			const activeRow = transaction
				.select({ n: count() })
				.from(runs)
				.where(inArray(runs.status, ACTIVE_RUN_STATUSES))
				.get();
			if ((activeRow?.n ?? 0) >= MAX_ACTIVE_RUNS) {
				throw { kind: "conflict", reason: "max_active_runs" };
			}

			const commissionRow = transaction
				.select()
				.from(commissions)
				.where(eq(commissions.id, params.commissionId))
				.get() as CommissionRow | undefined;
			if (!commissionRow) throw { kind: "not_found", reason: "commission_not_found" };
			if (commissionRow.status !== "approved") {
				throw { kind: "conflict", reason: "commission_not_approved" };
			}
			// Validate the persisted profile before inserting the run. Controller
			// wiring is deliberately checked at hand-off so an unwired profile
			// still gets a failed run record and remains observable for recovery.
			this.executorRouter.validateProfile(params.executorProfile);

			const id = randomUUID();
			transaction
				.insert(runs)
				.values({
					id,
					commissionId: params.commissionId,
					executorProfile: params.executorProfile,
					status: "enqueued",
				})
				.run();
			transaction
				.update(commissions)
				.set({ status: "queued" })
				.where(eq(commissions.id, params.commissionId))
				.run();

			const draft = this.parseDraft(commissionRow.draftJson);
			const run: ExecutorRun = {
				runId: id,
				commissionId: params.commissionId,
				executorProfile: params.executorProfile,
			};
			const commission: ExecutorCommission = {
				id: params.commissionId,
				title: draft.title,
				description: draft.description,
				reads: draft.reads,
				writes: draft.writes,
				networkAllowed: draft.networkAllowed,
				toolNames: draft.toolNames,
			};
			return { run, commission };
		});

		this.eventBus.publish("run.enqueued", {
			runId: launch.run.runId,
			commissionId: launch.run.commissionId,
			executorProfile: launch.run.executorProfile,
			status: "enqueued",
		});
		this.eventBus.publish("commission.status_changed", {
			commissionId: launch.run.commissionId,
			status: "queued",
		});

		try {
			await this.executorRouter.launch(launch.run, launch.commission, (event) => {
				this.handleExecutorEvent(launch.run.runId, event);
			});
		} catch (error) {
			const reason =
				error && typeof error === "object" && "reason" in error && typeof error.reason === "string"
					? error.reason
					: "executor_launch_failed";
			this.recordExecutorEvidence(launch.run.runId, "executor.launch_failed", { reason });
			if (this.getRun(launch.run.runId).completedAt === null) {
				this.completeRun(launch.run.runId, "failed");
			}
			throw error;
		}

		const run = this.getRun(launch.run.runId);
		return {
			runId: run.id,
			commissionId: run.commissionId,
			executorProfile: run.executorProfile,
			status: run.status,
		};
	}

	/** Start an enqueued run: status → running, started_at set. */
	startRun(runId: string): RunSummary {
		const run = this.getRun(runId);
		if (run.status !== "enqueued") {
			throw { kind: "conflict", reason: "run_not_startable" };
		}
		this.db
			.update(runs)
			.set({ status: "running", startedAt: new Date().toISOString() })
			.where(eq(runs.id, runId))
			.run();
		this.db
			.update(commissions)
			.set({ status: "running" })
			.where(eq(commissions.id, run.commissionId))
			.run();
		this.eventBus.publish("run.started", { runId });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commissionId,
			status: "running",
		});
		return this.summarizeRun(this.getRun(runId));
	}

	/** Land a run in a terminal status with completed_at (idempotence guard). */
	completeRun(runId: string, terminalStatus: TerminalRunStatus): RunSummary {
		const run = this.getRun(runId);
		if (run.completedAt !== null) {
			throw { kind: "conflict", reason: "run_already_terminated" };
		}
		this.db
			.update(runs)
			.set({ status: terminalStatus, completedAt: new Date().toISOString() })
			.where(eq(runs.id, runId))
			.run();
		const commissionStatus: CommissionStatus =
			terminalStatus === "completed"
				? "completed"
				: terminalStatus === "cancelled"
					? "cancelled"
					: "failed";
		this.db
			.update(commissions)
			.set({ status: commissionStatus })
			.where(eq(commissions.id, run.commissionId))
			.run();
		this.eventBus.publish("run.completed", { runId, status: terminalStatus });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commissionId,
			status: commissionStatus,
		});
		return this.summarizeRun(this.getRun(runId));
	}

	/** Pause a running run for user input. */
	needsUser(
		runId: string,
		prompt: string,
		requestId?: string,
		options: ExecutorPermissionOption[] = [],
	): RunSummary {
		const run = this.getRun(runId);
		if (run.status !== "running") {
			throw { kind: "conflict", reason: "run_not_active" };
		}
		this.db.update(runs).set({ status: "needs_user" }).where(eq(runs.id, runId)).run();
		this.db
			.update(commissions)
			.set({ status: "needs_user" })
			.where(eq(commissions.id, run.commissionId))
			.run();
		this.eventBus.publish("run.needs_user", { runId, prompt, requestId, options });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commissionId,
			status: "needs_user",
		});
		return this.summarizeRun(this.getRun(runId));
	}

	/** Send a steering instruction to an active run (no state change). */
	async steerRun(runId: string, instruction: string): Promise<void> {
		const run = this.getRun(runId);
		if (run.status !== "running" && run.status !== "needs_user") {
			throw { kind: "conflict", reason: "run_not_steerable" };
		}
		await this.executorRouter.steer(this.executorRun(run), instruction);
		this.eventBus.publish("run.steered", { runId, instruction });
	}

	/** Interrupt an active run. Stays resumable (completed_at left null). */
	async interruptRun(runId: string): Promise<RunSummary> {
		const run = this.getRun(runId);
		if (run.status !== "running" && run.status !== "needs_user") {
			throw { kind: "conflict", reason: "run_not_interruptible" };
		}
		await this.executorRouter.interrupt(this.executorRun(run));
		this.db.update(runs).set({ status: "interrupted" }).where(eq(runs.id, runId)).run();
		this.eventBus.publish("run.interrupted", { runId });
		return this.summarizeRun(this.getRun(runId));
	}

	/** Resume an interrupted (or user-paused) run back to running. */
	async resumeRun(runId: string): Promise<RunSummary> {
		const run = this.getRun(runId);
		const resumable =
			(run.status === "interrupted" || run.status === "needs_user") && run.completedAt === null;
		if (!resumable) {
			throw { kind: "conflict", reason: "run_not_resumable" };
		}
		// Re-prompt a paused executor turn (no permission response involved);
		// permission-paused runs are resumed via respondToExecutorPermission,
		// which already routed the response before calling resumeRun.
		if (run.status === "interrupted") {
			await this.executorRouter.resume(this.executorRun(run));
		}
		this.db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();
		this.db
			.update(commissions)
			.set({ status: "running" })
			.where(eq(commissions.id, run.commissionId))
			.run();
		this.eventBus.publish("run.resumed", { runId });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commissionId,
			status: "running",
		});
		return this.summarizeRun(this.getRun(runId));
	}

	/** Resolve an ACP permission request and resume the paused executor turn. */
	async respondToExecutorPermission(
		runId: string,
		requestId: string,
		optionId: string,
	): Promise<RunSummary> {
		const run = this.getRun(runId);
		if (run.status !== "needs_user" || run.completedAt !== null) {
			throw { kind: "conflict", reason: "run_not_awaiting_permission" };
		}
		await this.executorRouter.resume(this.executorRun(run), { requestId, optionId });
		return this.resumeRun(runId);
	}

	/** Cancel an active or transient run (terminal, completed_at set). */
	async cancelRun(runId: string): Promise<RunSummary> {
		const run = this.getRun(runId);
		const cancellable =
			run.completedAt === null &&
			(run.status === "enqueued" ||
				run.status === "running" ||
				run.status === "needs_user" ||
				run.status === "interrupted");
		if (!cancellable) {
			throw { kind: "conflict", reason: "run_not_cancellable" };
		}
		await this.executorRouter.cancel(this.executorRun(run));
		this.db
			.update(runs)
			.set({ status: "cancelled", completedAt: new Date().toISOString() })
			.where(eq(runs.id, runId))
			.run();
		this.db
			.update(commissions)
			.set({ status: "cancelled" })
			.where(eq(commissions.id, run.commissionId))
			.run();
		this.eventBus.publish("run.cancelled", { runId });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commissionId,
			status: "cancelled",
		});
		return this.summarizeRun(this.getRun(runId));
	}

	/** Number of runs currently sitting in the enqueued queue. */
	queue(): number {
		const row = this.db.select({ n: count() }).from(runs).where(eq(runs.status, "enqueued")).get();
		return row?.n ?? 0;
	}

	/** List commissions (optionally by status and active-companion ownership) with runs and draft summary. */
	list(params: CommissionListParams = {}): CommissionSummary[] {
		const statusFilter = params.status ? eq(commissions.status, params.status) : undefined;
		const rows = params.companionId
			? (this.db
					.select({
						id: commissions.id,
						conversationId: commissions.conversationId,
						triggerMessageId: commissions.triggerMessageId,
						status: commissions.status,
						draftJson: commissions.draftJson,
						approvalHash: commissions.approvalHash,
						createdAt: commissions.createdAt,
					})
					.from(commissions)
					.innerJoin(conversations, eq(commissions.conversationId, conversations.id))
					.innerJoin(
						messages,
						and(
							eq(messages.id, commissions.triggerMessageId),
							eq(messages.conversationId, commissions.conversationId),
							eq(messages.role, "user"),
						),
					)
					.where(and(eq(conversations.companionId, params.companionId), statusFilter))
					.orderBy(desc(commissions.createdAt), desc(commissions.id))
					.all() as CommissionRow[])
			: (this.db
					.select()
					.from(commissions)
					.where(statusFilter)
					.orderBy(desc(commissions.createdAt), desc(commissions.id))
					.all() as CommissionRow[]);
		return rows
			.filter(
				(row): row is CommissionRow & { triggerMessageId: string } =>
					typeof row.triggerMessageId === "string" && row.triggerMessageId.trim().length > 0,
			)
			.map((row) => {
				const draft = this.parseDraft(row.draftJson);
				const draftHash = row.approvalHash ?? "";
				const commissionRuns = this.db
					.select()
					.from(runs)
					.where(eq(runs.commissionId, row.id))
					.orderBy(asc(runs.createdAt), asc(runs.id))
					.all() as RunRow[];
				return {
					id: row.id,
					triggerMessageId: row.triggerMessageId,
					conversationId: row.conversationId,
					status: row.status,
					draft: {
						id: row.id,
						title: draft.title,
						description: draft.description,
						reads: draft.reads,
						writes: draft.writes,
						networkAllowed: draft.networkAllowed,
						toolNames: draft.toolNames,
						hash: draftHash,
					},
					draftHash,
					createdAt: row.createdAt,
					runs: commissionRuns.map((run) => this.summarizeRun(run)),
				};
			});
	}

	// -----------------------------------------------------------------------
	// Result adoption
	// -----------------------------------------------------------------------

	/**
	 * User adopts an artifact produced by a run. Independent of run
	 * completion — the user may adopt a result from an interrupted or even
	 * failed run.
	 */
	adoptResult(commissionId: string, artifactId: string, runId: string): void {
		const run = this.getRun(runId);
		if (run.commissionId !== commissionId) {
			throw { kind: "conflict", reason: "run_commission_mismatch" };
		}
		if (!this.artifactStore.get(artifactId)) {
			throw { kind: "not_found", reason: "artifact_not_found" };
		}
		this.artifactStore.markAdopted(artifactId, runId);
		this.eventBus.publish("run.result_adopted", { commissionId, artifactId, runId });
	}
}

function mimeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".json":
			return "application/json";
		case ".html":
			return "text/html";
		case ".css":
			return "text/css";
		case ".csv":
			return "text/csv";
		case ".md":
			return "text/markdown";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}
