// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import { CommissionService } from "../src/commissions/service.js";
import { AcpRunClient } from "../src/executors/acp-client.js";
import { AcpExecutorController } from "../src/executors/acp-executor.js";
import { CodexAdapter } from "../src/executors/codex-adapter.js";
import { PiAcpAdapter } from "../src/executors/pi-adapter.js";
import {
	type ExecutorController,
	type ExecutorLaunchRequest,
	ExecutorRouter,
} from "../src/executors/router.js";
import { EventBus } from "../src/storage/event-bus.js";

const controlsFixturePath = fileURLToPath(
	new URL("./fixtures/acp-controls-agent.mjs", import.meta.url),
);
const plainFixturePath = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const workerSourcePath = fileURLToPath(
	new URL("../src/executors/pi-acp-worker.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "bear-executor-controls-"));
	temporaryDirectories.push(directory);
	return directory;
}

type Fixture = {
	db: DatabaseSync;
	service: CommissionService;
	tmp: string;
};

function createServiceFixture(controller?: ExecutorController): Fixture {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE commissions (
			id TEXT PRIMARY KEY,
			conversation_id TEXT,
			trigger_entry_id TEXT NOT NULL,
			status TEXT NOT NULL,
			draft_json TEXT NOT NULL,
			approval_hash TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE approvals (
			id TEXT PRIMARY KEY,
			commission_id TEXT NOT NULL,
			draft_hash TEXT NOT NULL,
			approved_by TEXT NOT NULL DEFAULT 'user',
			expires_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE runs (
			id TEXT PRIMARY KEY,
			commission_id TEXT NOT NULL,
			executor_profile TEXT NOT NULL,
			status TEXT NOT NULL,
			started_at TEXT,
			completed_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE evidence (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			data TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE artifacts (
			id TEXT PRIMARY KEY,
			logical_name TEXT NOT NULL,
			mime TEXT NOT NULL,
			bytes INTEGER NOT NULL,
			sha256 TEXT NOT NULL,
			status TEXT NOT NULL,
			producer_run_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE artifact_adoptions (
			id TEXT PRIMARY KEY,
			artifact_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			adopted_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE executor_profiles (
			id TEXT PRIMARY KEY,
			profile_type TEXT NOT NULL,
			capability_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	db.prepare(
		"INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, 'product-managed', '{}')",
	).run("pi-worker");

	const orm = drizzle({ client: db });
	const eventBus = new EventBus(orm);
	const router = new ExecutorRouter(orm);
	if (controller) router.register("product-managed", controller);
	const tmp = mkdtempSync(join(tmpdir(), "bear-executor-controls-service-"));
	temporaryDirectories.push(tmp);
	return {
		db,
		service: new CommissionService(orm, eventBus, new ArtifactStore(orm, tmp), router),
		tmp,
	};
}

function approvedCommission(service: CommissionService): string {
	const { commissionId, draftHash } = service.draft({
		conversationId: "conversation-1",
		triggerEntryId: "user-message-1",
		title: "Inspect the workspace",
		description: "Read the approved files and summarize them.",
		reads: ["/workspace"],
		toolNames: ["read"],
	});
	service.approve(commissionId, draftHash);
	return commissionId;
}

describe("CommissionService interrupt/resume transitions", () => {
	it("interrupts a running run without completing it and resumes it back to running", async () => {
		const controls: string[] = [];
		const fixture = createServiceFixture({
			async launch(request) {
				request.emit({ type: "started" });
			},
			async steer(_run, instruction) {
				controls.push(`steer:${instruction}`);
			},
			async interrupt() {
				controls.push("interrupt");
			},
			async resume(_run, response) {
				controls.push(`resume:${response === undefined ? "continue" : "permission"}`);
			},
		});
		const launched = await fixture.service.launch({
			commissionId: approvedCommission(fixture.service),
			executorProfile: "pi-worker",
		});
		expect(launched.status).toBe("running");

		const interrupted = await fixture.service.interruptRun(launched.runId);
		expect(interrupted.status).toBe("interrupted");
		expect(interrupted.completedAt).toBeNull();
		expect(fixture.db.prepare("SELECT status, completed_at FROM runs").get()).toMatchObject({
			status: "interrupted",
			completed_at: null,
		});

		const resumed = await fixture.service.resumeRun(launched.runId);
		expect(resumed.status).toBe("running");
		expect(resumed.completedAt).toBeNull();
		expect(fixture.db.prepare("SELECT status, completed_at FROM runs").get()).toMatchObject({
			status: "running",
			completed_at: null,
		});
		expect(fixture.service.list()[0]).toMatchObject({ status: "running" });

		expect(controls).toEqual(["interrupt", "resume:continue"]);
		fixture.db.close();
	});

	it("refuses to interrupt or resume a run that is not in a controllable state", async () => {
		const fixture = createServiceFixture({
			async launch(request) {
				request.emit({ type: "started" });
				request.emit({ type: "completed" });
			},
			async interrupt() {},
			async resume() {},
		});
		const launched = await fixture.service.launch({
			commissionId: approvedCommission(fixture.service),
			executorProfile: "pi-worker",
		});
		expect(launched.status).toBe("completed");

		await expect(fixture.service.interruptRun(launched.runId)).rejects.toMatchObject({
			kind: "conflict",
			reason: "run_not_interruptible",
		});
		await expect(fixture.service.resumeRun(launched.runId)).rejects.toMatchObject({
			kind: "conflict",
			reason: "run_not_resumable",
		});
		fixture.db.close();
	});

	it("resumes a needs_user run without re-prompting the executor (permission path owns it)", async () => {
		const controls: string[] = [];
		const fixture = createServiceFixture({
			async launch(request) {
				request.emit({ type: "started" });
				request.emit({
					type: "needs_user",
					prompt: "Write the approved report?",
					requestId: "permission-1",
					options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }],
				});
			},
			async interrupt() {
				controls.push("interrupt");
			},
			async resume() {
				controls.push("resume");
			},
		});
		const launched = await fixture.service.launch({
			commissionId: approvedCommission(fixture.service),
			executorProfile: "pi-worker",
		});
		expect(launched.status).toBe("needs_user");

		const resumed = await fixture.service.resumeRun(launched.runId);
		expect(resumed.status).toBe("running");
		expect(controls).toEqual([]);
		fixture.db.close();
	});
});

describe("ExecutorRouter control routing", () => {
	it("routes steer, interrupt, and resume to a controller implementing all three", async () => {
		const calls: string[] = [];
		const controller: ExecutorController = {
			async launch(request) {
				request.emit({ type: "started" });
			},
			async steer(_run, instruction) {
				calls.push(`steer:${instruction}`);
			},
			async interrupt() {
				calls.push("interrupt");
			},
			async resume(_run, response) {
				calls.push(response ? "resume:permission" : "resume:continue");
			},
		};
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE executor_profiles (
				id TEXT PRIMARY KEY,
				profile_type TEXT NOT NULL,
				capability_json TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
		db.prepare(
			"INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, 'product-managed', '{}')",
		).run("pi-worker");
		const router = new ExecutorRouter(drizzle({ client: db }));
		router.register("product-managed", controller);
		const run = { runId: "run-1", commissionId: "commission-1", executorProfile: "pi-worker" };

		await expect(router.steer(run, "Use the shorter path.")).resolves.toBeUndefined();
		await expect(router.interrupt(run)).resolves.toBeUndefined();
		await expect(router.resume(run)).resolves.toBeUndefined();
		await expect(
			router.resume(run, { requestId: "permission-1", optionId: "allow" }),
		).resolves.toBeUndefined();

		expect(calls).toEqual([
			"steer:Use the shorter path.",
			"interrupt",
			"resume:continue",
			"resume:permission",
		]);
		db.close();
	});

	it("keeps a defensive failure when a controller omits an optional control method", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE executor_profiles (
				id TEXT PRIMARY KEY,
				profile_type TEXT NOT NULL,
				capability_json TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`);
		db.prepare(
			"INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, 'product-managed', '{}')",
		).run("pi-worker");
		const router = new ExecutorRouter(drizzle({ client: db }));
		router.register("product-managed", {
			async launch() {},
		});
		const run = { runId: "run-1", commissionId: "commission-1", executorProfile: "pi-worker" };

		await expect(router.steer(run, "nudge")).rejects.toMatchObject({
			kind: "unavailable",
			reason: "executor_steering_unsupported",
		});
		await expect(router.interrupt(run)).rejects.toMatchObject({
			kind: "unavailable",
			reason: "executor_interrupt_unsupported",
		});
		await expect(router.resume(run)).rejects.toMatchObject({
			kind: "unavailable",
			reason: "executor_resume_unsupported",
		});
		db.close();
	});

	it("registered ACP profiles implement steer, interrupt, and resume", () => {
		// Both registered profiles (Pi worker and Codex) share the base ACP
		// controller, so the methods must exist on their prototypes.
		for (const Adapter of [PiAcpAdapter, CodexAdapter]) {
			expect(typeof Adapter.prototype.steer).toBe("function");
			expect(typeof Adapter.prototype.interrupt).toBe("function");
			expect(typeof Adapter.prototype.resume).toBe("function");
		}
	});
});

describe("AcpRunClient steering transport", () => {
	it("steers through the _session/steering extension", async () => {
		const cwd = tempDirectory();
		const client = new AcpRunClient(
			{
				command: process.execPath,
				args: [controlsFixturePath],
				cwd,
				env: { PATH: process.env.PATH },
			},
			{
				onSessionUpdate: () => undefined,
				onPermissionRequest: () => undefined,
				onExit: () => undefined,
			},
		);
		await client.start();
		await expect(client.steerTurn("Use the shorter path.")).resolves.toBeUndefined();
		await client.stop();
	});

	it("falls back to a follow-up prompt when the agent rejects the extension", async () => {
		const cwd = tempDirectory();
		const client = new AcpRunClient(
			{ command: process.execPath, args: [plainFixturePath], cwd, env: { PATH: process.env.PATH } },
			{
				onSessionUpdate: () => undefined,
				onPermissionRequest: () => undefined,
				onExit: () => undefined,
			},
		);
		await client.start();
		await expect(client.steerTurn("nudge")).resolves.toBeUndefined();
		await client.stop();
	});
});

describe("AcpExecutorController mid-run controls", () => {
	it("steers, interrupts (pauses), and resumes a live ACP run without killing the process", async () => {
		const cwd = tempDirectory();
		class ControlsController extends AcpExecutorController {
			protected processSpec(): import("../src/executors/acp-client.js").AcpProcessSpec {
				return {
					command: process.execPath,
					args: [controlsFixturePath],
					cwd,
					env: { PATH: process.env.PATH },
				};
			}
		}
		const controller = new ControlsController();
		const events: Array<{ type: string; [key: string]: unknown }> = [];
		const paused = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const request: ExecutorLaunchRequest = {
			run: { runId: "run-1", commissionId: "commission-1", executorProfile: "pi-worker" },
			commission: {
				id: "commission-1",
				title: "Inspect",
				description: "Inspect the approved root.",
				reads: [cwd],
				writes: [],
				networkAllowed: false,
				toolNames: ["read"],
			},
			profile: { id: "pi-worker", type: "product-managed", capabilities: {} },
			emit: (event) => {
				events.push(event);
				if (event.type === "evidence" && event.kind === "run.paused") paused.resolve();
				if (event.type === "completed") completed.resolve();
			},
		};

		await controller.launch(request);

		// Steer while the first prompt is held open by the fixture.
		await expect(controller.steer(request.run, "Use the shorter path.")).resolves.toBeUndefined();

		// Interrupt: the turn cancels but the process/session must survive.
		await controller.interrupt(request.run);
		await paused.promise;
		expect(events).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "cancelled" })]),
		);
		expect(events).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "completed" })]),
		);

		// Resume: a fresh prompt on the same session completes the run.
		await controller.resume(request.run);
		await completed.promise;

		expect(events).toEqual(
			expect.arrayContaining([
				{ type: "started" },
				expect.objectContaining({ type: "evidence", kind: "run.paused" }),
				{ type: "completed", summary: undefined },
			]),
		);

		// The settled run is gone: a late resume is refused.
		await expect(controller.resume(request.run)).rejects.toMatchObject({
			kind: "conflict",
			reason: "executor_not_running",
		});

		// A second run held open but never interrupted refuses resume until
		// paused; a plain cancel still settles the run as cancelled.
		const cancelled = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const request2: ExecutorLaunchRequest = {
			...request,
			run: { ...request.run, runId: "run-2" },
			emit: (event) => {
				if (event.type === "cancelled") cancelled.resolve();
				if (event.type === "started") second.resolve();
			},
		};
		await controller.launch(request2);
		await second.promise;
		await expect(controller.resume(request2.run)).rejects.toMatchObject({
			kind: "conflict",
			reason: "executor_not_paused",
		});
		await controller.cancel(request2.run);
		await cancelled.promise;
	});
});

describe("Pi worker steering extension", () => {
	it("registers a _session/steering handler that enqueues the instruction", () => {
		const source = readFileSync(workerSourcePath, "utf8");
		// Read-based verification: the ACP server registers the extension method
		// and PiAcpAgent implements the steer handler that enqueues the
		// instruction into the running agent session.
		expect(source).toContain('const SESSION_STEERING_METHOD = "_session/steering";');
		expect(source).toContain(".onRequest(\n\t\tSESSION_STEERING_METHOD,");
		expect(source).toContain("async steer(params: SteeringParams");
		expect(source).toContain('streamingBehavior: "steer"');
	});
});
