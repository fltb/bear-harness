import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

test("mobile composer, live announcements, touch targets and detached scrolling stay usable", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await ensureReadyForConversation(page);

	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	const longMessage = Array.from({ length: 28 }, (_, index) => `第 ${index + 1} 行`).join("\n");
	await composer.fill(`${longMessage}\nSTREAM_HOLD_A`);
	const expandedComposer = await composer.evaluate((element) => ({
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
		overflowY: getComputedStyle(element).overflowY,
	}));
	expect(expandedComposer.clientHeight).toBeGreaterThan(44);
	expect(expandedComposer.clientHeight).toBeLessThanOrEqual(170);
	expect(expandedComposer.scrollHeight).toBeGreaterThan(expandedComposer.clientHeight);
	expect(expandedComposer.overflowY).toBe("auto");

	await page.getByRole("button", { name: zhCN.composer.sendLabel }).click();
	await expect(composer).toHaveValue("");
	await expect
		.poll(() => composer.evaluate((element) => element.clientHeight))
		.toBeLessThanOrEqual(52);

	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await expect(thread).not.toHaveAttribute("aria-live", "polite");
	const announcement = page.getByTestId("conversation-announcement");
	await expect(announcement).toHaveText(zhCN.messages.responding);
	await expect(page.getByTestId("streaming-assistant-message")).toContainText("HOLD_ONE");
	await expect(page.getByTestId("pending-user-message")).toHaveCount(0);
	await expect
		.poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight))
		.toBe(true);

	await thread.evaluate((element) => {
		element.scrollTop = 0;
		element.dispatchEvent(new WheelEvent("wheel"));
	});
	const jumpToLatest = page.getByRole("button", { name: zhCN.messages.returnToLatest });
	await expect(jumpToLatest).toBeVisible();
	await expect
		.poll(async () => (await thread.textContent())?.includes("HOLD_ONE HOLD_TWO"), {
			timeout: 8_000,
		})
		.toBe(true);
	expect(await thread.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(72);
	await expect(announcement).toHaveText("");

	await jumpToLatest.click();
	await expect(jumpToLatest).toBeHidden();
	await expect
		.poll(() =>
			thread.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
		)
		.toBeLessThanOrEqual(1);

	const completedReply = page
		.getByTestId("timeline-entry-row")
		.filter({ hasText: "HOLD_ONE HOLD_TWO" });
	const copyAction = completedReply.getByRole("button", { name: zhCN.messages.copy });
	const regenerateAction = page.getByRole("button", { name: zhCN.messages.regenerate });
	await expect(copyAction).toHaveCSS("opacity", "1");
	for (const action of [copyAction, regenerateAction]) {
		const box = await action.boundingBox();
		expect(box?.width).toBeGreaterThanOrEqual(44);
		expect(box?.height).toBeGreaterThanOrEqual(44);
	}
});

test("reduced motion disables new-turn entrance animation", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_HOLD_A");
	await page.getByRole("button", { name: zhCN.composer.sendLabel }).click();
	const streamingReply = page.getByTestId("streaming-assistant-message");
	await expect(streamingReply).toBeVisible();
	expect(await streamingReply.evaluate((element) => getComputedStyle(element).animationName)).toBe(
		"none",
	);
	await page.getByRole("button", { name: zhCN.composer.stopLabel }).click();
});
