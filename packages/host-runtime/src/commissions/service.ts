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
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactStore } from "../artifacts/index.js";
import type {
	ExecutorCommission,
	ExecutorEvent,
	ExecutorPermissionOption,
	ExecutorRouter,
	ExecutorRun,
} from "../executors/router.js";
import type { EventBus } from "../storage/event-bus.js";

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
	conversationId: string | null;
	status: CommissionStatus;
	draft: DraftSummary;
	draftHash: string;
	createdAt: string;
	runs: RunSummary[];
}

export interface CommissionListParams {
	status?: CommissionStatus;
}

/** Draft fields stored in commissions.draft_json (snake_case columns below). */
interface DraftPayload {
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
	conversation_id: string | null;
	status: CommissionStatus;
	draft_json: string;
	approval_hash: string | null;
	created_at: string;
};

type RunRow = {
	id: string;
	commission_id: string;
	executor_profile: string;
	status: RunStatus;
	started_at: string | null;
	completed_at: string | null;
};

/** Row shape for `SELECT COUNT(*) AS n` queries. */
type CountRow = {
	n: number;
};

export class CommissionService {
	private db: DatabaseSync;
	private eventBus: EventBus;
	private artifactStore: ArtifactStore;
	private executorRouter: ExecutorRouter;

	constructor(
		db: DatabaseSync,
		eventBus: EventBus,
		artifactStore: ArtifactStore,
		executorRouter: ExecutorRouter,
	) {
		this.db = db;
		this.eventBus = eventBus;
		this.artifactStore = artifactStore;
		this.executorRouter = executorRouter;
	}

	/** Run fn inside a BEGIN IMMEDIATE transaction; roll back on any throw. */
	private withTransaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	/** Fetch a commission row, throwing not_found when missing. */
	private getCommission(commissionId: string): CommissionRow {
		const row = this.db
			.prepare(
				`SELECT id, conversation_id, status, draft_json, approval_hash, created_at
				 FROM commissions WHERE id = ?`,
			)
			.get(commissionId) as CommissionRow | undefined;
		if (!row) throw { kind: "not_found", reason: "commission_not_found" };
		return row;
	}

	/** Fetch a run row, throwing not_found when missing. */
	private getRun(runId: string): RunRow {
		const row = this.db
			.prepare(
				`SELECT id, commission_id, executor_profile, status, started_at, completed_at
				 FROM runs WHERE id = ?`,
			)
			.get(runId) as RunRow | undefined;
		if (!row) throw { kind: "not_found", reason: "run_not_found" };
		return row;
	}

	/** Parse stored draft JSON with defensive defaults for legacy rows. */
	private parseDraft(json: string): DraftPayload {
		const raw = JSON.parse(json) as Partial<DraftPayload> | null;
		return {
			conversationId: typeof raw?.conversationId === "string" ? raw.conversationId : "",
			title: typeof raw?.title === "string" ? raw.title : "",
			description: typeof raw?.description === "string" ? raw.description : "",
			reads: Array.isArray(raw?.reads) ? raw.reads : [],
			writes: Array.isArray(raw?.writes) ? raw.writes : [],
			networkAllowed: typeof raw?.networkAllowed === "boolean" ? raw.networkAllowed : false,
			toolNames: Array.isArray(raw?.toolNames) ? raw.toolNames : [],
		};
	}

	/** Map a run row to its public summary shape. */
	private summarizeRun(row: RunRow): RunSummary {
		return {
			id: row.id,
			commissionId: row.commission_id,
			executorProfile: row.executor_profile,
			status: row.status,
			startedAt: row.started_at,
			completedAt: row.completed_at,
		};
	}

	/** Convert a persisted run row to the narrow executor command shape. */
	private executorRun(row: RunRow): ExecutorRun {
		return {
			runId: row.id,
			commissionId: row.commission_id,
			executorProfile: row.executor_profile,
		};
	}

	/** Persist executor-produced evidence through the Host's canonical boundary. */
	private recordExecutorEvidence(runId: string, kind: string, data: unknown): void {
		const evidenceId = randomUUID();
		this.db
			.prepare("INSERT INTO evidence (id, run_id, kind, data) VALUES (?, ?, ?, ?)")
			.run(evidenceId, runId, kind, JSON.stringify(data));
		this.eventBus.publish("evidence.collected", { runId, evidenceId, kind });
	}

