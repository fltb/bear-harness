import { EventEmitter } from "node:events";
// @vitest-environment node

import type { Dispatcher } from "@bear-harness/host-runtime";
import { CHANNEL_CONTRACTS } from "@bear-harness/protocol/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface InvokeEvent {
	sender: { id: number; mainFrame: { url: string } };
	senderFrame: { url: string } | null;
}

type Handler = (event: InvokeEvent, params: unknown) => Promise<unknown>;

const electron = vi.hoisted(() => {
	const handlers = new Map<string, Handler>();
	return {
		handlers,
		fromWebContents: vi.fn(),
		removeHandler: vi.fn((channel: string) => {
			handlers.delete(channel);
		}),
	};
});

vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: electron.fromWebContents },
	ipcMain: {
		handle: vi.fn((channel: string, handler: Handler) => {
			if (electron.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
			electron.handlers.set(channel, handler);
		}),
		removeHandler: electron.removeHandler,
	},
}));

import { wireElectronIpcHandlers } from "../src/main/ipc-router.js";

const ALLOWED_URL = "file:///dist/renderer/index.html";
const channel = Object.keys(CHANNEL_CONTRACTS)[0];
function setupRegistry() {
	return new Map([[1, { allowedUrl: ALLOWED_URL }]]);
}

if (!channel) throw new Error("protocol must expose at least one request channel");

function setup(registry = setupRegistry()) {
	const dispatch = vi.fn().mockResolvedValue({ ok: true, data: { accepted: true } });
	wireElectronIpcHandlers({ dispatch } as unknown as Dispatcher, registry);
	const handler = electron.handlers.get(channel);
	if (!handler) throw new Error(`handler not registered for ${channel}`);
	const mainFrame = { url: ALLOWED_URL };
	return { dispatch, handler, mainFrame };
}

function mainFrameEvent(mainFrame: { url: string }): InvokeEvent {
	return { sender: { id: 1, mainFrame }, senderFrame: mainFrame };
}

beforeEach(() => {
	electron.handlers.clear();
	electron.fromWebContents.mockReset();
	electron.removeHandler.mockClear();
});

