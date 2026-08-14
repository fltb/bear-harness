/**
 * ExecutorRouter — profile-aware dispatch for approved commission runs.
 *
 * A controller is an implementation detail of an executor profile type. It
 * never mutates Host state directly: all lifecycle and evidence changes are
 * returned as events to CommissionService, which owns the run FSM.
 */

import type { DatabaseSync } from "node:sqlite";

export type ExecutorProfileType = "product-managed" | "native-full" | "codex";

export interface ExecutorProfile {
	id: string;
	type: ExecutorProfileType;
	capabilities: Record<string, unknown>;
}

export interface ExecutorRun {
	runId: string;
	commissionId: string;
	executorProfile: string;
}

export interface ExecutorCommission {
	id: string;
	title: string;
	description: string;
	reads: string[];
	writes: string[];
	networkAllowed: boolean;
	toolNames: string[];
}

export type ExecutorEvent =
	| { type: "started" }
	| { type: "evidence"; kind: string; data: unknown }
	| { type: "needs_user"; prompt: string; requestId?: string }
	| { type: "completed"; summary?: string }
	| { type: "failed"; reason: string }
	| { type: "cancelled"; reason?: string };

export interface ExecutorLaunchRequest {
	run: ExecutorRun;
	commission: ExecutorCommission;
	profile: ExecutorProfile;
	emit(event: ExecutorEvent): void;
}

/** A worker implementation for one profile type. */
export interface ExecutorController {
	launch(request: ExecutorLaunchRequest): Promise<void>;
	cancel?(run: ExecutorRun): Promise<void>;
	steer?(run: ExecutorRun, instruction: string): Promise<void>;
	resume?(run: ExecutorRun, input?: string): Promise<void>;
}

type ProfileRow = {
	id: string;
	profile_type: ExecutorProfileType;
	capability_json: string;
};

const PROFILE_TYPES = new Set<ExecutorProfileType>(["product-managed", "native-full", "codex"]);

function unavailable(reason: string): never {
	throw { kind: "unavailable", reason };
}

/**
 * Resolves a persisted profile to its controller. The database remains the
 * profile authority; registration merely associates trusted app code with a
 * known profile type.
 */
export class ExecutorRouter {
	private readonly db: DatabaseSync;
	private readonly controllers = new Map<ExecutorProfileType, ExecutorController>();

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	register(profileType: ExecutorProfileType, controller: ExecutorController): void {
		if (this.controllers.has(profileType)) {
			throw new Error(`executor controller already registered for '${profileType}'`);
		}
		this.controllers.set(profileType, controller);
	}

	async launch(
		run: ExecutorRun,
		commission: ExecutorCommission,
		emit: ExecutorLaunchRequest["emit"],
	): Promise<void> {
		const { profile, controller } = this.resolve(run.executorProfile);
		await controller.launch({ run, commission, profile, emit });
	}

	async cancel(run: ExecutorRun): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.cancel) return;
		await controller.cancel(run);
	}

	async steer(run: ExecutorRun, instruction: string): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.steer) unavailable("executor_steering_unsupported");
		await controller.steer(run, instruction);
	}

	async resume(run: ExecutorRun, input?: string): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.resume) unavailable("executor_resume_unsupported");
		await controller.resume(run, input);
	}

	private resolve(profileId: string): { profile: ExecutorProfile; controller: ExecutorController } {
		const row = this.db
			.prepare(
				"SELECT id, profile_type, capability_json FROM executor_profiles WHERE id = ?",
			)
			.get(profileId) as ProfileRow | undefined;
		if (!row) unavailable("executor_profile_not_found");
		if (!PROFILE_TYPES.has(row.profile_type)) unavailable("executor_profile_type_invalid");

		let capabilities: Record<string, unknown>;
		try {
			const parsed = JSON.parse(row.capability_json) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				unavailable("executor_profile_invalid");
			}
			capabilities = parsed as Record<string, unknown>;
		} catch {
			unavailable("executor_profile_invalid");
		}

		const controller = this.controllers.get(row.profile_type);
		if (!controller) unavailable("executor_profile_not_wired");
		return { profile: { id: row.id, type: row.profile_type, capabilities }, controller };
	}
}