	/**
	 * Accept an event emitted by the profile router. Controllers cannot update
	 * runs or evidence themselves; every accepted event is validated against
	 * the Host's FSM before persistence.
	 */
	handleExecutorEvent(runId: string, event: ExecutorEvent): void {
		const run = this.getRun(runId);
		if (run.completed_at !== null) return;

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
				this.collectRunArtifacts(runId, this.getCommission(run.commission_id));
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
		const draft = this.parseDraft(commission.draft_json);
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
			.prepare(
				"INSERT INTO commissions (id, conversation_id, status, draft_json, approval_hash) VALUES (?, ?, 'draft', ?, ?)",
			)
			.run(commissionId, draft.conversationId, JSON.stringify(draft), draftHash);
		this.eventBus.publish("commission.drafted", { commissionId, draftHash });
		return { commissionId, draftHash };
	}

	/** Approve the draft for the exact hash the user was shown. */
	approve(commissionId: string, approvedHash: string): void {
		const commission = this.getCommission(commissionId);
		if (commission.status !== "draft") {
			throw { kind: "conflict", reason: "commission_not_draft" };
		}
		if (commission.approval_hash !== approvedHash) {
			throw { kind: "conflict", reason: "draft_hash_mismatch" };
		}
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		this.withTransaction(() => {
			this.db.prepare("UPDATE commissions SET status = 'approved' WHERE id = ?").run(commissionId);
			this.db
				.prepare(
					"INSERT INTO approvals (id, commission_id, draft_hash, expires_at) VALUES (?, ?, ?, ?)",
				)
				.run(randomUUID(), commissionId, approvedHash, expiresAt);
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
		this.db.prepare("UPDATE commissions SET status = 'cancelled' WHERE id = ?").run(commissionId);
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
		const launch = this.withTransaction(() => {
			const activeRow = this.db
				.prepare(
					`SELECT COUNT(*) AS n FROM runs
					 WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")})`,
				)
				.get(...ACTIVE_RUN_STATUSES) as CountRow | undefined;
			if ((activeRow?.n ?? 0) >= MAX_ACTIVE_RUNS) {
				throw { kind: "conflict", reason: "max_active_runs" };
			}

			const commissionRow = this.getCommission(params.commissionId);
			if (commissionRow.status !== "approved") {
				throw { kind: "conflict", reason: "commission_not_approved" };
			}

			const id = randomUUID();
			this.db
				.prepare(
					"INSERT INTO runs (id, commission_id, executor_profile, status) VALUES (?, ?, ?, 'enqueued')",
				)
				.run(id, params.commissionId, params.executorProfile);
			this.db
				.prepare("UPDATE commissions SET status = 'queued' WHERE id = ?")
				.run(params.commissionId);

			const draft = this.parseDraft(commissionRow.draft_json);
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
			if (this.getRun(launch.run.runId).completed_at === null) {
				this.completeRun(launch.run.runId, "failed");
			}
			throw error;
		}

		const run = this.getRun(launch.run.runId);
		return {
			runId: run.id,
			commissionId: run.commission_id,
			executorProfile: run.executor_profile,
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
			.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
			.run(new Date().toISOString(), runId);
		this.db
			.prepare("UPDATE commissions SET status = 'running' WHERE id = ?")
			.run(run.commission_id);
		this.eventBus.publish("run.started", { runId });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commission_id,
			status: "running",
		});
		return this.summarizeRun(this.getRun(runId));
	}

	/** Land a run in a terminal status with completed_at (idempotence guard). */
	completeRun(runId: string, terminalStatus: TerminalRunStatus): RunSummary {
		const run = this.getRun(runId);
		if (run.completed_at !== null) {
			throw { kind: "conflict", reason: "run_already_terminated" };
		}
		this.db
			.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?")
			.run(terminalStatus, new Date().toISOString(), runId);
		const commissionStatus: CommissionStatus =
			terminalStatus === "completed"
				? "completed"
				: terminalStatus === "cancelled"
					? "cancelled"
					: "failed";
		this.db
			.prepare("UPDATE commissions SET status = ? WHERE id = ?")
			.run(commissionStatus, run.commission_id);
		this.eventBus.publish("run.completed", { runId, status: terminalStatus });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commission_id,
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
		this.db.prepare("UPDATE runs SET status = 'needs_user' WHERE id = ?").run(runId);
		this.db
			.prepare("UPDATE commissions SET status = 'needs_user' WHERE id = ?")
			.run(run.commission_id);
		this.eventBus.publish("run.needs_user", { runId, prompt, requestId, options });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commission_id,
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
	interruptRun(runId: string): RunSummary {
		const run = this.getRun(runId);
		if (run.status !== "running" && run.status !== "needs_user") {
			throw { kind: "conflict", reason: "run_not_interruptible" };
		}
		this.db.prepare("UPDATE runs SET status = 'interrupted' WHERE id = ?").run(runId);
		this.eventBus.publish("run.interrupted", { runId });
		return this.summarizeRun(this.getRun(runId));
	}

	/** Resume an interrupted (or user-paused) run back to running. */
	resumeRun(runId: string): RunSummary {
		const run = this.getRun(runId);
		const resumable =
			(run.status === "interrupted" || run.status === "needs_user") && run.completed_at === null;
		if (!resumable) {
			throw { kind: "conflict", reason: "run_not_resumable" };
		}
		this.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
		this.db
			.prepare("UPDATE commissions SET status = 'running' WHERE id = ?")
			.run(run.commission_id);
		this.eventBus.publish("run.resumed", { runId });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commission_id,
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
		if (run.status !== "needs_user" || run.completed_at !== null) {
			throw { kind: "conflict", reason: "run_not_awaiting_permission" };
		}
		await this.executorRouter.resume(this.executorRun(run), { requestId, optionId });
		return this.resumeRun(runId);
	}

	/** Cancel an active or transient run (terminal, completed_at set). */
	async cancelRun(runId: string): Promise<RunSummary> {
		const run = this.getRun(runId);
		const cancellable =
			run.completed_at === null &&
			(run.status === "enqueued" ||
				run.status === "running" ||
				run.status === "needs_user" ||
				run.status === "interrupted");
		if (!cancellable) {
			throw { kind: "conflict", reason: "run_not_cancellable" };
		}
		await this.executorRouter.cancel(this.executorRun(run));
		this.db
			.prepare("UPDATE runs SET status = 'cancelled', completed_at = ? WHERE id = ?")
			.run(new Date().toISOString(), runId);
		this.db
			.prepare("UPDATE commissions SET status = 'cancelled' WHERE id = ?")
			.run(run.commission_id);
		this.eventBus.publish("run.cancelled", { runId });
		this.eventBus.publish("commission.status_changed", {
			commissionId: run.commission_id,
			status: "cancelled",
		});
		return this.summarizeRun(this.getRun(runId));
	}

	/** Number of runs currently sitting in the enqueued queue. */
	queue(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'enqueued'").get() as
			| CountRow
			| undefined;
		return row?.n ?? 0;
	}

	/** List commissions (optionally by status) with their runs and draft summary. */
	list(params: CommissionListParams = {}): CommissionSummary[] {
		const commissions = this.db
			.prepare(
				`SELECT id, conversation_id, status, draft_json, approval_hash, created_at
				 FROM commissions ${params.status ? "WHERE status = ?" : ""}
				 ORDER BY created_at DESC, rowid DESC`,
			)
			.all(...(params.status ? [params.status] : [])) as CommissionRow[];
		return commissions.map((row) => {
			const draft = this.parseDraft(row.draft_json);
			const draftHash = row.approval_hash ?? "";
			const runs = this.db
				.prepare(
					`SELECT id, commission_id, executor_profile, status, started_at, completed_at
					 FROM runs WHERE commission_id = ? ORDER BY rowid`,
				)
				.all(row.id) as RunRow[];
			return {
				id: row.id,
				conversationId: row.conversation_id,
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
				createdAt: row.created_at,
				runs: runs.map((run) => this.summarizeRun(run)),
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
		if (run.commission_id !== commissionId) {
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
