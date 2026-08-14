// @vitest-environment node

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/main/artifacts/index.js";
import { CommissionService } from "../src/main/commissions/service.js";
import {
	ExecutorRouter,
	type ExecutorController,
	type ExecutorLaunchRequest,
} from "../src/main/executors/router.js";
import { EventBus } from "../src/main/storage/event-bus.js";

type Fixture = {
	db: DatabaseSync;
	service: CommissionService;
	tmp: string;
};

function createFixture(controller?: ExecutorController): Fixture {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);
		CREATE TABLE commissions (
			id TEXT PRIMARY KEY,
			conversation_id TEXT,
			status TEXT NOT NULL,
			draft_json TEXT NOT NULL,
			approval_hash TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE approvals (
			id TEXT PRIMARY KEY,
			commission_id TEXT NOT NULL,
			draft_hash TEXT NOT NULL,
			expires_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE runs (
			id TEXT PRIMARY KEY,
			commission_id TEXT NOT NULL,
			executor_profile TEXT NOT NULL,
			status TEXT NOT NULL,
			started_at TEXT,
			completed_at TEXT
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
	db.prepare("INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, 'product-managed', '{}')").run(
		"pi-worker",
	);

	const eventBus = new EventBus(db);
	const router = new ExecutorRouter(db);
	if (controller) router.register("product-managed", controller);
	const tmp = mkdtempSync(join(tmpdir(), "bear-commission-router-"));
	return {
		db,
		service: new CommissionService(db, eventBus, new ArtifactStore(db, tmp), router),
		tmp,
	};
}

function approvedCommission(service: CommissionService): string {
	const { commissionId, draftHash } = service.draft({
		conversationId: "conversation-1",
		title: "Inspect the workspace",
		description: "Read the approved files and summarize them.",
		reads: ["/workspace"],
		toolNames: ["read"],
	});
	service.approve(commissionId, draftHash);
	return commissionId;
}

const fixtures: Fixture[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.db.close();
		rmSync(fixture.tmp, { recursive: true, force: true });
	}
});

describe("CommissionService executor routing", () => {
	it("dispatches only an approved run and persists controller evidence through the Host", async () => {
		const launches: ExecutorLaunchRequest[] = [];
		const fixture = createFixture({
			async launch(request) {
				launches.push(request);
				request.emit({ type: "started" });
				request.emit({ type: "evidence", kind: "tool_call", data: { tool: "read" } });
				request.emit({ type: "completed", summary: "Inspection complete." });
			},
		});
		fixtures.push(fixture);

		const commissionId = approvedCommission(fixture.service);
		const result = await fixture.service.launch({ commissionId, executorProfile: "pi-worker" });

		expect(result.status).toBe("completed");
		expect(launches).toHaveLength(1);
		expect(launches[0]?.commission).toMatchObject({
			id: commissionId,
			reads: ["/workspace"],
			toolNames: ["read"],
		});
		expect(
			fixture.db.prepare("SELECT kind FROM evidence WHERE run_id = ? ORDER BY rowid").all(result.runId),
		).toEqual([{ kind: "tool_call" }, { kind: "executor.summary" }]);
	});

	it("marks a run failed when its selected profile is not wired", async () => {
		const fixture = createFixture();
		fixtures.push(fixture);

		await expect(
			fixture.service.launch({ commissionId: approvedCommission(fixture.service), executorProfile: "pi-worker" }),
		).rejects.toMatchObject({ kind: "unavailable", reason: "executor_profile_not_wired" });

		expect(fixture.db.prepare("SELECT status, completed_at FROM runs").get()).toMatchObject({
			status: "failed",
			completed_at: expect.any(String),
		});
		expect(fixture.db.prepare("SELECT kind FROM evidence").all()).toEqual([
			{ kind: "executor.launch_failed" },
		]);
	});

	it("sends steering and cancellation to the launched profile before changing Host state", async () => {
		const controls: string[] = [];
		const fixture = createFixture({
			async launch(request) {
				request.emit({ type: "started" });
			},
			async steer(_run, instruction) {
				controls.push(`steer:${instruction}`);
			},
			async cancel() {
				controls.push("cancel");
			},
		});
		fixtures.push(fixture);

		const launched = await fixture.service.launch({
			commissionId: approvedCommission(fixture.service),
			executorProfile: "pi-worker",
		});
		await fixture.service.steerRun(launched.runId, "Use the shorter path.");
		const cancelled = await fixture.service.cancelRun(launched.runId);

		expect(controls).toEqual(["steer:Use the shorter path.", "cancel"]);
		expect(cancelled.status).toBe("cancelled");
	});
});
