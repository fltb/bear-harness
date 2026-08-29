// @vitest-environment node

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiTimeline } from "@bear-harness/protocol/schema";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PendingTurnStore } from "../src/companion/pending-turn-store.js";
import {
	type CompanionModelRuntimeSource,
	CompanionSupervisor,
} from "../src/companion/supervisor.js";
import { TurnPipeline } from "../src/companion/turn-pipeline.js";
import { ConversationRepository } from "../src/conversations/repository.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

const crashChildPath = fileURLToPath(
	new URL("./failpoints/pending-turn-crash-child.mjs", import.meta.url),
);
const READY_PREFIX = "PENDING_TURN_COMMITTED:";
const CHILD_TIMEOUT_MS = 8_000;
const RECOVERY_TIMEOUT_MS = 12_000;
const CONVERSATION_ID = "pending-turn-crash-conversation";
const COMPANION_ID = "pending-turn-crash-companion";
const USER_TEXT = "keep this exact turn";
const FRAMED_TEXT = `<host_context>\ncrash recovery\n</host_context>\n\n<current_user_message>\n${USER_TEXT}\n</current_user_message>`;
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_BASE64 = IMAGE_BYTES.toString("base64");
const IMAGE_MIME_TYPE = "image/png";
const REPLY_TEXT = "RECOVERED AFTER SIGKILL";
const FAILPOINTS = ["accepted", "dispatched", "user_persisted"] as const;
type Failpoint = (typeof FAILPOINTS)[number];

const roots = new Set<string>();
const databases = new Set<Database>();
const pipelines = new Set<TurnPipeline>();
const runtimes = new Set<CompanionSupervisor>();
const activeChildren = new Set<ChildProcess>();

interface Fixture {
	root: string;
	databaseDir: string;
	database: Database;
	runtime: CompanionSupervisor;
	faux: FauxProviderHandle;
	turnId: string;
	attachmentId: string;
	attachmentSendNonce: string;
	piEntryId?: string;
	fixturePath: string;
}

function createAuthlessModels(faux: FauxProviderHandle) {
	const models = createModels();
	models.setProvider(faux.provider);
	const authless = models as typeof models & {
		hasConfiguredAuth: (providerId: string) => boolean;
	};
	authless.hasConfiguredAuth = () => true;
	return models;
}

async function createFixture(failpoint: Failpoint): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), `bear-pending-turn-${failpoint}-`));
	roots.add(root);
	const databaseDir = join(root, "database");
	const database = new Database(databaseDir);
	databases.add(database);
	database.migrate(MIGRATIONS);
	const eventBus = new EventBus(database.orm);
	const repository = new ConversationRepository(database.orm, {
		sessionDir: join(root, "sessions"),
		sessionCwd: root,
	});
	database.connection.exec(`
		INSERT INTO companion_packages (id, name, version, hash, origin)
		VALUES ('${COMPANION_ID}', 'Crash Companion', '1.0.0', 'crash-hash', 'official');
		INSERT INTO companion_identity (id, package_id, name, self_canon)
		VALUES ('${COMPANION_ID}', '${COMPANION_ID}', 'Crash Companion', '{}');
	`);
	repository.createAndSelect({
		id: CONVERSATION_ID,
		branchId: "main",
		companionId: COMPANION_ID,
		title: "Pending turn crash",
	});

	const faux = fauxProvider({
		provider: `pending-turn-crash-${failpoint}`,
		models: [
			{
				id: `pending-turn-crash-${failpoint}`,
				name: "Pending turn crash model",
				input: ["text", "image"],
			},
		],
	});
	const models = createAuthlessModels(faux);
	const providers: CompanionModelRuntimeSource = { getModels: async () => models };
	const runtime = new CompanionSupervisor(
		root,
		eventBus,
		providers,
		repository.getSessionResolver(),
	);
	runtimes.add(runtime);
	repository.setLiveSessionResolver(runtime.getLiveSessionResolver());
	await runtime.start();
	const session = await runtime.ensureSession(CONVERSATION_ID);
	session.agent.state.model = faux.models[0];

	const turnId = randomUUID();
	const attachmentId = randomUUID();
	const attachmentSendNonce = randomUUID();
	database.connection
		.prepare(`
			INSERT INTO conversation_attachments (
				id, conversation_id, origin_entry_id, send_nonce,
				kind, name, total_bytes, file_count
			) VALUES (?, ?, NULL, ?, 'file', 'crash-image.png', ?, 1)
		`)
		.run(attachmentId, CONVERSATION_ID, attachmentSendNonce, IMAGE_BYTES.byteLength);

	let piEntryId: string | undefined;
	if (failpoint !== "accepted") {
		await session.agentSession.sendCustomMessage(
			{
				customType: "host_pending_turn",
				content: "",
				display: false,
				details: { turnId },
			},
			{ triggerTurn: false },
		);
	}
	if (failpoint === "user_persisted") {
		piEntryId = session.sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: FRAMED_TEXT },
				{ type: "image", data: IMAGE_BASE64, mimeType: IMAGE_MIME_TYPE },
			],
			timestamp: Date.now(),
		});
	}

	const fixturePath = join(root, "pending-turn-fixture.json");
	writeFileSync(
		fixturePath,
		JSON.stringify({
			turnId,
			conversationId: CONVERSATION_ID,
			framedText: FRAMED_TEXT,
			attachmentId,
			attachmentSendNonce,
			imageMimeType: IMAGE_MIME_TYPE,
			imageBase64: IMAGE_BASE64,
			piEntryId,
		}),
		{ mode: 0o600 },
	);
	return {
		root,
		databaseDir,
		database,
		runtime,
		faux,
		turnId,
		attachmentId,
		attachmentSendNonce,
		piEntryId,
		fixturePath,
	};
}

