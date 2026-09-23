// @vitest-environment node

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAction } from "@bear-harness/protocol";
import { RunGetResponse } from "@bear-harness/protocol/schema";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ArtifactCaptureLimits,
	DEFAULT_ARTIFACT_CAPTURE_LIMITS,
} from "../src/artifacts/capture.js";
import { ArtifactStore } from "../src/artifacts/index.js";
import type { ExecutorLaunchRequest, ExecutorRecovery } from "../src/executors/router.js";
import { ExternalAgentRunService, type RunStatus } from "../src/external-agents/run-service.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../src/storage/database.js";
import { conversations, evidence, runManifests, runs } from "../src/storage/schema.js";

const roots: string[] = [];

function setup(
	options: {
		launch?: (request: ExecutorLaunchRequest) => Promise<void>;
		interrupt?: () => Promise<void>;
		cancel?: () => Promise<void>;
		close?: () => Promise<void>;
		resolvePiModel?: ConstructorParameters<typeof ExternalAgentRunService>[4];
		onTerminal?: ConstructorParameters<typeof ExternalAgentRunService>[5];
		captureLimits?: ArtifactCaptureLimits;
		profiles?: Record<string, ExecutorLaunchRequest["profile"]>;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "bear-run-restart-"));
	roots.push(root);
	const database = new CompanionDatabase(join(root, "runtime.db"), "bear");
	database.initialize(COMPANION_SCHEMA_SQL);
	database.ensureRuntimeIdentity();
	database.orm.insert(conversations).values({ id: "conversation-1", companionId: "bear" }).run();
	const publish = vi.fn();
	const interrupt = vi.fn(async () => options.interrupt?.());
	const resume = vi.fn(async () => undefined);
	const recover = vi.fn(
		async (_run: ExecutorLaunchRequest["run"]): Promise<ExecutorRecovery> => "confirmed_lost",
	);
	const runtime = vi.fn(
		(
			_run: ExecutorLaunchRequest["run"],
		): { controller: ExecutorRecovery; actions: RunAction[] } => ({
			controller: "attached",
			actions: ["steer", "interrupt", "resume", "cancel", "respondPermission"],
		}),
	);
	const launch = vi.fn(
		async (
			run: ExecutorLaunchRequest["run"],
			task: ExecutorLaunchRequest["task"],
			emit: ExecutorLaunchRequest["emit"],
		) =>
			options.launch?.({
				run,
				task,
				emit,
				profile: { id: run.executorProfile, type: "pi", capabilities: {} },
			}),
	);
	const validateProfile = vi.fn((id: string) => {
		const profile =
			options.profiles?.[id] ??
			(id === "pi-default" ? { id, type: "pi" as const, capabilities: {} } : undefined);
		if (!profile) throw { kind: "unavailable", reason: "executor_profile_not_found" };
		if (profile.capabilities.enabled === false)
			throw { kind: "unavailable", reason: "runner_disabled" };
		return profile;
	});
	const controllerClose = vi.fn(async () => options.close?.());
	const cancel = vi.fn(async () => options.cancel?.());
	const stop = vi.fn(async () => undefined);
	const runRoot = join(root, "runs");
	const artifactStore = new ArtifactStore(database.orm, join(root, "artifacts"));
	const createService = () =>
		new ExternalAgentRunService(
			database.orm,
			{
				interrupt,
				resume,
				recover,
				runtime,
				steer: vi.fn(async () => ({ outcome: "injected" })),
				launch,
				validateProfile,
				profile: validateProfile,
				profileType: (id: string) => validateProfile(id).type,
				restore: (run: ExecutorLaunchRequest["run"]) => recover(run),
				suspend: async () => {
					await controllerClose();
					return [];
				},
				close: controllerClose,
				cancel,
				stop,
			} as never,
			artifactStore,
			runRoot,
			options.resolvePiModel ?? (async () => ({ providerId: "test", modelId: "test" })),
			options.onTerminal,
			15_000,
			undefined,
			options.captureLimits,
		);
	const service = createService();
	service.subscribeChanges(publish);
	return {
		database,
		service,
		artifactStore,
		createService,
		runRoot,
		publish,
		interrupt,
		resume,
		recover,
		runtime,
		launch,
		controllerClose,
		cancel,
		stop,
	};
}

