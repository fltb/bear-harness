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
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import type { ExecutorLaunchRequest, ExecutorRecovery } from "../src/executors/router.js";
import { ExternalAgentRunService, type RunStatus } from "../src/external-agents/run-service.js";
import { COMPANION_SCHEMA_SQL, CompanionDatabase } from "../src/storage/database.js";
import { conversations, runs } from "../src/storage/schema.js";

const roots: string[] = [];

function setup(
	options: {
		launch?: (request: ExecutorLaunchRequest) => Promise<void>;
		interrupt?: () => Promise<void>;
		cancel?: () => Promise<void>;
		close?: () => Promise<void>;
		resolvePiModel?: ConstructorParameters<typeof ExternalAgentRunService>[4];
		onTerminal?: ConstructorParameters<typeof ExternalAgentRunService>[5];
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
	const validateProfile = vi.fn();
	const controllerClose = vi.fn(async () => options.close?.());
	const cancel = vi.fn(async () => options.cancel?.());
	const stop = vi.fn(async () => undefined);
	const runRoot = join(root, "runs");
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
				close: controllerClose,
				cancel,
				stop,
			} as never,
			new ArtifactStore(database.orm, join(root, "artifacts")),
			runRoot,
			options.resolvePiModel ?? (async () => ({ providerId: "test", modelId: "test" })),
			options.onTerminal,
			15_000,
		);
	const service = createService();
	service.subscribeChanges(publish);
	return {
		database,
		service,
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

			expect(delegated).toEqual({ accepted: true, runId: delegated.runId, executor: "pi" });
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
					toolCallId: `tool-${kind}`,
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
			expect(first).toEqual({ accepted: true, runId: second.runId, executor: "pi" });
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

	it("does not settle an owned startup when controller close cannot confirm release", async () => {
		const launchEntered = deferred();
		const startup = deferred();
		const fixture = setup({
			launch: async () => {
				launchEntered.resolve();
				await startup.promise;
			},
			close: async () => {
				startup.resolve();
				throw new Error("native release unconfirmed");
			},
		});
		fixture.runtime.mockReturnValue({ controller: "unknown", actions: [] });
		fixture.recover.mockResolvedValue("unknown");
		try {
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
