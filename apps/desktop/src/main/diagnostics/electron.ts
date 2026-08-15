/**
 * Electron diagnostics wiring: the renderer-fault IPC channel and the
 * process-gone hooks. Per-webContents hooks (unresponsive/responsive/
 * preload-error) are attached by `registerWindowHooks` when a window is
 * created.
 *
 * The renderer-fault listener validates, in order:
 *   1. envelope shape (plain object, exact keys { traceparent, fault });
 *   2. sender is a registered window webContents;
 *   3. senderFrame is the main frame of that sender;
 *   4. frame URL equals the registered allowedUrl;
 *   5. fault shape (kind/errorType/line/column);
 *   6. traceparent grammar and exact match with the registered value —
 *      on failure a trace is restarted but the shape-valid fault is kept;
 *   7. per-webContents rate limit (rendererFaultsPerMinute per 60 s).
 *
 * Failures emit fixed-field `diagnostics.input_rejected{reason}` events; the
 * rate-limit rejection is written at most once per 60 s per window.
 */

import {
	type DiagnosticName,
	type Diagnostics,
	isErrorType,
	parseTraceparent,
	RENDERER_FAULT_KINDS,
} from "@bear-harness/host-runtime";

export interface WindowRegistration {
	traceparent: string;
	allowedUrl: string;
	rateWindow: { count: number; windowStart: number; rejectedAt: number };
}

export interface IpcEventLike {
	sender: {
		id: number;
		mainFrame: { url: string };
	};
	senderFrame: { url: string } | null;
}

export interface IpcMainLike {
	on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
	removeListener?(
		channel: string,
		listener: (event: IpcEventLike, ...args: unknown[]) => void,
	): unknown;
}

export type AppEventListener = (...args: unknown[]) => void;

export interface AppLike {
	on(event: string, listener: AppEventListener): unknown;
	removeListener?(event: string, listener: AppEventListener): unknown;
}

export interface WindowHooksWebContents {
	readonly id: number;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ElectronDiagnosticsOptions {
	app: AppLike;
	ipcMain: IpcMainLike;
	diagnostics: Diagnostics;
	windowRegistry: Map<number, WindowRegistration>;
	clock?: () => number;
}

const FAULT_CHANNEL = "diagnostics:renderer-fault:v1";
const RATE_WINDOW_MS = 60_000;

const GONE_REASONS: Record<string, true> = {
	"clean-exit": true,
	"abnormal-exit": true,
	killed: true,
	crashed: true,
	oom: true,
	"launch-failed": true,
	"integrity-failure": true,
};

const CHILD_TYPES: Record<string, true> = {
	utility: true,
	renderer: true,
	zygote: true,
	gpu: true,
	"gpu-broker": true,
	"sandbox-helper": true,
	"pepper-plugin-helper": true,
	"crashpad-handler": true,
};

function normalizeGoneReason(value: unknown): string {
	return typeof value === "string" && GONE_REASONS[value] ? value : "unknown";
}

function normalizeChildType(value: unknown): string {
	return typeof value === "string" && CHILD_TYPES[value] ? value : "unknown";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => own.includes(key));
}

function validFaultShape(fault: Record<string, unknown>): boolean {
	const keys = Object.keys(fault);
	for (const key of keys) {
		if (key !== "kind" && key !== "errorType" && key !== "line" && key !== "column") return false;
	}
	if (!(RENDERER_FAULT_KINDS as readonly string[]).includes(String(fault.kind))) return false;
	if (!isErrorType(fault.errorType)) return false;
	for (const key of ["line", "column"]) {
		if (key in fault) {
			const value = fault[key];
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0 ||
				value > 2_147_483_647
			) {
				return false;
			}
		}
	}
	return true;
}

function faultAttributes(
	fault: Record<string, unknown>,
): Record<string, boolean | number | string> {
	const attributes: Record<string, boolean | number | string> = {
		kind: String(fault.kind),
		errorType: String(fault.errorType),
	};
	if (typeof fault.line === "number") attributes.line = fault.line;
	if (typeof fault.column === "number") attributes.column = fault.column;
	return attributes;
}

