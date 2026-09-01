// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PiRuntime,
	type PiRuntimeOptions,
	type PiSessionEvent,
} from "../src/companion/pi-runtime.js";

const roots: string[] = [];

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

interface FakeSession {
	session: AgentSession;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	sendCustomMessage: ReturnType<typeof vi.fn>;
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
		isIdle: true,
		isStreaming: false,
		state: { streamingMessage: undefined, errorMessage: undefined },
		pendingMessageCount: 0,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		abort,
		dispose,
		sendCustomMessage,
		setSessionName: (name: string) => manager.appendSessionInfo(name),
	} as unknown as AgentSession;
	return {
		session,
		abort,
		dispose,
		sendCustomMessage,
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
		sessionEvent: (event: PiSessionEvent) => nativeEvents.push(event),
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
				const entered = vi.fn(async () => {
					await gate;
					return { cancelled: false };
				});
				Object.assign(session, {
					navigateTree: entered,
					sendUserMessage: vi.fn(async () => undefined),
				});
				return { entered, command: runtime.edit(id, "entry", "replacement") };
			},
		},
		{
			name: "regenerate",
			start(runtime: PiRuntime, id: string, session: AgentSession, gate: Promise<void>) {
				const userId = session.sessionManager.appendMessage({
					role: "user",
					content: "original",
					timestamp: 1,
				});
				const entryId = session.sessionManager.appendCustomEntry("race-target", { userId });
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
				return { entered, command: runtime.regenerate(id, entryId) };
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
		{
			name: "deliverExternalResult",
			start(runtime: PiRuntime, id: string, session: AgentSession, gate: Promise<void>) {
				const entered = vi.fn(async () => {
					await gate;
					session.sessionManager.appendCustomMessageEntry(
						"host_external_agent_result",
						"done",
						true,
						{ runId: "run-race" },
					);
				});
				Object.assign(session, { sendCustomMessage: entered });
				return { entered, command: runtime.deliverExternalResult(id, "run-race", "done") };
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
		["regenerate", (runtime: PiRuntime, id: string) => runtime.regenerate(id, "entry")],
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
});
