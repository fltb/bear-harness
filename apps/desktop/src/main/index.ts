/**
 * Electron production shell.
 *
 * The shell owns Chromium lifecycle, preload isolation, native diagnostics,
 * credential encryption, and IPC sender validation. The product Host itself is
 * the injected, transport-neutral @bear-harness/host-runtime instance.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createDiagnostics,
	createHostRuntime,
	type Diagnostics,
	formatTraceparent,
	type HostRuntime,
} from "@bear-harness/host-runtime";
import { productConfig } from "@bear-harness/product-config";
import { app, BrowserWindow, crashReporter, ipcMain, shell } from "electron";
import {
	registerElectronDiagnostics,
	registerWindowHooks,
	type WindowRegistration,
} from "./diagnostics/electron.js";
import { electronCredentialVault } from "./electron-credential-vault.js";
import { wireElectronIpcHandlers } from "./ipc-router.js";

const DEV_RENDERER_URL = "http://127.0.0.1:3100";
const DEV_RENDERER_URL_WITH_SLASH = `${DEV_RENDERER_URL}/`;
const isSourceE2E =
	!app.isPackaged && process.env.NODE_ENV === "test" && process.env.BEAR_E2E_SOURCE === "1";

const electronApp: {
	on(eventName: string, listener: (...args: unknown[]) => void): unknown;
} = app;

function failInit(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
	app.exit(1);
	throw new Error(message);
}

const userData = join(app.getPath("appData"), productConfig.dataDirectoryName);
try {
	mkdirSync(userData, { recursive: true, mode: 0o700 });
	mkdirSync(join(userData, "Chromium"), { recursive: true, mode: 0o700 });
} catch {
	failInit("Failed to initialize application data directory");
}
app.setPath("userData", userData);
app.setPath("sessionData", join(userData, "Chromium"));

const diagnosticsRoot =
	isSourceE2E && process.env.BEAR_DIAGNOSTICS_ROOT && isAbsolute(process.env.BEAR_DIAGNOSTICS_ROOT)
		? process.env.BEAR_DIAGNOSTICS_ROOT
		: join(userData, "diagnostics");
const diagnostics: Diagnostics = createDiagnostics({
	app: {
		setAppLogsPath: (path) => app.setAppLogsPath(path),
		setPath: (name, path) => app.setPath(name, path),
	},
	root: diagnosticsRoot,
	launchId: randomUUID(),
	packaged: app.isPackaged,
	reporter: {
		start: (options) => crashReporter.start(options),
	},
});

const windowRegistry = new Map<number, WindowRegistration>();
const windowSpans: Array<{ end(status: "ok" | "error" | "cancelled"): void }> = [];
let shutdownRequested = false;
let shutdownComplete = false;
let hostRuntime: HostRuntime | null = null;

function requestShutdown(exitCode: number): void {
	process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode);
	if (shutdownRequested) return;
	shutdownRequested = true;
	app.quit();
}

app.on("before-quit", (event) => {
	if (shutdownComplete) return;
	event.preventDefault();
	for (const span of windowSpans.splice(0)) span.end("cancelled");
	const closeHost = hostRuntime ? hostRuntime.close() : Promise.resolve();
	void closeHost.finally(() => {
		void diagnostics.shutdown().then(() => {
			shutdownComplete = true;
			app.quit();
		});
	});
});

process.on("SIGINT", () => requestShutdown(0));
process.on("SIGTERM", () => requestShutdown(0));
process.on("uncaughtException", () => {
	diagnostics.emit("main.uncaught_exception", {});
	requestShutdown(1);
});

function characterRoot(): string {
	const runtime = process as NodeJS.Process & { resourcesPath?: string };
	const shippedRoot = runtime.resourcesPath
		? join(runtime.resourcesPath, "config", "characters")
		: undefined;
	return shippedRoot && existsSync(shippedRoot)
		? shippedRoot
		: resolve(process.cwd(), "../../config/characters");
}

async function initializeHost(): Promise<boolean> {
	try {
		const runtime = createHostRuntime({
			dataDir: userData,
			characterRoot: characterRoot(),
			productConfig,
			credentialVault: electronCredentialVault,
			protocolViolationMode: app.isPackaged ? "isolate" : "throw",
		});
		wireElectronIpcHandlers(runtime.dispatcher, windowRegistry);
		await runtime.start();
		hostRuntime = runtime;
		return true;
	} catch (error) {
		process.stderr.write(`storage unavailable: ${(error as Error)?.message ?? String(error)}\n`);
		return false;
	}
}

function createMainWindow(): void {
	const rendererHtmlPath = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
	const loadFromHtml = app.isPackaged || isSourceE2E;
	const allowedUrl = loadFromHtml
		? pathToFileURL(rendererHtmlPath).href
		: DEV_RENDERER_URL_WITH_SLASH;
	if (!loadFromHtml && process.env.BEAR_RENDERER_URL !== DEV_RENDERER_URL) {
		throw new Error(`BEAR_RENDERER_URL must be exactly ${DEV_RENDERER_URL} for development`);
	}

	const windowSpan = diagnostics.startSpan("window.session", {});
	const traceparent = formatTraceparent(windowSpan.context.traceId, windowSpan.context.spanId);
	const window = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 1050,
		minHeight: 680,
		backgroundColor: "#07171c",
		show: false,
		title: productConfig.productName,
		autoHideMenuBar: process.platform !== "darwin",
		webPreferences: {
			preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			additionalArguments: [`--bear-traceparent=${traceparent}`],
		},
	});

	const webContentsId = window.webContents.id;
	windowRegistry.set(webContentsId, {
		traceparent,
		allowedUrl,
		rateWindow: { count: 0, windowStart: 0, rejectedAt: 0 },
	});
	const windowSpanHandle = {
		end: (status: "ok" | "error" | "cancelled") => {
			windowSpan.end(status, { webContentsId });
		},
	};
	windowSpans.push(windowSpanHandle);
	window.webContents.once("destroyed", () => {
		windowRegistry.delete(webContentsId);
		windowSpanHandle.end("cancelled");
		const index = windowSpans.indexOf(windowSpanHandle);
		if (index >= 0) windowSpans.splice(index, 1);
	});

	registerWindowHooks(window.webContents, diagnostics);
	window.webContents.session.setPermissionCheckHandler(() => false);
	window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
		callback(false),
	);
	window.webContents.on("will-navigate", (event, url) => {
		if (url !== allowedUrl) event.preventDefault();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("https://")) void shell.openExternal(url);
		return { action: "deny" };
	});

	const loadSpan = diagnostics.startSpan("window.load", {});
	window.webContents.once("did-finish-load", () => {
		loadSpan.end("ok", { webContentsId, ok: true });
	});
	window.webContents.on(
		"did-fail-load",
		(_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
			if (!isMainFrame) return;
			diagnostics.emit("window.load_failed", { webContentsId });
			loadSpan.end("error", { webContentsId, ok: false });
			windowSpanHandle.end("error");
			window.destroy();
			requestShutdown(1);
		},
	);
	window.once("ready-to-show", () => window.show());
	if (loadFromHtml) void window.loadFile(rendererHtmlPath);
	else void window.loadURL(DEV_RENDERER_URL);
}

registerElectronDiagnostics({
	app: {
		on: (event, listener) => electronApp.on(event, listener),
	},
	ipcMain: {
		on: (channel, listener) => ipcMain.on(channel, listener as Parameters<typeof ipcMain.on>[1]),
	},
	diagnostics,
	windowRegistry,
});

diagnostics.runInSession(() => {
	app
		.whenReady()
		.then(async () => {
			if (!(await initializeHost())) failInit("Failed to initialize companion host runtime");
			createMainWindow();
		})
		.catch((error: unknown) => {
			failInit(error instanceof Error ? error.message : String(error));
		});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") requestShutdown(0);
	});
});
