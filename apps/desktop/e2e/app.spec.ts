import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { productConfig } from "@bear-harness/product-config";
import { RPC } from "@bear-harness/protocol/schema";
import { expect, test } from "playwright/test";
import {
	assertProductWindow,
	invokeRpc,
	launchSourceApp,
	launchSourceAppAt,
	provisionReplyModel,
	terminateSourceApp,
} from "./helpers";
import {
	createLegacyUpgradeFixture,
	LEGACY_UPGRADE,
	snapshotTreeBytes,
	validateCanonicalCriticalFiles,
} from "./legacy-upgrade.fixture";

const _desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const _electronExecutable = require("electron") as string;

test("source build loads from file:// with official identity and isolated diagnostics", async () => {
	const { app: electronApp, tempRoot } = await launchSourceApp({});
	try {
		const setupWindow = await electronApp.firstWindow();
		expect(
			await electronApp.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().some((candidate) => candidate.isFocused()),
			),
		).toBe(false);
		await expect(
			setupWindow.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).toBeVisible();
		await provisionReplyModel(setupWindow);
		const window = await assertProductWindow(electronApp, productConfig);

		// The page must come from the built file: HTML, not the dev server.
		const pageUrl = window.url();
		expect(pageUrl.startsWith("file://")).toBe(true);

		// Persistent userData keeps the product directory name; the diagnostics
		// root for this run is the test temp dir.
		const paths = await electronApp.evaluate(({ app }) => ({
			userData: app.getPath("userData"),
			logs: app.getPath("logs"),
			crashDumps: app.getPath("crashDumps"),
		}));
		expect(paths.userData.endsWith(productConfig.dataDirectoryName)).toBe(true);
		expect(paths.logs.startsWith(tempRoot)).toBe(true);
		expect(paths.crashDumps.startsWith(join(tempRoot, "crashes"))).toBe(true);
		const launchDir = paths.crashDumps.split(/[\\/]/).pop();
		expect(launchDir).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

		// The Host exposes package assets as data URLs and the renderer composes
		// them through generic scene/presence components.
		const sceneAsset = window.getByRole("img", { name: "极光书房" });
		await expect(sceneAsset).toBeVisible();
		const sceneImage = window.getByTestId("scene-asset");
		await expect(sceneImage).toHaveAttribute("src", /^data:image\/png;base64,/);
		await expect
			.poll(() => sceneImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
			.toBeGreaterThan(0);
		const presenceAsset = window.getByTestId("presence-asset");
		await expect(presenceAsset).toBeVisible();
		await expect(presenceAsset).toHaveAttribute("src", /^data:image\/(?:png|svg\+xml);base64,/);
		await expect
			.poll(() => presenceAsset.evaluate((image: HTMLImageElement) => image.naturalWidth))
			.toBeGreaterThan(0);
	} finally {
		await electronApp.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("real source Electron upgrades the complete legacy data root without touching its backup", async () => {
	test.setTimeout(180_000);
	const appDataRoot = realpathSync(mkdtempSync(join(tmpdir(), "bear-legacy-upgrade-e2e-")));
	const fixture = await createLegacyUpgradeFixture(appDataRoot);
	const { app: electronApp } = await launchSourceAppAt(appDataRoot, { migrateLegacy: true });
	let closed = false;
	try {
		const window = await electronApp.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		await expect(window.getByRole("application", { name: zhCN.shell.productName })).toBeVisible();
		await expect(window).toHaveTitle(zhCN.shell.productName);
		expect(window.url().startsWith("file://")).toBe(true);

		const userData = await electronApp.evaluate(({ app }) => app.getPath("userData"));
		expect(userData).toBe(fixture.canonicalRoot);

		const snapshot = await invokeRpc(window, RPC.snapshot.get, {});
		expect(snapshot.character?.name).toBe("极昼");
		expect(snapshot.conversation?.id).toBe(LEGACY_UPGRADE.conversationId);

		const conversations = await invokeRpc(window, RPC.conversation.list, {});
		expect(conversations.conversations).toContainEqual(
			expect.objectContaining({
				id: LEGACY_UPGRADE.conversationId,
				title: LEGACY_UPGRADE.conversationTitle,
			}),
		);
		const active = await invokeRpc(window, RPC.conversation.activeGet, {});
		expect(active.conversation?.piTimeline.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					text: LEGACY_UPGRADE.conversationUserText,
				}),
				expect.objectContaining({
					role: "assistant",
					text: LEGACY_UPGRADE.conversationAssistantText,
				}),
			]),
		);

		const attachments = await invokeRpc(window, RPC.conversationAttachment.list, {
			conversationId: LEGACY_UPGRADE.conversationId,
		});
		expect(attachments.attachments).toContainEqual(
			expect.objectContaining({
				id: LEGACY_UPGRADE.attachmentId,
				name: LEGACY_UPGRADE.attachmentName,
			}),
		);
		const attachment = await invokeRpc(window, RPC.conversationAttachment.read, {
			mode: "semantic",
			conversationId: LEGACY_UPGRADE.conversationId,
			attachmentId: LEGACY_UPGRADE.attachmentId,
			relativePath: LEGACY_UPGRADE.attachmentName,
		});
		expect(attachment.mode).toBe("semantic");
		if (attachment.mode !== "semantic") throw new Error("legacy attachment read changed mode");
		expect(attachment.content).toBe(LEGACY_UPGRADE.attachmentText);

		const providers = await invokeRpc(window, RPC.provider.list, {});
		expect(providers.providers).toContainEqual(
			expect.objectContaining({
				id: LEGACY_UPGRADE.providerId,
				source: "custom",
				added: true,
				credentialStatus: "missing",
				availableModels: [
					expect.objectContaining({
						id: LEGACY_UPGRADE.modelId,
						name: LEGACY_UPGRADE.modelLabel,
					}),
				],
			}),
		);
		const models = await invokeRpc(window, RPC.model.poolGet, {});
		expect(models.models).toContainEqual(
			expect.objectContaining({
				providerId: LEGACY_UPGRADE.providerId,
				modelId: LEGACY_UPGRADE.modelId,
				label: LEGACY_UPGRADE.modelLabel,
			}),
		);

		const memory = await invokeRpc(window, RPC.memory.candidatesList, {
			characterId: LEGACY_UPGRADE.characterId,
			status: "pending",
		});
		expect(memory.candidates).toContainEqual(
			expect.objectContaining({
				id: LEGACY_UPGRADE.memoryCandidateId,
				normalizedText: LEGACY_UPGRADE.memoryText,
			}),
		);
		const audit = await invokeRpc(window, RPC.audit.list, {});
		expect(audit.entries).toContainEqual(
			expect.objectContaining({
				action: LEGACY_UPGRADE.auditAction,
				detail: LEGACY_UPGRADE.auditDetail,
			}),
		);
		const auditExport = await invokeRpc(window, RPC.audit.export, {});
		expect(auditExport.verified).toBe(true);
		expect(auditExport.lines).toContain(LEGACY_UPGRADE.auditAction);

		await expect(window.getByText(LEGACY_UPGRADE.conversationTitle, { exact: true })).toBeVisible();
		await expect(
			window.locator(`[data-attachment-id="${LEGACY_UPGRADE.attachmentId}"]`),
		).toContainText(LEGACY_UPGRADE.attachmentName);

		expect(snapshotTreeBytes(fixture.legacyRoot)).toEqual(fixture.legacyBeforeLaunch);
		await electronApp.close();
		closed = true;
		expect(snapshotTreeBytes(fixture.legacyRoot)).toEqual(fixture.legacyBeforeLaunch);
		validateCanonicalCriticalFiles(fixture);
	} finally {
		if (!closed) await electronApp.close().catch(() => undefined);
		rmSync(appDataRoot, { recursive: true, force: true });
	}
});

