/**
 * ExecutorRouter — profile-aware dispatch for approved commission runs.
 *
 * A controller is an implementation detail of an executor profile type. It
 * never mutates Host state directly: all lifecycle and evidence changes are
 * returned as events to CommissionService, which owns the run FSM.
 */

import { eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { executorProfiles } from "../storage/schema.js";

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
	| { type: "needs_user"; prompt: string; requestId?: string; options?: ExecutorPermissionOption[] }
	| { type: "completed"; summary?: string }
	| { type: "failed"; reason: string }
	| { type: "cancelled"; reason?: string };

export interface ExecutorLaunchRequest {
	run: ExecutorRun;
	commission: ExecutorCommission;
	profile: ExecutorProfile;
	emit(event: ExecutorEvent): void;
}

export interface ExecutorPermissionResponse {
	requestId: string;
	optionId: string;
}

export interface ExecutorPermissionOption {
	optionId: string;
	kind: string;
	name: string;
}

/** A worker implementation for one profile type. */
export interface ExecutorController {
	launch(request: ExecutorLaunchRequest): Promise<void>;
	cancel?(run: ExecutorRun): Promise<void>;
	steer?(run: ExecutorRun, instruction: string): Promise<void>;
	resume?(run: ExecutorRun, response: ExecutorPermissionResponse): Promise<void>;
}

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
	private readonly db: AppDatabase;
	private readonly controllers = new Map<ExecutorProfileType, ExecutorController>();

	constructor(db: AppDatabase) {
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

	async resume(run: ExecutorRun, response: ExecutorPermissionResponse): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.resume) unavailable("executor_resume_unsupported");
		await controller.resume(run, response);
	}

	private resolve(profileId: string): { profile: ExecutorProfile; controller: ExecutorController } {
		const row = this.db
			.select()
			.from(executorProfiles)
			.where(eq(executorProfiles.id, profileId))
			.get();
		if (!row) unavailable("executor_profile_not_found");
		if (!PROFILE_TYPES.has(row.profileType)) unavailable("executor_profile_type_invalid");

		const capabilities = row.capabilityJson;

		const controller = this.controllers.get(row.profileType);
		if (!controller) unavailable("executor_profile_not_wired");
		return { profile: { id: row.id, type: row.profileType, capabilities }, controller };
	}
}
