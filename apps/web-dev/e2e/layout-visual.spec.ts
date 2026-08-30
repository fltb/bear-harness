import { mkdir } from "node:fs/promises";
import path from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

const screenshotDir = path.resolve(
	import.meta.dirname,
	"../../../artifacts/ux-coverage-2026-08-28",
);

const viewports = [
	{ mode: "mobile", width: 390, height: 844 },
	{ mode: "window", width: 1280, height: 800 },
	{ mode: "fullscreen", width: 1920, height: 1080 },
] as const;

test("canonical layouts and management surfaces stay usable", async ({ page }) => {
	test.setTimeout(60_000);
	await mkdir(screenshotDir, { recursive: true });
	await page.setViewportSize(viewports[1]);
	await ensureReadyForConversation(page);

	for (const viewport of viewports) {
		await page.setViewportSize(viewport);
		const application = page.getByRole("application", {
			name: zhCN.shell.productName,
		});
		await expect(application).toHaveAttribute("data-layout", viewport.mode);

		const thread = page.getByRole("region", {
			name: zhCN.messages.conversation,
		});
		const composer = page.getByRole("form", {
			name: zhCN.composer.messageInputLabel,
		});
		const threadBox = await thread.boundingBox();
		const composerBox = await composer.boundingBox();
		expect(threadBox).not.toBeNull();
		expect(composerBox).not.toBeNull();
		expect((threadBox?.y ?? 0) + (threadBox?.height ?? 0)).toBeLessThanOrEqual(composerBox?.y ?? 0);
		expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
		expect(Math.abs((threadBox?.x ?? 0) - (composerBox?.x ?? 0))).toBeLessThanOrEqual(1);
		expect(Math.abs((threadBox?.width ?? 0) - (composerBox?.width ?? 0))).toBeLessThanOrEqual(1);
		const [applicationOverflow, threadOverflow] = await Promise.all([
			application.evaluate((element) => element.scrollWidth - element.clientWidth),
			thread.evaluate((element) => element.scrollWidth - element.clientWidth),
		]);
		expect(applicationOverflow).toBeLessThanOrEqual(1);
		expect(threadOverflow).toBeLessThanOrEqual(1);

		const navigation = page.getByRole("navigation", {
			name: zhCN.sidebar.conversations,
		});
		await expect(application).toHaveScreenshot(`layout-${viewport.mode}.png`);
		await application.screenshot({
			path: path.join(screenshotDir, `23-layout-${viewport.mode}.png`),
		});

		await page.getByRole("button", { name: new RegExp(zhCN.threadHead.runningWork) }).click();
		const workMenu = page.getByRole("menu", {
			name: zhCN.threadHead.runningWork,
		});
		await expect(workMenu).toBeVisible();
		await expect(workMenu.getByText(zhCN.threadHead.noRunningWork)).toBeVisible();
		const menuBox = await workMenu.boundingBox();
		expect(menuBox).not.toBeNull();
		expect(menuBox?.x).toBeGreaterThanOrEqual(0);
		expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
		await application.screenshot({
			path: path.join(screenshotDir, `26-work-menu-${viewport.mode}.png`),
		});
		await page.keyboard.press("Escape");
		await expect(workMenu).toBeHidden();

		if (viewport.mode === "mobile") {
			for (const target of [
				page.getByRole("button", {
					name: zhCN.sidebar.conversations,
					exact: true,
				}),
				page.getByRole("button", { name: zhCN.composer.attachLabel }),
				page.getByRole("button", { name: zhCN.composer.sendLabel }),
			]) {
				const box = await target.boundingBox();
				expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
			}
			const closedBox = await navigation.boundingBox();
			expect(closedBox?.x).toBeLessThan(0);
			await page.getByRole("button", { name: zhCN.sidebar.conversations, exact: true }).click();
			await expect
				.poll(async () => (await navigation.boundingBox())?.x ?? -999)
				.toBeGreaterThanOrEqual(-1);
			await expect(navigation.getByText("Ctrl", { exact: true })).toBeHidden();
		}
		const [searchBox, newConversationBox] = await Promise.all([
			page.getByTestId("sidebar-search-control").boundingBox(),
			page
				.getByRole("button", {
					name: zhCN.sidebar.newConversation,
					exact: true,
				})
				.boundingBox(),
		]);
		expect(searchBox).not.toBeNull();
		expect(newConversationBox).not.toBeNull();
		expect(Math.abs((searchBox?.y ?? 0) - (newConversationBox?.y ?? 0))).toBeLessThanOrEqual(1);
		expect(
			Math.abs((searchBox?.height ?? 0) - (newConversationBox?.height ?? 0)),
		).toBeLessThanOrEqual(1);

		await page.getByRole("button", { name: zhCN.sidebar.systemSettings }).click();
		const dialog = page.getByRole("dialog", {
			name: zhCN.sidebar.systemSettings,
		});
		await expect(dialog).toBeVisible();
		const dialogBox = await dialog.boundingBox();
		expect(dialogBox).not.toBeNull();
		expect(dialogBox?.x).toBeGreaterThanOrEqual(0);
		expect(dialogBox?.y).toBeGreaterThanOrEqual(0);
		expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
		expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
		await expect(
			dialog.getByRole("navigation", { name: zhCN.sidebar.systemSettings }),
		).toBeVisible();
		if (viewport.mode === "mobile") {
			await expect(
				dialog.getByRole("button", {
					name: new RegExp(`^${zhCN.sidebar.systemSettings}`),
				}),
			).toBeVisible();
			await expect(dialog.getByRole("button", { name: zhCN.settings.language })).toBeHidden();
		} else {
			await expect(
				dialog.getByRole("button", {
					name: new RegExp(`^${zhCN.sidebar.systemSettings}`),
				}),
			).toBeHidden();
			await expect(dialog.getByRole("button", { name: zhCN.settings.language })).toBeVisible();
		}
		await page.evaluate(() => window.scrollTo(0, 0));
		if (viewport.mode === "mobile") {
			await expect(page).toHaveScreenshot(`system-settings-${viewport.mode}.png`);
			await page.screenshot({
				path: path.join(screenshotDir, `24-system-settings-${viewport.mode}.png`),
			});
		} else {
			await expect(dialog).toHaveScreenshot(`system-settings-${viewport.mode}.png`);
			await dialog.screenshot({
				path: path.join(screenshotDir, `24-system-settings-${viewport.mode}.png`),
			});
		}

		if (viewport.mode === "mobile") {
			await dialog
				.getByRole("button", {
					name: new RegExp(`^${zhCN.sidebar.systemSettings}`),
				})
				.click();
			await page.getByRole("option", { name: zhCN.sidebar.archivedConversations }).click();
		} else {
			await dialog.getByRole("button", { name: zhCN.sidebar.archivedConversations }).click();
		}
		await expect(
			dialog.getByRole("heading", { name: zhCN.sidebar.archivedConversations }),
		).toBeVisible();
		if (viewport.mode === "mobile") {
			await page.screenshot({
				path: path.join(screenshotDir, `24-archived-conversations-${viewport.mode}.png`),
			});
		} else {
			await dialog.screenshot({
				path: path.join(screenshotDir, `24-archived-conversations-${viewport.mode}.png`),
			});
		}

		if (viewport.mode === "mobile") {
			await dialog
				.getByRole("button", {
					name: new RegExp(`^${zhCN.sidebar.systemSettings}`),
				})
				.click();
			await page.getByRole("option", { name: zhCN.settings.networkSection }).click();
		} else {
			await dialog.getByRole("button", { name: zhCN.settings.networkSection }).click();
		}
		const proxyTrigger = dialog.getByRole("button", {
			name: zhCN.settings.proxyMode,
		});
		await proxyTrigger.click();
		const proxyOptions = page.getByRole("listbox", {
			name: zhCN.settings.proxyMode,
		});
		await expect(proxyOptions).toBeVisible();
		const optionsBox = await proxyOptions.boundingBox();
		expect(optionsBox).not.toBeNull();
		expect(optionsBox?.x).toBeGreaterThanOrEqual(0);
		expect(optionsBox?.y).toBeGreaterThanOrEqual(0);
		expect((optionsBox?.x ?? 0) + (optionsBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
		expect((optionsBox?.y ?? 0) + (optionsBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		await page.evaluate(() => window.scrollTo(0, 0));
		if (viewport.mode === "mobile") {
			await expect(page).toHaveScreenshot(`network-memory-settings-${viewport.mode}.png`);
			await page.screenshot({
				path: path.join(screenshotDir, `25-network-memory-${viewport.mode}.png`),
			});
		} else {
			await expect(dialog).toHaveScreenshot(`network-memory-settings-${viewport.mode}.png`);
			await dialog.screenshot({
				path: path.join(screenshotDir, `25-network-memory-${viewport.mode}.png`),
			});
		}
		await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
		await expect(dialog).toBeHidden();
	}
});