function seedRun(
	database: CompanionDatabase,
	id: string,
	status: RunStatus,
	completedAt?: string,
): void {
	database.orm
		.insert(runs)
		.values({
			id,
			conversationId: "conversation-1",
			triggerEntryId: `entry-${id}`,
			executorProfile: "pi-default",
			title: id,
			instruction: "Do the work",
			status,
			...(completedAt ? { completedAt } : {}),
		})
		.run();
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ExternalAgentRunService restart recovery", () => {
	it("queries recovery before marking confirmed orphaned runs as forced termination", async () => {
		const { database, service, runRoot, recover } = setup();
		try {
			for (const status of ["enqueued", "running", "needs_user", "interrupted"] as const) {
				seedRun(database, status, status);
			}
			seedRun(database, "completed", "completed", "2026-08-31T00:00:00.000Z");
			seedRun(database, "old-interrupted", "interrupted", "2026-08-31T00:00:00.000Z");

			expect(await service.recoverUnfinishedRuns()).toBe(4);
			expect(recover).toHaveBeenCalledTimes(4);

			for (const id of ["enqueued", "running", "needs_user", "interrupted"]) {
				const row = database.orm.select().from(runs).where(eq(runs.id, id)).get();
				expect(row).toMatchObject({
					status: "forced_termination",
					summary: "External agent execution could not be recovered after Host restart.",
				});
				expect(row?.completedAt).toEqual(expect.any(String));
			}
			expect(database.orm.select().from(runs).where(eq(runs.id, "completed")).get()?.status).toBe(
				"completed",
			);
			expect(
				database.orm.select().from(runs).where(eq(runs.id, "old-interrupted")).get()?.status,
			).toBe("interrupted");
			expect(existsSync(runRoot)).toBe(false);
		} finally {
			database.close();
		}
	});

	it("keeps a run nonterminal when its controller reattaches it", async () => {
		const { database, service, recover, runRoot } = setup();
		try {
			seedRun(database, "running", "running");
			recover.mockResolvedValueOnce("attached");

			expect(await service.recoverUnfinishedRuns()).toBe(0);
			expect(database.orm.select().from(runs).where(eq(runs.id, "running")).get()).toMatchObject({
				status: "running",
				completedAt: null,
			});
			expect(existsSync(runRoot)).toBe(true);
		} finally {
			database.close();
		}
	});

	it("defers termination for both unknown and failed recovery probes", async () => {
		const { database, service, recover } = setup();
		try {
			seedRun(database, "unknown", "running");
			seedRun(database, "query-error", "needs_user");
			recover.mockImplementation(async (run) => {
				if (run.runId === "unknown") return "unknown";
				throw new Error("temporary query failure");
			});

			expect(await service.recoverUnfinishedRuns()).toBe(0);
			expect(database.orm.select().from(runs).where(eq(runs.id, "unknown")).get()).toMatchObject({
				status: "running",
				completedAt: null,
			});
			expect(
				database.orm.select().from(runs).where(eq(runs.id, "query-error")).get(),
			).toMatchObject({ status: "needs_user", completedAt: null });
		} finally {
			database.close();
		}
	});

	it("deduplicates recovery probes in flight and allows a later recovery attempt", async () => {
		const fixture = setup();
		const probe = Promise.withResolvers<ExecutorRecovery>();
		fixture.recover.mockReturnValue(probe.promise);
		try {
			seedRun(fixture.database, "recoverable", "running");
			const first = fixture.service.recoverUnfinishedRuns();
			const second = fixture.service.recoverUnfinishedRuns();
			expect(second).toBe(first);
			await vi.waitFor(() => expect(fixture.recover).toHaveBeenCalledOnce());
			probe.resolve("unknown");
			expect(await first).toBe(0);
			fixture.recover.mockResolvedValue("confirmed_lost");
			expect(await fixture.service.recoverUnfinishedRuns()).toBe(1);
			expect(fixture.recover).toHaveBeenCalledTimes(2);
		} finally {
			probe.resolve("unknown");
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("never force-terminates an unknown run during later Host close", async () => {
		const { controllerClose, database, service, recover, runRoot } = setup();
		try {
			seedRun(database, "attached", "running");
			seedRun(database, "unknown", "interrupted");
			mkdirSync(join(runRoot, "attached"), { recursive: true });
			mkdirSync(join(runRoot, "unknown"), { recursive: true });
			recover.mockImplementation(async (run) =>
				run.runId === "attached" ? "attached" : "unknown",
			);

			await service.close();

			expect(controllerClose).toHaveBeenCalledOnce();
			expect(database.orm.select().from(runs).where(eq(runs.id, "attached")).get()).toMatchObject({
				status: "forced_termination",
				completedAt: expect.any(String),
			});
			expect(database.orm.select().from(runs).where(eq(runs.id, "unknown")).get()).toMatchObject({
				status: "interrupted",
				completedAt: null,
			});
			expect(existsSync(join(runRoot, "attached"))).toBe(false);
			expect(existsSync(join(runRoot, "unknown"))).toBe(true);
			expect(() => service.assertRuntimeDeletable()).toThrowError(
				expect.objectContaining({
					kind: "conflict",
					reason: "external_agent_controller_unavailable",
				}),
			);
			expect(service.getDetail("unknown").run.completedAt).toBeUndefined();
			recover.mockResolvedValue("confirmed_lost");
			await service.recoverUnfinishedRuns();
			expect(() => service.assertRuntimeDeletable()).not.toThrow();
		} finally {
			database.close();
		}
	});

	it("keeps a user interrupt nonterminal and resumable in the same Host process", async () => {
		const { database, service, interrupt, resume } = setup();
		try {
			seedRun(database, "run-1", "running");

			const interrupted = await service.interruptRun("run-1");
			expect(interrupted).toMatchObject({ status: "interrupted", completedAt: null });
			expect(interrupt).toHaveBeenCalledOnce();

			const resumed = await service.resumeRun("run-1");
			expect(resumed).toMatchObject({ status: "running", completedAt: null });
			expect(resume).toHaveBeenCalledOnce();
		} finally {
			database.close();
		}
	});

	it("keeps a terminal executor event when an earlier interrupt call returns late", async () => {
		let emit: ExecutorLaunchRequest["emit"] | undefined;
		let finishInterrupt: (() => void) | undefined;
		const interruptPending = new Promise<void>((resolve) => {
			finishInterrupt = resolve;
		});
		const { database, service } = setup({
			launch: async (request) => {
				emit = request.emit;
				request.emit({ type: "started" });
			},
			interrupt: async () => interruptPending,
		});
		try {
			const delegated = await service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "entry-race",
				toolCallId: "tool-race",
				inputPaths: [],
				instruction: "Exercise terminal ordering.",
			});
			await vi.waitFor(() => expect(service.list()[0]?.status).toBe("running"));

			const interrupting = service.interruptRun(delegated.runId);
			await vi.waitFor(() => expect(emit).toBeDefined());
			emit?.({ type: "failed", reason: "executor ended" });
			await vi.waitFor(() => expect(service.list()[0]?.status).toBe("failed"));
			finishInterrupt?.();

			await expect(interrupting).resolves.toMatchObject({
				status: "failed",
				completedAt: expect.any(String),
			});
		} finally {
			await service.close();
			database.close();
		}
	});

	it("counts unfinished interrupted runs against executor resource concurrency", async () => {
		const { database, launch, service } = setup();
		try {
			seedRun(database, "interrupted-a", "interrupted");
			seedRun(database, "interrupted-b", "interrupted");

			await expect(
				service.delegate({
					conversationId: "conversation-1",
					triggerEntryId: "entry-blocked",
					toolCallId: "tool-blocked",
					inputPaths: [],
					instruction: "This run must wait for an executor slot.",
				}),
			).rejects.toMatchObject({ kind: "conflict", reason: "max_concurrent_runs" });
			expect(launch).not.toHaveBeenCalled();
			expect(
				database.orm
					.select({ status: runs.status, completedAt: runs.completedAt })
					.from(runs)
					.all(),
			).toEqual([
				expect.objectContaining({ status: "interrupted", completedAt: null }),
				expect.objectContaining({ status: "interrupted", completedAt: null }),
			]);
		} finally {
			await service.close();
			database.close();
		}
	});

	it("does not treat historical completed interrupted rows as live resource owners", async () => {
		const { database, service } = setup();
		try {
			const completedAt = "2026-08-31T00:00:00.000Z";
			seedRun(database, "historical-a", "interrupted", completedAt);
			seedRun(database, "historical-b", "interrupted", completedAt);

			const delegated = await service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "entry-allowed",
				toolCallId: "tool-allowed",
				inputPaths: [],
				instruction: "Use the available executor slot.",
			});

			expect(delegated).toEqual({
				accepted: true,
				runId: delegated.runId,
				executor: "pi",
				runnerId: "pi-default",
			});
			expect(service.list()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: delegated.runId,
						status: "enqueued",
						completedAt: null,
					}),
					expect.objectContaining({ id: "historical-a", status: "interrupted", completedAt }),
					expect.objectContaining({ id: "historical-b", status: "interrupted", completedAt }),
				]),
			);
		} finally {
			await service.close();
			database.close();
		}
	});

	it("stops conversation-owned controllers and workspaces before deletion", async () => {
		const { cancel, database, runRoot, service, stop, recover } = setup();
		recover.mockResolvedValue("attached");
		try {
			seedRun(database, "running", "running");
			seedRun(database, "completed", "completed", "2026-08-31T00:00:00.000Z");
			mkdirSync(join(runRoot, "running"), { recursive: true });
			mkdirSync(join(runRoot, "completed"), { recursive: true });

			await service.prepareConversationDeletion("conversation-1");

			expect(cancel).toHaveBeenCalledOnce();
			expect(stop).toHaveBeenCalledOnce();
			expect(database.orm.select().from(runs).where(eq(runs.id, "running")).get()).toMatchObject({
				status: "cancelled",
				completedAt: expect.any(String),
			});
			expect(existsSync(join(runRoot, "running"))).toBe(false);
			expect(existsSync(join(runRoot, "completed"))).toBe(false);
		} finally {
			database.close();
		}
	});
});

