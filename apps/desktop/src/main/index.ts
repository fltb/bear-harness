/**
 * Electron production shell.
 *
 * The shell owns Chromium lifecycle, preload isolation, native diagnostics,
 * credential encryption, and IPC sender validation. The product Host itself is
 * the injected, transport-neutral @bear-harness/host-runtime instance.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type BootstrapFatalIssue,
	completePendingProductResets,
	createDiagnostics,
	createHostRuntime,
	type Diagnostics,
	formatTraceparent,
	type HostRuntime,
	inspectBootstrapHealth,
	RuntimeLayout,
	repairCompanionDatabase,
	repairSystemDatabase,
	resetProductData,
	restoreDefaultCharacterPackage,
	selectDefaultCharacter,
} from "@bear-harness/host-runtime";
import { productConfig } from "@bear-harness/product-config";
import { app, BrowserWindow, crashReporter, dialog, ipcMain, shell } from "electron";
import { createDesktopArtifactPresenter } from "./artifact-presenter.js";
import {
	registerElectronDiagnostics,
	registerWindowHooks,
	type WindowRegistration,
} from "./diagnostics/electron.js";
import { e2eCredentialVault } from "./e2e-vault.js";
import { electronCredentialVault } from "./electron-credential-vault.js";
import { wireElectronIpcHandlers } from "./ipc-router.js";
import { registerLocalFileBridge } from "./local-file-bridge.js";
import {
	type NativeRecoveryInterface,
	RecoveryController,
	type RecoveryDestinationRequest,
	type RecoveryPrompt,
} from "./recovery-controller.js";
import {
	type RecoveryIncident,
	RecoveryStateStore,
	recoveryStateRootForAppData,
} from "./recovery-state.js";
import { chooseRecoveryAction } from "./recovery-window.js";
import { UpdateService } from "./update-service.js";

const DEV_RENDERER_URL = "http://127.0.0.1:3100";
const DEV_RENDERER_URL_WITH_SLASH = `${DEV_RENDERER_URL}/`;
const isSourceE2E =
	!app.isPackaged && process.env.NODE_ENV === "test" && process.env.BEAR_E2E_SOURCE === "1";
const isPackagedE2E =
	app.isPackaged &&
	process.env.NODE_ENV === "test" &&
	process.env.BEAR_E2E_PACKAGED === "1" &&
	typeof process.env.BEAR_E2E_APP_DATA === "string" &&
	isAbsolute(process.env.BEAR_E2E_APP_DATA);
const rendererHtmlPath = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const loadFromHtml = app.isPackaged || isSourceE2E;
const allowedUrl = loadFromHtml
	? pathToFileURL(rendererHtmlPath).href
	: DEV_RENDERER_URL_WITH_SLASH;

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updateService: UpdateService | null = null;
let updateTimer: NodeJS.Timeout | null = null;

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

const appDataBase =
	(isSourceE2E || isPackagedE2E) &&
	process.env.BEAR_E2E_APP_DATA &&
	isAbsolute(process.env.BEAR_E2E_APP_DATA)
		? process.env.BEAR_E2E_APP_DATA
		: app.getPath("appData");
const canonicalDataRoot = join(appDataBase, productConfig.dataDirectoryName);
const recoveryRoot = recoveryStateRootForAppData(appDataBase);
let recoveryStore: RecoveryStateStore | null = null;
let bootstrapFailureReason: string | null = null;
let storageLayoutReady = false;

try {
	recoveryStore = new RecoveryStateStore(recoveryRoot, {
		productDataRoots: [canonicalDataRoot],
	});
	mkdirSync(canonicalDataRoot, { recursive: true, mode: 0o700 });
	storageLayoutReady = true;
} catch {
	bootstrapFailureReason = "Failed to initialize the application data directory safely";
}

const defaultElectronUserData = app.getPath("userData");
let userData = storageLayoutReady
	? canonicalDataRoot
	: join(recoveryRoot, "recovery-electron-profile");
try {
	mkdirSync(join(userData, "Chromium"), { recursive: true, mode: 0o700 });
	app.setPath("userData", userData);
	app.setPath("sessionData", join(userData, "Chromium"));
} catch {
	userData = defaultElectronUserData;
	bootstrapFailureReason ??= "Failed to initialize the application data directory safely";
}

// Only packaged builds enforce one instance per install. Unpackaged
// development/source-E2E runs need parallel instances with distinct data
// roots, while macOS gives all unpackaged Electron apps one identity.
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
	(isSourceE2E || isPackagedE2E) &&
	process.env.BEAR_DIAGNOSTICS_ROOT &&
	isAbsolute(process.env.BEAR_DIAGNOSTICS_ROOT)
		? process.env.BEAR_DIAGNOSTICS_ROOT
		: storageLayoutReady
			? new RuntimeLayout(userData).systemDiagnostics
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
const windowHookDisposers = new Map<number, () => void>();
let shutdownRequested = false;
let shutdownComplete = false;
let hostRuntime: HostRuntime | null = null;
let disposeElectronIpcHandlers: (() => void) | null = null;
let disposeElectronDiagnostics: (() => void) | null = null;
const artifactPresentation = createDesktopArtifactPresenter({
	showSaveDialog: (options) => dialog.showSaveDialog(options),
	openPath: (path) => shell.openPath(path),
	showItemInFolder: (path) => shell.showItemInFolder(path),
	documentsDirectory: () => app.getPath("documents"),
});

function requestShutdown(exitCode: number): void {
	process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode);
	if (shutdownRequested) return;
	shutdownRequested = true;
	app.quit();
}

function nativeRecoveryInterface(): NativeRecoveryInterface {
	return {
		chooseAction: (prompt: RecoveryPrompt) =>
			chooseRecoveryAction(productConfig.productName, prompt),
		chooseDestination: async (request: RecoveryDestinationRequest) => {
			const result = await dialog.showSaveDialog({
				title:
					request.purpose === "safe_reset"
						? "Create recovery export before safe reset"
						: "Export current application data",
				defaultPath: join(app.getPath("documents"), request.suggestedName),
				buttonLabel: "Create recovery export",
				properties: ["createDirectory", "showOverwriteConfirmation"],
			});
			return result.canceled ? null : (result.filePath ?? null);
		},
		openPath: async (path) => {
			const error = await shell.openPath(path);
			if (error) throw new Error("The selected recovery location could not be opened");
		},
		exit: () => {
			// The recovery loop owns shutdown so cancellation and Exit converge.
		},
	};
}

function recoveryDataRoot(): string {
	return canonicalDataRoot;
}

function firstPendingIncident(): RecoveryIncident | undefined {
	if (!recoveryStore) return undefined;
	try {
		return recoveryStore.list().records.find((record) => record.status === "pending");
	} catch {
		return undefined;
	}
}

async function runRecoveryInterface(
	reason: string,
	retry: () => boolean | Promise<boolean>,
	issue?: BootstrapFatalIssue,
): Promise<void> {
	const incident = firstPendingIncident();
	const bootstrap = {
		dataDir: canonicalDataRoot,
		characterSeedRoot: characterSeedRoot(),
		defaultCharacterId: productConfig.defaultCharacterId,
	};
	const actions = issue
		? issue.kind === "settings_database"
			? (["repair_database", "export_data", "open_data_location", "safe_reset", "exit"] as const)
			: issue.kind === "companion_database"
				? ([
						"repair_database",
						...(issue.characterId === productConfig.defaultCharacterId
							? []
							: (["use_default_character"] as const)),
						"export_data",
						"open_data_location",
						"safe_reset",
						"exit",
					] as const)
				: issue.kind === "character_package"
					? issue.defaultCharacter
						? ([
								"restore_default_character",
								"export_data",
								"open_data_location",
								"safe_reset",
								"exit",
							] as const)
						: (["use_default_character", "export_data", "open_data_location", "exit"] as const)
					: (["export_data", "open_data_location", "safe_reset", "exit"] as const)
		: (["retry", "export_data", "open_data_location", "exit"] as const);
	const recovery = new RecoveryController({
		reason,
		dataRoot: recoveryDataRoot(),
		resetTarget: canonicalDataRoot,
		...(incident && recoveryStore ? { incident, stateStore: recoveryStore } : {}),
		native: nativeRecoveryInterface(),
		retry,
		...(actions ? { actions } : {}),
		...(issue?.kind === "settings_database"
			? {
					repairDatabase: () => {
						repairSystemDatabase(canonicalDataRoot);
					},
				}
			: issue?.kind === "companion_database"
				? {
						repairDatabase: () => {
							repairCompanionDatabase(canonicalDataRoot, issue.characterId);
						},
					}
				: {}),
		useDefaultCharacter: () => selectDefaultCharacter(bootstrap),
		restoreDefaultCharacter: () => {
			restoreDefaultCharacterPackage(bootstrap);
		},
		clearData: () => {
			resetProductData(canonicalDataRoot, recoveryRoot);
		},
	});
	for (;;) {
		const result = await recovery.present();
		if (result.status === "failed") {
			await dialog.showMessageBox({
				type: "error",
				title: `${productConfig.productName} Recovery`,
				message: "Recovery action was not completed",
				detail: result.message,
				buttons: ["Return to recovery"],
			});
			continue;
		}
		if (result.status === "succeeded" && !result.restartRequired) continue;
		if (result.status === "succeeded" && !isSourceE2E) app.relaunch();
		requestShutdown(result.status === "succeeded" ? 0 : 1);
		return;
	}
}

app.on("before-quit", (event) => {
	if (shutdownComplete) return;
	event.preventDefault();
	if (updateTimer) {
		clearInterval(updateTimer);
		updateTimer = null;
	}
	const disposeIpcHandlers = disposeElectronIpcHandlers;
	disposeElectronIpcHandlers = null;
	disposeIpcHandlers?.();
	const disposeDiagnostics = disposeElectronDiagnostics;
	disposeElectronDiagnostics = null;
	disposeDiagnostics?.();
	for (const dispose of windowHookDisposers.values()) dispose();
	windowHookDisposers.clear();
	for (const span of windowSpans.splice(0)) span.end("cancelled");
	const closeHost = hostRuntime ? hostRuntime.close() : Promise.resolve();
	void Promise.allSettled([closeHost, artifactPresentation.dispose()]).finally(() => {
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

function characterSeedRoot(): string {
	const runtime = process as NodeJS.Process & { resourcesPath?: string };
	const packaged = runtime.resourcesPath
		? join(runtime.resourcesPath, "character-seeds")
		: undefined;
	return packaged && existsSync(packaged)
		? packaged
		: resolve(process.cwd(), "../../config/characters");
}

function bundledGitRuntime(): { shellPath: string; pathEntries: string[] } | undefined {
	if (!app.isPackaged || !process.resourcesPath) return undefined;
	const gitRoot = join(process.resourcesPath, "git");
	const shellPath = join(gitRoot, "usr", "bin", "bash.exe");
	const pathEntries = [
		join(gitRoot, "cmd"),
		join(gitRoot, "mingw64", "bin"),
		join(gitRoot, "usr", "bin"),
	];
	return existsSync(shellPath) && pathEntries.every(existsSync)
		? { shellPath, pathEntries }
		: undefined;
}

function sourceE2EPiWorkerPath(): string | undefined {
	if (!isSourceE2E) return undefined;
	const configured = process.env.BEAR_E2E_PI_WORKER_PATH;
	if (!configured) return undefined;
	if (!isAbsolute(configured)) throw new Error("BEAR_E2E_PI_WORKER_PATH must be absolute");
	const canonical = realpathSync.native(configured);
	if (canonical !== configured) throw new Error("BEAR_E2E_PI_WORKER_PATH must be canonical");
	return canonical;
}

async function initializeHost(): Promise<boolean> {
	let ipcHandlersDispose: (() => void) | null = null;
	let runtime: ReturnType<typeof createHostRuntime> | null = null;
	try {
		const updater = updateService;
		const createdRuntime = createHostRuntime({
			dataDir: userData,
			characterSeedRoot: characterSeedRoot(),
			productConfig,
			credentialVault: isSourceE2E ? e2eCredentialVault : electronCredentialVault,
			updateService: updater
				? {
						check: () => updater.check(),
						discard: () => Promise.resolve({ ...updater.discard(), discarded: true }),
						apply: () => Promise.resolve(updater.apply()),
					}
				: undefined,
			bundledGit: bundledGitRuntime(),
			piWorkerPath: sourceE2EPiWorkerPath(),
			artifactPresenter: artifactPresentation.presenter,
			characterPackagePresenter: {
				reveal: async (directory) => {
					const error = await shell.openPath(directory);
					if (error) throw new Error("character_package_reveal_failed");
				},
			},
		});
		runtime = createdRuntime;
		const disposeRouter = wireElectronIpcHandlers(createdRuntime.dispatcher, windowRegistry, {
			subscribeInvalidations: (listener) => createdRuntime.subscribeInvalidations(listener),
			subscribeLivePush: (listener) => createdRuntime.subscribeLivePush(listener),
			diagnostics,
		});
		const disposeLocalFileBridge = registerLocalFileBridge(windowRegistry);
		ipcHandlersDispose = () => {
			disposeLocalFileBridge();
			disposeRouter();
		};
		disposeElectronIpcHandlers = ipcHandlersDispose;
		await createdRuntime.start();
		hostRuntime = createdRuntime;
		return true;
	} catch (error) {
		ipcHandlersDispose?.();
		if (disposeElectronIpcHandlers === ipcHandlersDispose) disposeElectronIpcHandlers = null;
		await runtime?.close().catch(() => {});
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
	const disposeWindowHooks = registerWindowHooks(window.webContents, diagnostics);
	windowHookDisposers.set(webContentsId, disposeWindowHooks);
	window.webContents.once("destroyed", () => {
		windowRegistry.delete(webContentsId);
		const dispose = windowHookDisposers.get(webContentsId);
		windowHookDisposers.delete(webContentsId);
		dispose?.();
		windowSpanHandle.end("cancelled");
		const index = windowSpans.indexOf(windowSpanHandle);
		if (index >= 0) windowSpans.splice(index, 1);
	});
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
	window.once("ready-to-show", () => {
		// CI source E2E drives the BrowserWindow through Playwright while keeping it
		// fully hidden. Local interactive E2E remains visible without taking focus.
		if (process.env.BEAR_E2E_SOURCE === "1") {
			if (process.env.CI !== "1") window.showInactive();
		} else window.show();
	});
	if (loadFromHtml) void window.loadFile(rendererHtmlPath);
	else void window.loadURL(DEV_RENDERER_URL);
}

disposeElectronDiagnostics = registerElectronDiagnostics({
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
			if (bootstrapFailureReason) {
				await runRecoveryInterface(
					bootstrapFailureReason,
					() => {
						if (!recoveryStore) return false;
						try {
							mkdirSync(canonicalDataRoot, { recursive: true, mode: 0o700 });
							storageLayoutReady = true;
							bootstrapFailureReason = null;
							return true;
						} catch {
							return false;
						}
					},
					{ kind: "filesystem", message: bootstrapFailureReason },
				);
				return;
			}
			try {
				completePendingProductResets(canonicalDataRoot, recoveryRoot);
			} catch (error) {
				await runRecoveryInterface(
					error instanceof Error ? error.message : "Product data reset could not be completed",
					() => false,
					{
						kind: "filesystem",
						message: error instanceof Error ? error.message : String(error),
					},
				);
				return;
			}
			const bootstrapHealth = inspectBootstrapHealth({
				dataDir: canonicalDataRoot,
				characterSeedRoot: characterSeedRoot(),
				defaultCharacterId: productConfig.defaultCharacterId,
			});
			if (bootstrapHealth.status === "fatal") {
				await runRecoveryInterface(
					bootstrapHealth.issue.message,
					() => false,
					bootstrapHealth.issue,
				);
				return;
			}
			updateService = new UpdateService({
				feedUrl: productConfig.updateFeedUrl ?? "",
				currentVersion: app.getVersion(),
				stagingDir: new RuntimeLayout(userData).systemUpdates,
				publisherPolicy: productConfig.updatePublisher,
			});
			if (!(await initializeHost()) || !hostRuntime) {
				await runRecoveryInterface(
					"Failed to initialize the local companion host runtime safely",
					initializeHost,
				);
				return;
			}
			// Idle update checks every 6h; the renderer can also trigger on
			// demand via the update.check RPC. No-op while the feed is empty.
			updateTimer = setInterval(() => {
				void updateService?.check().catch(() => {
					// The state machine carries the error; the timer keeps running.
				});
			}, UPDATE_CHECK_INTERVAL_MS);
			updateTimer.unref?.();
			createMainWindow();
		})
		.catch(async (error: unknown) => {
			try {
				await runRecoveryInterface(
					error instanceof Error ? error.message : "Desktop initialization failed safely",
					() => false,
				);
			} catch (recoveryError) {
				process.stderr.write(
					`native recovery interface unavailable: ${
						recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
					}\n`,
				);
				requestShutdown(1);
			}
		});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") requestShutdown(0);
	});
});
