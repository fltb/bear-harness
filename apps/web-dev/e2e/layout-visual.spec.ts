import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

const viewports = [
	{ mode: "mobile", width: 390, height: 844 },
	{ mode: "window", width: 1280, height: 800 },
	{ mode: "fullscreen", width: 1920, height: 1080 },
] as const;

test("canonical layouts and management surfaces stay usable", async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize(viewports[1]);
	await ensureReadyForConversation(page);

	for (const viewport of viewports) {
		await page.setViewportSize(viewport);
		const application = page.getByRole("application", { name: zhCN.shell.productName });
		await expect(application).toHaveAttribute("data-layout", viewport.mode);

		const thread = page.getByRole("region", { name: zhCN.messages.conversation });
		const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
		const threadBox = await thread.boundingBox();
		const composerBox = await composer.boundingBox();
		expect(threadBox).not.toBeNull();
		expect(composerBox).not.toBeNull();
		expect((threadBox?.y ?? 0) + (threadBox?.height ?? 0)).toBeLessThanOrEqual(composerBox?.y ?? 0);
		expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);

		const navigation = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
		await expect(application).toHaveScreenshot(`layout-${viewport.mode}.png`);
		if (viewport.mode === "mobile") {
			const closedBox = await navigation.boundingBox();
			expect(closedBox?.x).toBeLessThan(0);
			await page.getByRole("button", { name: zhCN.sidebar.conversations, exact: true }).click();
			await expect
				.poll(async () => (await navigation.boundingBox())?.x ?? -999)
				.toBeGreaterThanOrEqual(-1);
		}

		await page.getByRole("button", { name: zhCN.sidebar.systemSettings }).click();
		const dialog = page.getByRole("dialog", { name: zhCN.sidebar.systemSettings });
		await expect(dialog).toBeVisible();
		const dialogBox = await dialog.boundingBox();
		expect(dialogBox).not.toBeNull();
		expect(dialogBox?.x).toBeGreaterThanOrEqual(0);
		expect(dialogBox?.y).toBeGreaterThanOrEqual(0);
		expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
		expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
		if (viewport.mode === "mobile") {
			await expect(dialog).toHaveScreenshot("system-settings-mobile.png");
		}
		await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
		await expect(dialog).toBeHidden();
	}
});