describe("ExternalAgentRunService output capture", () => {
	it.each([
		["maxFileBytes", 3, "run_output_file_too_large"],
		["maxTotalBytes", 7, "run_output_total_too_large"],
		["maxFiles", 1, "run_output_file_limit"],
		["maxEntries", 1, "run_output_entry_limit"],
		["maxDepth", 0, "run_output_depth_limit"],
	] as const)("enforces %s before publishing any captured output", async (key, limit, reason) => {
		const fixture = setup({
			captureLimits: { ...DEFAULT_ARTIFACT_CAPTURE_LIMITS, [key]: limit },
			launch: async ({ task, emit }) => {
				if (key === "maxDepth") mkdirSync(join(task.outputDirectory, "nested"));
				else {
					writeFileSync(join(task.outputDirectory, "one.txt"), "1234");
					writeFileSync(join(task.outputDirectory, "two.txt"), "5678");
				}
				emit({ type: "started" });
				emit({ type: "completed", summary: "done" });
			},
		});
		try {
			const run = await fixture.service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "entry-limits",
				toolCallId: "tool-limits",
				inputPaths: [],
				instruction: "Produce bounded outputs",
			});
			await vi.waitFor(() =>
				expect(fixture.service.getDetail(run.runId).run).toMatchObject({
					status: "failed",
					summary: reason,
					artifacts: [],
				}),
			);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("reports the same committed verified files on initial delivery and retry after partial capture failure", async () => {
		const reports: Array<{ status: string; names: string[] }> = [];
		const fixture = setup({
			launch: async ({ task, emit }) => {
				writeFileSync(join(task.outputDirectory, "a.txt"), "first committed file");
				writeFileSync(join(task.outputDirectory, "b.txt"), "second capture fails");
				emit({ type: "started" });
				emit({ type: "completed", summary: "Executor finished writing" });
			},
			onTerminal: async ({ run }) => {
				reports.push({
					status: run.status,
					names: run.artifacts.map(({ logicalName }) => logicalName),
				});
				if (reports.length === 1) throw new Error("delivery unavailable");
				return { resultReported: true };
			},
		});
		const capture = fixture.artifactStore.createFromPath.bind(fixture.artifactStore);
		vi.spyOn(fixture.artifactStore, "createFromPath").mockImplementation((input) => {
			if (input.logicalName === "b.txt") return Promise.reject(new Error("second capture failed"));
			return capture(input);
		});
		try {
			const receipt = await fixture.service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "partial",
				toolCallId: "partial",
				inputPaths: [],
				instruction: "Produce two files",
			});
			await vi.waitFor(() =>
				expect(
					fixture.service
						.getDetail(receipt.runId)
						.evidence.some(({ kind }) => kind === "run.reconciliation_pending"),
				).toBe(true),
			);
			expect(reports).toEqual([{ status: "failed", names: ["a.txt"] }]);
			expect(
				fixture.artifactStore
					.list(receipt.runId)
					.map(({ logicalName, verification }) => ({ logicalName, verification })),
			).toEqual([{ logicalName: "a.txt", verification: "verified" }]);
			expect(
				fixture.service.getDetail(receipt.runId).run.artifacts.map(({ name }) => name),
			).toEqual(["a.txt"]);
			await fixture.service.retryDelivery(receipt.runId);
			expect(reports).toEqual([
				{ status: "failed", names: ["a.txt"] },
				{ status: "failed", names: ["a.txt"] },
			]);
			expect(fixture.service.getDetail(receipt.runId).run).toMatchObject({
				status: "failed",
				resultReportedAt: expect.any(String),
			});
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("does not advertise committed but unverified files during initial delivery or retry", async () => {
		const reports: string[][] = [];
		const fixture = setup({
			onTerminal: async ({ run }) => {
				reports.push(run.artifacts.map(({ logicalName }) => logicalName));
				return { resultReported: reports.length > 1 };
			},
		});
		try {
			seedRun(fixture.database, "unverified-result", "failed", "2026-09-22T00:00:00.000Z");
			const verified = fixture.artifactStore.create({
				logicalName: "ready.txt",
				mime: "text/plain",
				buffer: Buffer.from("verified"),
				producerRunId: "unverified-result",
			});
			fixture.artifactStore.markVerified(verified.id);
			fixture.artifactStore.create({
				logicalName: "pending.txt",
				mime: "text/plain",
				buffer: Buffer.from("pending"),
				producerRunId: "unverified-result",
			});
			await fixture.service.reconcilePending();
			await fixture.service.retryDelivery("unverified-result");
			expect(reports).toEqual([["ready.txt"], ["ready.txt"]]);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("keeps unrelated Run controls available while another output capture is pending", async () => {
		let launched = 0;
		const fixture = setup({
			launch: async ({ task, emit }) => {
				emit({ type: "started" });
				if (++launched === 1) {
					writeFileSync(join(task.outputDirectory, "result.txt"), "captured result");
					emit({ type: "completed", summary: "done" });
				}
			},
		});
		const entered = deferred();
		const release = deferred();
		const create = fixture.artifactStore.createFromPath.bind(fixture.artifactStore);
		vi.spyOn(fixture.artifactStore, "createFromPath").mockImplementation(async (params) => {
			entered.resolve();
			await release.promise;
			return create(params);
		});
		try {
			const first = await fixture.service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "first",
				toolCallId: "first",
				inputPaths: [],
				instruction: "Create result",
			});
			await entered.promise;
			const second = await fixture.service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "second",
				toolCallId: "second",
				inputPaths: [],
				instruction: "Keep working",
			});
			await vi.waitFor(() =>
				expect(fixture.service.getDetail(second.runId).run.status).toBe("running"),
			);
			await expect(fixture.service.interruptRun(second.runId)).resolves.toMatchObject({
				status: "interrupted",
			});
			expect(fixture.service.getDetail(first.runId).run.status).toBe("running");
			release.resolve();
			await vi.waitFor(() =>
				expect(fixture.service.getDetail(first.runId).run.status).toBe("completed"),
			);
		} finally {
			release.resolve();
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it.each(["close", "delete"] as const)(
		"drains owned output IO before %s removes the Run directory",
		async (operation) => {
			const fixture = setup({
				launch: async ({ task, emit }) => {
					writeFileSync(join(task.outputDirectory, "result.txt"), "captured result");
					emit({ type: "started" });
					emit({ type: "completed", summary: "done" });
				},
			});
			const entered = deferred();
			const release = deferred();
			let captureSignal: AbortSignal | undefined;
			const create = fixture.artifactStore.createFromPath.bind(fixture.artifactStore);
			vi.spyOn(fixture.artifactStore, "createFromPath").mockImplementation(async (params) => {
				captureSignal = params.signal;
				entered.resolve();
				await release.promise;
				return create(params);
			});
			try {
				const run = await fixture.service.delegate({
					conversationId: "conversation-1",
					triggerEntryId: "capture",
					toolCallId: "capture",
					inputPaths: [],
					instruction: "Create result",
				});
				await entered.promise;
				// The executor already completed: only the capture operation still owns this directory.
				fixture.recover.mockResolvedValue("unknown");
				const draining =
					operation === "close"
						? fixture.service.close()
						: fixture.service.prepareConversationDeletion("conversation-1");
				expect(captureSignal?.aborted).toBe(true);
				expect(existsSync(join(fixture.runRoot, run.runId))).toBe(true);
				release.resolve();
				await draining;
				expect(existsSync(join(fixture.runRoot, run.runId))).toBe(false);
				expect(fixture.artifactStore.list()).toEqual([]);
				expect(fixture.service.getDetail(run.runId).run.status).toBe(
					operation === "close" ? "forced_termination" : "cancelled",
				);
			} finally {
				release.resolve();
				await fixture.service.close();
				fixture.database.close();
			}
		},
	);

	it("persists only stable executor failure codes, never raw worker error text", async () => {
		const secret = "pi-secret-must-not-persist";
		const fixture = setup({
			launch: async ({ emit }) => {
				emit({ type: "started" });
				emit({ type: "failed", reason: `worker stderr exposed ${secret}` });
			},
		});
		try {
			const delegated = await fixture.service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "entry-safe-failure",
				toolCallId: "tool-safe-failure",
				inputPaths: [],
				instruction: "Fail without persisting worker diagnostics.",
			});
			await vi.waitFor(() => {
				expect(fixture.service.list()[0]).toMatchObject({
					id: delegated.runId,
					status: "failed",
					summary: "executor_failed",
				});
			});
			const persisted = {
				run: fixture.database.orm.select().from(runs).where(eq(runs.id, delegated.runId)).get(),
				events: fixture.publish.mock.calls,
			};
			expect(JSON.stringify(persisted)).not.toContain(secret);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("sniffs media bytes on the same descriptor used for CAS capture", async () => {
		const fixture = setup({
			launch: async ({ task, emit }) => {
				writeFileSync(join(task.outputDirectory, "misleading.txt"), "%PDF-1.7\n");
				emit({ type: "started" });
				emit({ type: "completed", summary: "done" });
			},
		});
		try {
			const delegated = await fixture.service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "entry-output",
				toolCallId: "tool-output",
				inputPaths: [],
				instruction: "Create output",
			});
			await vi.waitFor(() => {
				expect(fixture.service.list()[0]).toMatchObject({ status: "completed" });
			});
			expect(fixture.service.list()[0]?.artifacts).toEqual([
				expect.objectContaining({
					producerRunId: delegated.runId,
					mime: "application/pdf",
					verification: "verified",
				}),
			]);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("captures outputs beyond former depth and total byte quotas", async () => {
		for (const kind of ["depth", "bytes"] as const) {
			const fixture = setup({
				launch: async ({ task, emit }) => {
					if (kind === "depth") {
						let directory = task.outputDirectory;
						for (let index = 0; index < 33; index += 1) {
							directory = join(directory, `level-${index}`);
							mkdirSync(directory);
						}
					} else {
						for (let index = 0; index < 3; index += 1) {
							const path = join(task.outputDirectory, `${index}.bin`);
							writeFileSync(path, "");
							truncateSync(path, 400 * 1024 * 1024);
						}
					}
					emit({ type: "started" });
					emit({ type: "completed", summary: "done" });
				},
			});
			try {
				await fixture.service.delegate({
					conversationId: "conversation-1",
					triggerEntryId: `entry-${kind}`,
					toolCallId: `tool-${kind}`,
					inputPaths: [],
					instruction: "Create oversized output",
				});
				await vi.waitFor(
					() => {
						expect(fixture.service.list()[0]).toMatchObject({
							status: "completed",
							summary: "done",
						});
					},
					{ timeout: 20_000 },
				);
				expect(fixture.service.list()[0]?.artifacts).toHaveLength(kind === "bytes" ? 3 : 0);
			} finally {
				await fixture.service.close();
				fixture.database.close();
			}
		}
	}, 30_000);

	it("rejects an output root replaced with a symlink", async () => {
		const outside = mkdtempSync(join(tmpdir(), "bear-run-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "secret.txt"), "must not be captured");
		const fixture = setup({
			launch: async ({ task, emit }) => {
				rmSync(task.outputDirectory, { recursive: true });
				symlinkSync(outside, task.outputDirectory, "dir");
				emit({ type: "started" });
				emit({ type: "completed", summary: "done" });
			},
		});
		try {
			await fixture.service.delegate({
				conversationId: "conversation-1",
				triggerEntryId: "entry-escape",
				toolCallId: "tool-escape",
				inputPaths: [],
				instruction: "Replace output root",
			});
			await vi.waitFor(() => {
				expect(fixture.service.list()[0]).toMatchObject({
					status: "failed",
					summary: "output_snapshot_failed",
				});
			});
			expect(fixture.service.list()[0]?.artifacts).toEqual([]);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});
});

describe("ExternalAgentRunService admission and inspectable results", () => {
	const params = {
		conversationId: "conversation-1",
		triggerEntryId: "entry-admission",
		toolCallId: "tool-admission",
		instruction: "Perform the delegated work.",
		inputPaths: [],
	};

	it("deduplicates simultaneous native tool calls and retains the admitted ID after startup failure", async () => {
		const fixture = setup({
			launch: async () => {
				throw new Error("private startup diagnostics");
			},
		});
		try {
			const [first, second] = await Promise.all([
				fixture.service.delegate(params),
				fixture.service.delegate(params),
			]);
			expect(first).toEqual({
				accepted: true,
				runId: second.runId,
				executor: "pi",
				runnerId: "pi-default",
			});
			await vi.waitFor(() =>
				expect(fixture.service.getDetail(first.runId).run.status).toBe("failed"),
			);
			expect(await fixture.service.delegate(params)).toEqual(first);
			expect(fixture.launch).toHaveBeenCalledOnce();
			expect(fixture.service.getDetail(first.runId)).toMatchObject({
				run: { executorProfile: "pi-default", status: "failed" },
				evidence: [expect.objectContaining({ kind: "executor.launch_failed" })],
			});
			expect(JSON.stringify(fixture.service.getDetail(first.runId))).not.toContain(
				"private startup diagnostics",
			);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("cancels an accepted but not yet launched worker without creating an executor", async () => {
		const fixture = setup();
		try {
			const receipt = await fixture.service.delegate(params);
			expect(await fixture.service.cancelRun(receipt.runId)).toMatchObject({ status: "cancelled" });
			expect(fixture.launch).not.toHaveBeenCalled();
			expect(fixture.cancel).not.toHaveBeenCalled();
			expect(fixture.service.getDetail(receipt.runId).run.actions).toEqual([]);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("deletes an admitted conversation before any worker launch can begin", async () => {
		const fixture = setup();
		try {
			const receipt = await fixture.service.delegate(params);
			await fixture.service.prepareConversationDeletion("conversation-1");
			expect(fixture.launch).not.toHaveBeenCalled();
			expect(fixture.service.getDetail(receipt.runId).run.status).toBe("cancelled");
			expect(existsSync(join(fixture.runRoot, receipt.runId))).toBe(false);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("waits for an already executing control before close returns", async () => {
		let finishInterrupt!: () => void;
		const interrupted = new Promise<void>((resolve) => {
			finishInterrupt = resolve;
		});
		const fixture = setup({ interrupt: () => interrupted });
		try {
			seedRun(fixture.database, "controlled", "running");
			fixture.recover.mockResolvedValue("attached");
			const control = fixture.service.interruptRun("controlled");
			await vi.waitFor(() => expect(fixture.interrupt).toHaveBeenCalledOnce());
			let closed = false;
			const closing = fixture.service.close().then(() => {
				closed = true;
			});
			await vi.waitFor(() => expect(fixture.controllerClose).toHaveBeenCalledOnce());
			expect(closed).toBe(false);
			finishInterrupt();
			await control;
			await closing;
			expect(fixture.service.getDetail("controlled").run.status).toBe("forced_termination");
		} finally {
			finishInterrupt();
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("prevents admission after deletion starts while its model prerequisite is pending", async () => {
		let release!: (route: { providerId: string; modelId: string }) => void;
		const route = new Promise<{ providerId: string; modelId: string }>((resolve) => {
			release = resolve;
		});
		const fixture = setup({ resolvePiModel: () => route });
		try {
			const admission = fixture.service.delegate(params);
			const rejection = expect(admission).rejects.toMatchObject({
				reason: "conversation_deleting",
			});
			const deletion = fixture.service.prepareConversationDeletion("conversation-1");
			release({ providerId: "test", modelId: "test" });
			await rejection;
			await deletion;
			expect(fixture.service.list()).toEqual([]);
			expect(fixture.launch).not.toHaveBeenCalled();
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it.each(["cancel", "delete", "close"] as const)(
		"drains an owned unknown handshake before confirming %s",
		async (operation) => {
			const launchEntered = deferred();
			const nativeRelease = deferred();
			const launchDrain = deferred();
			const stopEntered = deferred();
			let outputDirectory = "";
			const releaseController = async () => {
				stopEntered.resolve();
				await nativeRelease.promise;
			};
			const fixture = setup({
				launch: async ({ task }) => {
					outputDirectory = task.outputDirectory;
					launchEntered.resolve();
					await nativeRelease.promise;
					await launchDrain.promise;
					// Startup must still own its workspace until its actual operation drains.
					writeFileSync(join(outputDirectory, "shutdown.txt"), "startup drained");
					throw new Error("ACP handshake stopped");
				},
				cancel: releaseController,
				close: releaseController,
			});
			fixture.runtime.mockReturnValue({ controller: "unknown", actions: [] });
			fixture.recover.mockResolvedValue("unknown");
			try {
				fixture.database.orm
					.insert(conversations)
					.values({ id: "conversation-2", companionId: "bear" })
					.run();
				seedRun(fixture.database, "historical-unknown", "interrupted");
				fixture.database.orm
					.update(runs)
					.set({ conversationId: "conversation-2" })
					.where(eq(runs.id, "historical-unknown"))
					.run();
				const historicalRoot = join(fixture.runRoot, "historical-unknown");
				mkdirSync(historicalRoot);
				const receipt = await fixture.service.delegate(params);
				await launchEntered.promise;
				expect(fixture.service.getDetail(receipt.runId).run).toMatchObject({
					status: "enqueued",
					controller: "unknown",
					actions: ["cancel"],
				});
				await expect(
					fixture.service.delegate({ ...params, toolCallId: "over-capacity" }),
				).rejects.toMatchObject({ reason: "max_concurrent_runs" });
				let settled = false;
				const pending = (
					operation === "cancel"
						? fixture.service.cancelRun(receipt.runId)
						: operation === "delete"
							? fixture.service.prepareConversationDeletion("conversation-1")
							: fixture.service.close()
				).then(() => {
					settled = true;
				});
				await Promise.race([stopEntered.promise, pending]);
				expect(settled).toBe(false);
				expect(fixture.service.getDetail(receipt.runId).run.completedAt).toBeUndefined();
				expect(existsSync(outputDirectory)).toBe(true);
				nativeRelease.resolve();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				expect(fixture.service.getDetail(receipt.runId).run.completedAt).toBeUndefined();
				expect(existsSync(outputDirectory)).toBe(true);
				launchDrain.resolve();
				await pending;
				expect(fixture.service.getDetail(receipt.runId).run).toMatchObject({
					status: operation === "close" ? "forced_termination" : "cancelled",
					completedAt: expect.any(String),
				});
				expect(existsSync(outputDirectory)).toBe(operation === "cancel");
				expect(fixture.service.getDetail("historical-unknown").run).toMatchObject({
					status: "interrupted",
					controller: "unknown",
					actions: [],
				});
				expect(fixture.service.getDetail("historical-unknown").run.completedAt).toBeUndefined();
				expect(existsSync(historicalRoot)).toBe(true);
				const admissionService = operation === "close" ? fixture.createService() : fixture.service;
				try {
					if (operation === "close") await admissionService.recoverUnfinishedRuns();
					const next = await admissionService.delegate({
						...params,
						conversationId: "conversation-2",
						toolCallId: "replacement",
					});
					expect(await admissionService.cancelRun(next.runId)).toMatchObject({
						status: "cancelled",
					});
				} finally {
					if (operation === "close") await admissionService.close();
				}
			} finally {
				nativeRelease.resolve();
				launchDrain.resolve();
				await fixture.service.close();
				fixture.database.close();
			}
		},
	);

	it("retains an owned startup after failed close and retries release without settling unknown runs", async () => {
		const launchEntered = deferred();
		const startup = deferred();
		let releaseFails = true;
		const fixture = setup({
			launch: async () => {
				launchEntered.resolve();
				await startup.promise;
			},
			close: async () => {
				startup.resolve();
				if (releaseFails) throw new Error("native release unconfirmed");
			},
		});
		fixture.runtime.mockReturnValue({ controller: "unknown", actions: [] });
		fixture.recover.mockResolvedValue("unknown");
		try {
			seedRun(fixture.database, "historical-unknown", "interrupted");
			mkdirSync(join(fixture.runRoot, "historical-unknown"), { recursive: true });
			const receipt = await fixture.service.delegate(params);
			await launchEntered.promise;
			await expect(fixture.service.close()).rejects.toThrow("native release unconfirmed");
			expect(fixture.service.getDetail(receipt.runId).run).toMatchObject({
				status: "enqueued",
				controller: "unknown",
				actions: [],
			});
			expect(fixture.service.getDetail(receipt.runId).run.completedAt).toBeUndefined();
			expect(existsSync(join(fixture.runRoot, receipt.runId))).toBe(true);
			await expect(fixture.service.delegate(params)).rejects.toMatchObject({
				reason: "run_service_closed",
			});
			releaseFails = false;
			await fixture.service.close();
			expect(fixture.controllerClose).toHaveBeenCalledTimes(2);
			expect(fixture.service.getDetail(receipt.runId).run.status).toBe("forced_termination");
			expect(existsSync(join(fixture.runRoot, receipt.runId))).toBe(false);
			expect(fixture.service.getDetail("historical-unknown").run).toMatchObject({
				status: "interrupted",
				controller: "unknown",
			});
			expect(fixture.service.getDetail("historical-unknown").run.completedAt).toBeUndefined();
			expect(existsSync(join(fixture.runRoot, "historical-unknown"))).toBe(true);
		} finally {
			startup.resolve();
			await fixture.service.close().catch(() => undefined);
			fixture.database.close();
		}
	});

	it("lists old unfinished work separately from cursor-paginated terminal history", async () => {
		const fixture = setup();
		try {
			seedRun(fixture.database, "old-unfinished", "interrupted");
			fixture.database.orm
				.update(runs)
				.set({ createdAt: "2020-01-01T00:00:00.000Z" })
				.where(eq(runs.id, "old-unfinished"))
				.run();
			for (let index = 0; index < 25; index++)
				seedRun(
					fixture.database,
					`history-${index.toString().padStart(2, "0")}`,
					"completed",
					"2026-08-31T00:00:00.000Z",
				);
			const first = fixture.service.listPage("bear", { limit: 10 });
			expect(first.runs.filter((run) => !run.completedAt).map((run) => run.id)).toEqual([
				"old-unfinished",
			]);
			expect(first.nextCursor).toBeDefined();
			const second = fixture.service.listPage("bear", {
				scope: "history",
				cursor: first.nextCursor,
				limit: 10,
			});
			expect(second.runs.some((run) => first.runs.some((previous) => previous.id === run.id))).toBe(
				false,
			);
			const third = fixture.service.listPage("bear", {
				scope: "history",
				cursor: second.nextCursor,
				limit: 10,
			});
			expect(third.runs).toHaveLength(5);
			expect(third.nextCursor).toBeUndefined();
			expect(
				fixture.service.listPage("bear", { scope: "unfinished" }).runs.map((run) => run.id),
			).toEqual(["old-unfinished"]);
			expect(fixture.service.listPage("other-character").runs).toEqual([]);
			expect(() =>
				fixture.service.assertConversationRun("other-conversation", "old-unfinished"),
			).toThrow();
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("rejects controls and deletion when controller ownership is unknown", async () => {
		const fixture = setup();
		try {
			seedRun(fixture.database, "unknown", "running");
			fixture.runtime.mockReturnValue({ controller: "unknown", actions: [] });
			fixture.recover.mockResolvedValue("unknown");
			expect(fixture.service.getDetail("unknown").run).toMatchObject({
				controller: "unknown",
				actions: [],
			});
			await expect(fixture.service.cancelRun("unknown")).rejects.toMatchObject({
				reason: "run_cancel_unavailable",
			});
			await expect(
				fixture.service.prepareConversationDeletion("conversation-1"),
			).rejects.toMatchObject({ reason: "run_controller_unknown" });
			expect(fixture.service.getDetail("unknown").run).toMatchObject({ status: "running" });
			expect(fixture.cancel).not.toHaveBeenCalled();
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("orders same-time evidence by insertion and keeps cursor pages within their Run", async () => {
		const fixture = setup();
		try {
			seedRun(fixture.database, "ordered", "completed");
			seedRun(fixture.database, "other", "completed");
			for (const [id, runId] of [
				["z", "ordered"],
				["a", "ordered"],
				["foreign", "other"],
				["m", "ordered"],
			]) {
				fixture.database.orm
					.insert(evidence)
					.values({ id, runId, kind: "step", data: {}, createdAt: "2026-09-13 00:00:00" })
					.run();
			}
			const first = fixture.service.getDetail("ordered", { limit: 2 });
			expect(first.evidence.map((item) => item.id)).toEqual(["m", "a"]);
			const second = fixture.service.getDetail("ordered", { limit: 2, cursor: first.nextCursor });
			expect(second.evidence.map((item) => item.id)).toEqual(["z"]);
			expect(second.nextCursor).toBeUndefined();
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("coalesces consecutive message fragments without losing whitespace or overflow text", async () => {
		const fixture = setup({
			launch: async ({ emit }) => {
				emit({ type: "started" });
				for (const text of ["Hello", " ", "world\\n"])
					emit({ type: "evidence", kind: "acp.message", data: { text } });
				emit({
					type: "evidence",
					kind: "acp.tool_call",
					data: { toolCallId: "write", title: "write", status: "completed" },
				});
				for (const text of ["x".repeat(4_090), " final text"])
					emit({ type: "evidence", kind: "acp.message", data: { text } });
				emit({ type: "completed" });
			},
		});
		try {
			const receipt = await fixture.service.delegate(params);
			await vi.waitFor(() =>
				expect(fixture.service.getDetail(receipt.runId).run.status).toBe("completed"),
			);
			const records = fixture.service.getDetail(receipt.runId).evidence.toReversed();
			expect(records.map((item) => item.kind)).toEqual([
				"acp.message",
				"acp.tool_call",
				"acp.message",
				"acp.message",
			]);
			expect(records.map((item) => item.data)).toEqual([
				{ text: "Hello world\\n" },
				{ toolCallId: "write", title: "write", status: "completed" },
				{ text: "x".repeat(4_090) },
				{ text: " final text" },
			]);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("retains useful bounded evidence while redacting secrets and local paths", async () => {
		const cyclic: Record<string, unknown> = {
			toolName: "read",
			text: "Observed a real result",
			password: "private-password",
			path: "/data/private/file.txt",
		};
		cyclic.self = cyclic;
		const fixture = setup({
			launch: async ({ emit }) => {
				emit({ type: "started" });
				emit({ type: "evidence", kind: "tool.result", data: cyclic });
				emit({ type: "completed" });
			},
		});
		try {
			const receipt = await fixture.service.delegate(params);
			await vi.waitFor(() =>
				expect(fixture.service.getDetail(receipt.runId).run.status).toBe("completed"),
			);
			const detail = fixture.service.getDetail(receipt.runId);
			expect(detail.evidence).toEqual([
				expect.objectContaining({
					kind: "tool.result",
					data: expect.objectContaining({ toolName: "read", text: "Observed a real result" }),
				}),
			]);
			expect(JSON.stringify(detail)).not.toContain("private-password");
			expect(JSON.stringify(detail)).not.toContain("/data/private/file.txt");
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("keeps captured artifacts available while native result delivery remains unconfirmed", async () => {
		let confirmed = false;
		const fixture = setup({
			launch: async ({ task, emit }) => {
				writeFileSync(join(task.outputDirectory, "result.txt"), "independent artifact");
				emit({ type: "started" });
				emit({ type: "completed", summary: "The artifact is ready." });
			},
			onTerminal: async () => ({ resultReported: confirmed }),
		});
		try {
			const receipt = await fixture.service.delegate(params);
			await vi.waitFor(() =>
				expect(fixture.service.getDetail(receipt.runId).run.status).toBe("completed"),
			);
			await fixture.service.reconcilePending();
			const pending = fixture.service.getDetail(receipt.runId).run;
			expect(pending.resultReportedAt).toBeUndefined();
			expect(pending.artifacts.map((artifact) => artifact.name)).toEqual(["result.txt"]);
			expect(pending.actions).toEqual(["retryDelivery"]);
			await expect(fixture.service.retryDelivery(receipt.runId)).rejects.toMatchObject({
				reason: "run_result_delivery_pending",
			});
			confirmed = true;
			await fixture.service.retryDelivery(receipt.runId);
			const delivered = fixture.service.getDetail(receipt.runId).run;
			expect(delivered.resultReportedAt).toEqual(expect.any(String));
			expect(delivered.artifacts).toEqual(pending.artifacts);
			expect(delivered.actions).toEqual([]);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});
});

describe("Run launch provenance projection", () => {
	it("exposes only supported bounded launch facts without paths, secrets, or raw manifests", async () => {
		const fixture = setup();
		try {
			seedRun(fixture.database, "provenance", "completed", "2026-09-22T00:00:00.000Z");
			expect(fixture.service.getDetail("provenance").provenance).toEqual({
				entries: [],
				unavailableCount: 0,
				hasMore: false,
			});
			const base = {
				schemaVersion: 1,
				runId: "provenance",
				profileId: "pi-default",
				launchedAt: "2026-09-22T01:02:03.000Z",
			};
			fixture.database.orm
				.insert(runManifests)
				.values([
					{
						id: "pi-launch",
						runId: "provenance",
						manifestJson: {
							...base,
							executor: "pi-acp",
							workerPath: "/private/worker.js",
							apiKey: "never-return-this",
							version: "ignored-for-pi",
							sha256: "a".repeat(64),
						},
					},
					{
						id: "codex-launch",
						runId: "provenance",
						manifestJson: {
							...base,
							executor: "codex",
							version: "0.149.1",
							sha256: "b".repeat(64),
							canonicalPath: "/private/codex",
							environment: { TOKEN: "never-return-this" },
						},
					},
					{
						id: "future-launch",
						runId: "provenance",
						manifestJson: { ...base, schemaVersion: 2, executor: "future" },
					},
					{
						id: "wrong-binding",
						runId: "provenance",
						manifestJson: { ...base, runId: "another-run", executor: "pi-acp" },
					},
				])
				.run();
			const provenance = fixture.service.getDetail("provenance").provenance;
			expect(provenance).toEqual({
				entries: [
					{
						executor: "codex",
						profileId: "pi-default",
						launchedAt: base.launchedAt,
						version: "0.149.1",
						sha256: "b".repeat(64),
					},
					{ executor: "pi-acp", profileId: "pi-default", launchedAt: base.launchedAt },
				],
				unavailableCount: 2,
				hasMore: false,
			});
			expect(JSON.stringify(provenance)).not.toContain("/private");
			expect(JSON.stringify(provenance)).not.toContain("never-return-this");
			expect(JSON.stringify(provenance)).not.toContain("workerPath");
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("omits unsafe optional version and hash fields while retaining valid launch facts", async () => {
		const fixture = setup();
		try {
			seedRun(fixture.database, "unsafe-optional", "completed", "2026-09-22T00:00:00.000Z");
			const versions = [
				"never-return-this",
				"/private/codex",
				"0.149.1\nTOKEN=secret",
				"1".repeat(129),
			];
			for (const [index, version] of versions.entries())
				fixture.database.orm
					.insert(runManifests)
					.values({
						id: `unsafe-${index}`,
						runId: "unsafe-optional",
						manifestJson: {
							schemaVersion: 1,
							executor: "codex",
							runId: "unsafe-optional",
							profileId: "pi-default",
							launchedAt: "2026-09-22T01:02:03.000Z",
							version,
							sha256: "secret-or-path",
						},
					})
					.run();
			const detail = fixture.service.getDetail("unsafe-optional");
			expect(detail.provenance).toEqual({
				entries: versions.map(() => ({
					executor: "codex",
					profileId: "pi-default",
					launchedAt: "2026-09-22T01:02:03.000Z",
				})),
				unavailableCount: 0,
				hasMore: false,
			});
			expect(() => RunGetResponse.parse(detail)).not.toThrow();
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("distinguishes absent, malformed and unsupported records and caps history at twenty", async () => {
		const fixture = setup();
		try {
			seedRun(fixture.database, "unsupported", "completed", "2026-09-22T00:00:00.000Z");
			fixture.database.orm
				.insert(runManifests)
				.values({
					id: "unsupported-record",
					runId: "unsupported",
					manifestJson: { schemaVersion: 99 },
				})
				.run();
			expect(fixture.service.getDetail("unsupported").provenance).toEqual({
				entries: [],
				unavailableCount: 1,
				hasMore: false,
			});
			seedRun(fixture.database, "history", "completed", "2026-09-22T00:00:00.000Z");
			for (let index = 0; index < 21; index++)
				fixture.database.orm
					.insert(runManifests)
					.values({
						id: `launch-${index}`,
						runId: "history",
						manifestJson: {
							schemaVersion: 1,
							executor: "pi-acp",
							runId: "history",
							profileId: "pi-default",
							launchedAt: "2026-09-22T01:02:03.000Z",
						},
					})
					.run();
			const page = fixture.service.getDetail("history").provenance;
			expect(page.entries).toHaveLength(20);
			expect(page).toMatchObject({ unavailableCount: 0, hasMore: true });
			fixture.database.connection
				.prepare("UPDATE run_manifests SET manifest_json = ? WHERE id = ?")
				.run("invalid JSON", "launch-20");
			fixture.database.orm
				.insert(runManifests)
				.values({
					id: "oversize",
					runId: "history",
					manifestJson: { ignored: "secret".repeat(1000) },
				})
				.run();
			const filtered = fixture.service.getDetail("history").provenance;
			expect(filtered.entries).toHaveLength(18);
			expect(filtered).toMatchObject({ unavailableCount: 2, hasMore: true });
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});
});

describe("explicit runner admission", () => {
	it("uses Pi only when omitted and never resolves a Pi model for a selected custom worker", async () => {
		const resolvePiModel = vi.fn(async () => ({ providerId: "test", modelId: "test" }));
		const fixture = setup({
			resolvePiModel,
			profiles: { "custom-research": { id: "custom-research", type: "custom", capabilities: {} } },
		});
		try {
			const custom = await fixture.service.delegate({
				conversationId: "conversation-1",
				inputPaths: [],
				triggerEntryId: "custom-entry",
				toolCallId: "custom-call",
				instruction: "Research",
				runnerId: "custom-research",
			});
			expect(custom).toMatchObject({ executor: "custom", runnerId: "custom-research" });
			expect(resolvePiModel).not.toHaveBeenCalled();
			const pi = await fixture.service.delegate({
				conversationId: "conversation-1",
				inputPaths: [],
				triggerEntryId: "pi-entry",
				toolCallId: "pi-call",
				instruction: "Work",
			});
			expect(pi).toMatchObject({ executor: "pi", runnerId: "pi-default" });
			expect(resolvePiModel).toHaveBeenCalledOnce();
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});
	it("rejects disabled and unknown explicit selections without admitting a default Run", async () => {
		const fixture = setup({
			profiles: { disabled: { id: "disabled", type: "custom", capabilities: { enabled: false } } },
		});
		try {
			for (const runnerId of ["disabled", "missing"])
				await expect(
					fixture.service.delegate({
						conversationId: "conversation-1",
						inputPaths: [],
						triggerEntryId: runnerId,
						toolCallId: runnerId,
						instruction: "Work",
						runnerId,
					}),
				).rejects.toMatchObject({ kind: "unavailable" });
			expect(fixture.service.list()).toEqual([]);
			expect(fixture.launch).not.toHaveBeenCalled();
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});
});