test("real source Electron opens recovery when legacy and canonical roots are ambiguous", async () => {
	test.setTimeout(90_000);
	const appDataRoot = realpathSync(mkdtempSync(join(tmpdir(), "bear-ambiguous-roots-e2e-")));
	const fixture = await createLegacyUpgradeFixture(appDataRoot, { ambiguousBothRoots: true });
	if (!fixture.canonicalBeforeLaunch)
		throw new Error("ambiguous fixture did not create canonical root");
	const { app: electronApp } = await launchSourceAppAt(appDataRoot, {
		migrateLegacy: true,
		waitForWindow: false,
	});
	let terminated = false;
	try {
		const incidentPath = join(
			appDataRoot,
			".bear-harness-recovery-state",
			"data-root-migration.json",
		);
		await expect.poll(() => existsSync(incidentPath), { timeout: 30_000 }).toBe(true);
		const incident = JSON.parse(readFileSync(incidentPath, "utf8")) as {
			kind?: string;
			status?: string;
			reason?: string;
		};
		expect(incident).toMatchObject({
			kind: "root_migration",
			status: "pending",
		});
		expect(incident.reason).toContain("Both legacy and canonical data roots exist");

		// Persisting the incident is the fail-closed completion signal. Startup
		// is now intentionally blocked in native recovery UI, so it will never
		// create a renderer window unless an operator completes recovery.
		expect(electronApp.windows()).toHaveLength(0);
		await terminateSourceApp(electronApp);
		terminated = true;
		expect(snapshotTreeBytes(fixture.legacyRoot)).toEqual(fixture.legacyBeforeLaunch);
		expect(snapshotTreeBytes(fixture.canonicalRoot)).toEqual(fixture.canonicalBeforeLaunch);
	} finally {
		if (!terminated) await terminateSourceApp(electronApp).catch(() => undefined);
		rmSync(appDataRoot, { recursive: true, force: true });
	}
});
