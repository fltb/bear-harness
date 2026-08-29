import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import type { ProductConfig } from "@bear-harness/product-config";
import { RPC, type RpcEndpoint } from "@bear-harness/protocol/schema";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { expect } from "playwright/test";

export type ElectronApp = ElectronApplication;

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceE2EPiWorkerPath = realpathSync.native(
	fileURLToPath(new URL("../../../attachment-agent-e2e-worker.mjs", import.meta.url)),
);

interface SourceAppLaunchOptions {
	waitForWindow?: boolean;
	migrateLegacy?: boolean;
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
		...(options.migrateLegacy ? { BEAR_E2E_MIGRATE_LEGACY: "1" } : {}),
		...extraEnv,
	};
	const app = await electron.launch({
		args: ["dist/main/index.js"],
		cwd: desktopRoot,
		env,
		timeout: 60_000,
	});
	try {
		if (options.waitForWindow !== false) await app.firstWindow({ timeout: 45_000 });
		return { app, tempRoot };
	} catch (error) {
		await app.close().catch(() => {});
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
	const envelope = await window.evaluate(
		async ({ channel, params }) => window.bearDesktop.transport.invoke(channel, params),
		{ channel: endpoint.channel, params },
	);
	if (!envelope || typeof envelope !== "object" || !("ok" in envelope) || !envelope.ok) {
		throw new Error(`RPC failed: ${endpoint.channel}`);
	}
	return endpoint.response.parse("data" in envelope ? envelope.data : undefined);
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
	await invokeRpc(window, RPC.model.defaultsSetReply, {
		reply: { providerId: provider.id, modelId: model.id },
	});
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
	await window.reload();
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
	const activeConversationId = snapshot.conversation.activeConversationId;
	const sceneId =
		(activeConversationId
			? snapshot.characterRuntime.byConversation[activeConversationId]?.sceneId
			: undefined) ?? character.visual.defaultSceneId;
	const sceneLabel = character.scenes.find((scene) => scene.id === sceneId)?.label;
	if (!sceneLabel) throw new Error(`scene ${sceneId} unavailable in character snapshot`);

	await expect(window).toHaveTitle(zhCN.shell.productName);
	await expect(window.getByRole("heading", { level: 1 })).toHaveText(sceneLabel);
	await expect(window.getByText(character.name, { exact: true })).toBeVisible();
	await expect(window.getByText(character.character.subtitle, { exact: true })).toBeVisible();

	const composer = window.getByPlaceholder(character.character.composer_placeholder);
	await expect(composer).toBeVisible();
	await expect(composer).toBeEnabled();

	// Preload exposes only platform, diagnostics, attachments, and the schema-neutral transport.
	const bridge = await window.evaluate(() => {
		const keys = Object.keys(window.bearDesktop);
		const diagnosticsKeys = Object.keys(window.bearDesktop.diagnostics);
		const attachmentKeys = Object.keys(
			(
				window.bearDesktop as typeof window.bearDesktop & {
					attachments: Readonly<Record<string, unknown>>;
				}
			).attachments,
		);
		const transportKeys = Object.keys(window.bearDesktop.transport);
		return {
			keys,
			diagnosticsKeys,
			attachmentKeys,
			transportKeys,
			platform: window.bearDesktop.platform,
			reporterType: typeof window.bearDesktop.diagnostics.reportRendererFault,
		};
	});
	expect(bridge.keys).toEqual(["platform", "diagnostics", "attachments", "transport"]);
	expect(bridge.diagnosticsKeys).toEqual(["reportRendererFault"]);
	expect(bridge.attachmentKeys).toEqual(["pickFiles", "pickFolder", "importDroppedFiles"]);
	expect(bridge.transportKeys).toEqual(["listen", "invoke"]);
	expect(bridge.platform).toMatch(/^(darwin|win32|linux)$/);
	expect(bridge.reporterType).toBe("function");
}
