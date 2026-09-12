import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

for (const width of [390, 854, 1280, 1920]) {
	test(`scene-facing design remains readable and separated at ${width}px`, async ({
		page,
	}, info) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width, height: 900 });
		await ensureReadyForConversation(page);
		await sendMessage(page, "你好");
		const thread = page.getByRole("region", { name: zhCN.messages.conversation });
		await expect(thread).toBeVisible();
		await expect
			.poll(() => thread.getByRole("article", { name: "极昼", exact: true }).count())
			.toBeGreaterThan(0);
		await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeHidden();
		const surface = await thread.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				background: style.backgroundColor,
				blur: style.backdropFilter,
				border: style.borderTopWidth,
				// test-quality-allow querySelector: inspect the shared typography recipe inside this reading plane.
				font: getComputedStyle(element.querySelector(".message-content")!).fontFamily,
			};
		});
		expect(surface.background).not.toBe("rgba(0, 0, 0, 0)");
		expect(surface.blur).toBe("blur(18px)");
		expect(surface.border).toBe("1px");
		expect(surface.font).not.toContain("Songti");
		// test-quality-allow locator: stage and header are the product's CSS layout contracts.
		const stage = page.locator(".presence-stage");
		await expect(stage).toBeVisible();
		// test-quality-allow locator: desktop hides duplicate scene labels; mobile retains them.
		const title = page.locator(".thread-head .scene-title");
		if (width > 767) {
			// test-quality-allow locator: validate the full-width tab and its sole scroll container.
			const navigation = page.locator(".nav-list");
			const navGeometry = await navigation.evaluate((element) => ({
				xOverflow: element.scrollWidth - element.clientWidth,
				yOverflow: element.scrollHeight - element.clientHeight,
			}));
			expect(navGeometry.xOverflow).toBeLessThanOrEqual(1);
			expect(navGeometry.yOverflow).toBeLessThanOrEqual(1);
			// test-quality-allow locator: active tab width must not be reduced by invisible action buttons.
			const navTab = page.locator('.nav-item[aria-current="page"]');
			const navBox = await navTab.boundingBox();
			const listBox = await navigation.boundingBox();
			expect(navBox!.width).toBeGreaterThan(listBox!.width - 30);
			await expect(title).toBeHidden();
			const readingBox = await thread.boundingBox();
			const stageBox = await stage.boundingBox();
			expect(stageBox!.x).toBeGreaterThanOrEqual(readingBox!.x + readingBox!.width - 1);
		} else {
			await expect(title).toBeVisible();
		}
		expect(
			await page.evaluate(() => document.body.scrollWidth - window.innerWidth),
		).toBeLessThanOrEqual(1);
		await page.screenshot({ path: info.outputPath(`conversation-${width}.png`) });
	});
}
