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
	ARTIFACT_SCHEME,
	registerArtifactProtocol,
	registerArtifactSchemePrivileges,
} from "./artifact-protocol.js";
import {
	registerElectronDiagnostics,
	registerWindowHooks,
	type WindowRegistration,
} from "./diagnostics/electron.js";
import { e2eCredentialVault } from "./e2e-vault.js";
import { electronCredentialVault } from "./electron-credential-vault.js";
import { wireElectronIpcHandlers } from "./ipc-router.js";
import { UpdateService } from "./update-service.js";

const DEV_RENDERER_URL = "http://127.0.0.1:3100";
const DEV_RENDERER_URL_WITH_SLASH = `${DEV_RENDERER_URL}/`;
const isSourceE2E =
	!app.isPackaged && process.env.NODE_ENV === "test" && process.env.BEAR_E2E_SOURCE === "1";

// The bear-artifact:// scheme must be privileged before app readiness.
registerArtifactSchemePrivileges();

const rendererHtmlPath = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const loadFromHtml = app.isPackaged || isSourceE2E;
const allowedUrl = loadFromHtml
	? pathToFileURL(rendererHtmlPath).href
	: DEV_RENDERER_URL_WITH_SLASH;

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updateService: UpdateService | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let artifactProtocolRegistered = false;

// Unpackaged runs (dev, source e2e) never touch the real macOS login
// keychain: Chromium would pop an authorization dialog for its own safe
// storage (cookies, HTTP auth), blocking startup until timeout. The mock
// keychain is Chromium's official CI/test flag for exactly this, and the GPU
// process is another first-boot blocker that serializes fast repeated
// launches (it hangs the app-ready handshake Playwright waits on).
if (!app.isPackaged) {
	app.commandLine.appendSwitch("use-mock-keychain");
	app.commandLine.appendSwitch("disable-gpu");
	app.disableHardwareAcceleration();
}

const electronApp: {
	on(eventName: string, listener: (...args: unknown[]) => void): unknown;
} = app;

function failInit(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
	app.exit(1);
	throw new Error(message);
}

const appDataBase =
	isSourceE2E && process.env.BEAR_E2E_APP_DATA && isAbsolute(process.env.BEAR_E2E_APP_DATA)
		? process.env.BEAR_E2E_APP_DATA
		: app.getPath("appData");
const userData = join(appDataBase, productConfig.dataDirectoryName);
try {
	mkdirSync(userData, { recursive: true, mode: 0o700 });
	mkdirSync(join(userData, "Chromium"), { recursive: true, mode: 0o700 });
} catch {
	failInit("Failed to initialize application data directory");
}
app.setPath("userData", userData);
app.setPath("sessionData", join(userData, "Chromium"));

// A second instance would share this userData directory and the same memory
// bank namespace, racing writes (SQLite busy errors, memory last-write-wins).
// Keep one window per user data dir: a second launch quits and focuses the
// existing window via the second-instance event.
// A second instance would share this userData directory and the same memory
// bank namespace, racing writes (SQLite busy errors, memory last-write-wins).
// Keep one window per install: a second launch quits and focuses the existing
// window via the second-instance event. Only enforced in packaged builds — an
// unpackaged dev/e2e run needs parallel instances (distinct BEAR_E2E_APP_DATA
// roots) and macOS treats all unpackaged Electron apps as one identity.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
	app.exit(0);
} else if (app.isPackaged) {
	app.on("second-instance", () => {
		const window = BrowserWindow.getAllWindows()[0];
		if (window) {
			if (window.isMinimized()) window.restore();
			window.focus();
		}
	});
}

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
	if (updateTimer) clearInterval(updateTimer);
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
		const updater = updateService;
		const runtime = createHostRuntime({
			dataDir: userData,
			characterRoot: characterRoot(),
			productConfig,
			credentialVault: isSourceE2E ? e2eCredentialVault : electronCredentialVault,
			protocolViolationMode: app.isPackaged ? "isolate" : "throw",
			artifactProtocolUrlFactory: (artifactId) =>
				`${ARTIFACT_SCHEME}://artifact/${encodeURIComponent(artifactId)}`,
			updateService: updater ? { check: () => updater.check() } : undefined,
		});
		wireElectronIpcHandlers(runtime.dispatcher, windowRegistry, {
			artifactProtocolAvailable: () => artifactProtocolRegistered,
		});
		await runtime.start();
		hostRuntime = runtime;
		return true;
	} catch (error) {
		process.stderr.write(`storage unavailable: ${(error as Error)?.message ?? String(error)}\n`);
		return false;
	}
}

function createMainWindow(): void {
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
			updateService = new UpdateService({
				feedUrl: productConfig.updateFeedUrl ?? "",
				currentVersion: app.getVersion(),
				stagingDir: join(userData, "updates"),
			});
			if (!(await initializeHost())) failInit("Failed to initialize companion host runtime");
			const artifacts = hostRuntime?.artifacts;
			if (!artifacts) failInit("Host runtime is unavailable");
			registerArtifactProtocol({
				get: (id) => artifacts.get(id),
				readBlob: (id) => artifacts.readBlob(id),
				allowedUrl,
			});
			artifactProtocolRegistered = true;
			// Idle update checks every 6h; the renderer can also trigger on
			// demand via the update.check:v1 RPC. No-op while the feed is empty.
			updateTimer = setInterval(() => {
				void updateService?.check().catch(() => {
					// The state machine carries the error; the timer keeps running.
				});
			}, UPDATE_CHECK_INTERVAL_MS);
			updateTimer.unref?.();
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
