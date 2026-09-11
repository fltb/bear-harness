import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import type { ProductConfig } from "@bear-harness/product-config";
import { RPC, type RpcEndpoint } from "@bear-harness/protocol/schema";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { expect, test } from "playwright/test";

export type ElectronApp = ElectronApplication;

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceE2EPiWorkerPath = realpathSync.native(
	fileURLToPath(new URL("../../../pi-e2e-worker.mjs", import.meta.url)),
);

interface SourceAppLaunchOptions {
	waitForWindow?: boolean;
}

async function launchSourceAppFromRoot(
	tempRoot: string,
	extraEnv: Record<string, string>,
	options: SourceAppLaunchOptions,
) {
	const env = {
		...process.env,
		HOME: tempRoot,
		NODE_ENV: "test",
		BEAR_E2E_SOURCE: "1",
		BEAR_E2E_APP_DATA: tempRoot,
		BEAR_DIAGNOSTICS_ROOT: tempRoot,
		BEAR_E2E_PI_WORKER_PATH: sourceE2EPiWorkerPath,
		...extraEnv,
	};
	await test.info().attach("isolated-app-root", { body: tempRoot, contentType: "text/plain" });
	const app = await test.step("launch Electron process", () =>
		electron.launch({
			args: ["dist/main/index.js"],
			cwd: desktopRoot,
			env,
			timeout: 60_000,
		}));
	try {
		if (options.waitForWindow !== false) {
			await test.step("wait for first Electron window", () => app.firstWindow({ timeout: 45_000 }));
		}
		return { app, tempRoot };
	} catch (error) {
		await terminateSourceApp(app).catch(() => {});
		throw error;
	}
}

/**
 * Launch the source build against a fresh temp data dir.
 *
 * On macOS a first-from-cold Electron boot occasionally never completes its
 * app-ready handshake under fast repeated launches. A single bounded retry
 * with a fresh root keeps the ordinary source smoke deterministic.
 */
export async function launchSourceApp(extraEnv: Record<string, string> = {}) {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "bear-e2e-")));
		try {
			return await launchSourceAppFromRoot(tempRoot, extraEnv, {});
		} catch (error) {
			lastError = error;
			if (attempt < 2) rmSync(tempRoot, { recursive: true, force: true });
		}
	}
	throw lastError;
}

/**
 * Launch the real source Electron shell against a caller-populated appData
 * root. Unlike the fresh-root helper, this never retries or substitutes data:
 * upgrade and recovery tests must certify the exact bytes they prepared.
 */
export async function launchSourceAppAt(appDataRoot: string, options: SourceAppLaunchOptions = {}) {
	return launchSourceAppFromRoot(realpathSync(appDataRoot), {}, options);
}

/**
 * Force-terminate a source Electron process that is intentionally waiting in
 * native recovery UI. ElectronApplication.close() asks app.quit() to perform a
 * graceful shutdown, which cannot complete while that modal recovery action
 * is pending.
 */
export async function terminateSourceApp(app: ElectronApp): Promise<void> {
	const child = app.process();
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = app.waitForEvent("close", { timeout: 10_000 });
	child.kill("SIGKILL");
	await closed;
}

interface CharacterProjection {
	name: string;
	character: {
		subtitle: string;
		composer_placeholder: string;
	};
	scenes: Array<{ id: string; label: string }>;
	visual: { defaultSceneId: string };
}

export async function invokeRpc<Endpoint extends RpcEndpoint>(
	window: Page,
	endpoint: Endpoint,
	params: unknown,
) {
	return test.step(`RPC ${endpoint.channel}`, async () => {
		const envelope = await window.evaluate(
			async ({ channel, params }) => window.bearDesktop.transport.invoke(channel, params),
			{ channel: endpoint.channel, params },
		);
		if (!envelope || typeof envelope !== "object" || !("ok" in envelope) || !envelope.ok) {
			const error =
				envelope && typeof envelope === "object" && "error" in envelope
					? envelope.error
					: undefined;
			throw new Error(`RPC failed: ${endpoint.channel}: ${JSON.stringify(error)}`);
		}
		return endpoint.response.parse("data" in envelope ? envelope.data : undefined);
	});
}

