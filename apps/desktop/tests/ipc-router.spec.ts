// @vitest-environment node

import type { Dispatcher } from "@bear-harness/host-runtime";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface InvokeEvent {
	sender: { id: number; mainFrame: { url: string } };
	senderFrame: { url: string } | null;
}

type Handler = (event: InvokeEvent, params: unknown) => Promise<unknown>;

const electron = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: electron.fromWebContents },
	ipcMain: {
		handle: vi.fn((channel: string, handler: Handler) => {
			electron.handlers.set(channel, handler);
		}),
	},
}));

import { PROTOCOL_AVAILABILITY_CHANNEL, wireElectronIpcHandlers } from "../src/main/ipc-router.js";

const ALLOWED_URL = "file:///dist/renderer/index.html";
const channel = Object.keys(REQUEST_SCHEMAS)[0];
if (!channel) throw new Error("protocol must expose at least one request channel");

function setup(registry = new Map([[1, { allowedUrl: ALLOWED_URL }]])) {
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
});

describe("wireElectronIpcHandlers", () => {
	it("registers every public protocol channel plus the host-shell availability channel", () => {
		const { dispatch } = setup();

		expect([...electron.handlers.keys()].sort()).toEqual(
			[...Object.keys(REQUEST_SCHEMAS), PROTOCOL_AVAILABILITY_CHANNEL].sort(),
		);
		expect(dispatch).not.toHaveBeenCalled();
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

	describe("desktop:artifactProtocol:v1", () => {
		it("reports the protocol availability to the registered main frame", async () => {
			electron.fromWebContents.mockReturnValue({});
			const available = vi.fn().mockReturnValue(true);
			const mainFrame = { url: ALLOWED_URL };
			const dispatch = vi.fn();
			wireElectronIpcHandlers(
				{ dispatch } as unknown as Dispatcher,
				new Map([[1, { allowedUrl: ALLOWED_URL }]]),
				{ artifactProtocolAvailable: available },
			);
			const handler = electron.handlers.get(PROTOCOL_AVAILABILITY_CHANNEL);
			if (!handler) throw new Error("availability channel not registered");

			await expect(handler(mainFrameEvent(mainFrame), {})).resolves.toEqual({
				ok: true,
				data: { available: true },
			});
			expect(dispatch).not.toHaveBeenCalled();
		});

		it("defaults to unavailable when no callback is provided", async () => {
			electron.fromWebContents.mockReturnValue({});
			setup();
			const handler = electron.handlers.get(PROTOCOL_AVAILABILITY_CHANNEL);
			if (!handler) throw new Error("availability channel not registered");

			await expect(handler(mainFrameEvent({ url: ALLOWED_URL }), {})).resolves.toEqual({
				ok: true,
				data: { available: false },
			});
		});

		it("rejects a disallowed sender", async () => {
			electron.fromWebContents.mockReturnValue(undefined);
			const { handler } = setup();

			await expect(handler(mainFrameEvent({ url: ALLOWED_URL }), {})).resolves.toEqual({
				ok: false,
				error: { kind: "unavailable", reason: "no_window" },
			});
		});
	});
});
