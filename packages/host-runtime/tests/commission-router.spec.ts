// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import { CommissionService } from "../src/commissions/service.js";
import {
	type ExecutorController,
	type ExecutorLaunchRequest,
	ExecutorRouter,
} from "../src/executors/router.js";
import type { CredentialVault } from "../src/providers/credential-store.js";
import { ResourceReferenceService } from "../src/resources/reference-service.js";
import { EventBus } from "../src/storage/event-bus.js";

type Fixture = {
	db: DatabaseSync;
	service: CommissionService;
	resources: ResourceReferenceService;
	tmp: string;
};

const vault: CredentialVault = {
	securityLevel: "os",
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from(value, "utf8"),
	decryptString: (value) => Buffer.from(value).toString("utf8"),
};

function createFixture(controller?: ExecutorController): Fixture {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
		CREATE TABLE conversations (id TEXT PRIMARY KEY, companion_id TEXT NOT NULL);
		CREATE TABLE commissions (
			id TEXT PRIMARY KEY,
			conversation_id TEXT,
			trigger_entry_id TEXT NOT NULL DEFAULT '',
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
		CREATE TABLE resource_refs (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL, access TEXT NOT NULL,
			persistence TEXT NOT NULL, encrypted_locator_json BLOB NOT NULL, identity_json TEXT NOT NULL,
			baseline_json TEXT NOT NULL, state TEXT NOT NULL, granted_at TEXT NOT NULL,
			last_resolved_at TEXT, revoked_at TEXT
		);
		CREATE TABLE commission_resource_grants (
			commission_id TEXT NOT NULL, resource_id TEXT NOT NULL, grant_json TEXT NOT NULL,
			PRIMARY KEY (commission_id, resource_id)
		);
		CREATE TABLE run_resource_changes (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL, resource_id TEXT, parent_resource_id TEXT,
			relative_path TEXT, operation TEXT NOT NULL, before_sha256 TEXT, after_sha256 TEXT,
			before_size INTEGER, after_size INTEGER, detected_at TEXT NOT NULL
		);
		CREATE TABLE run_outputs (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL, resource_id TEXT, parent_resource_id TEXT,
			relative_path TEXT, operation TEXT NOT NULL, before_sha256 TEXT, after_sha256 TEXT NOT NULL,
			evidence_artifact_id TEXT, adoption_state TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE executor_profiles (
			id TEXT PRIMARY KEY,
			profile_type TEXT NOT NULL,
			capability_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	db.prepare("INSERT INTO conversations (id, companion_id) VALUES (?, ?), (?, ?)").run(
		"conversation-1",
		"companion-active",
		"conversation-2",
		"companion-other",
	);
	db.prepare(
		"INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, 'product-managed', '{}')",
	).run("pi-worker");

	const orm = drizzle({ client: db });
	const eventBus = new EventBus(orm);
	const router = new ExecutorRouter(orm);
	if (controller) router.register("product-managed", controller);
	const tmp = mkdtempSync(join(tmpdir(), "bear-commission-router-"));
	const resources = new ResourceReferenceService(orm, vault);
	return {
		db,
		service: new CommissionService(orm, eventBus, new ArtifactStore(orm, tmp), router, resources),
		resources,
		tmp,
	};
}

function approvedCommission(service: CommissionService): string {
	const { commissionId, draftHash } = service.draft({
		conversationId: "conversation-1",
		triggerEntryId: "user-message-1",
		title: "Inspect the workspace",
		description: "Read the approved files and summarize them.",
		resourceGrants: [],
		outputGrants: [],
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
	it("resolves approved resource IDs only at launch and records verified file changes", async () => {
		let approvedPath = "";
		const fixture = createFixture({
			async launch(request) {
				approvedPath = request.commission.resources[0]?.resolvedPath ?? "";
				writeFileSync(approvedPath, "after", "utf8");
				request.emit({ type: "started" });
				request.emit({ type: "completed" });
			},
		});
		fixtures.push(fixture);
		const path = join(fixture.tmp, "approved.txt");
		writeFileSync(path, "before", "utf8");
		const resource = fixture.resources.grant(path, { access: "read-write" });
		const { commissionId, draftHash } = fixture.service.draft({
			conversationId: "conversation-1",
			triggerEntryId: "user-message-resource",
			title: "Modify approved resource",
			description: "Update only the approved file.",
			resourceGrants: [{ resourceId: resource.id, operations: ["read", "modify"] }],
			acceptanceCriteria: ["File contains after"],
		});
		expect(JSON.stringify(fixture.service.list()[0]?.draft)).not.toContain(path);
		fixture.service.approve(commissionId, draftHash);
		await fixture.service.launch({ commissionId, executorProfile: "pi-worker" });
		expect(approvedPath).toBe(path);
		expect(
			fixture.db.prepare("SELECT operation, resource_id FROM run_resource_changes").get(),
		).toEqual({ operation: "modified", resource_id: resource.id });
		expect(fixture.service.listOutputs()).toMatchObject([
			{
				runId: expect.any(String),
				resourceId: resource.id,
				operation: "modified",
				adoptionState: "returned",
			},
		]);
		const output = fixture.service.listOutputs()[0];
		if (!output) throw new Error("expected run output");
		fixture.service.decideOutput(output.id, "accepted");
		expect(fixture.service.listOutputs()[0]?.adoptionState).toBe("accepted");
	});

	it("keeps distinct user-message triggers through persistence and list projection", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const first = fixture.service.draft({
			conversationId: "conversation-1",
			triggerEntryId: "user-message-1",
			title: "First",
			description: "First request",
		});
		const second = fixture.service.draft({
			conversationId: "conversation-1",
			triggerEntryId: "user-message-2",
			title: "Second",
			description: "Second request",
		});
		const rows = fixture.service.list();
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.id === first.commissionId)).toMatchObject({
			id: first.commissionId,
			triggerEntryId: "user-message-1",
		});
		expect(rows.find((row) => row.id === second.commissionId)).toMatchObject({
			id: second.commissionId,
			triggerEntryId: "user-message-2",
		});
		expect(
			fixture.db
				.prepare("SELECT trigger_entry_id FROM commissions WHERE id = ?")
				.get(first.commissionId),
		).toEqual({ trigger_entry_id: "user-message-1" });
		expect(
			fixture.db
				.prepare("SELECT trigger_entry_id FROM commissions WHERE id = ?")
				.get(second.commissionId),
		).toEqual({ trigger_entry_id: "user-message-2" });
	});
	it("preserves unlinked legacy commissions without exposing them in the strict list", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const valid = fixture.service.draft({
			conversationId: "conversation-1",
			triggerEntryId: "user-message-1",
			title: "Current",
			description: "Current request",
		});
		fixture.db
			.prepare(
				"INSERT INTO commissions (id, conversation_id, trigger_entry_id, status, draft_json) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"legacy-commission",
				"conversation-1",
				"",
				"completed",
				JSON.stringify({
					conversationId: "conversation-1",
					title: "Legacy",
					description: "Historical request",
					reads: [],
					writes: [],
					networkAllowed: false,
					toolNames: [],
				}),
			);

		expect(fixture.service.list()).toMatchObject([
			{ id: valid.commissionId, triggerEntryId: "user-message-1" },
		]);
		expect(
			fixture.db
				.prepare("SELECT trigger_entry_id FROM commissions WHERE id = ?")
				.get("legacy-commission"),
		).toEqual({ trigger_entry_id: "" });
	});

	it("scopes commission projections to the requested companion and valid trigger", () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const active = fixture.service.draft({
			conversationId: "conversation-1",
			triggerEntryId: "user-message-1",
			title: "Active",
			description: "Owned by the active companion",
		});
		const other = fixture.service.draft({
			conversationId: "conversation-2",
			triggerEntryId: "user-message-3",
			title: "Other",
			description: "Owned by another companion",
		});

		const rows = fixture.service.list({ companionId: "companion-active" });
		expect(rows.map((row) => row.id)).toEqual([active.commissionId]);
		expect(rows.map((row) => row.id)).not.toContain(other.commissionId);
	});

	it("rejects unsupported executor profiles before inserting a run", async () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		fixture.db
			.prepare(
				"INSERT INTO executor_profiles (id, profile_type, capability_json) VALUES (?, ?, '{}')",
			)
			.run("native-worker", "native-full");

		const commissionId = approvedCommission(fixture.service);
		await expect(
			fixture.service.launch({ commissionId, executorProfile: "native-worker" }),
		).rejects.toMatchObject({ kind: "unavailable", reason: "executor_profile_type_invalid" });
		expect(fixture.db.prepare("SELECT id FROM runs").all()).toEqual([]);
		expect(
			fixture.db.prepare("SELECT status FROM commissions WHERE id = ?").get(commissionId),
		).toEqual({
			status: "approved",
		});
	});

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
			resources: [],
			outputs: [],
			toolNames: ["read"],
		});
		expect(
			fixture.db
				.prepare("SELECT kind FROM evidence WHERE run_id = ? ORDER BY rowid")
				.all(result.runId),
		).toEqual([{ kind: "tool_call" }, { kind: "executor.summary" }]);
		expect(fixture.service.list()[0]).toMatchObject({ id: commissionId, status: "completed" });
	});

	it("marks a run failed when its selected profile is not wired", async () => {
		const fixture = createFixture();
		fixtures.push(fixture);

		await expect(
			fixture.service.launch({
				commissionId: approvedCommission(fixture.service),
				executorProfile: "pi-worker",
			}),
		).rejects.toMatchObject({ kind: "unavailable", reason: "executor_profile_not_wired" });

		expect(fixture.db.prepare("SELECT status, completed_at FROM runs").get()).toMatchObject({
			status: "failed",
			completed_at: expect.any(String),
		});
		expect(fixture.db.prepare("SELECT kind FROM evidence").all()).toEqual([
			{ kind: "executor.launch_failed" },
		]);
	});

	it("does not copy direct worker writes into the artifact store by default", async () => {
		let output = "";
		const fixture = createFixture({
			async launch(request) {
				writeFileSync(output, "finished report", "utf8");
				request.emit({ type: "started" });
				request.emit({ type: "completed" });
			},
		});
		fixtures.push(fixture);
		output = join(fixture.tmp, "report.md");
		const { commissionId, draftHash } = fixture.service.draft({
			conversationId: "conversation-1",
			title: "Write report",
			triggerEntryId: "user-message-2",
			description: "Create the approved report.",
			resourceGrants: [],
			outputGrants: [],
			toolNames: ["write"],
		});
		fixture.service.approve(commissionId, draftHash);
		const result = await fixture.service.launch({ commissionId, executorProfile: "pi-worker" });

		expect(result.status).toBe("completed");
		expect(fixture.db.prepare("SELECT id FROM artifacts").get()).toBeUndefined();
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
		expect(fixture.service.list()[0]).toMatchObject({ status: "cancelled" });
	});
	it("publishes a permission request and resumes only the matching active worker", async () => {
		const responses: Array<{ requestId: string; optionId: string }> = [];
		const fixture = createFixture({
			async launch(request) {
				request.emit({ type: "started" });
				request.emit({
					type: "needs_user",
					prompt: "Write the approved report?",
					requestId: "permission-1",
					options: [{ optionId: "allow", kind: "allow_once", name: "Allow once" }],
				});
			},
			async resume(_run, response) {
				if (response) responses.push(response);
			},
		});
		fixtures.push(fixture);

		const launched = await fixture.service.launch({
			commissionId: approvedCommission(fixture.service),
			executorProfile: "pi-worker",
		});
		expect(launched.status).toBe("needs_user");
		expect(
			JSON.parse(
				(
					fixture.db.prepare("SELECT payload FROM events WHERE kind = 'run.needs_user'").get() as {
						payload: string;
					}
				).payload,
			),
		).toMatchObject({
			runId: launched.runId,
			requestId: "permission-1",
			options: [{ optionId: "allow", kind: "allow_once" }],
		});

		const resumed = await fixture.service.respondToExecutorPermission(
			launched.runId,
			"permission-1",
			"allow",
		);
		expect(responses).toEqual([{ requestId: "permission-1", optionId: "allow" }]);
		expect(resumed.status).toBe("running");
		expect(fixture.service.list()[0]).toMatchObject({ status: "running" });
	});
});
