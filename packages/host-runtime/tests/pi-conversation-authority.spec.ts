// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiLiveState, PiTimeline } from "@bear-harness/protocol/schema";
import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PendingTurnStore } from "../src/companion/pending-turn-store.js";
import { PiSessionStore } from "../src/companion/pi-session-store.js";
import {
	type CompanionModelRuntimeSource,
	CompanionSupervisor,
	type PiSessionHandle,
} from "../src/companion/supervisor.js";
import { TurnPipeline } from "../src/companion/turn-pipeline.js";
import { ConversationRepository } from "../src/conversations/repository.js";
import { Database, MIGRATIONS } from "../src/storage/database.js";
import { EventBus } from "../src/storage/event-bus.js";

/**
 * Pi conversation authority contract (plan §8): AgentSession/SessionManager
 * are the only transcript authority. These tests drive the real Host
 * composition — repository + EventBus + CompanionSupervisor + TurnPipeline —
 * against a scripted pi-ai faux provider and assert the observable
 * projection contracts, including zero writes to the legacy Host transcript
 * tables that still exist until the removal migration.
 */

const CONVERSATION_ID = "conversation";
const COMPANION_ID = "character";
const REPLY_TEXT = "HELLO FROM PI";
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createAuthlessModels(faux: FauxProviderHandle) {
	const models = createModels();
	models.setProvider(faux.provider);
	const authless = models as typeof models & {
		hasConfiguredAuth: (providerId: string) => boolean;
	};
	authless.hasConfiguredAuth = () => true;
	return models;
}

interface Harness {
	root: string;
	database: Database;
	eventBus: EventBus;
	repository: ConversationRepository;
	store: PiSessionStore;
	runtime: CompanionSupervisor;
	pipeline: TurnPipeline;
	pendingTurns: PendingTurnStore;
	attachmentBinding: { writes: number };
	faux: FauxProviderHandle;
}

const roots: string[] = [];
const databases: Database[] = [];
const pipelines: TurnPipeline[] = [];
const runtimes: CompanionSupervisor[] = [];

afterEach(async () => {
	for (const pipeline of pipelines.splice(0)) pipeline.dispose();
	for (const runtime of runtimes.splice(0)) await runtime.stop();
	// Drain any microtask-scheduled pi.session.changed notifications published
	// after stop() before the connection closes.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	for (const database of databases.splice(0)) database.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Build the full Host composition with one empty conversation and a live session. */
async function setupHarness(
	options: {
		tokensPerSecond?: number;
		onCorrectedTurn?: (turn: {
			conversationId: string;
			userText: string;
			assistantText: string;
			correction: string;
		}) => Promise<void>;
	} = {},
): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "bear-pi-authority-"));
	roots.push(root);
	const faux = fauxProvider({
		provider: "pi-authority",
		models: [{ id: "pi-authority-model", name: "Pi authority model", input: ["text", "image"] }],
		...options,
	});
	const models = createAuthlessModels(faux);
	const database = new Database(root);
	databases.push(database);
	database.migrate(MIGRATIONS);
	const eventBus = new EventBus(database.orm);
	const repository = new ConversationRepository(database.orm, {
		sessionDir: join(root, "sessions"),
		sessionCwd: root,
	});
	// conversations.companion_id references companion_identity, which in turn
	// references companion_packages — both must exist before createAndSelect.
	database.connection
		.prepare(
			"INSERT INTO companion_packages (id, name, version, hash) VALUES ('character', 'Character', '1', 'hash')",
		)
		.run();
	database.connection
		.prepare(
			"INSERT INTO companion_identity (id, package_id, name, self_canon) VALUES ('character', 'character', 'Character', '')",
		)
		.run();
	repository.createAndSelect({
		id: CONVERSATION_ID,
		branchId: "main",
		companionId: COMPANION_ID,
		title: "Authority chat",
		sceneTitle: "Scene",
	});
	const store = repository.getSession(CONVERSATION_ID);
	const providers: CompanionModelRuntimeSource = { getModels: async () => models };
	const runtime = new CompanionSupervisor(
		root,
		eventBus,
		providers,
		repository.getSessionResolver(),
	);
	runtimes.push(runtime);
	repository.setLiveSessionResolver(runtime.getLiveSessionResolver());
	await runtime.start();
	const pendingTurns = new PendingTurnStore(database.orm);
	const attachmentBinding = { writes: 0 };
	const pipeline = new TurnPipeline(database.orm, runtime, eventBus, {
		pendingTurns,
		...(options.onCorrectedTurn ? { onCorrectedTurn: options.onCorrectedTurn } : {}),
		finishAttachmentSend: (conversationId, nonce, nativeUserEntryId) => {
			const result = database.connection
				.prepare(
					"UPDATE conversation_attachments SET origin_entry_id = ?, send_nonce = NULL WHERE conversation_id = ? AND send_nonce = ?",
				)
				.run(nativeUserEntryId, conversationId, nonce);
			attachmentBinding.writes += Number(result.changes);
		},
	});
	pipelines.push(pipeline);

	// TurnPipeline.prompt() runs Pi without the supervisor route selection, so
	// inject the resolved model into the same agent state Bear's selectRoute
	// would have populated.
	const session = await runtime.ensureSession(CONVERSATION_ID);
	session.agent.state.model = faux.models[0];
	return {
		root,
		database,
		eventBus,
		repository,
		store,
		runtime,
		pipeline,
		pendingTurns,
		attachmentBinding,
		faux,
	};
}

