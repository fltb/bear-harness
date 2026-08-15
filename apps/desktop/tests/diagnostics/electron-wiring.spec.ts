// @vitest-environment node

import type { Diagnostics } from "@bear-harness/host-runtime";
import { DIAGNOSTICS_POLICY } from "@bear-harness/host-runtime";
import { describe, expect, it, vi } from "vitest";
import {
	type IpcEventLike,
	registerElectronDiagnostics,
	registerWindowHooks,
	type WindowRegistration,
} from "../../src/main/diagnostics/electron.js";

const ALLOWED_URL = "file:///dist/renderer/index.html";
const TRACEPARENT = `00-${"aa".repeat(16)}-${"bb".repeat(8)}-01`;

function makeFakes(clock = () => Date.now()) {
	const emitted: Array<{ name: string; attributes: Record<string, unknown> }> = [];
	const emittedRemote: Array<{
		name: string;
		attributes: Record<string, unknown>;
		trace: { traceId: string; parentSpanId?: string };
	}> = [];
	const appListeners = new Map<string, (...args: unknown[]) => void>();
	let ipcListener: ((event: IpcEventLike, ...args: unknown[]) => void) | undefined;

	const diagnostics = {
		policy: DIAGNOSTICS_POLICY,
		emit: (name: string, attributes: Record<string, unknown> = {}) => {
			emitted.push({ name, attributes });
		},
		emitRemote: (
			name: string,
			attributes: Record<string, unknown>,
			trace: { traceId: string; parentSpanId?: string },
		) => {
			emittedRemote.push({ name, attributes, trace });
		},
	} as unknown as Diagnostics;

	const registry = new Map<number, WindowRegistration>();
	registry.set(1, {
		traceparent: TRACEPARENT,
		allowedUrl: ALLOWED_URL,
		rateWindow: { count: 0, windowStart: 0, rejectedAt: 0 },
	});

	const app = {
		on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			appListeners.set(event, listener);
		}),
		removeListener: vi.fn(),
	};
	const ipcMain = {
		on: vi.fn((_channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void) => {
			ipcListener = listener;
		}),
		removeListener: vi.fn(),
	};

	const dispose = registerElectronDiagnostics({
		app,
		ipcMain,
		diagnostics,
		windowRegistry: registry,
		clock,
	});

	const sendFault = (payload: unknown, event?: Partial<IpcEventLike>) => {
		const listener = ipcListener;
		if (!listener) throw new Error("ipc listener not registered");
		// Real Electron hands the same WebFrameMain object for sender.mainFrame
		// and senderFrame when the sender is the main frame; the listener
		// compares by reference, so the fake must share the object.
		const mainFrame = { url: ALLOWED_URL };
		const fullEvent: IpcEventLike = {
			sender: { id: 1, mainFrame },
			senderFrame: mainFrame,
			...event,
		};
		listener(fullEvent, payload);
	};

	return { emitted, emittedRemote, appListeners, app, ipcMain, dispose, sendFault };
}

const validFault = { kind: "error", errorType: "TypeError", line: 3, column: 4 };
const validEnvelope = { traceparent: TRACEPARENT, fault: validFault };

