import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { expect, test } from "playwright/test";
import { productConfig } from "../product.config";
import { assertProductWindow } from "./helpers";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

test("source build loads from file:// with official identity and isolated diagnostics", async () => {
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "bear-e2e-app-")));
	const electronApp = await electron.launch({
		args: ["dist/main/index.js"],
		cwd: desktopRoot,
		env: {
			...process.env,
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

		// Role-content navigation still switches the scene (official copy).
		await window.getByRole("button", { name: /旧站留下的记录/ }).click();
		await expect(window.getByRole("heading", { level: 1 })).toHaveText(
			productConfig.defaultCharacter.oldStationTitle,
		);
		await expect(window.getByText(productConfig.defaultCharacter.oldStationGreeting)).toBeVisible();
	} finally {
		await electronApp.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