export async function provisionReplyModel(window: Page) {
	const { providers } = await invokeRpc(window, RPC.provider.list, {});
	const provider = providers.find(
		(candidate) =>
			candidate.authMethods.some((method) => method.type === "api_key") &&
			candidate.availableModels.length > 0,
	);
	if (!provider) throw new Error("desktop E2E requires an API-key provider with a preset model");
	const model = provider.availableModels[0];
	if (!model) throw new Error("desktop E2E provider has no model");
	await invokeRpc(window, RPC.provider.setApiKey, {
		providerId: provider.id,
		apiKey: "desktop-e2e-key",
		sessionOnly: true,
	});
	await invokeRpc(window, RPC.model.enable, {
		providerId: provider.id,
		modelId: model.id,
		label: model.name,
	});
	await invokeRpc(window, RPC.systemOnboarding.completeModel, {
		reply: { providerId: provider.id, modelId: model.id },
		vision: { mode: "auto" },
		licensesAcknowledged: {
			bear: "GPL-3.0-only",
			...(process.platform === "win32" ? { gitForWindows: "GPL-2.0-only" } : {}),
		},
	});
	await invokeRpc(window, RPC.systemOnboarding.completeEmbedding, { choice: "none" });
	await invokeRpc(window, RPC.model.defaultsCompleteOnboarding, {});
	const snapshot = await invokeRpc(window, RPC.snapshot.get, {});
	const steps = snapshot.character?.character.first_meeting.steps ?? [];
	let onboarding = await invokeRpc(window, RPC.onboarding.get, {});
	while (onboarding.status === "active") {
		const step = steps.find((candidate) => candidate.id === onboarding.currentStepId);
		if (!step)
			throw new Error(`desktop E2E cannot resolve onboarding step ${onboarding.currentStepId}`);
		const answer =
			step.kind === "text"
				? "E2E User"
				: step.kind === "choice"
					? step.choices[0]?.value
					: undefined;
		onboarding = await invokeRpc(window, RPC.onboarding.submit, {
			stepId: step.id,
			...(answer ? { answer } : {}),
		});
	}
	const conversation = await invokeRpc(window, RPC.conversation.create, {});
	await invokeRpc(window, RPC.model.routeSet, {
		conversationId: conversation.conversationId,
		selected: { providerId: provider.id, modelId: model.id },
	});
	await window.reload();
}

export async function acknowledgeOpenSourceLicenses(window: Page) {
	const dialog = window.getByRole("dialog", { name: zhCN.licenseNotice.dialogLabel });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("heading", { name: zhCN.licenseNotice.bearTitle })).toBeVisible();
	const gitHeading = dialog.getByRole("heading", { name: zhCN.licenseNotice.gitTitle });
	if (process.platform === "win32") await expect(gitHeading).toBeVisible();
	else await expect(gitHeading).toHaveCount(0);
	const continueButton = dialog.getByRole("button", { name: zhCN.licenseNotice.continue });
	await expect(continueButton).toBeDisabled();
	const confirmationLabel =
		process.platform === "win32"
			? zhCN.licenseNotice.confirmWindows
			: zhCN.licenseNotice.confirmBear;
	const confirmation = dialog.getByRole("checkbox", { name: confirmationLabel });
	await dialog.getByText(confirmationLabel, { exact: true }).click();
	await expect(confirmation).toBeChecked();
	await expect(continueButton).toBeEnabled();
	await continueButton.click();
	await expect(dialog).toBeHidden();
}

/**
 * Shared packaged/source UI assertions. Renderer shell identity comes from the
 * canonical product locale; character identity and copy are read through the
 * real preload snapshot, never duplicated in product configuration or test.
 */
export async function assertProductWindow(
	electronApp: ElectronApp,
	product: Readonly<ProductConfig>,
) {
	const window = await electronApp.firstWindow();
	await assertProductPage(window, product);
	return window;
}

export async function assertProductPage(window: Page, _product: Readonly<ProductConfig>) {
	await window.waitForLoadState("domcontentloaded");
	const snapshot = await invokeRpc(window, RPC.snapshot.get, {});
	const character = snapshot.character as CharacterProjection | undefined;
	if (!character) throw new Error("character snapshot unavailable");
	const sceneId = character.visual.defaultSceneId;
	const sceneLabel = character.scenes.find((scene) => scene.id === sceneId)?.label;
	if (!sceneLabel) throw new Error(`scene ${sceneId} unavailable in character snapshot`);

	await expect(window).toHaveTitle(zhCN.shell.productName);
	await expect(window.getByRole("heading", { level: 1 })).toHaveText(sceneLabel);
	await expect(window.getByText(character.name, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.subtitle, { exact: true })).toBeVisible();

	const composer = window.getByPlaceholder(character.character.composer_placeholder);
	await expect(composer).toBeVisible();
	await expect(composer).toBeEnabled();

	// The picker only reveals paths explicitly selected by the user; files remain in place.
	const bridge = await window.evaluate(() => {
		const keys = Object.keys(window.bearDesktop);
		const diagnosticsKeys = Object.keys(window.bearDesktop.diagnostics);
		const localFileKeys = Object.keys(
			(
				window.bearDesktop as typeof window.bearDesktop & {
					localFiles: Readonly<Record<string, unknown>>;
				}
			).localFiles,
		);
		const transportKeys = Object.keys(window.bearDesktop.transport);
		return {
			keys,
			diagnosticsKeys,
			localFileKeys,
			transportKeys,
			platform: window.bearDesktop.platform,
			reporterType: typeof window.bearDesktop.diagnostics.reportRendererFault,
		};
	});
	expect(bridge.keys).toEqual(["platform", "diagnostics", "localFiles", "transport"]);
	expect(bridge.diagnosticsKeys).toEqual(["reportRendererFault"]);
	expect(bridge.localFileKeys).toEqual(["pickFiles", "pickFolder", "pathsForDroppedFiles"]);
	expect(bridge.transportKeys).toEqual(["listenInvalidations", "subscribeLive", "invoke"]);
	expect(bridge.platform).toMatch(/^(darwin|win32|linux)$/);
	expect(bridge.reporterType).toBe("function");
}