describe("registerElectronDiagnostics — renderer fault channel", () => {
	it("accepts a valid fault and forwards it on the registered trace", () => {
		const { emittedRemote, sendFault } = makeFakes();
		sendFault(validEnvelope);

		expect(emittedRemote).toHaveLength(1);
		expect(emittedRemote[0]).toEqual({
			name: "renderer.fault",
			attributes: { kind: "error", errorType: "TypeError", line: 3, column: 4 },
			trace: { traceId: "aa".repeat(16), parentSpanId: "bb".repeat(8) },
		});
	});

	it("rejects an unregistered sender with input_rejected{sender} and never emits a fault", () => {
		const { emitted, emittedRemote, sendFault } = makeFakes();
		sendFault(validEnvelope, { sender: { id: 99, mainFrame: { url: ALLOWED_URL } } });

		expect(emitted).toEqual([
			{ name: "diagnostics.input_rejected", attributes: { reason: "sender" } },
		]);
		expect(emittedRemote).toHaveLength(0);
	});

	it("rejects a subframe sender with input_rejected{frame}", () => {
		const { emitted, emittedRemote, sendFault } = makeFakes();
		sendFault(validEnvelope, { senderFrame: { url: ALLOWED_URL } });

		expect(emitted[0]).toEqual({
			name: "diagnostics.input_rejected",
			attributes: { reason: "frame" },
		});
		expect(emittedRemote).toHaveLength(0);
	});

	it("rejects a frame URL mismatch with input_rejected{url}", () => {
		const { emitted, emittedRemote, sendFault } = makeFakes();
		// The main frame itself points at a non-allowed URL; senderFrame stays
		// the same object (main frame) so the url check fires after the frame check.
		const wrongFrame = { url: "file:///elsewhere" };
		sendFault(validEnvelope, {
			sender: { id: 1, mainFrame: wrongFrame },
			senderFrame: wrongFrame,
		});

		expect(emitted[0]).toEqual({
			name: "diagnostics.input_rejected",
			attributes: { reason: "url" },
		});
		expect(emittedRemote).toHaveLength(0);
	});

	it.each([
		["non-object payload", "junk"],
		["missing fault", { traceparent: TRACEPARENT }],
		["extra envelope key", { traceparent: TRACEPARENT, fault: validFault, extra: 1 }],
	])("rejects a bad envelope (%s) with input_rejected{shape}", (_label, payload) => {
		const { emitted, emittedRemote, sendFault } = makeFakes();
		sendFault(payload);
		expect(emitted[0]).toEqual({
			name: "diagnostics.input_rejected",
			attributes: { reason: "shape" },
		});
		expect(emittedRemote).toHaveLength(0);
	});

	it.each([
		["missing errorType", { kind: "error" }],
		["bad kind", { kind: "nope", errorType: "TypeError" }],
		["bad errorType", { kind: "error", errorType: "UnknownError" }],
		["negative line", { kind: "error", errorType: "TypeError", line: -1 }],
		["unknown key", { kind: "error", errorType: "TypeError", message: "secret" }],
	])("rejects a bad fault shape (%s) with input_rejected{shape}", (_label, fault) => {
		const { emitted, emittedRemote, sendFault } = makeFakes();
		sendFault({ traceparent: TRACEPARENT, fault });
		expect(emitted[0]).toEqual({
			name: "diagnostics.input_rejected",
			attributes: { reason: "shape" },
		});
		expect(emittedRemote).toHaveLength(0);
	});

	it("restarts the trace but keeps a shape-valid fault when the traceparent mismatches", () => {
		const { emitted, emittedRemote, sendFault } = makeFakes();
		const other = `00-${"cc".repeat(16)}-${"dd".repeat(8)}-01`;
		sendFault({ traceparent: other, fault: validFault });

		// The trace is restarted but the shape-valid fault is kept via a fresh
		// trace (plain emit, not emitRemote).
		expect(emitted.map((e) => e.name)).toEqual(["diagnostics.trace_restarted", "renderer.fault"]);
		expect(emittedRemote).toHaveLength(0);
	});

	it("rate-limits to 20 faults per 60 s per webContents with a single rejection event", () => {
		let now = 1_000_000;
		const { emitted, emittedRemote, sendFault } = makeFakes(() => now);

		for (let i = 0; i < 21; i += 1) sendFault(validEnvelope);
		expect(emittedRemote).toHaveLength(20);
		expect(emitted.filter((e) => e.name === "diagnostics.input_rejected")).toEqual([
			{ name: "diagnostics.input_rejected", attributes: { reason: "rate" } },
		]);

		// Within the same window no further rejection event is written.
		sendFault(validEnvelope);
		expect(emitted.filter((e) => e.name === "diagnostics.input_rejected")).toHaveLength(1);

		// A new 60 s window resets the counter.
		now += 61_000;
		sendFault(validEnvelope);
		expect(emittedRemote).toHaveLength(21);
	});

	it("dispose removes the ipc and app listeners", () => {
		const { app, ipcMain, dispose } = makeFakes();
		dispose();
		expect(ipcMain.removeListener).toHaveBeenCalledWith(
			"diagnostics:renderer-fault:v1",
			expect.any(Function),
		);
		expect(app.removeListener).toHaveBeenCalledWith("render-process-gone", expect.any(Function));
		expect(app.removeListener).toHaveBeenCalledWith("child-process-gone", expect.any(Function));
	});
});

describe("registerElectronDiagnostics — process gone hooks", () => {
	it("maps render-process-gone details to a fixed enum", () => {
		const { emitted, appListeners } = makeFakes();
		appListeners.get("render-process-gone")?.("event", "webContents", { reason: "crashed" });
		expect(emitted).toEqual([{ name: "renderer.process_gone", attributes: { reason: "crashed" } }]);
	});

	it("normalizes unknown reasons and types to unknown", () => {
		const { emitted, appListeners } = makeFakes();
		appListeners.get("render-process-gone")?.("event", "webContents", { reason: "something-new" });
		appListeners.get("child-process-gone")?.("event", { type: "frobnicator", reason: "oom" });
		expect(emitted[0]).toEqual({
			name: "renderer.process_gone",
			attributes: { reason: "unknown" },
		});
		expect(emitted[1]).toEqual({
			name: "electron.child_process_gone",
			attributes: { type: "unknown", reason: "oom" },
		});
	});
});

describe("registerWindowHooks", () => {
	it("emits fixed-field events for unresponsive/responsive/preload-error", () => {
		const emitted: Array<{ name: string; attributes: Record<string, unknown> }> = [];
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const webContents = {
			id: 5,
			on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
				listeners.set(event, listener),
			),
			removeListener: vi.fn(),
		};
		const diagnostics = {
			emit: (name: string, attributes: Record<string, unknown> = {}) =>
				emitted.push({ name, attributes }),
		} as unknown as Diagnostics;

		const dispose = registerWindowHooks(webContents, diagnostics);
		listeners.get("unresponsive")?.();
		listeners.get("responsive")?.();
		listeners.get("preload-error")?.("event", "/path/to/preload", new Error("boom"));

		expect(emitted).toEqual([
			{ name: "window.unresponsive", attributes: { webContentsId: 5 } },
			{ name: "window.responsive", attributes: { webContentsId: 5 } },
			{ name: "preload.failed", attributes: { webContentsId: 5 } },
		]);
		dispose();
		expect(webContents.removeListener).toHaveBeenCalledTimes(3);
	});
});