describe("wireElectronIpcHandlers", () => {
	it("registers every public protocol channel", () => {
		const { dispatch } = setup();

		expect([...electron.handlers.keys()].sort()).toEqual(Object.keys(CHANNEL_CONTRACTS).sort());
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("disposes its handlers idempotently", () => {
		const dispose = wireElectronIpcHandlers(
			{ dispatch: vi.fn() } as unknown as Dispatcher,
			setupRegistry(),
		);
		const channelCount = Object.keys(CHANNEL_CONTRACTS).length;
		const registrationRemovals = electron.removeHandler.mock.calls.length;

		expect(electron.handlers.size).toBe(channelCount);
		dispose();
		expect(electron.handlers.size).toBe(0);
		expect(electron.removeHandler).toHaveBeenCalledTimes(registrationRemovals + channelCount);
		dispose();
		expect(electron.removeHandler).toHaveBeenCalledTimes(registrationRemovals + channelCount);
	});

	it("replaces an existing registration without letting the old disposer remove it", () => {
		const firstDispose = wireElectronIpcHandlers(
			{ dispatch: vi.fn() } as unknown as Dispatcher,
			setupRegistry(),
		);
		const firstHandler = electron.handlers.get(channel);
		if (!firstHandler) throw new Error(`handler not registered for ${channel}`);

		const secondDispose = wireElectronIpcHandlers(
			{ dispatch: vi.fn() } as unknown as Dispatcher,
			setupRegistry(),
		);
		const secondHandler = electron.handlers.get(channel);
		if (!secondHandler) throw new Error(`handler not registered for ${channel}`);
		expect(secondHandler).not.toBe(firstHandler);

		firstDispose();
		expect(electron.handlers.get(channel)).toBe(secondHandler);
		secondDispose();
		expect(electron.handlers.size).toBe(0);
	});

	it("dispatches calls from the registered main frame at its allowed URL", async () => {
		electron.fromWebContents.mockReturnValue({});
		const { dispatch, handler, mainFrame } = setup();
		const params = { limit: 10 };

		await expect(handler(mainFrameEvent(mainFrame), params)).resolves.toEqual({
			ok: true,
			data: { accepted: true },
		});
		expect(dispatch).toHaveBeenCalledWith(channel, params);
	});

	it("rejects a sender that is not a BrowserWindow", async () => {
		electron.fromWebContents.mockReturnValue(undefined);
		const { dispatch, handler, mainFrame } = setup();

		await expect(handler(mainFrameEvent(mainFrame), {})).resolves.toEqual({
			ok: false,
			error: { kind: "unavailable", reason: "no_window" },
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects an unregistered BrowserWindow sender", async () => {
		electron.fromWebContents.mockReturnValue({});
		const { dispatch, handler, mainFrame } = setup(new Map());

		await expect(handler(mainFrameEvent(mainFrame), {})).resolves.toEqual({
			ok: false,
			error: { kind: "unavailable", reason: "no_window" },
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects a subframe sender", async () => {
		electron.fromWebContents.mockReturnValue({});
		const { dispatch, handler, mainFrame } = setup();
		const subframe = { url: ALLOWED_URL };

		await expect(
			handler({ ...mainFrameEvent(mainFrame), senderFrame: subframe }, {}),
		).resolves.toEqual({
			ok: false,
			error: { kind: "unavailable", reason: "no_window" },
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects a main frame that navigated away from its registered URL", async () => {
		electron.fromWebContents.mockReturnValue({});
		const { dispatch, handler } = setup();
		const wrongMainFrame = { url: "file:///untrusted.html" };

		await expect(handler(mainFrameEvent(wrongMainFrame), {})).resolves.toEqual({
			ok: false,
			error: { kind: "unavailable", reason: "no_window" },
		});
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("pushes to the admitted frame and removes the subscription on navigation", async () => {
		electron.fromWebContents.mockReturnValue({});
		const stop = vi.fn();
		let publish!: (event: import("@bear-harness/protocol").DomainEvent) => void;
		const subscribeEvents = vi.fn((listener, _afterSeq) => {
			publish = listener;
			return stop;
		});
		const dispose = wireElectronIpcHandlers(
			{ dispatch: vi.fn() } as unknown as Dispatcher,
			setupRegistry(),
			{ subscribeEvents },
		);
		const mainFrame = { url: ALLOWED_URL };
		const sender = Object.assign(new EventEmitter(), {
			id: 1,
			mainFrame,
			send: vi.fn(),
			isDestroyed: () => false,
		});
		const start = electron.handlers.get("events:listen:v1")!;
		await expect(
			start(
				{ sender, senderFrame: { url: "https://untrusted.example" } },
				{ id: "stream-1", afterSeq: 4 },
			),
		).rejects.toThrow("untrusted");
		expect(subscribeEvents).not.toHaveBeenCalled();
		await start({ sender, senderFrame: mainFrame }, { id: "stream-1", afterSeq: 4 });
		publish({ seq: 5, kind: "provider.login_changed", payload: { providerId: "openai-codex" } });
		expect(sender.send).toHaveBeenCalledWith("events:push:v1", {
			id: "stream-1",
			batch: {
				events: [
					{ seq: 5, kind: "provider.login_changed", payload: { providerId: "openai-codex" } },
				],
			},
		});
		sender.emit("did-start-navigation");
		expect(stop).toHaveBeenCalledOnce();
		dispose();
		expect(sender.listenerCount("destroyed")).toBe(0);
	});

	it("keeps transient Pi events on their dedicated non-replay channel", async () => {
		electron.fromWebContents.mockReturnValue({});
		const stop = vi.fn();
		let publish!: (event: import("@bear-harness/protocol").PiSessionLiveEvent) => void;
		const subscribePiEvents = vi.fn((listener) => {
			publish = listener;
			return stop;
		});
		const dispose = wireElectronIpcHandlers(
			{ dispatch: vi.fn() } as unknown as Dispatcher,
			setupRegistry(),
			{ subscribePiEvents },
		);
		const mainFrame = { url: ALLOWED_URL };
		const sender = Object.assign(new EventEmitter(), {
			id: 1,
			mainFrame,
			send: vi.fn(),
			isDestroyed: () => false,
		});
		const start = electron.handlers.get("pi-events:listen:v1")!;
		await start({ sender, senderFrame: mainFrame }, { id: "pi-stream-1" });
		publish({
			sessionId: "session-1",
			type: "message_update",
			live: { isStreaming: true, queuedUserMessages: [] },
		});
		expect(sender.send).toHaveBeenCalledWith("pi-events:push:v1", {
			id: "pi-stream-1",
			batch: {
				events: [
					{
						sessionId: "session-1",
						type: "message_update",
						live: { isStreaming: true, queuedUserMessages: [] },
					},
				],
			},
		});
		sender.emit("destroyed");
		expect(stop).toHaveBeenCalledOnce();
		dispose();
	});
});