function assertTranscriptTablesAbsent(database: Database): void {
	for (const table of ["messages", "message_versions", "turns", "branches"]) {
		expect(
			database.connection
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(table),
		).toBeUndefined();
	}
}

/** Wait for the fire-and-forget Host dispatch to begin and then settle. */
async function settleSession(h: Harness): Promise<PiSessionHandle> {
	const session = h.runtime.getLiveSessionResolver().get(CONVERSATION_ID);
	if (!session) throw new Error("live session missing");
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	const deadline = Date.now() + 5_000;
	while (session.isStreaming && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	if (session.isStreaming) throw new Error("session never became idle");
	return session;
}

function isStandardMessageEntry(
	entry: unknown,
): entry is { id: string; message: { role: string; content?: unknown } } {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as { type?: unknown; id?: unknown; message?: unknown };
	if (candidate.type !== "message" || typeof candidate.id !== "string") return false;
	if (!candidate.message || typeof candidate.message !== "object") return false;
	const message = candidate.message as { role?: unknown; content?: unknown };
	if (typeof message.role !== "string") return false;
	return true;
}

function messageEntries(timeline: PiTimeline) {
	return timeline.entries.filter((entry) => entry.kind === "message");
}

describe("Pi conversation authority", () => {
	it("persists the native user entry on accepted send and the native assistant entry after the final stream, with zero Host transcript writes", async () => {
		const h = await setupHarness();
		h.faux.setResponses([fauxAssistantMessage(REPLY_TEXT)]);
		assertTranscriptTablesAbsent(h.database);

		const receipt = await h.pipeline.sendUserMessage(CONVERSATION_ID, "hello");
		expect(receipt).toEqual({
			accepted: true,
			sessionId: h.store.sessionId,
			entryId: expect.stringMatching(/^[0-9a-f]{8}$/),
		});

		await settleSession(h);
		const projection = h.repository.get(CONVERSATION_ID, COMPANION_ID);
		expect(projection?.piSessionId).toBe(h.store.sessionId);
		const timeline = PiTimeline.parse(projection?.piTimeline);
		expect(PiLiveState.parse(projection?.piLiveState)).toEqual({ isStreaming: false });
		const entries = messageEntries(timeline);
		expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
		expect(entries[0]?.text).toBe("hello");
		expect(entries[1]?.text).toBe(REPLY_TEXT);

		// Every timeline ID is a Pi SessionManager entry ID, never a Host UUID.
		for (const entry of entries) {
			expect(entry.id).toMatch(/^[0-9a-f]{8}$/);
			expect(entry.id).not.toMatch(FULL_UUID);
		}

		// The durable tree owns the transcript: reopen from the session file and
		// read the same native entries.
		const reopened = PiSessionStore.open({
			sessionDir: join(h.root, "sessions"),
			cwd: h.root,
			sessionFile: h.store.sessionFile,
		});
		expect(reopened.buildPiTimeline().entries.map((entry) => entry.id)).toEqual(
			entries.map((entry) => entry.id),
		);

		// No Host transcript mirror remains to receive a write.
		assertTranscriptTablesAbsent(h.database);

		await h.runtime.stop();
	});
	it("passes Host-resolved current-message image bytes to Pi as image content", async () => {
		const h = await setupHarness();
		let userContent: unknown;
		h.faux.setResponses([
			(context) => {
				userContent = context.messages.find((message) => message.role === "user")?.content;
				return fauxAssistantMessage(REPLY_TEXT);
			},
		]);

		const attachmentId = randomUUID();
		const sendNonce = randomUUID();
		h.database.connection
			.prepare(
				"INSERT INTO conversation_attachments (id, conversation_id, send_nonce, kind, name, total_bytes, file_count) VALUES (?, ?, ?, 'file', 'image.png', 4, 1)",
			)
			.run(attachmentId, CONVERSATION_ID, sendNonce);
		await h.pipeline.sendUserMessage(
			CONVERSATION_ID,
			"inspect this",
			[
				{
					attachmentId,
					data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
					mimeType: "image/png",
				},
			],
			{
				attachmentIds: [attachmentId],
				attachmentSendNonce: sendNonce,
			},
		);
		await settleSession(h);

		expect(userContent).toEqual([
			{ type: "text", text: "inspect this" },
			{ type: "image", data: "iVBORw==", mimeType: "image/png" },
		]);
	});

	it("exposes the partial assistant through piLiveState.streamingMessage while the user entry is already durable", async () => {
		const h = await setupHarness({ tokensPerSecond: 30 });
		h.faux.setResponses([fauxAssistantMessage(REPLY_TEXT)]);
		const session = h.runtime.getLiveSessionResolver().get(CONVERSATION_ID);
		if (!session) throw new Error("live session missing");

		await h.pipeline.sendUserMessage(CONVERSATION_ID, "hello");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const deadline = Date.now() + 5_000;
		while (
			!h.repository.get(CONVERSATION_ID, COMPANION_ID)?.piLiveState.streamingMessage?.text &&
			session.isStreaming &&
			Date.now() < deadline
		) {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}

		// Mid-stream: user entry durable, assistant entry not yet final.
		// The native user entry is durable before the turn settles. A fast
		// provider may append the final assistant before this assertion runs.
		const storeTimeline = PiTimeline.parse(h.store.buildPiTimeline());
		const storeMessages = messageEntries(storeTimeline);
		expect(storeMessages[0]).toMatchObject({ role: "user", text: "hello" });
		// Repository projection performs the safe Pi live-state mapping. A fast
		// provider may settle after the user entry becomes visible; in that case
		// the final assistant is already native and no live fragment remains.
		const projection = h.repository.get(CONVERSATION_ID, COMPANION_ID);
		const live = PiLiveState.parse(projection?.piLiveState);
		const projectedTimeline = PiTimeline.parse(projection?.piTimeline);
		if (live.isStreaming) {
			expect(live.streamingMessage?.stopReason).toBe("pending");
			expect(live.streamingMessage?.text).toBeDefined();
			expect(REPLY_TEXT.startsWith(live.streamingMessage?.text ?? "\u0000")).toBe(true);
			expect(projectedTimeline.entries.map((entry) => entry.role)).toEqual(["user"]);
		} else {
			expect(live).toEqual({ isStreaming: false });
			expect(projectedTimeline.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
		}
		// After the final stream: streamingMessage disappears and the native
		// assistant entry replaces it in the timeline.
		await settleSession(h);
		const settled = h.repository.get(CONVERSATION_ID, COMPANION_ID);
		expect(PiLiveState.parse(settled?.piLiveState)).toEqual({ isStreaming: false });
		expect(
			messageEntries(PiTimeline.parse(settled?.piTimeline)).map((entry) => entry.role),
		).toEqual(["user", "assistant"]);

		await h.runtime.stop();
	});

	it("expresses provider failures through the Pi final assistant, not a Host synthetic message", async () => {
		const h = await setupHarness();
		h.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "PROVIDER_BROKE" }),
		]);
		await h.pipeline.sendUserMessage(CONVERSATION_ID, "hello");
		await settleSession(h);

		const projection = h.repository.get(CONVERSATION_ID, COMPANION_ID);
		expect(PiLiveState.parse(projection?.piLiveState).isStreaming).toBe(false);
		const messages = messageEntries(PiTimeline.parse(projection?.piTimeline));
		expect(messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
		expect(messages[1]?.text).toBeUndefined();
		expect(messages[1]?.toolCalls).toBeUndefined();
		expect(messages[1]).toMatchObject({ stopReason: "error", errorMessage: "PROVIDER_BROKE" });

		const live = PiLiveState.parse(
			h.runtime.getLiveSessionResolver().get(CONVERSATION_ID)?.readPiLiveState(),
		);
		expect(live.errorMessage).toBe("PROVIDER_BROKE");

		await h.runtime.stop();
	});

	it("expresses abort through the Pi final assistant and leaves no Host synthetic entry", async () => {
		const h = await setupHarness({ tokensPerSecond: 10 });
		h.faux.setResponses([fauxAssistantMessage(REPLY_TEXT)]);
		const session = h.runtime.getLiveSessionResolver().get(CONVERSATION_ID);
		if (!session) throw new Error("live session missing");
		assertTranscriptTablesAbsent(h.database);

		await h.pipeline.sendUserMessage(CONVERSATION_ID, "hello");
		const streamingStarted = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		await streamingStarted;
		expect(session.isStreaming).toBe(true);

		await session.abort();
		expect(session.isStreaming).toBe(false);
		const entries = h.store.sessionManager.buildContextEntries();
		const messages = entries.filter(isStandardMessageEntry);
		expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
		const assistantMessage = messages.at(-1)?.message;
		expect(assistantMessage).toBeDefined();
		if (!assistantMessage) throw new Error("assistant entry missing");
		expect(assistantMessage).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		});
		assertTranscriptTablesAbsent(h.database);

		const projection = h.repository.get(CONVERSATION_ID, COMPANION_ID);
		expect(PiLiveState.parse(projection?.piLiveState).isStreaming).toBe(false);
		expect(messageEntries(PiTimeline.parse(projection?.piTimeline)).at(-1)?.role).toBe("assistant");

		await h.runtime.stop();
	});

	it("rejects editing an assistant entry without touching the Pi tree", async () => {
		const h = await setupHarness();
		h.faux.setResponses([fauxAssistantMessage(REPLY_TEXT)]);
		await h.pipeline.sendUserMessage(CONVERSATION_ID, "hello");
		await settleSession(h);
		const before = h.store.sessionManager
			.buildContextEntries()
			.filter(isStandardMessageEntry)
			.map((entry) => entry.id);
		const assistantId = before.at(-1);
		if (!assistantId) throw new Error("no assistant entry");

		await expect(h.pipeline.edit(CONVERSATION_ID, assistantId, "rewritten")).rejects.toMatchObject({
			kind: "invalid_request",
			reason: "message_edit_user_only",
		});

		const after = h.store.sessionManager
			.buildContextEntries()
			.filter(isStandardMessageEntry)
			.map((entry) => entry.id);
		expect(after).toEqual(before);
		expect(h.store.sessionManager.getLeafId()).toBe(assistantId);
		const entries = messageEntries(PiTimeline.parse(h.store.buildPiTimeline()));
		expect(entries[0]?.text).toBe("hello");
		expect(entries[1]?.text).toBe(REPLY_TEXT);

		await h.runtime.stop();
	});

	it("replaces a rejected assistant answer with a hidden role-package correction", async () => {
		const captures: Array<{ userText: string; assistantText: string; correction: string }> = [];
		const h = await setupHarness({
			onCorrectedTurn: async ({ userText, assistantText, correction }) => {
				captures.push({ userText, assistantText, correction });
			},
		});
		h.faux.setResponses([
			fauxAssistantMessage("wrong answer"),
			fauxAssistantMessage("corrected answer"),
		]);
		await h.pipeline.sendUserMessage(CONVERSATION_ID, "hello");
		await settleSession(h);
		const rejected = messageEntries(PiTimeline.parse(h.store.buildPiTimeline())).at(-1);
		if (!rejected) throw new Error("no rejected assistant entry");

		await h.pipeline.correct(CONVERSATION_ID, rejected.id, "Stay in character.");
		await settleSession(h);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const visible = messageEntries(PiTimeline.parse(h.store.buildPiTimeline()));
		expect(visible.map((entry) => entry.text)).toEqual(["hello", "corrected answer"]);
		expect(JSON.stringify(h.store.buildPiTimeline())).not.toContain("Stay in character");
		expect(captures).toEqual([
			{
				userText: "hello",
				assistantText: "corrected answer",
				correction: "Stay in character.",
			},
		]);
	});

	it("reopens an accepted outbox turn, replays stored content and images once, binds once, and never replays it after completion", async () => {
		const h = await setupHarness();
		const turnId = randomUUID();
		const attachmentId = randomUUID();
		const sendNonce = randomUUID();
		h.database.connection
			.prepare(
				"INSERT INTO conversation_attachments (id, conversation_id, send_nonce, kind, name, total_bytes, file_count) VALUES (?, ?, ?, 'file', 'image.png', 4, 1)",
			)
			.run(attachmentId, CONVERSATION_ID, sendNonce);
		h.pendingTurns.createAccepted({
			id: turnId,
			conversationId: CONVERSATION_ID,
			framedText: "recover this accepted turn",
			images: [
				{
					attachmentId,
					mimeType: "image/png",
					data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
				},
			],
			attachmentIds: [attachmentId],
			attachmentSendNonce: sendNonce,
		});
		let replayedUserContent: unknown;
		h.faux.setResponses([
			(context) => {
				replayedUserContent = context.messages.find((message) => message.role === "user")?.content;
				return fauxAssistantMessage(REPLY_TEXT);
			},
		]);

		h.pipeline.dispose();
		const reopened = new TurnPipeline(h.database.orm, h.runtime, h.eventBus, {
			pendingTurns: h.pendingTurns,
			finishAttachmentSend: (conversationId, nonce, nativeUserEntryId) => {
				const result = h.database.connection
					.prepare(
						"UPDATE conversation_attachments SET origin_entry_id = ?, send_nonce = NULL WHERE conversation_id = ? AND send_nonce = ?",
					)
					.run(nativeUserEntryId, conversationId, nonce);
				h.attachmentBinding.writes += Number(result.changes);
			},
		});
		pipelines.push(reopened);
		await reopened.reconcilePendingTurns();
		await settleSession(h);

		expect(replayedUserContent).toEqual([
			{ type: "text", text: "recover this accepted turn" },
			{ type: "image", data: "iVBORw==", mimeType: "image/png" },
		]);
		const firstTimeline = messageEntries(PiTimeline.parse(h.store.buildPiTimeline()));
		expect(firstTimeline.map((entry) => entry.role)).toEqual(["user", "assistant"]);
		expect(firstTimeline[0]?.text).toBe("recover this accepted turn");
		expect(h.pendingTurns.get(CONVERSATION_ID, turnId)?.state).toBe("completed");
		expect(h.attachmentBinding.writes).toBe(1);
		expect(
			h.database.connection
				.prepare(
					"SELECT origin_entry_id AS originEntryId, send_nonce AS sendNonce FROM conversation_attachments WHERE id = ?",
				)
				.get(attachmentId),
		).toEqual({
			originEntryId: firstTimeline[0]?.id,
			sendNonce: null,
		});

		await reopened.reconcilePendingTurns();
		expect(messageEntries(PiTimeline.parse(h.store.buildPiTimeline()))).toEqual(firstTimeline);
		expect(h.attachmentBinding.writes).toBe(1);
	});

	it("resumes a durable native user receipt after reopen instead of duplicating the user turn", async () => {
		const h = await setupHarness();
		const turnId = randomUUID();
		h.pendingTurns.createAccepted({
			id: turnId,
			conversationId: CONVERSATION_ID,
			framedText: "native user survived",
		});
		const session = await h.runtime.ensureSession(CONVERSATION_ID);
		await session.agentSession.sendCustomMessage(
			{
				customType: "host_pending_turn",
				content: "",
				display: false,
				details: { turnId },
			},
			{ triggerTurn: false },
		);
		const nativeUserEntryId = session.sessionManager.appendMessage({
			role: "user",
			content: "native user survived",
			timestamp: Date.now(),
		});
		h.faux.setResponses([fauxAssistantMessage(REPLY_TEXT)]);

		h.pipeline.dispose();
		const reopened = new TurnPipeline(h.database.orm, h.runtime, h.eventBus, {
			pendingTurns: h.pendingTurns,
		});
		pipelines.push(reopened);
		await reopened.reconcilePendingTurns();

		const nativeMarker = h.store.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "host_pending_turn" &&
					(entry.details as { turnId?: unknown } | undefined)?.turnId === turnId,
			);
		expect(nativeMarker).toMatchObject({
			type: "custom_message",
			customType: "host_pending_turn",
			details: { turnId },
		});

		const timeline = PiTimeline.parse(h.store.buildPiTimeline());
		expect(timeline.entries.some((entry) => entry.id === nativeMarker?.id)).toBe(false);
		expect(timeline.entries.map((entry) => entry.kind)).toEqual(["message", "message"]);
		const entries = messageEntries(timeline);
		expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
		expect(entries.filter((entry) => entry.role === "user")).toHaveLength(1);
		expect(entries[0]?.id).toBe(nativeUserEntryId);
		expect(h.pendingTurns.get(CONVERSATION_ID, turnId)).toMatchObject({
			state: "completed",
			piEntryId: nativeUserEntryId,
		});
	});

	it("retains a failed replay as pending with a recoverable error", async () => {
		const h = await setupHarness();
		const turnId = randomUUID();
		h.pendingTurns.createAccepted({
			id: turnId,
			conversationId: CONVERSATION_ID,
			framedText: "retry after failure",
		});
		const originalPrompt = h.runtime.promptConversation.bind(h.runtime);
		h.runtime.promptConversation = () => {
			throw new Error("replay dispatch failed");
		};

		await h.pipeline.reconcilePendingTurns();
		h.runtime.promptConversation = originalPrompt;

		expect(h.pendingTurns.get(CONVERSATION_ID, turnId)).toMatchObject({
			state: "dispatched",
			piEntryId: null,
			lastError: "replay dispatch failed",
		});
		expect(messageEntries(PiTimeline.parse(h.store.buildPiTimeline()))).toHaveLength(0);
	});

	it("publishes only session-change notifications whose payloads carry no transcript text", async () => {
		const h = await setupHarness();
		h.faux.setResponses([fauxAssistantMessage(REPLY_TEXT)]);
		const changed: Array<Record<string, unknown>> = [];
		const unsubscribe = h.eventBus.subscribe((event) => {
			if (event.kind === "pi.session.changed") changed.push(event.payload);
		});

		await h.pipeline.sendUserMessage(CONVERSATION_ID, "hello");
		await settleSession(h);
		unsubscribe();

		expect(changed.length).toBeGreaterThan(0);
		for (const payload of changed) {
			expect(payload).toEqual({
				conversationId: CONVERSATION_ID,
				sessionId: h.store.sessionId,
				reason: expect.stringMatching(/^(message|turn|agent|tool|compaction|queue)$/),
			});
			expect(payload).not.toHaveProperty("text");
			expect(payload).not.toHaveProperty("message");
			expect(payload).not.toHaveProperty("delta");
		}

		// The persisted event stream contains no transcript-bearing event kinds.
		const kinds = (
			h.database.connection.prepare("SELECT kind FROM events ORDER BY seq").all() as Array<{
				kind: string;
			}>
		).map((row) => row.kind);
		expect(kinds).not.toContain("message.user_sent");
		expect(kinds).not.toContain("message_start");
		expect(kinds).not.toContain("message_update");
		expect(kinds).not.toContain("message_end");
		expect(kinds).not.toContain("message.assistant_committed");
		expect(kinds).toContain("pi.session.changed");

		await h.runtime.stop();
	});
});
