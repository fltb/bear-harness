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
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import type { ExecutorLaunchRequest } from "../src/executors/router.js";
import { ExternalAgentRunService, type RunStatus } from "../src/external-agents/run-service.js";
import { COMPANION_MIGRATIONS, CompanionDatabase } from "../src/storage/database.js";
import { conversations, runs } from "../src/storage/schema.js";

const roots: string[] = [];

function setup(options: { launch?: (request: ExecutorLaunchRequest) => Promise<void> } = {}) {
	const root = mkdtempSync(join(tmpdir(), "bear-run-restart-"));
	roots.push(root);
	const database = new CompanionDatabase(join(root, "runtime.db"), "bear");
	database.migrate(COMPANION_MIGRATIONS);
	database.ensureRuntimeIdentity();
	database.orm.insert(conversations).values({ id: "conversation-1", companionId: "bear" }).run();
	const publish = vi.fn();
	const interrupt = vi.fn(async () => undefined);
	const resume = vi.fn(async () => undefined);
	const recover = vi.fn(async (_run: ExecutorLaunchRequest["run"]) => "confirmed_lost" as const);
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
				profile: { id: run.executorProfile, type: "codex", capabilities: {} },
			}),
	);
	const validateProfile = vi.fn();
	const controllerClose = vi.fn(async () => undefined);
	const cancel = vi.fn(async () => undefined);
	const stop = vi.fn(async () => undefined);
	const emit = vi.fn();
	const runRoot = join(root, "runs");
	const service = new ExternalAgentRunService(
		database.orm,
		{ publish } as never,
		{
			interrupt,
			resume,
			recover,
			launch,
			validateProfile,
			close: controllerClose,
			cancel,
			stop,
		} as never,
		new ArtifactStore(database.orm, join(root, "artifacts")),
		runRoot,
		async () => "pi-default",
		async () => undefined,
		undefined,
		15_000,
		{ emit } as never,
	);
	return {
		database,
		service,
		runRoot,
		publish,
		interrupt,
		resume,
		recover,
		launch,
		controllerClose,
		cancel,
		stop,
		emit,
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

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ExternalAgentRunService restart recovery", () => {
	it("queries recovery before marking confirmed orphaned runs as forced termination", async () => {
		const { database, service, runRoot, recover, emit } = setup();
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
			expect(
				emit.mock.calls
					.filter(([name]) => name === "external_agent.run")
					.map(([, attributes]) => attributes),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ runId: "running", phase: "forced_termination" }),
					expect.objectContaining({ runId: "interrupted", phase: "forced_termination" }),
				]),
			);
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

	it("counts unfinished interrupted runs against executor resource concurrency", async () => {
		const { database, launch, service } = setup();
		try {
			seedRun(database, "interrupted-a", "interrupted");
			seedRun(database, "interrupted-b", "interrupted");

			await expect(
				service.delegate({
					conversationId: "conversation-1",
					triggerEntryId: "entry-blocked",
					agent: "codex",
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
		const { database, launch, service } = setup();
		try {
			seedRun(database, "historical-a", "interrupted", "2026-08-31T00:00:00.000Z");
			seedRun(database, "historical-b", "interrupted", "2026-08-31T00:00:00.000Z");

			await expect(
				service.delegate({
					conversationId: "conversation-1",
					triggerEntryId: "entry-allowed",
					agent: "codex",
					inputPaths: [],
					instruction: "Use the available executor slot.",
				}),
			).resolves.toMatchObject({ status: "enqueued" });
			expect(launch).toHaveBeenCalledOnce();
		} finally {
			await service.close();
			database.close();
		}
	});

	it("stops conversation-owned controllers and workspaces before deletion", async () => {
		const { cancel, database, runRoot, service, stop } = setup();
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
				agent: "codex",
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
				diagnostics: fixture.emit.mock.calls,
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
				agent: "codex",
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
					status: "verified",
				}),
			]);
		} finally {
			await fixture.service.close();
			fixture.database.close();
		}
	});

	it("fails capture before copying an output tree that exceeds depth or byte limits", async () => {
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
					agent: "codex",
					inputPaths: [],
					instruction: "Create oversized output",
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
		}
	});

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
				agent: "codex",
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