function runCrashChild(
	fixture: Fixture,
	failpoint: Failpoint,
): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[crashChildPath, join(fixture.databaseDir, "canon.db"), failpoint, fixture.fixturePath],
			{
				cwd: fixture.root,
				env: { ...process.env, NODE_NO_WARNINGS: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		activeChildren.add(child);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pending-turn crash child timed out at ${failpoint}`));
		}, CHILD_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			activeChildren.delete(child);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			activeChildren.delete(child);
			if (!stdout.includes(`${READY_PREFIX}${failpoint}\n`)) {
				reject(
					new Error(
						`pending-turn crash child exited before durable acknowledgement (${stderr || stdout})`,
					),
				);
				return;
			}
			resolve({ code, signal, stdout, stderr });
		});
	});
}

function messageEntries(repository: ConversationRepository) {
	const projection = repository.get(CONVERSATION_ID, COMPANION_ID);
	return PiTimeline.parse(projection?.piTimeline).entries.filter(
		(entry) => entry.kind === "message",
	);
}

afterEach(async () => {
	const children = [...activeChildren];
	await Promise.all(
		children.map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resolve();
						return;
					}
					child.once("exit", () => resolve());
					child.kill("SIGKILL");
				}),
		),
	);
	activeChildren.clear();
	for (const pipeline of pipelines) pipeline.dispose();
	pipelines.clear();
	for (const runtime of runtimes) await runtime.stop();
	runtimes.clear();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	for (const database of databases) database.close();
	databases.clear();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots.clear();
});

describe("pending-turn process crash recovery", () => {
	for (const failpoint of FAILPOINTS) {
		it(`recovers exactly once after SIGKILL at the ${failpoint} durable boundary`, async () => {
			const fixture = await createFixture(failpoint);
			const observedUserContent: unknown[] = [];
			const captureResponse: FauxResponseFactory = (context) => {
				observedUserContent.push(
					context.messages.find((message) => message.role === "user")?.content,
				);
				return fauxAssistantMessage(REPLY_TEXT);
			};
			fixture.faux.setResponses([captureResponse, captureResponse]);

			const death = await runCrashChild(fixture, failpoint);
			expect(death).toMatchObject({ code: null, signal: "SIGKILL" });
			expect(death.stdout).toBe(`${READY_PREFIX}${failpoint}\n`);

			// Cross a real Host restart boundary before constructing any recovered
			// DB-backed component. Removing each resource from its cleanup registry
			// after disposal prevents afterEach from stopping or closing it twice.
			await fixture.runtime.stop();
			runtimes.delete(fixture.runtime);
			fixture.database.close();
			databases.delete(fixture.database);

			const recoveredDatabase = new Database(fixture.databaseDir);
			databases.add(recoveredDatabase);
			const recoveredEventBus = new EventBus(recoveredDatabase.orm);
			const recoveredRepository = new ConversationRepository(recoveredDatabase.orm, {
				sessionDir: join(fixture.root, "sessions"),
				sessionCwd: fixture.root,
			});
			const recoveredModels = createAuthlessModels(fixture.faux);
			const recoveredProviders: CompanionModelRuntimeSource = {
				getModels: async () => recoveredModels,
			};
			const recoveredRuntime = new CompanionSupervisor(
				fixture.root,
				recoveredEventBus,
				recoveredProviders,
				recoveredRepository.getSessionResolver(),
			);
			runtimes.add(recoveredRuntime);
			recoveredRepository.setLiveSessionResolver(recoveredRuntime.getLiveSessionResolver());
			await recoveredRuntime.start();
			const recoveredSession = await recoveredRuntime.ensureSession(CONVERSATION_ID);
			recoveredSession.agent.state.model = fixture.faux.models[0];

			const timelineBeforeReconciliation = messageEntries(recoveredRepository);
			if (failpoint === "user_persisted") {
				expect(timelineBeforeReconciliation).toHaveLength(1);
				expect(timelineBeforeReconciliation[0]).toMatchObject({
					id: fixture.piEntryId,
					role: "user",
					text: USER_TEXT,
				});
			} else {
				expect(timelineBeforeReconciliation).toEqual([]);
			}

			const pendingTurns = new PendingTurnStore(recoveredDatabase.orm);
			const durable = pendingTurns.get(CONVERSATION_ID, fixture.turnId);
			expect(durable).toMatchObject({
				id: fixture.turnId,
				conversationId: CONVERSATION_ID,
				framedText: FRAMED_TEXT,
				attachmentIds: [fixture.attachmentId],
				attachmentSendNonce: fixture.attachmentSendNonce,
				state: failpoint,
				piEntryId: failpoint === "user_persisted" ? fixture.piEntryId : null,
			});
			expect(durable?.images).toHaveLength(1);
			expect(durable?.images[0]).toMatchObject({
				attachmentId: fixture.attachmentId,
				mimeType: IMAGE_MIME_TYPE,
			});
			expect(durable?.images[0]?.data.equals(IMAGE_BYTES)).toBe(true);

			let attachmentBindingChanges = 0;
			const pipeline = new TurnPipeline(
				recoveredDatabase.orm,
				recoveredRuntime,
				recoveredEventBus,
				{
					pendingTurns,
					finishAttachmentSend: (conversationId, nonce, nativeUserEntryId) => {
						const result = recoveredDatabase.connection
							.prepare(`
									UPDATE conversation_attachments
									SET origin_entry_id = ?, send_nonce = NULL
									WHERE conversation_id = ? AND send_nonce = ?
								`)
							.run(nativeUserEntryId, conversationId, nonce);
						attachmentBindingChanges += Number(result.changes);
					},
				},
			);
			pipelines.add(pipeline);
			const providerRequestCountBeforeReconciliation = observedUserContent.length;
			await pipeline.reconcilePendingTurns({ timeoutMs: RECOVERY_TIMEOUT_MS });

			const framedProviderRequest = [
				{ type: "text", text: FRAMED_TEXT },
				{ type: "image", data: IMAGE_BASE64, mimeType: IMAGE_MIME_TYPE },
			];
			const recoveryProviderRequests = observedUserContent.slice(
				providerRequestCountBeforeReconciliation,
			);
			expect(recoveryProviderRequests).toEqual([framedProviderRequest]);
			const firstTimeline = messageEntries(recoveredRepository);
			expect(firstTimeline.map((entry) => entry.role)).toEqual(["user", "assistant"]);
			expect(firstTimeline[0]?.text).toBe(USER_TEXT);
			expect(firstTimeline[1]?.text).toBe(REPLY_TEXT);
			expect(pendingTurns.get(CONVERSATION_ID, fixture.turnId)).toMatchObject({
				state: "completed",
				piEntryId: firstTimeline[0]?.id,
			});
			expect(attachmentBindingChanges).toBe(1);
			expect(
				recoveredDatabase.connection
					.prepare(`
							SELECT origin_entry_id AS originEntryId, send_nonce AS sendNonce
							FROM conversation_attachments WHERE id = ?
						`)
					.get(fixture.attachmentId),
			).toEqual({ originEntryId: firstTimeline[0]?.id, sendNonce: null });

			const providerRequestsAfterFirstReconciliation = [...observedUserContent];
			await pipeline.reconcilePendingTurns({ timeoutMs: RECOVERY_TIMEOUT_MS });
			expect(messageEntries(recoveredRepository)).toEqual(firstTimeline);
			expect(observedUserContent).toEqual(providerRequestsAfterFirstReconciliation);
			expect(attachmentBindingChanges).toBe(1);
			expect(pendingTurns.listIncomplete(CONVERSATION_ID)).toEqual([]);
		}, 30_000);
	}
});
