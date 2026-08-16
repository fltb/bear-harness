import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { productConfig } from "@bear-harness/product-config";
import { _electron as electron } from "playwright";
import { expect, test } from "playwright/test";
import { assertProductWindow, provisionReplyModel } from "./helpers";

/**
 * Packaged-app smoke: launches the real installed binary (located by
 * resolve-packaged-binary.mjs, which sets BEAR_PACKAGED_BINARY) and verifies
 * the configured identity end to end. Never collected by the default
 * testMatch — opt-in via `npm run test:e2e:packaged`.
 */
test("packaged app shows the configured product", async () => {
	const binary = process.env.BEAR_PACKAGED_BINARY;
	expect(binary, "BEAR_PACKAGED_BINARY must point at the unpacked app binary").toBeTruthy();
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "bear-e2e-packaged-")));

	const electronApp = await electron.launch({
		executablePath: binary as string,
		args: [`--user-data-dir=${join(tempRoot, productConfig.dataDirectoryName)}`],
		env: { ...process.env, HOME: tempRoot, BEAR_DIAGNOSTICS_ROOT: tempRoot },
	});
	try {
		const setupWindow = await electronApp.firstWindow();
		await expect(
			setupWindow.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).toBeVisible();
		await provisionReplyModel(setupWindow);
		const window = await assertProductWindow(electronApp, productConfig);

		// Packaged app must load from the asar's file: HTML, never a server.
		expect(window.url().startsWith("file://")).toBe(true);
		const userData = await electronApp.evaluate(({ app }) => app.getPath("userData"));
		expect(userData.startsWith(tempRoot)).toBe(true);
		expect(userData.endsWith(productConfig.dataDirectoryName)).toBe(true);
	} finally {
		await electronApp.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
