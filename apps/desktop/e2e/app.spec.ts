import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { productConfig } from "@bear-harness/product-config";
import { _electron as electron } from "playwright";
import { expect, test } from "playwright/test";
import { assertProductWindow, provisionReplyModel } from "./helpers";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;

test("source build loads from file:// with official identity and isolated diagnostics", async () => {
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "bear-e2e-app-")));
	const electronApp = await electron.launch({
		executablePath: electronExecutable,
		args: ["dist/main/index.js"],
		cwd: desktopRoot,
		env: {
			...process.env,
			HOME: tempRoot,
			NODE_ENV: "test",
			BEAR_E2E_SOURCE: "1",
			BEAR_DIAGNOSTICS_ROOT: tempRoot,
		},
	});
	try {
		const setupWindow = await electronApp.firstWindow();
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
		await expect(sceneAsset).toHaveAttribute("src", /^data:image\/png;base64,/);
		await expect
			.poll(() => sceneAsset.evaluate((image: HTMLImageElement) => image.naturalWidth))
			.toBeGreaterThan(0);
		const presence = window.getByRole("img", { name: "极昼在" });
		await expect(presence).toBeVisible();
		const presenceAsset = presence.getByTestId("presence-asset");
		await expect(presenceAsset).toHaveAttribute("src", /^data:image\/(?:png|svg\+xml);base64,/);
		await expect
			.poll(() => presenceAsset.evaluate((image: HTMLImageElement) => image.naturalWidth))
			.toBeGreaterThan(0);
	} finally {
		await electronApp.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