export function registerElectronDiagnostics(options: ElectronDiagnosticsOptions): () => void {
	const disposers: Array<() => void> = [];

	const channelListener = (event: IpcEventLike, ...args: unknown[]): void => {
		const diagnostics = options.diagnostics;
		const reject = (reason: "sender" | "shape" | "frame" | "url" | "rate"): void => {
			diagnostics.emit("diagnostics.input_rejected", { reason });
		};

		const payload = args[0];
		if (!isPlainObject(payload) || !hasExactKeys(payload, ["traceparent", "fault"])) {
			reject("shape");
			return;
		}
		const { traceparent, fault } = payload;
		const registration = options.windowRegistry.get(event.sender.id);
		if (!registration) {
			reject("sender");
			return;
		}
		if (event.senderFrame !== event.sender.mainFrame) {
			reject("frame");
			return;
		}
		if (event.senderFrame === null || event.senderFrame.url !== registration.allowedUrl) {
			reject("url");
			return;
		}
		if (!isPlainObject(fault) || !validFaultShape(fault)) {
			reject("shape");
			return;
		}

		// Traceparent: grammar + exact registration match. A mismatch restarts
		// the trace but keeps the shape-valid fault.
		const parsed = typeof traceparent === "string" ? parseTraceparent(traceparent) : null;
		const traceMatches = parsed !== null && traceparent === registration.traceparent;

		// Rate limit: rendererFaultsPerMinute per 60 s per webContents.
		const now = options.clock ? options.clock() : Date.now();
		const rateWindow = registration.rateWindow;
		if (now - rateWindow.windowStart > RATE_WINDOW_MS) {
			rateWindow.windowStart = now;
			rateWindow.count = 0;
		}
		rateWindow.count += 1;
		if (rateWindow.count > options.diagnostics.policy.rendererFaultsPerMinute) {
			if (now - rateWindow.rejectedAt > RATE_WINDOW_MS) {
				rateWindow.rejectedAt = now;
				reject("rate");
			}
			return;
		}

		const attributes = faultAttributes(fault);
		if (traceMatches && parsed !== null) {
			options.diagnostics.emitRemote("renderer.fault", attributes, {
				traceId: parsed.traceId,
				parentSpanId: parsed.spanId,
			});
		} else {
			options.diagnostics.emit("diagnostics.trace_restarted", {});
			options.diagnostics.emit("renderer.fault", attributes);
		}
	};
	options.ipcMain.on(FAULT_CHANNEL, channelListener);
	disposers.push(() => {
		options.ipcMain.removeListener?.(FAULT_CHANNEL, channelListener);
	});

	const onRenderProcessGone = (...args: unknown[]): void => {
		const details = isPlainObject(args[2]) ? args[2] : {};
		options.diagnostics.emit("renderer.process_gone", {
			reason: normalizeGoneReason(details.reason),
		});
	};
	const onChildProcessGone = (...args: unknown[]): void => {
		const details = isPlainObject(args[1]) ? args[1] : {};
		options.diagnostics.emit("electron.child_process_gone", {
			type: normalizeChildType(details.type),
			reason: normalizeGoneReason(details.reason),
		});
	};

	options.app.on("render-process-gone", onRenderProcessGone);
	options.app.on("child-process-gone", onChildProcessGone);
	disposers.push(() => {
		options.app.removeListener?.("render-process-gone", onRenderProcessGone);
		options.app.removeListener?.("child-process-gone", onChildProcessGone);
	});

	return () => {
		for (const dispose of disposers) dispose();
	};
}

/**
 * Per-webContents hooks: unresponsive/responsive transitions and preload
 * failures. Emitted fields are fixed (webContentsId only); the hook never
 * forwards error messages, preload paths or URLs.
 */
export function registerWindowHooks(
	webContents: WindowHooksWebContents,
	diagnostics: Diagnostics,
): () => void {
	const emitWindow = (
		name: DiagnosticName,
		attributes: Record<string, boolean | number | string>,
	) => diagnostics.emit(name, attributes);

	const onUnresponsive = (): void =>
		emitWindow("window.unresponsive", { webContentsId: webContents.id });
	const onResponsive = (): void =>
		emitWindow("window.responsive", { webContentsId: webContents.id });
	const onPreloadError = (): void =>
		emitWindow("preload.failed", { webContentsId: webContents.id });

	webContents.on("unresponsive", onUnresponsive);
	webContents.on("responsive", onResponsive);
	webContents.on("preload-error", onPreloadError);
	return () => {
		webContents.removeListener?.("unresponsive", onUnresponsive);
		webContents.removeListener?.("responsive", onResponsive);
		webContents.removeListener?.("preload-error", onPreloadError);
	};
}
