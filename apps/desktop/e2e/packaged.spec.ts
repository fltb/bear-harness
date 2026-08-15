import { productConfig } from "@bear-harness/product-config";
import { _electron as electron } from "playwright";
import { expect, test } from "playwright/test";
import { assertProductWindow } from "./helpers";

/**
 * Packaged-app smoke: launches the real installed binary (located by
 * resolve-packaged-binary.mjs, which sets BEAR_PACKAGED_BINARY) and verifies
 * the configured identity end to end. Never collected by the default
 * testMatch — opt-in via `npm run test:e2e:packaged`.
 */
test("packaged app shows the configured product", async () => {
	const binary = process.env.BEAR_PACKAGED_BINARY;
	expect(binary, "BEAR_PACKAGED_BINARY must point at the unpacked app binary").toBeTruthy();

	const electronApp = await electron.launch({ executablePath: binary as string });
	try {
		const window = await assertProductWindow(electronApp, productConfig);

		// Packaged app must load from the asar's file: HTML, never a server.
		expect(window.url().startsWith("file://")).toBe(true);
		const userData = await electronApp.evaluate(({ app }) => app.getPath("userData"));
		expect(userData.endsWith(productConfig.dataDirectoryName)).toBe(true);
	} finally {
		await electronApp.close();
	}
});
