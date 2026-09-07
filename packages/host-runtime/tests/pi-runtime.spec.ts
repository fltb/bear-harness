// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LivePush, PiProjectionVersion } from "@bear-harness/protocol";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectPiLiveSnapshot } from "../src/companion/pi-live-events.js";
import { PiRuntime, type PiRuntimeOptions } from "../src/companion/pi-runtime.js";

const roots: string[] = [];
type PiSessionEvent = { sessionId: string; event: AgentSessionEvent; version: PiProjectionVersion };

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "bear-pi-registry-"));
	roots.push(value);
	mkdirSync(join(value, "runtime"), { recursive: true });
	mkdirSync(join(value, "sessions"), { recursive: true });
	return value;
}

function persistedSession(dataDir: string, name: string): string {
	const manager = SessionManager.create(join(dataDir, "runtime"), join(dataDir, "sessions"));
	manager.appendSessionInfo(name);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Pi did not allocate a session file");
	writeFileSync(
		sessionFile,
		`${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return manager.getSessionId();
}

function assistantMessage(text = "reply") {
	return {
		role: "assistant" as const,
		api: "openai-completions" as const,
		content: [{ type: "text" as const, text }],
		provider: "provider",
		model: "model",
		timestamp: 2,
		stopReason: "stop" as const,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function persistedConversation(
	dataDir: string,
	userText = "hello",
): { sessionId: string; userId: string; assistantId: string } {
	const manager = SessionManager.create(join(dataDir, "runtime"), join(dataDir, "sessions"));
	const userId = manager.appendMessage({ role: "user", content: userText, timestamp: 1 });
	const assistantId = manager.appendMessage(assistantMessage());
	return { sessionId: manager.getSessionId(), userId, assistantId };
}

interface FakeSession {
	session: AgentSession;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	sendCustomMessage: ReturnType<typeof vi.fn>;
	listenerCount(): number;
	emit(event: AgentSessionEvent): void;
}

function fakeSession(manager: SessionManager): FakeSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const abort = vi.fn(async () => undefined);
	const dispose = vi.fn();
	const sendCustomMessage = vi.fn(
		async (message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		}) => {
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		},
	);
	const session = {
		sessionId: manager.getSessionId(),
		sessionName: manager.getSessionName(),
		sessionFile: manager.getSessionFile(),
		sessionManager: manager,
		messages: [],
		agent: { hasQueuedMessages: () => true },
		isIdle: true,
		isStreaming: false,
		isRetrying: false,
		retryAttempt: 0,
		isCompacting: false,
		state: { streamingMessage: undefined, errorMessage: undefined, pendingToolCalls: new Set() },
		pendingMessageCount: 0,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		abort,
		abortCompaction: vi.fn(),
		abortBranchSummary: vi.fn(),
		dispose,
		sendCustomMessage,
		setSessionName: (name: string) => manager.appendSessionInfo(name),
	} as unknown as AgentSession;
	return {
		session,
		abort,
		dispose,
		sendCustomMessage,
		listenerCount: () => listeners.size,
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
	};
}

function setup(dataDir: string) {
	const nativeEvents: PiSessionEvent[] = [];
	const discarded: string[] = [];
	const runtime = new PiRuntime({
		paths: { runtime: join(dataDir, "runtime"), sessions: join(dataDir, "sessions") },
		models: {
			getModels: async () => ({
				getModel: (providerId: string, modelId: string) => ({
					provider: providerId,
					id: modelId,
				}),
			}),
		},
		memory: { drain: async () => undefined },
		sessionEvent: (sessionId: string, event: AgentSessionEvent, version: PiProjectionVersion) =>
			nativeEvents.push({ sessionId, event, version }),
		sessionDiscarded: (sessionId: string) => discarded.push(sessionId),
	} as unknown as PiRuntimeOptions);
	const built = new Map<string, FakeSession>();
	const buildSession = vi.fn(async (manager: SessionManager) => {
		const value = fakeSession(manager);
		built.set(manager.getSessionId(), value);
		return value.session;
	});
	Object.assign(runtime, { buildSession });
	return { runtime, built, buildSession, nativeEvents, discarded };
}

interface PiRuntimeTestAccess {
	consumeResponseGuidance(sessionId: string, prompt: string): string | undefined;
}

function responseGuidanceConsumer(runtime: PiRuntime) {
	// Exercise the exact extension-hook callback without building a provider-backed Pi session.
	const testAccess = runtime as unknown as PiRuntimeTestAccess;
	return testAccess.consumeResponseGuidance.bind(testAccess);
}

async function nativeSetup(
	overrides: {
		memory?: Partial<PiRuntimeOptions["memory"]>;
		context?: PiRuntimeOptions["context"];
	} = {},
) {
	const dataDir = root();
	const models = await ModelRuntime.create({
		authPath: join(dataDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	models.registerProvider("test", {
		baseUrl: "https://unused.invalid",
		api: "openai-completions",
		apiKey: "test-only",
		models: [
			{
				id: "test-model",
				name: "Test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			},
		],
	});
	const stream = vi.spyOn(models, "streamSimple").mockImplementation(() => {
		const events = new AssistantMessageEventStream();
		events.push({ type: "done", reason: "stop", message: assistantMessage() });
		return events;
	});
	const activities: Extract<LivePush, { type: "conversationActivity" }>[] = [];
	const nativeEvents: PiSessionEvent[] = [];
	const runtime = new PiRuntime({
		paths: { runtime: join(dataDir, "runtime"), sessions: join(dataDir, "sessions") },
		models: { getModels: async () => models },
		character: () => ({ id: "test-character" }),
		defaultModel: () => ({ providerId: "test", modelId: "test-model" }),
		multimodalFallback: () => undefined,
		context: overrides.context ?? (() => "turn context"),
		memory: {
			enabled: () => true,
			recall: async () => ({ appendSystemContext: "recalled context" }),
			capture: async () => undefined,
			drain: async () => undefined,
			explicit: { read: async () => "", edit: async () => "" },
			...overrides.memory,
		},
		sessionActivity: (event: Extract<LivePush, { type: "conversationActivity" }>) =>
			activities.push(event),
		sessionEvent: (sessionId: string, event: AgentSessionEvent, version: PiProjectionVersion) =>
			nativeEvents.push({ sessionId, event, version }),
	} as unknown as PiRuntimeOptions);
	const session = await runtime.create("Native lifecycle");
	return { runtime, session, activities, nativeEvents, stream };
}

afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PiRuntime session registry", () => {
	it("deduplicates concurrent opens of the same session", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Alpha");
		const { runtime, buildSession } = setup(dataDir);

		const [left, right] = await Promise.all([runtime.open(id), runtime.open(id)]);

		expect(left.sessionId).toBe(id);
		expect(right.sessionId).toBe(id);
		expect(buildSession).toHaveBeenCalledTimes(1);
		expect(runtime.snapshot(id)?.sessionId).toBe(id);
	});

	it("lists a native empty handle, then discards its missing transcript on close", async () => {
		const dataDir = root();
		const { runtime, discarded } = setup(dataDir);
		const created = await runtime.create();

		expect((await runtime.list()).map(({ id }) => id)).toContain(created.sessionId);
		await runtime.close(created.sessionId);

		expect(discarded).toEqual([created.sessionId]);
		expect((await setup(dataDir).runtime.list()).map(({ id }) => id)).not.toContain(
			created.sessionId,
		);
	});

	it("opens another session without aborting the first", async () => {
		const dataDir = root();
		const alpha = persistedSession(dataDir, "Alpha");
		const beta = persistedSession(dataDir, "Beta");
		const { runtime, built } = setup(dataDir);

		await runtime.open(alpha);
		await runtime.open(beta);

		expect(built.get(alpha)?.abort).not.toHaveBeenCalled();
		expect(runtime.snapshot(alpha)?.sessionId).toBe(alpha);
		expect(runtime.snapshot(beta)?.sessionId).toBe(beta);
	});

	it("forks from a separately loaded manager without mutating the source handle", async () => {
		const dataDir = root();
		const { sessionId, assistantId } = persistedConversation(dataDir);
		const { runtime } = setup(dataDir);
		const source = await runtime.open(sessionId);

		const branch = await runtime.fork(sessionId, assistantId, "Branch");

		expect(branch.sessionId).not.toBe(sessionId);
		expect(branch.sessionName).toBe("Branch");
		expect(source.sessionId).toBe(sessionId);
		expect(source.sessionManager.getSessionId()).toBe(sessionId);
		expect(runtime.snapshot(sessionId)).toBe(source);
		expect(runtime.snapshot(branch.sessionId)).toBe(branch);
	});

	it("edits a historical user turn as a sibling in the same native Session tree", async () => {
		const dataDir = root();
		const { sessionId, userId, assistantId } = persistedConversation(dataDir);
		const { runtime } = setup(dataDir);
		const session = await runtime.open(sessionId);
		const manager = session.sessionManager;
		const prompt = vi.fn((text: string, options: { preflightResult(ok: boolean): void }) => {
			manager.appendMessage({ role: "user", content: text, timestamp: 3 });
			options.preflightResult(true);
			return new Promise<void>(() => undefined);
		});
		const navigateTree = vi.fn(async (targetId: string) => {
			const target = manager.getEntry(targetId);
			if (target?.type === "message" && target.message.role === "user") {
				if (target.parentId) manager.branch(target.parentId);
				else manager.resetLeaf();
			}
			return { cancelled: false };
		});
		Object.assign(session, { navigateTree, prompt });

		await runtime.edit(sessionId, userId, "replacement");

		const branch = manager.getBranch();
		const replacement = branch.at(-1);
		expect(session.sessionId).toBe(sessionId);
		expect(replacement).toMatchObject({
			type: "message",
			parentId: null,
			message: { role: "user", content: "replacement" },
		});
		expect(branch.some(({ id }) => id === assistantId)).toBe(false);
		expect(manager.getEntry(userId)).toBeDefined();
		expect(replacement?.parentId).toBe(manager.getEntry(userId)?.parentId);
		expect(prompt).toHaveBeenCalledWith(
			"replacement",
			expect.objectContaining({ expandPromptTemplates: false }),
		);
	});

	it("corrects an assistant answer with exact original text, images, and one-turn guidance", async () => {
		const dataDir = root();
		const originalText = "  /literal\n保留空白  ";
		const image = {
			type: "image" as const,
			data: "aW1hZ2U=",
			mimeType: "image/png" as const,
		};
		const persisted = SessionManager.create(join(dataDir, "runtime"), join(dataDir, "sessions"));
		const userId = persisted.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "  /literal\n" },
				image,
				{ type: "text", text: "保留空白  " },
			],
			timestamp: 1,
		});
		const assistantId = persisted.appendMessage(assistantMessage());
		const sessionId = persisted.getSessionId();
		const { runtime } = setup(dataDir);
		const session = await runtime.open(sessionId);
		const manager = session.sessionManager;
		const systemPrompts: string[] = [];
		const consumeGuidance = responseGuidanceConsumer(runtime);
		const navigateTree = vi.fn(async (targetId: string) => {
			const target = manager.getEntry(targetId);
			if (target?.type === "message" && target.message.role === "user") {
				if (target.parentId) manager.branch(target.parentId);
				else manager.resetLeaf();
			} else if (target) {
				manager.branch(target.id);
			}
			return { cancelled: false };
		});
		let resolveCorrectionTurn!: () => void;
		const correctionTurn = new Promise<void>((resolve) => {
			resolveCorrectionTurn = resolve;
		});
		const prompt = vi.fn(
			(
				text: string,
				options: { images?: (typeof image)[]; preflightResult(ok: boolean): void },
			) => {
				const guidance = consumeGuidance(sessionId, text);
				systemPrompts.push(guidance ? `base\n\n${guidance}` : "base");
				manager.appendMessage({ role: "user", content: text, timestamp: 3 });
				Object.assign(session, { isStreaming: true });
				options.preflightResult(true);
				return prompt.mock.calls.length === 1 ? correctionTurn : Promise.resolve();
			},
		);
		const abort = vi.fn(async () => {
			Object.assign(session, { isStreaming: false });
			resolveCorrectionTurn();
		});
		Object.assign(session, { sessionName: "Named", navigateTree, prompt, abort });
		let turnFinished = false;
		void correctionTurn.then(() => {
			turnFinished = true;
		});

		await runtime.correct(sessionId, assistantId, "这不像极昼");
		expect(turnFinished).toBe(false);
		await expect(runtime.send(sessionId, "too early")).rejects.toMatchObject({
			reason: "pi_session_busy",
		});
		await runtime.abort(sessionId);
		expect(turnFinished).toBe(true);
		await runtime.send(sessionId, "later");

		expect(session.sessionId).toBe(sessionId);
		expect(prompt.mock.calls[0]?.[0]).toBe(originalText);
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(prompt.mock.calls[1]?.[0]).toBe("later");
		expect(prompt.mock.calls[0]?.[1]?.images).toEqual([image]);
		expect(manager.getBranch().some(({ id }) => id === userId || id === assistantId)).toBe(false);
		expect(systemPrompts[0]).toContain(JSON.stringify("这不像极昼"));
		expect(systemPrompts[1]).toBe("base");
	});

	it("rejects invalid edit and correction roles before navigating the Session tree", async () => {
		const dataDir = root();
		const { sessionId, userId, assistantId } = persistedConversation(dataDir);
		const { runtime } = setup(dataDir);
		const session = await runtime.open(sessionId);
		const navigateTree = vi.fn();
		Object.assign(session, { navigateTree });

		await expect(runtime.edit(sessionId, assistantId, "replacement")).rejects.toMatchObject({
			reason: "pi_user_message_not_found",
		});
		await expect(runtime.correct(sessionId, userId, "feedback")).rejects.toMatchObject({
			reason: "pi_assistant_message_not_found",
		});
		session.sessionManager.resetLeaf();
		const orphanAssistantId = session.sessionManager.appendMessage(assistantMessage("orphan"));
		await expect(runtime.correct(sessionId, orphanAssistantId, "feedback")).rejects.toMatchObject({
			reason: "pi_user_message_not_found",
		});
		expect(navigateTree).not.toHaveBeenCalled();
	});

	it("restores the source branch and clears hidden guidance when prompt preflight rejects", async () => {
		const dataDir = root();
		const { sessionId, assistantId } = persistedConversation(dataDir, "original");
		const { runtime } = setup(dataDir);
		const session = await runtime.open(sessionId);
		const manager = session.sessionManager;
		const consumeGuidance = responseGuidanceConsumer(runtime);
		const navigateTree = vi.fn(async (targetId: string) => {
			const target = manager.getEntry(targetId);
			if (target?.type === "message" && target.message.role === "user") {
				if (target.parentId) manager.branch(target.parentId);
				else manager.resetLeaf();
			} else if (target) {
				manager.branch(target.id);
			}
			return { cancelled: false };
		});
		let leakedGuidance: string | undefined;
		const prompt = vi
			.fn()
			.mockImplementationOnce((_text: string, options: { preflightResult(ok: boolean): void }) => {
				options.preflightResult(false);
				return Promise.resolve();
			})
			.mockImplementation((text: string, options: { preflightResult(ok: boolean): void }) => {
				leakedGuidance = consumeGuidance(sessionId, text);
				options.preflightResult(true);
				return Promise.resolve();
			});
		Object.assign(session, { sessionName: "Named", navigateTree, prompt });

		await expect(runtime.correct(sessionId, assistantId, "must not leak")).rejects.toMatchObject({
			reason: "pi_prompt_rejected",
		});
		expect(manager.getLeafId()).toBe(assistantId);
		await runtime.send(sessionId, "later");
		expect(leakedGuidance).toBeUndefined();
	});

	it("tags every native Pi event and does not drop message updates", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Alpha");
		const { runtime, built, nativeEvents } = setup(dataDir);
		await runtime.open(id);

		built.get(id)?.emit({
			type: "message_update",
			message: { role: "assistant", content: [], timestamp: 1 },
			assistantMessageEvent: { type: "text_delta", delta: "a" },
		} as unknown as AgentSessionEvent);
		built.get(id)?.emit({ type: "agent_settled" });

		expect(nativeEvents.map(({ sessionId, event }) => [sessionId, event.type])).toEqual([
			[id, "message_update"],
			[id, "agent_settled"],
		]);
	});

	it("closes only the requested session", async () => {
		const dataDir = root();
		const alpha = persistedSession(dataDir, "Alpha");
		const beta = persistedSession(dataDir, "Beta");
		const { runtime, built } = setup(dataDir);
		await Promise.all([runtime.open(alpha), runtime.open(beta)]);

		await runtime.close(alpha);

		expect(built.get(alpha)?.abort).toHaveBeenCalledOnce();
		expect(built.get(alpha)?.dispose).toHaveBeenCalledOnce();
		expect(built.get(beta)?.abort).not.toHaveBeenCalled();
		expect(runtime.snapshot(alpha)).toBeUndefined();
		expect(runtime.snapshot(beta)?.sessionId).toBe(beta);
	});

	it.runIf(typeof (globalThis as { gc?: () => void }).gc === "function")(
		"releases handles, subscriptions, queues, and heap across 100 open-close cycles",
		async () => {
			const dataDir = root();
			const id = persistedSession(dataDir, "Repeated");
			const { runtime, built, buildSession } = setup(dataDir);
			const forceGc = (globalThis as { gc(): void }).gc;
			for (let warmup = 0; warmup < 100; warmup += 1) {
				await runtime.open(id);
				await runtime.close(id, "preserve");
				built.delete(id);
				buildSession.mockClear();
			}
			forceGc();
			const baseline = process.memoryUsage().heapUsed;
			let buildCount = 0;
			for (let cycle = 0; cycle < 100; cycle += 1) {
				await runtime.open(id);
				const current = built.get(id);
				buildCount += buildSession.mock.calls.length;
				expect(current?.listenerCount()).toBe(1);
				await runtime.close(id, "preserve");
				expect(runtime.snapshot(id)).toBeUndefined();
				expect(current?.listenerCount()).toBe(0);
				expect(current?.dispose).toHaveBeenCalledOnce();
				built.delete(id);
				buildSession.mockClear();
			}
			forceGc();
			const growth = Math.max(0, process.memoryUsage().heapUsed - baseline);
			expect(buildCount).toBe(100);
			expect(growth).toBeLessThanOrEqual(10 * 1024 * 1024);
			expect(growth).toBeLessThanOrEqual(baseline * 0.05);
		},
	);

	it("keeps a session unavailable for the whole managed deletion", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Alpha");
		const { runtime, built } = setup(dataDir);
		await runtime.open(id);
		let finishRemoval: () => void = () => undefined;
		const removalGate = new Promise<void>((resolve) => {
			finishRemoval = resolve;
		});

		const deleting = runtime.delete(id, () => removalGate);
		await vi.waitFor(() => expect(built.get(id)?.abort).toHaveBeenCalledOnce());
		await expect(runtime.open(id)).rejects.toMatchObject({ reason: "pi_session_deleting" });
		await expect(runtime.rename(id, "Blocked")).rejects.toMatchObject({
			reason: "pi_session_deleting",
		});

		finishRemoval();
		await deleting;
	});

	it("serializes deletion behind Pi prompt preflight for the same session", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Alpha");
		const { runtime, built } = setup(dataDir);
		const session = await runtime.open(id);
		let accept!: (ok: boolean) => void;
		const turn = Promise.withResolvers<void>();
		Object.assign(session, {
			prompt: vi.fn((_text, options) => {
				accept = options.preflightResult;
				return turn.promise;
			}),
		});

		const sending = runtime.send(id, "hello");
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
		const deleting = runtime.delete(id, () => undefined);
		expect(built.get(id)?.abort).not.toHaveBeenCalled();

		accept(true);
		await sending;
		await deleting;
		expect(built.get(id)?.abort).toHaveBeenCalledOnce();
		turn.resolve();
	});

	const commandDeletionCases = [
		{
			name: "abort",
			start(runtime: PiRuntime, id: string, session: AgentSession, gate: Promise<void>) {
				const entered = vi.fn(() => gate);
				Object.assign(session, { abort: entered });
				return { entered, command: runtime.abort(id) };
			},
		},
		{
			name: "navigate",
			start(runtime: PiRuntime, id: string, session: AgentSession, gate: Promise<void>) {
				const entered = vi.fn(async () => {
					await gate;
					return { cancelled: false };
				});
				Object.assign(session, { navigateTree: entered });
				return { entered, command: runtime.navigate(id, "entry") };
			},
		},
		{
			name: "edit",
			start(runtime: PiRuntime, id: string, session: AgentSession, gate: Promise<void>) {
				const entryId = session.sessionManager.appendMessage({
					role: "user",
					content: "original",
					timestamp: 1,
				});
				const entered = vi.fn(async () => {
					await gate;
					return { cancelled: false };
				});
				Object.assign(session, {
					navigateTree: entered,
					prompt: vi.fn(async (_text, options) => {
						options.preflightResult(true);
					}),
				});
				return { entered, command: runtime.edit(id, entryId, "replacement") };
			},
		},
		{
			name: "correct",
			start(runtime: PiRuntime, id: string, session: AgentSession, gate: Promise<void>) {
				session.sessionManager.appendMessage({
					role: "user",
					content: "original",
					timestamp: 1,
				});
				const entryId = session.sessionManager.appendMessage(assistantMessage());
				const entered = vi.fn(async () => {
					await gate;
					return { cancelled: false, editorText: "original" };
				});
				Object.assign(session, {
					navigateTree: entered,
					prompt: vi.fn(async (_text, options) => {
						options.preflightResult(true);
					}),
				});
				return { entered, command: runtime.correct(id, entryId, "guidance") };
			},
		},
		{
			name: "setModel",
			start(runtime: PiRuntime, id: string, session: AgentSession, gate: Promise<void>) {
				const entered = vi.fn(() => gate);
				Object.assign(session, { setModel: entered });
				return { entered, command: runtime.setModel(id, "provider", "model") };
			},
		},
	] as const;

	it.each(commandDeletionCases)(
		"orders $name before deletion once that command has entered its Session sequence",
		async ({ start }) => {
			const dataDir = root();
			const id = persistedSession(dataDir, "Alpha");
			const { runtime, built } = setup(dataDir);
			const session = await runtime.open(id);
			const gate = Promise.withResolvers<void>();
			const { entered, command } = start(runtime, id, session, gate.promise);
			await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
			const remove = vi.fn();
			const deleting = runtime.delete(id, remove);

			await Promise.resolve();
			expect(remove).not.toHaveBeenCalled();
			expect(built.get(id)?.dispose).not.toHaveBeenCalled();

			gate.resolve();
			await command;
			await deleting;
			expect(remove).toHaveBeenCalledOnce();
			expect(built.get(id)?.dispose).toHaveBeenCalledOnce();
		},
	);

	const blockedDuringDeletion = [
		["open", (runtime: PiRuntime, id: string) => runtime.open(id)],
		["send", (runtime: PiRuntime, id: string) => runtime.send(id, "hello")],
		["fork", (runtime: PiRuntime, id: string) => runtime.fork(id, "entry")],
		["abort", (runtime: PiRuntime, id: string) => runtime.abort(id)],
		["navigate", (runtime: PiRuntime, id: string) => runtime.navigate(id, "entry")],
		["edit", (runtime: PiRuntime, id: string) => runtime.edit(id, "entry", "replacement")],
		["correct", (runtime: PiRuntime, id: string) => runtime.correct(id, "entry", "guidance")],
		["continue", (runtime: PiRuntime, id: string) => runtime.continue(id)],
		["rename", (runtime: PiRuntime, id: string) => runtime.rename(id, "Blocked")],
		["setModel", (runtime: PiRuntime, id: string) => runtime.setModel(id, "provider", "model")],
		["modelFor", (runtime: PiRuntime, id: string) => runtime.modelFor(id)],
		[
			"deliverExternalResult",
			(runtime: PiRuntime, id: string) => runtime.deliverExternalResult(id, "run", "done"),
		],
		["close", (runtime: PiRuntime, id: string) => runtime.close(id)],
	] as const;

	it.each(blockedDuringDeletion)(
		"rejects $0 while managed deletion owns the Session",
		async (_name, invoke) => {
			const dataDir = root();
			const id = persistedSession(dataDir, "Alpha");
			const { runtime } = setup(dataDir);
			await runtime.open(id);
			const removal = Promise.withResolvers<void>();
			const remove = vi.fn(() => removal.promise);
			const deleting = runtime.delete(id, remove);
			await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

			await expect(invoke(runtime, id)).rejects.toMatchObject({
				reason: "pi_session_deleting",
			});

			removal.resolve();
			await deleting;
		},
	);

	it("lets an accepted open finish, then deletes it, while rejecting later opens", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Alpha");
		const { runtime } = setup(dataDir);
		const built = Promise.withResolvers<void>();
		let fake: FakeSession | undefined;
		const buildSession = vi.fn(async (manager: SessionManager) => {
			fake = fakeSession(manager);
			await built.promise;
			return fake.session;
		});
		Object.assign(runtime, { buildSession });

		const opening = runtime.open(id);
		await vi.waitFor(() => expect(buildSession).toHaveBeenCalledOnce());
		const remove = vi.fn();
		const deleting = runtime.delete(id, remove);
		await expect(runtime.open(id)).rejects.toMatchObject({ reason: "pi_session_deleting" });
		expect(remove).not.toHaveBeenCalled();

		built.resolve();
		await expect(opening).resolves.toMatchObject({ sessionId: id });
		await deleting;
		expect(fake?.dispose).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
	});

	it("continues the Session sequence after a command rejects", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Before");
		const { runtime } = setup(dataDir);
		const session = await runtime.open(id);
		Object.assign(session, {
			navigateTree: vi.fn(async () => Promise.reject(new Error("failed"))),
		});

		await expect(runtime.navigate(id, "entry")).rejects.toThrow("failed");
		await expect(runtime.rename(id, "After")).resolves.toBeUndefined();
		expect((await runtime.list()).find((item) => item.id === id)?.name).toBe("After");
	});

	it("does not serialize commands for different sessions", async () => {
		const dataDir = root();
		const alpha = persistedSession(dataDir, "Alpha");
		const beta = persistedSession(dataDir, "Beta");
		const { runtime, built } = setup(dataDir);
		const [alphaSession] = await Promise.all([runtime.open(alpha), runtime.open(beta)]);
		let accept!: (ok: boolean) => void;
		const turn = Promise.withResolvers<void>();
		Object.assign(alphaSession, {
			prompt: vi.fn((_text, options) => {
				accept = options.preflightResult;
				return turn.promise;
			}),
		});

		const sending = runtime.send(alpha, "hello");
		await vi.waitFor(() => expect(alphaSession.prompt).toHaveBeenCalledOnce());
		await runtime.abort(beta);
		expect(built.get(beta)?.abort).toHaveBeenCalledOnce();
		expect(built.get(alpha)?.abort).not.toHaveBeenCalled();
		accept(true);
		await sending;
		turn.resolve();
	});

	it("renames a closed session without opening it", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Before");
		const { runtime, buildSession } = setup(dataDir);

		await runtime.rename(id, "After");

		expect(buildSession).not.toHaveBeenCalled();
		expect((await runtime.list()).find((session) => session.id === id)?.name).toBe("After");
	});

	it("routes an external result to its explicit session and deduplicates the run id", async () => {
		const dataDir = root();
		const alpha = persistedSession(dataDir, "Alpha");
		const beta = persistedSession(dataDir, "Beta");
		const { runtime, built } = setup(dataDir);
		await Promise.all([runtime.open(alpha), runtime.open(beta)]);

		await runtime.deliverExternalResult(beta, "run-1", "done");
		await runtime.deliverExternalResult(beta, "run-1", "done");

		expect(built.get(alpha)?.sendCustomMessage).not.toHaveBeenCalled();
		expect(built.get(beta)?.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(built.get(beta)?.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { runId: "run-1" } }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it("does not acknowledge busy enqueue or unrelated leaves, and deduplicates pending attempts", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Busy");
		const { runtime, built } = setup(dataDir);
		const session = await runtime.open(id);
		const fake = built.get(id)!;
		Object.assign(session, { isStreaming: true });
		fake.sendCustomMessage.mockResolvedValue(undefined);
		const observed = vi.fn();
		const first = runtime.deliverExternalResult(id, "run-busy", "done").then(observed);
		const duplicate = runtime.deliverExternalResult(id, "run-busy", "done");
		await vi.waitFor(() => expect(fake.sendCustomMessage).toHaveBeenCalledOnce());
		session.sessionManager.appendCustomMessageEntry("host_external_agent_result", "other", true, {
			runId: "other-run",
		});
		fake.emit({ type: "agent_settled" });
		await Promise.resolve();
		expect(observed).not.toHaveBeenCalled();
		const message = {
			role: "custom" as const,
			customType: "host_external_agent_result",
			content: "done",
			display: true,
			details: { runId: "run-busy" },
			timestamp: 1,
		};
		fake.emit({ type: "message_end", message });
		expect(observed).not.toHaveBeenCalled();
		const entryId = session.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		await first;
		expect(observed).toHaveBeenCalledWith({ entryId });
		expect(await duplicate).toEqual({ entryId });
		expect(fake.sendCustomMessage).toHaveBeenCalledOnce();
		await runtime.closeAll();
	});

	it("keeps the actual queued delivery deduplicated after timeout and leaves restart-before-append unacknowledged", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Pending");
		const { runtime, built } = setup(dataDir);
		await runtime.open(id);
		const fake = built.get(id)!;
		fake.sendCustomMessage.mockResolvedValue(undefined);
		vi.useFakeTimers();
		try {
			const first = runtime
				.deliverExternalResult(id, "run-pending", "done")
				.catch((error: unknown) => error);
			await vi.waitFor(() => expect(fake.sendCustomMessage).toHaveBeenCalledOnce());
			await vi.advanceTimersByTimeAsync(5_001);
			expect(await first).toMatchObject({ reason: "pi_result_delivery_pending" });
			const retry = runtime
				.deliverExternalResult(id, "run-pending", "done")
				.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(5_001);
			expect(await retry).toMatchObject({ reason: "pi_result_delivery_pending" });
			expect(fake.sendCustomMessage).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
			await runtime.closeAll();
		}
		const restarted = setup(dataDir);
		const reopened = await restarted.runtime.open(id);
		expect(
			reopened.sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
		).toEqual([]);
		const receipt = await restarted.runtime.deliverExternalResult(id, "run-pending", "done");
		expect(reopened.sessionManager.getEntry(receipt.entryId)).toMatchObject({
			type: "custom_message",
			customType: "host_external_agent_result",
			details: { runId: "run-pending" },
		});
		expect(restarted.built.get(id)!.sendCustomMessage).toHaveBeenCalledOnce();
		await restarted.runtime.closeAll();
	});

	it("deleting one session releases only its pending delivery without waiting for the model", async () => {
		const dataDir = root();
		const alpha = persistedSession(dataDir, "Alpha");
		const beta = persistedSession(dataDir, "Beta");
		const { runtime, built } = setup(dataDir);
		await Promise.all([runtime.open(alpha), runtime.open(beta)]);
		const model = Promise.withResolvers<void>();
		built.get(alpha)!.sendCustomMessage.mockReturnValue(model.promise);
		built.get(beta)!.sendCustomMessage.mockResolvedValue(undefined);
		const discarded = runtime
			.deliverExternalResult(alpha, "same-run", "alpha")
			.catch((error: unknown) => error);
		const retained = runtime.deliverExternalResult(beta, "same-run", "beta");
		await vi.waitFor(() => expect(built.get(beta)!.sendCustomMessage).toHaveBeenCalledOnce());
		const remove = vi.fn();
		await runtime.delete(alpha, remove);
		expect(await discarded).toMatchObject({ reason: "pi_result_session_closed" });
		expect(remove).toHaveBeenCalledOnce();
		expect(built.get(alpha)!.dispose).toHaveBeenCalledOnce();
		expect(built.get(beta)!.dispose).not.toHaveBeenCalled();
		const betaSession = built.get(beta)!.session;
		const entryId = betaSession.sessionManager.appendCustomMessageEntry(
			"host_external_agent_result",
			"beta",
			true,
			{ runId: "same-run" },
		);
		built.get(beta)!.emit({ type: "agent_settled" });
		expect(await retained).toEqual({ entryId });
		model.reject(new Error("aborted after disposal"));
		await runtime.closeAll();
	});

	it("returns the exact persisted result even when idle prompting rejects after another entry", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Idle");
		const { runtime, built } = setup(dataDir);
		const session = await runtime.open(id);
		let resultEntryId = "";
		built.get(id)!.sendCustomMessage.mockImplementation(async () => {
			resultEntryId = session.sessionManager.appendCustomMessageEntry(
				"host_external_agent_result",
				"done",
				true,
				{ runId: "idle-rejection" },
			);
			session.sessionManager.appendMessage(assistantMessage("partial explanation"));
			throw new Error("model explanation failed");
		});
		expect(await runtime.deliverExternalResult(id, "idle-rejection", "done")).toEqual({
			entryId: resultEntryId,
		});
		expect(resultEntryId).not.toBe(session.sessionManager.getLeafId());
		await runtime.closeAll();
	});

	it("stamps native events once and uses a new transport instance when a session reopens", async () => {
		const dataDir = root();
		const id = persistedSession(dataDir, "Versions");
		const { runtime, built, nativeEvents } = setup(dataDir);
		const session = await runtime.open(id);
		const before = projectPiLiveSnapshot(session).version!;
		built.get(id)!.emit({ type: "agent_start" });
		built.get(id)!.emit({ type: "agent_settled" });
		expect(nativeEvents.map(({ version }) => version)).toEqual([
			{ instanceId: before.instanceId, sequence: before.sequence + 1 },
			{ instanceId: before.instanceId, sequence: before.sequence + 2 },
		]);
		expect(projectPiLiveSnapshot(session).version).toEqual(nativeEvents[1]!.version);
		await runtime.close(id);
		const reopened = await runtime.open(id);
		expect(projectPiLiveSnapshot(reopened).version!.instanceId).not.toBe(before.instanceId);
		await runtime.closeAll();
	});
});

describe("PiRuntime native stage lifecycle", () => {
	it("delivers a busy native follow-up once, only after the native custom entry is appended", async () => {
		const { runtime, session, stream } = await nativeSetup({ memory: { enabled: () => false } });
		const pending = new AssistantMessageEventStream();
		stream.mockImplementationOnce(() => pending);
		await runtime.send(session.sessionId, "keep working");
		await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
		const send = vi.spyOn(session, "sendCustomMessage");
		const observed = vi.fn();
		const delivery = runtime
			.deliverExternalResult(session.sessionId, "native-busy", "Worker result")
			.then((receipt) => {
				observed(receipt);
				return receipt;
			});
		const duplicate = runtime.deliverExternalResult(
			session.sessionId,
			"native-busy",
			"Worker result",
		);
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		expect(observed).not.toHaveBeenCalled();
		expect(
			session.sessionManager.getEntries().some((entry) => entry.type === "custom_message"),
		).toBe(false);
		pending.push({ type: "done", reason: "stop", message: assistantMessage() });
		const receipt = await delivery;
		expect(await duplicate).toEqual(receipt);
		expect(session.sessionManager.getEntry(receipt.entryId)).toMatchObject({
			type: "custom_message",
			customType: "host_external_agent_result",
			details: { runId: "native-busy" },
		});
		expect(
			session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
		).toHaveLength(1);
		await runtime.closeAll();
	});

	it("releases an unappended delivery when native queue removal is confirmed at idle", async () => {
		const { runtime, session, stream, nativeEvents } = await nativeSetup({
			memory: { enabled: () => false },
		});
		const pending = new AssistantMessageEventStream();
		stream.mockImplementationOnce(() => pending);
		await runtime.send(session.sessionId, "keep working");
		await vi.waitFor(() => expect(stream).toHaveBeenCalledOnce());
		const send = vi.spyOn(session, "sendCustomMessage");
		const delivery = runtime
			.deliverExternalResult(session.sessionId, "removed-native", "Worker result")
			.catch((error: unknown) => error);
		await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		session.clearQueue();
		pending.push({ type: "done", reason: "stop", message: assistantMessage() });
		expect(await delivery).toMatchObject({ reason: "pi_result_not_persisted" });
		await vi.waitFor(() =>
			expect(nativeEvents.some(({ event }) => event.type === "agent_settled")).toBe(true),
		);
		expect(
			session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
		).toEqual([]);
		const receipt = await runtime.deliverExternalResult(
			session.sessionId,
			"removed-native",
			"Worker result",
		);
		expect(send).toHaveBeenCalledTimes(2);
		expect(session.sessionManager.getEntry(receipt.entryId)).toMatchObject({
			type: "custom_message",
			details: { runId: "removed-native" },
		});
		await runtime.closeAll();
	});

	it("acknowledges an idle native append before model latency or later model failure", async () => {
		const { runtime, session, stream, nativeEvents } = await nativeSetup({
			memory: { enabled: () => false },
		});
		// A real original conversation already contains a persisted assistant turn.
		session.sessionManager.appendMessage(assistantMessage("previous reply"));
		const pending = new AssistantMessageEventStream();
		stream.mockImplementationOnce(() => pending);
		const receipt = await runtime.deliverExternalResult(
			session.sessionId,
			"native-idle",
			"Worker finished",
		);
		expect(session.sessionManager.getEntry(receipt.entryId)).toMatchObject({
			type: "custom_message",
			details: { runId: "native-idle" },
		});
		expect(SessionManager.open(session.sessionFile!).getEntry(receipt.entryId)).toMatchObject({
			type: "custom_message",
			details: { runId: "native-idle" },
		});
		pending.push({
			type: "error",
			reason: "error",
			error: { ...assistantMessage(""), stopReason: "error", errorMessage: "model unavailable" },
		});
		await vi.waitFor(() =>
			expect(nativeEvents.some(({ event }) => event.type === "agent_settled")).toBe(true),
		);
		expect(
			await runtime.deliverExternalResult(session.sessionId, "native-idle", "Worker finished"),
		).toEqual(receipt);
		await runtime.closeAll();
	});

	it("marks structured Host failure as a native tool error without dropping its content or details", async () => {
		const failure = {
			ok: false,
			code: "memory_search_unavailable",
			message: "Relationship store is unavailable",
		};
		const { runtime, session, stream, nativeEvents } = await nativeSetup({
			memory: {
				enabled: () => false,
				search: async () => {
					throw failure;
				},
			},
		});
		stream.mockImplementationOnce(() => {
			const events = new AssistantMessageEventStream();
			events.push({
				type: "done",
				reason: "toolUse",
				message: {
					...assistantMessage(),
					stopReason: "toolUse",
					content: [
						{
							type: "toolCall",
							id: "search-failure",
							name: "tdai_memory_search",
							arguments: { query: "history", limit: 2 },
						},
					],
				},
			});
			return events;
		});
		await runtime.send(session.sessionId, "recall prior work");
		await vi.waitFor(() =>
			expect(nativeEvents.some(({ event }) => event.type === "agent_settled")).toBe(true),
		);
		const entry = session.sessionManager
			.getEntries()
			.find((item) => item.type === "message" && item.message.role === "toolResult");
		expect(entry).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "search-failure",
				isError: true,
				details: failure,
				content: [{ type: "text", text: failure.message }],
			},
		});
		expect(
			nativeEvents.find(({ event }) => event.type === "tool_execution_end")?.event,
		).toMatchObject({
			isError: true,
			result: { details: failure },
		});
		await runtime.closeAll();
	});

	it("accepts a native correction before first output and lets Stop reach the pending provider", async () => {
		const { runtime, session, nativeEvents, stream } = await nativeSetup({
			memory: { enabled: () => false },
		});
		await runtime.send(session.sessionId, "original question");
		await vi.waitFor(() =>
			expect(nativeEvents.some(({ event }) => event.type === "agent_settled")).toBe(true),
		);
		const answer = session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!answer) throw new Error("Native assistant entry missing");
		let providerAborted = false;
		stream.mockImplementationOnce((_model, _context, options) => {
			const events = new AssistantMessageEventStream();
			options?.signal?.addEventListener(
				"abort",
				() => {
					providerAborted = true;
					events.push({
						type: "error",
						reason: "aborted",
						error: {
							...assistantMessage(),
							stopReason: "aborted",
							errorMessage: "Request aborted",
						},
					});
				},
				{ once: true },
			);
			return events;
		});
		await runtime.correct(session.sessionId, answer.id, "Use a different explanation");
		await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
		expect(session.isStreaming).toBe(true);
		expect(stream.mock.calls[1]?.[1].systemPrompt).toContain("Use a different explanation");
		await runtime.abort(session.sessionId);
		expect(providerAborted).toBe(true);
		expect(session.isStreaming).toBe(false);
		await runtime.send(session.sessionId, "next question");
		await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(3));
		expect(stream.mock.calls[2]?.[1].systemPrompt).not.toContain("Use a different explanation");
		await runtime.closeAll();
	});

	it("exposes native retry backoff on reconnect and cancels it without another provider attempt", async () => {
		const { runtime, session, nativeEvents, stream } = await nativeSetup({
			memory: { enabled: () => false },
		});
		session.setAutoRetryEnabled(true);
		stream.mockImplementation(() => {
			const events = new AssistantMessageEventStream();
			events.push({
				type: "error",
				reason: "error",
				error: {
					...assistantMessage(),
					stopReason: "error",
					errorMessage: "429 rate limit exceeded",
				},
			});
			return events;
		});
		await runtime.send(session.sessionId, "hello");
		await vi.waitFor(() => expect(session.isRetrying).toBe(true));
		expect(projectPiLiveSnapshot(session)).toMatchObject({
			isStreaming: true,
			isRetrying: true,
			retryAttempt: 1,
			isCompacting: false,
		});
		await runtime.abort(session.sessionId);
		expect(projectPiLiveSnapshot(session)).toMatchObject({ isStreaming: false, isRetrying: false });
		expect(stream).toHaveBeenCalledOnce();
		expect(
			nativeEvents.some(({ event }) => event.type === "auto_retry_end" && event.success === false),
		).toBe(true);
		await runtime.closeAll();
	});

	it("reports real preparation and idle capture, then delivers settled even if capture fails", async () => {
		let finishRecall!: () => void;
		const recallGate = new Promise<void>((resolve) => {
			finishRecall = resolve;
		});
		let failCapture!: (error: Error) => void;
		const captureGate = new Promise<void>((_resolve, reject) => {
			failCapture = reject;
		});
		const { runtime, session, activities, nativeEvents, stream } = await nativeSetup({
			memory: {
				recall: async () => {
					await recallGate;
					return { appendSystemContext: "a real recalled fact" };
				},
				capture: () => captureGate,
				drain: async () => {
					await captureGate.catch(() => undefined);
				},
			},
		});
		const sending = runtime.send(session.sessionId, "hello");
		await vi.waitFor(() => expect(activities[0]?.activity).toBe("memory_recall"));
		expect(stream).not.toHaveBeenCalled();
		expect(activities[0]).toMatchObject({
			conversationId: session.sessionId,
			status: "started",
			live: { isStreaming: false },
		});
		finishRecall();
		await sending;
		await vi.waitFor(() => expect(activities.at(-1)?.activity).toBe("memory_capture"));
		expect(activities.map(({ activity, status }) => [activity, status])).toEqual([
			["memory_recall", "started"],
			["memory_recall", "completed"],
			["context", "started"],
			["context", "completed"],
			["memory_capture", "started"],
		]);
		expect(stream.mock.calls[0]?.[1].systemPrompt).toContain("a real recalled fact");
		expect(stream.mock.calls[0]?.[1].systemPrompt).toContain("turn context");
		expect(session.isStreaming).toBe(false);
		expect(activities.at(-1)?.live.isStreaming).toBe(false);
		expect(
			session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message.role),
		).toEqual(["user", "assistant"]);
		expect(nativeEvents.some(({ event }) => event.type === "entry_appended")).toBe(false);
		expect(nativeEvents.some(({ event }) => event.type === "agent_settled")).toBe(false);
		failCapture(new Error("capture storage unavailable"));
		await vi.waitFor(() =>
			expect(nativeEvents.some(({ event }) => event.type === "agent_settled")).toBe(true),
		);
		expect(activities.at(-1)).toMatchObject({
			activity: "memory_capture",
			status: "failed",
			errorMessage: "capture storage unavailable",
			operationId: activities.at(-2)?.operationId,
			live: { isStreaming: false },
		});
		await runtime.closeAll();
	});

	it("drains capture before disposal without reopening a session when Stop races close", async () => {
		let finishCapture!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			finishCapture = resolve;
		});
		const { runtime, session, activities } = await nativeSetup({
			memory: { capture: () => captureGate, drain: () => captureGate },
		});
		await runtime.send(session.sessionId, "hello");
		await vi.waitFor(() => expect(activities.at(-1)?.activity).toBe("memory_capture"));
		expect(session.isIdle).toBe(true);
		const dispose = vi.spyOn(session, "dispose");
		const closing = runtime.close(session.sessionId);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(dispose).not.toHaveBeenCalled();
		await runtime.abort(session.sessionId);
		expect(runtime.snapshot(session.sessionId)).toBeUndefined();
		expect(dispose).not.toHaveBeenCalled();
		finishCapture();
		await closing;
		expect(dispose).toHaveBeenCalledOnce();
		expect(runtime.snapshot(session.sessionId)).toBeUndefined();
	});

	it("does not advertise disabled memory, and reports failed preparation without inventing turn failure", async () => {
		const { runtime, session, activities, nativeEvents } = await nativeSetup({
			memory: { enabled: () => false },
			context: () => {
				throw new Error("context source unavailable");
			},
		});
		await runtime.send(session.sessionId, "hello");
		await vi.waitFor(() =>
			expect(nativeEvents.some(({ event }) => event.type === "agent_settled")).toBe(true),
		);
		expect(activities.map(({ activity, status }) => [activity, status])).toEqual([
			["context", "started"],
			["context", "failed"],
		]);
		expect(activities[1]).toMatchObject({
			errorMessage: "context source unavailable",
			operationId: activities[0]?.operationId,
		});
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		await runtime.closeAll();
	});
});
