/**
 * ExecutorRouter — profile-aware dispatch for independent external-agent runs.
 *
 * The persisted profile selects a trusted controller. Controllers receive a
 * concrete task and never mutate Host state directly: lifecycle and evidence
 * are returned as events to the owning run service.
 */

import { eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { executorProfiles } from "../storage/schema.js";

export type ExecutorProfileType = "pi" | "codex";

export interface ExecutorProfile {
	id: string;
	type: ExecutorProfileType;
	capabilities: Record<string, unknown>;
}

export interface ExecutorRun {
	runId: string;
	triggerEntryId: string;
	executorProfile: string;
}

/** Host-resolved launch material. Paths are ephemeral and never persisted. */
export interface ExecutorTask {
	instruction: string;
	workspace: string;
	outputDirectory: string;
	modelRoute?: { providerId: string; modelId: string; apiKey?: string };
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
	task: ExecutorTask;
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
	interrupt?(run: ExecutorRun): Promise<void>;
	/** Resolve a pending permission with `response`, or re-prompt a paused run when `response` is omitted. */
	resume?(run: ExecutorRun, response?: ExecutorPermissionResponse): Promise<void>;
}

const PROFILE_TYPES: Record<ExecutorProfileType, true> = {
	pi: true,
	codex: true,
};

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

	/**
	 * Validate that a persisted profile exists and uses a currently supported
	 * profile type. Controller wiring is checked separately during launch.
	 */
	validateProfile(profileId: string): void {
		const row = this.db
			.select({ profileType: executorProfiles.profileType })
			.from(executorProfiles)
			.where(eq(executorProfiles.id, profileId))
			.get();
		if (!row) unavailable("executor_profile_not_found");
		if (!PROFILE_TYPES[row.profileType]) unavailable("executor_profile_type_invalid");
	}

	async launch(
		run: ExecutorRun,
		task: ExecutorTask,
		emit: ExecutorLaunchRequest["emit"],
	): Promise<void> {
		const { profile, controller } = this.resolve(run.executorProfile);
		await controller.launch({ run, task, profile, emit });
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

	async interrupt(run: ExecutorRun): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.interrupt) unavailable("executor_interrupt_unsupported");
		await controller.interrupt(run);
	}

	async resume(run: ExecutorRun, response?: ExecutorPermissionResponse): Promise<void> {
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
		if (!PROFILE_TYPES[row.profileType]) unavailable("executor_profile_type_invalid");

		const capabilities = row.capabilityJson;

		const controller = this.controllers.get(row.profileType);
		if (!controller) unavailable("executor_profile_not_wired");
		return { profile: { id: row.id, type: row.profileType, capabilities }, controller };
	}
}
