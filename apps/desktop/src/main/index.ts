/**
 * Electron main process: three-process-separated shell.
 *
 * Startup order (all before `app.whenReady()`):
 *   1. userData/sessionData isolation under `<appData>/<dataDirectoryName>`
 *      (created first — `app.setPath` rejects nonexistent directories);
 *   2. Diagnostics initialization (root override only for the source-E2E
 *      test triple: unpackaged + NODE_ENV=test + BEAR_E2E_SOURCE=1 with an
 *      absolute BEAR_DIAGNOSTICS_ROOT);
 *   3. session span, fault hooks, then `app.whenReady()`.
 *
 * Window loading has exactly three modes, decided in order:
 *   - packaged: loadFile(dist/renderer/index.html);
 *   - unpackaged + NODE_ENV=test + BEAR_E2E_SOURCE=1: the same built HTML;
 *   - otherwise: require BEAR_RENDERER_URL === "http://127.0.0.1:3100".
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { productConfig } from "../../product.config.js";
import {
	registerElectronDiagnostics,
	registerWindowHooks,
	type WindowRegistration,
} from "./diagnostics/electron.js";
import { createDiagnostics, type Diagnostics } from "./diagnostics/index.js";
import { formatTraceparent } from "./diagnostics/trace.js";
import { openDatabase, migrate, MIGRATIONS } from "./storage/database.js";
import { EventBus } from "./storage/event-bus.js";
import { ArtifactStore } from "./artifacts/index.js";
import { CompanionSupervisor } from "./companion/supervisor.js";
import { CharacterBehaviorService } from "./companion/character-behavior.js";
import {
	characterPiResources,
	getActiveCharacterId,
	loadCharacter,
} from "./companion/character-loader.js";
import { MemoryService } from "./memory/service.js";
import { FirstMeetingMachine } from "./companion/first-meeting.js";
import { TurnPipeline } from "./companion/turn-pipeline.js";
import { VoiceStackManager } from "./companion/voice-stack.js";
import { CommissionService } from "./commissions/service.js";
import { ExecutorRouter } from "./executors/router.js";
import { CodexAdapter } from "./executors/codex-adapter.js";
import { PiAcpAdapter, seedPiAcpProfile } from "./executors/pi-adapter.js";
import { CredentialStore } from "./providers/credential-store.js";
import { ProviderCatalog } from "./providers/catalog.js";
import { wireAllHandlers, type HostServices } from "./composition.js";
import { wireIpcHandlers } from "./ipc-router.js";

const DEV_RENDERER_URL = "http://127.0.0.1:3100";
const DEV_RENDERER_URL_WITH_SLASH = `${DEV_RENDERER_URL}/`;

// Narrow electron's heavily overloaded app.on to the generic signature: the
// typed event overloads reject plain `string` event names under the native
// compiler, so the diagnostics wiring routes through this structural view.
const electronApp: {
	on(eventName: string, listener: (...args: unknown[]) => void): unknown;
} = app;

const isSourceE2E =
	!app.isPackaged && process.env.NODE_ENV === "test" && process.env.BEAR_E2E_SOURCE === "1";

// ---------------------------------------------------------------------------
// userData / sessionData isolation.
// ---------------------------------------------------------------------------

function failInit(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
	app.exit(1);
	throw new Error(message);
}

const userData = join(app.getPath("appData"), productConfig.dataDirectoryName);
try {
	mkdirSync(userData, { recursive: true, mode: 0o700 });
} catch {
	failInit("Failed to initialize application data directory");
}
app.setPath("userData", userData);

const sessionData = join(userData, "Chromium");
try {
	mkdirSync(sessionData, { recursive: true, mode: 0o700 });
} catch {
	failInit("Failed to initialize application data directory");
}
app.setPath("sessionData", sessionData);

// ---------------------------------------------------------------------------
// Diagnostics (before any BrowserWindow).
// ---------------------------------------------------------------------------

const diagnosticsRoot =
	isSourceE2E && process.env.BEAR_DIAGNOSTICS_ROOT && isAbsolute(process.env.BEAR_DIAGNOSTICS_ROOT)
		? process.env.BEAR_DIAGNOSTICS_ROOT
		: join(userData, "diagnostics");

const launchId = randomUUID();
const diagnostics: Diagnostics = createDiagnostics({
	app: {
		setAppLogsPath: (path) => app.setAppLogsPath(path),
		setPath: (name, path) => app.setPath(name, path),
	},
	root: diagnosticsRoot,
	launchId,
	packaged: app.isPackaged,
});

const windowRegistry = new Map<number, WindowRegistration>();
const windowSpans: Array<{ end(status: "ok" | "error" | "cancelled"): void }> = [];
let shutdownRequested = false;
let shutdownComplete = false;
let hostServices: HostServices | null = null;

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

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
	const stopCompanion = hostServices ? hostServices.supervisor.stop() : Promise.resolve();
	void stopCompanion.finally(() => {
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

// ---------------------------------------------------------------------------
// Window.
// ---------------------------------------------------------------------------

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

	const win = new BrowserWindow({
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

	const webContentsId = win.webContents.id;
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

	win.webContents.once("destroyed", () => {
		windowRegistry.delete(webContentsId);
		windowSpanHandle.end("cancelled");
		const index = windowSpans.indexOf(windowSpanHandle);
		if (index >= 0) windowSpans.splice(index, 1);
	});

	registerWindowHooks(win.webContents, diagnostics);

	// Permissions: deny everything for this shell's session.
	win.webContents.session.setPermissionCheckHandler(() => false);
	win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
		callback(false),
	);

	// Navigation: same-URL main-frame navigation allowed, everything else blocked.
	win.webContents.on("will-navigate", (event, url) => {
		if (url !== allowedUrl) event.preventDefault();
	});
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

	// Load tracking: fixed-field failure event, never the URL or free-text error.
	const loadSpan = diagnostics.startSpan("window.load", {});
	win.webContents.once("did-finish-load", () => {
		loadSpan.end("ok", { webContentsId, ok: true });
	});
	win.webContents.on(
		"did-fail-load",
		(_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
			if (!isMainFrame) return;
			diagnostics.emit("window.load_failed", { webContentsId });
			loadSpan.end("error", { webContentsId, ok: false });
			windowSpanHandle.end("error");
			win.destroy();
			requestShutdown(1);
		},
	);

	win.once("ready-to-show", () => win.show());

	if (loadFromHtml) {
		void win.loadFile(rendererHtmlPath);
	} else {
		void win.loadURL(DEV_RENDERER_URL);
	}
}

// ---------------------------------------------------------------------------
// Host services (companion domain) — after diagnostics, before window.
// ---------------------------------------------------------------------------

function initHostServices(): HostServices | null {
	try {
		const db = openDatabase(join(userData, "storage"));
		migrate(MIGRATIONS);
		const eventBus = new EventBus(db);
		const artifactStore = new ArtifactStore(db, join(userData, "artifacts"));
		const credentials = new CredentialStore(db);
		const providers = new ProviderCatalog(credentials, join(userData, "companion-runtime"));
		const supervisor = new CompanionSupervisor(userData, eventBus, providers);
		const characterBehavior = new CharacterBehaviorService(db, eventBus);
		supervisor.setHostToolHandler((call) => characterBehavior.invoke(call));
		const memory = new MemoryService(db, eventBus);
		const onboarding = new FirstMeetingMachine(db, eventBus);
		const turns = new TurnPipeline(db, supervisor, eventBus);
		const voice = new VoiceStackManager(db, eventBus);
		seedPiAcpProfile(db);
		const executorRouter = new ExecutorRouter(db);
		executorRouter.register("product-managed", new PiAcpAdapter(db, userData));
		executorRouter.register("codex", new CodexAdapter(db, eventBus));
		const commissions = new CommissionService(db, eventBus, artifactStore, executorRouter);
		const services: HostServices = {
			db,
			eventBus,
			artifactStore,
			supervisor,
			memory,
			onboarding,
			turns,
			voice,
			commissions,
			credentials,
			providers,
		};
		wireAllHandlers(services);
		const activeCharacterId = getActiveCharacterId(db, productConfig.defaultCharacterId);
		const activeCharacter = loadCharacter(activeCharacterId);
		if (!activeCharacter) throw new Error(`character package missing: ${activeCharacterId}`);
		supervisor.configureRuntime(characterPiResources(activeCharacter));
		wireIpcHandlers();
		void supervisor.start();
		hostServices = services;
		return services;
	} catch (error) {
		process.stderr.write(`storage unavailable: ${(error as Error)?.message ?? String(error)}\n`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

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
		.then(() => {
			if (!initHostServices()) failInit("Failed to initialize companion host services");
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
