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
import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../storage/event-bus.js";
import type { CompanionSupervisor } from "../companion/supervisor.js";
import type { ArtifactStore } from "../artifacts/index.js";

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
	status: "enqueued";
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
	/** Reserved for the executor adapters (Pi/Codex hand-off); unused by the FSM itself. */
	private supervisor: CompanionSupervisor;
	private artifactStore: ArtifactStore;

	constructor(
		db: DatabaseSync,
		eventBus: EventBus,
		supervisor: CompanionSupervisor,
		artifactStore: ArtifactStore,
	) {
		this.db = db;
		this.eventBus = eventBus;
		this.supervisor = supervisor;
		this.artifactStore = artifactStore;
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
			this.db
				.prepare("UPDATE commissions SET status = 'approved' WHERE id = ?")
				.run(commissionId);
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

	/** Enqueue a run for an approved commission (max MAX_ACTIVE_RUNS active). */
	launch(params: CommissionLaunchParams): CommissionLaunchResult {
		const runId = this.withTransaction(() => {
			const activeRow = this.db
				.prepare(
					`SELECT COUNT(*) AS n FROM runs
					 WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")})`,
				)
				.get(...ACTIVE_RUN_STATUSES) as CountRow | undefined;
			const active = activeRow?.n ?? 0;
			if (active >= MAX_ACTIVE_RUNS) {
				throw { kind: "conflict", reason: "max_active_runs" };
			}
			const commission = this.getCommission(params.commissionId);
			if (commission.status !== "approved") {
				throw { kind: "conflict", reason: "commission_not_approved" };
			}
			const id = randomUUID();
			this.db
				.prepare(
					"INSERT INTO runs (id, commission_id, executor_profile, status) VALUES (?, ?, ?, 'enqueued')",
				)
				.run(id, params.commissionId, params.executorProfile);
			return id;
		});
		const result: CommissionLaunchResult = {
			runId,
			commissionId: params.commissionId,
			executorProfile: params.executorProfile,
			status: "enqueued",
		};
		this.eventBus.publish("run.enqueued", result);
		return result;
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
		this.eventBus.publish("run.started", { runId });
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
		this.eventBus.publish("run.completed", { runId, status: terminalStatus });
		return this.summarizeRun(this.getRun(runId));
	}

	/** Pause a running run for user input. */
	needsUser(runId: string, prompt: string): RunSummary {
		const run = this.getRun(runId);
		if (run.status !== "running") {
			throw { kind: "conflict", reason: "run_not_active" };
		}
		this.db.prepare("UPDATE runs SET status = 'needs_user' WHERE id = ?").run(runId);
		this.eventBus.publish("run.needs_user", { runId, prompt });
		return this.summarizeRun(this.getRun(runId));
	}

	/** Send a steering instruction to an active run (no state change). */
	steerRun(runId: string, instruction: string): void {
		const run = this.getRun(runId);
		if (run.status !== "running" && run.status !== "needs_user") {
			throw { kind: "conflict", reason: "run_not_steerable" };
		}
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
		this.eventBus.publish("run.resumed", { runId });
		return this.summarizeRun(this.getRun(runId));
	}

	/** Cancel an active or transient run (terminal, completed_at set). */
	cancelRun(runId: string): RunSummary {
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
		this.db
			.prepare("UPDATE runs SET status = 'cancelled', completed_at = ? WHERE id = ?")
			.run(new Date().toISOString(), runId);
		this.eventBus.publish("run.cancelled", { runId });
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
