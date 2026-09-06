import { existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { productConfig } from "@bear-harness/product-config";
import { expect, test } from "playwright/test";
import { assertProductWindow, launchSourceApp, provisionReplyModel } from "./helpers";

const _desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const _electronExecutable = require("electron") as string;

test("source build loads from file:// with official identity and isolated diagnostics", async () => {
	const testInfo = test.info();
	const { app: electronApp, tempRoot } = await test.step("launch source Electron", () =>
		launchSourceApp({}));
	try {
		await electronApp
			.context()
			.tracing.start({ screenshots: true, snapshots: true, sources: true });
		const setupWindow = await electronApp.firstWindow();
		expect(
			await electronApp.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().some((candidate) => candidate.isFocused()),
			),
		).toBe(false);
		await expect(
			setupWindow.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel }),
		).toBeVisible();
		await test.step("complete both onboarding layers and create a conversation", () =>
			provisionReplyModel(setupWindow));
		const window = await test.step("assert product identity and native bridge controls", () =>
			assertProductWindow(electronApp, productConfig));

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
		try {
			const logsDir = join(tempRoot, "logs");
			if (existsSync(logsDir)) {
				for (const name of readdirSync(logsDir)
					.filter((name) => name.endsWith(".jsonl"))
					.sort()) {
					await testInfo.attach(`diagnostics-${name}`, {
						path: join(logsDir, name),
						contentType: "application/x-ndjson",
					});
				}
			}
			const tracePath = testInfo.outputPath("electron-trace.zip");
			await electronApp.context().tracing.stop({ path: tracePath });
			await testInfo.attach("electron-trace", { path: tracePath, contentType: "application/zip" });
		} finally {
			await test.step("close source Electron", () => electronApp.close());
			if (testInfo.status === testInfo.expectedStatus) {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		}
	}
});
