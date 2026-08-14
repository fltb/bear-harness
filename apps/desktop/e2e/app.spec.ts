import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { expect, test } from "playwright/test";
import { productConfig } from "../product.config";
import { assertProductWindow } from "./helpers";

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
		const window = await assertProductWindow(electronApp, productConfig);

		// The page must come from the built file: HTML, not the dev server.
		const pageUrl = window.url();
		expect(pageUrl.startsWith("file://")).toBe(true);

		// Persistent userData keeps the fork-isolated directory name; the
		// diagnostics root for this run is the test temp dir.
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
		await expect(window.locator(".scene-backdrop img")).toHaveAttribute(
			"src",
			/^data:image\/svg\+xml;base64,/,
		);
		await expect(window.locator(".presence-stage img")).toHaveAttribute(
			"src",
			/^data:image\/svg\+xml;base64,/,
		);
	} finally {
		await electronApp.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
