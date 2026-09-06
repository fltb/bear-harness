/**
 * ExecutorRouter — profile-aware dispatch for independent external-agent runs.
 *
 * The persisted profile selects a trusted controller. Controllers receive a
 * concrete task and never mutate Host state directly: lifecycle and evidence
 * are returned as events to the owning run service.
 */

import type { RunAction, RunSteerResponse } from "@bear-harness/protocol";
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
	/** Immutable Host-materialized input snapshots readable by the agent. */
	readOnlyPaths?: string[];
	modelRoute?: { providerId: string; modelId: string; apiKey?: string };
}

export type ExecutorEvent =
	| { type: "started" }
	| { type: "evidence"; kind: string; data: unknown }
	| { type: "needs_user"; prompt: string; requestId: string; options?: ExecutorPermissionOption[] }
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

export type ExecutorRecovery = "attached" | "confirmed_lost" | "unknown";

/** A worker implementation for one profile type. */
export interface ExecutorController {
	launch(request: ExecutorLaunchRequest): Promise<void>;
	/** Query/recover the controller's live handle before startup declares a persisted run orphaned. */
	recover(run: ExecutorRun): Promise<ExecutorRecovery>;
	/** Synchronous observation of a resource owned by this controller. */
	runtime?(run: ExecutorRun): { controller: ExecutorRecovery; actions: RunAction[] };
	stop(run: ExecutorRun): Promise<void>;
	close(): Promise<void>;
	cancel?(run: ExecutorRun): Promise<void>;
	steer?(run: ExecutorRun, instruction: string): Promise<RunSteerResponse>;
	interrupt?(run: ExecutorRun): Promise<void>;
	/** Resolve a pending permission with `response`, or re-prompt a paused run when `response` is omitted. */
	resume?(
		run: ExecutorRun,
		response?: ExecutorPermissionResponse,
		instruction?: string,
	): Promise<void>;
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

	/** Validate known profile and controller prerequisites before admission. */
	validateProfile(profileId: string, expectedType?: ExecutorProfileType): void {
		const { profile } = this.resolve(profileId);
		if (expectedType && profile.type !== expectedType) unavailable("executor_profile_type_invalid");
	}

	async launch(
		run: ExecutorRun,
		task: ExecutorTask,
		emit: ExecutorLaunchRequest["emit"],
	): Promise<void> {
		const { profile, controller } = this.resolve(run.executorProfile);
		await controller.launch({ run, task, profile, emit });
	}

	async recover(run: ExecutorRun): Promise<ExecutorRecovery> {
		const { controller } = this.resolve(run.executorProfile);
		return controller.recover(run);
	}

	runtime(run: ExecutorRun): { controller: ExecutorRecovery; actions: RunAction[] } {
		try {
			return (
				this.resolve(run.executorProfile).controller.runtime?.(run) ?? {
					controller: "unknown",
					actions: [],
				}
			);
		} catch {
			return { controller: "unknown", actions: [] };
		}
	}

	async stop(run: ExecutorRun): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		await controller.stop(run);
	}

	async cancel(run: ExecutorRun): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.cancel) unavailable("executor_cancel_unsupported");
		await controller.cancel(run);
	}

	async steer(run: ExecutorRun, instruction: string): Promise<RunSteerResponse> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.steer) unavailable("executor_steering_unsupported");
		return controller.steer(run, instruction);
	}

	async interrupt(run: ExecutorRun): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.interrupt) unavailable("executor_interrupt_unsupported");
		await controller.interrupt(run);
	}

	async resume(
		run: ExecutorRun,
		response?: ExecutorPermissionResponse,
		instruction?: string,
	): Promise<void> {
		const { controller } = this.resolve(run.executorProfile);
		if (!controller.resume) unavailable("executor_resume_unsupported");
		await controller.resume(run, response, instruction);
	}

	async close(): Promise<void> {
		await Promise.all(
			[...new Set(this.controllers.values())].map((controller) => controller.close()),
		);
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
