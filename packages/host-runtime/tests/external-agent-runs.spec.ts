// @vitest-environment node

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts/index.js";
import {
	type CompanionModelRuntimeSource,
	CompanionSupervisor,
} from "../src/companion/supervisor.js";
import { TurnPipeline } from "../src/companion/turn-pipeline.js";
import { ConversationAttachmentService } from "../src/conversation-attachments/service.js";
import { ConversationRepository } from "../src/conversations/repository.js";
import { createDiagnostics, type Diagnostics } from "../src/diagnostics/index.js";
import { readDiagnosticTrace } from "../src/diagnostics/query.js";
import { seedPiAcpProfile } from "../src/executors/pi-adapter.js";
import { type ExecutorLaunchRequest, ExecutorRouter } from "../src/executors/router.js";
import {
	ExternalAgentRunService,
	externalAgentResultMessage,
	removeExternalAgentRunRoot,
	type TerminalRunResult,
} from "../src/external-agents/run-service.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";
import { runs } from "../src/storage/schema.js";

const CONVERSATION_ID = "conversation";
const COMPANION_ID = "character";
const roots: string[] = [];
const databases: Database[] = [];
const pipelines: TurnPipeline[] = [];
const supervisors: CompanionSupervisor[] = [];
const services: ExternalAgentRunService[] = [];
const diagnosticsInstances: Diagnostics[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const diagnostics of diagnosticsInstances.splice(0)) await diagnostics.shutdown();
	for (const pipeline of pipelines.splice(0)) pipeline.dispose();
	for (const supervisor of supervisors.splice(0)) await supervisor.stop();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	for (const database of databases.splice(0)) database.close();
	for (const root of roots.splice(0)) {
		removeExternalAgentRunRoot(join(root, "runs"));
		rmSync(root, { recursive: true, force: true });
	}
});

function createDatabase(): {
	root: string;
	database: Database;
	repository: ConversationRepository;
} {
	const root = mkdtempSync(join(tmpdir(), "bear-external-runs-"));
	roots.push(root);
	const database = new Database(join(root, "storage"));
	databases.push(database);
	database.migrate(MIGRATIONS);
	database.connection
		.prepare("INSERT INTO companion_packages (id, name, version, hash) VALUES (?, ?, ?, ?)")
		.run(COMPANION_ID, "Character", "1", "hash");
	database.connection
		.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES (?, ?, ?, ?)",
		)
		.run(COMPANION_ID, COMPANION_ID, "Character", "");
	const repository = new ConversationRepository(database.orm, {
		sessionDir: join(root, "sessions"),
		sessionCwd: root,
	});
	repository.createAndSelect({
		id: CONVERSATION_ID,
		companionId: COMPANION_ID,
		title: "Direct run chat",
		sceneTitle: "Scene",
	});
	return { root, database, repository };
}

function authlessModels(faux: FauxProviderHandle) {
	const models = createModels();
	models.setProvider(faux.provider);
	(models as typeof models & { hasConfiguredAuth(providerId: string): boolean }).hasConfiguredAuth =
		() => true;
	return models;
}

async function createRoleHarness() {
	const { root, database, repository } = createDatabase();
	const faux = fauxProvider({
		provider: "external-result-role",
		models: [{ id: "role-model", name: "Role model" }],
	});
	const providers: CompanionModelRuntimeSource = { getModels: async () => authlessModels(faux) };
	const eventBus = new EventBus(database.orm);
	const supervisor = new CompanionSupervisor(
		root,
		eventBus,
		providers,
		repository.getSessionResolver(),
	);
	supervisors.push(supervisor);
	repository.setLiveSessionResolver(supervisor.getLiveSessionResolver());
	await supervisor.start();
	const pipeline = new TurnPipeline(database.orm, supervisor, eventBus);
	pipelines.push(pipeline);
	const session = await supervisor.ensureSession(CONVERSATION_ID);
	session.agent.state.model = faux.models[0];
	return { root, database, repository, faux, supervisor, pipeline, session };
}

async function waitForTerminal(service: ExternalAgentRunService, runId: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!service.list().find((run) => run.id === runId)?.completedAt && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	if (!service.list().find((run) => run.id === runId)?.completedAt) {
		throw new Error("run did not settle");
	}
}

describe("direct external-agent runs", () => {
	it("launches the default Pi profile, captures terminal outputs, and reconciles exactly once", async () => {
		const { root, database } = createDatabase();
		const eventBus = new EventBus(database.orm);
		const attachments = new ConversationAttachmentService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "artifacts")),
		);
		const input = attachments.createSnapshot({
			conversationId: CONVERSATION_ID,
			kind: "file",
			name: "input.txt",
			files: [{ relativePath: "input.txt", mime: "text/plain", buffer: Buffer.from("input") }],
		});
		seedPiAcpProfile(database.orm);
		const router = new ExecutorRouter(database.orm);
		let launch: ExecutorLaunchRequest | undefined;
		const launchAgent = vi.fn(async (request: ExecutorLaunchRequest) => {
			launch = request;
			request.emit({ type: "started" });
		});
		router.register("pi", { launch: launchAgent });
		let active = false;
		const terminal = vi.fn(async (_result: TerminalRunResult) => ({
			resultReported: active,
			memoryCaptured: active,
		}));
		const diagnostics = createDiagnostics({
			app: { setAppLogsPath: () => undefined, setPath: () => undefined },
			root: join(root, "diagnostics"),
			launchId: "external-run-trace",
			logLevel: "info",
			heartbeatMs: 0,
			pruneIntervalMs: 0,
		});
		diagnosticsInstances.push(diagnostics);
		const service = new ExternalAgentRunService(
			database.orm,
			eventBus,
			router,
			attachments,
			join(root, "runs"),
			async () => "pi-default",
			() => ({ providerId: "provider", modelId: "model" }),
			terminal,
			undefined,
			diagnostics,
		);
		services.push(service);

		const turn = diagnostics.startSpan("companion.turn", {
			conversationId: CONVERSATION_ID,
			hasImages: false,
			includeHistory: false,
		});
		const delegated = await diagnostics.runInSpan(turn, () =>
			service.delegate({
				conversationId: CONVERSATION_ID,
				triggerEntryId: "native-user-entry",
				agent: "pi",
				attachmentIds: [input.id],
				instruction: "Produce the requested file",
			}),
		);
		turn.end("ok");
		expect(launchAgent).toHaveBeenCalledOnce();
		expect(launch?.profile).toMatchObject({ id: "pi-default", type: "pi" });
		expect(launch?.task.modelRoute).toEqual({ providerId: "provider", modelId: "model" });
		if (process.platform !== "win32") {
			const snapshotDirectory = launch!.task.readOnlyPaths![0]!;
			expect(statSync(snapshotDirectory).mode & 0o777).toBe(0o500);
			expect(statSync(join(snapshotDirectory, "input.txt")).mode & 0o777).toBe(0o400);
		}
		writeFileSync(join(launch!.task.outputDirectory, "answer.txt"), "captured output");
		launch!.emit({ type: "completed", summary: "Finished safely" });
		await waitForTerminal(service, delegated.runId);
		expect(terminal).toHaveBeenCalledOnce();
		expect(terminal.mock.calls[0]?.[0].outputs).toEqual([
			expect.objectContaining({ kind: "generated", fileCount: 1 }),
		]);

		active = true;
		await service.reconcilePending(CONVERSATION_ID);
		const settled = database.orm
			.select()
			.from(runs)
			.all()
			.find((run) => run.id === delegated.runId);
		expect(settled?.resultReportedAt).toBeTruthy();
		expect(settled?.memoryCapturedAt).toBeTruthy();
		expect(terminal).toHaveBeenCalledTimes(2);
		await service.reconcilePending(CONVERSATION_ID);
		expect(terminal).toHaveBeenCalledTimes(2);
		await diagnostics.shutdown();
		const trace = await readDiagnosticTrace(join(root, "diagnostics"), turn.context.traceId);
		expect(
			trace.records
				.filter((record) => record.name === "external_agent.run")
				.map((record) => record.attributes.phase),
		).toEqual(expect.arrayContaining(["enqueued", "started", "completed"]));
		await service.close();
		expect(existsSync(join(root, "runs"))).toBe(false);
	});

	it("keeps raw terminal results visible while a hung follow-up remains durably retryable", async () => {
		const { root, database } = createDatabase();
		const eventBus = new EventBus(database.orm);
		const attachments = new ConversationAttachmentService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "artifacts")),
		);
		const input = attachments.createSnapshot({
			conversationId: CONVERSATION_ID,
			kind: "file",
			name: "input.txt",
			files: [{ relativePath: "input.txt", mime: "text/plain", buffer: Buffer.from("input") }],
		});
		seedPiAcpProfile(database.orm);
		const router = new ExecutorRouter(database.orm);
		let launch: ExecutorLaunchRequest | undefined;
		router.register("pi", {
			launch: async (request) => {
				launch = request;
				request.emit({ type: "started" });
			},
		});
		const never = new Promise<never>(() => undefined);
		const terminal = vi.fn(() => never);
		const service = new ExternalAgentRunService(
			database.orm,
			eventBus,
			router,
			attachments,
			join(root, "runs"),
			async () => "pi-default",
			() => ({ providerId: "provider", modelId: "model" }),
			terminal,
			20,
		);
		services.push(service);
		const delegated = await service.delegate({
			conversationId: CONVERSATION_ID,
			triggerEntryId: "native-user-entry",
			agent: "pi",
			attachmentIds: [input.id],
			instruction: "Finish without waiting for role follow-up",
		});
		launch!.emit({ type: "completed", summary: "Raw executor result" });
		await waitForTerminal(service, delegated.runId);
		expect(service.list().find((run) => run.id === delegated.runId)).toMatchObject({
			status: "completed",
			summary: "Raw executor result",
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(
			database.connection
				.prepare(
					"SELECT result_reported_at AS resultReportedAt, memory_captured_at AS memoryCapturedAt FROM runs WHERE id = ?",
				)
				.get(delegated.runId),
		).toEqual({ resultReportedAt: null, memoryCapturedAt: null });
		expect(
			database.connection
				.prepare(
					"SELECT COUNT(*) AS count FROM evidence WHERE run_id = ? AND kind = 'run.reconciliation_pending'",
				)
				.get(delegated.runId),
		).toEqual({ count: 1 });

		const firstRetry = service.reconcilePending(CONVERSATION_ID);
		const duplicateRetry = service.reconcilePending(CONVERSATION_ID);
		await Promise.resolve();
		expect(terminal).toHaveBeenCalledTimes(2);
		await expect(service.close()).resolves.toBeUndefined();
		await expect(Promise.all([firstRetry, duplicateRetry])).resolves.toEqual([1, 1]);
		expect(terminal).toHaveBeenCalledTimes(2);
	});

	it("delivers one hidden role follow-up and binds generated outputs to its native assistant entry", async () => {
		const h = await createRoleHarness();
		h.faux.setResponses([fauxAssistantMessage("I have the completed result for you.")]);
		const first = await h.pipeline.deliverExternalAgentResult(
			CONVERSATION_ID,
			"run-1",
			"External agent completed with one generated attachment.",
		);
		const hungProvider = vi
			.spyOn(h.supervisor, "selectModelForConversation")
			.mockImplementation(() => new Promise<never>(() => undefined));
		const second = await h.pipeline.deliverExternalAgentResult(
			CONVERSATION_ID,
			"run-1",
			"This duplicate must not be appended.",
		);
		expect(second).toEqual(first);
		expect(hungProvider).not.toHaveBeenCalled();
		const notifications = h.session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom_message" && entry.customType === "host_external_agent_result",
			);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toMatchObject({ display: false, details: { runId: "run-1" } });

		const attachments = new ConversationAttachmentService(
			h.database.orm,
			new ArtifactStore(h.database.orm, join(h.root, "artifacts")),
		);
		const generated = attachments.createSnapshot({
			conversationId: CONVERSATION_ID,
			kind: "generated",
			name: "Generated outputs",
			files: [{ relativePath: "answer.txt", mime: "text/plain", buffer: Buffer.from("answer") }],
		});
		attachments.bindGenerated(CONVERSATION_ID, [generated.id], first.entryId);
		expect(attachments.list(CONVERSATION_ID, generated.id)).toEqual([
			expect.objectContaining({ id: generated.id, originEntryId: first.entryId }),
		]);
	});

	it("interrupts startup orphans, including permission waits, without relaunching agents", async () => {
		const { root, database } = createDatabase();
		const eventBus = new EventBus(database.orm);
		const router = new ExecutorRouter(database.orm);
		const launchAgent = vi.fn(async (_request: ExecutorLaunchRequest) => undefined);
		router.register("pi", { launch: launchAgent });
		seedPiAcpProfile(database.orm);
		const attachments = new ConversationAttachmentService(
			database.orm,
			new ArtifactStore(database.orm, join(root, "artifacts")),
		);
		for (const status of ["enqueued", "running", "needs_user", "interrupted"] as const) {
			database.orm
				.insert(runs)
				.values({
					id: `orphan-${status}`,
					conversationId: CONVERSATION_ID,
					triggerEntryId: "native-user-entry",
					executorProfile: "pi-default",
					title: status,
					instruction: "stale process",
					status,
				})
				.run();
		}
		const terminal = vi.fn(async () => ({ resultReported: true, memoryCaptured: true }));
		const service = new ExternalAgentRunService(
			database.orm,
			eventBus,
			router,
			attachments,
			join(root, "runs"),
			async () => "pi-default",
			() => ({ providerId: "provider", modelId: "model" }),
			terminal,
		);
		services.push(service);
		eventBus.publish("run.needs_user", {
			runId: "orphan-needs_user",
			requestId: "request",
			prompt: "Allow?",
			options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
		});
		expect(service.pendingPermissions(COMPANION_ID)).toEqual([
			expect.objectContaining({ runId: "orphan-needs_user", requestId: "request" }),
		]);
		expect(service.pendingPermissions("other-character")).toEqual([]);
		expect(service.markOrphansInterrupted()).toBe(4);
		expect(service.pendingPermissions(COMPANION_ID)).toEqual([]);
		await service.reconcilePending();
		expect(launchAgent).not.toHaveBeenCalled();
		expect(service.list().filter((run) => run.status === "interrupted")).toHaveLength(4);
		expect(terminal).toHaveBeenCalledTimes(4);
	});

	it.skipIf(process.platform === "win32")(
		"restores Host-owned run permissions without following symlinks",
		() => {
			const root = mkdtempSync(join(tmpdir(), "bear-external-run-cleanup-"));
			roots.push(root);
			const runRoot = join(root, "runs");
			const snapshot = join(runRoot, "run-1", "snapshot-0", "nested");
			const outside = join(root, "outside");
			mkdirSync(snapshot, { recursive: true });
			mkdirSync(outside);
			const snapshotFile = join(snapshot, "input.txt");
			const outsideFile = join(outside, "preserved.txt");
			writeFileSync(snapshotFile, "immutable input");
			writeFileSync(outsideFile, "outside run root");
			symlinkSync(outside, join(snapshot, "escape"));
			chmodSync(snapshotFile, 0o400);
			chmodSync(snapshot, 0o500);
			chmodSync(outsideFile, 0o400);

			removeExternalAgentRunRoot(runRoot);

			expect(existsSync(runRoot)).toBe(false);
			expect(readFileSync(outsideFile, "utf8")).toBe("outside run root");
			expect(statSync(outsideFile).mode & 0o777).toBe(0o400);
		},
	);

	it("bounds and sanitizes the Tencent memory/result payload without paths or terminal control logs", () => {
		const content = externalAgentResultMessage({
			run: {
				id: "run-safe",
				conversationId: CONVERSATION_ID,
				triggerEntryId: "native-user-entry",
				executorProfile: "pi-default",
				title: "Result at /Users/alice/private/work.txt\u001b[31m",
				status: "completed",
				startedAt: null,
				completedAt: new Date().toISOString(),
				summary: `${"safe summary ".repeat(1_000)} C:\\secret\\terminal.log`,
			},
			outputs: [
				{
					id: "attachment-1",
					name: "/tmp/private-output.txt",
					kind: "generated",
					bytes: 10,
					fileCount: 1,
				},
			],
		});
		expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(6_000);
		expect(content).not.toContain("/Users/alice");
		expect(content).not.toContain("/tmp/private-output.txt");
		expect(content).not.toContain("C:\\secret");
		expect(content).not.toContain("\u001b");
		expect(content).toContain("<redacted-path>");
	});
});
