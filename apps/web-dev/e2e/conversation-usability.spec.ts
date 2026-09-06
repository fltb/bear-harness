import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

test("mobile composer, live activity, touch targets and detached scrolling stay usable", async ({
	page,
}) => {
	const browserErrors: Error[] = [];
	page.on("pageerror", (error) => browserErrors.push(error));
	await page.setViewportSize({ width: 390, height: 844 });
	await ensureReadyForConversation(page);
	const background = page.getByTestId("scene-asset");
	await expect(background).toBeVisible();
	const expectViewportBackground = async () => {
		await expect(async () => {
			const bounds = await background.boundingBox();
			expect(bounds).toMatchObject({ x: 0, width: 390, height: 844 });
			if (!bounds) throw new Error("scene background must remain visible");
			// At the document end, sticky positioning can settle half a CSS pixel above
			// zero. Both viewport edges must still align within that subpixel offset.
			expect(
				Math.max(Math.abs(bounds.y), Math.abs(bounds.y + bounds.height - 844)),
			).toBeLessThanOrEqual(0.5);
		}).toPass({ timeout: 5_000 });
	};
	await expectViewportBackground();

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

	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	await expect(composer).toHaveValue("");
	await expect
		.poll(() => composer.evaluate((element) => element.clientHeight))
		.toBeLessThanOrEqual(52);

	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const user = thread.getByRole("article", { name: zhCN.messages.you, exact: true });
	await expect(thread).not.toHaveAttribute("aria-live", "polite");
	const activity = page.getByTestId("conversation-activity");
	await expect(activity).toBeVisible();
	await expect(page.getByTestId("streaming-assistant-message")).toContainText("HOLD_ONE");
	await expect(user.getByText(`${longMessage}\nSTREAM_HOLD_A`, { exact: true })).toHaveCount(1);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const scrollingElement = document.scrollingElement;
				return Boolean(
					scrollingElement && scrollingElement.scrollHeight > scrollingElement.clientHeight,
				);
			}),
		)
		.toBe(true);

	await page.evaluate(() => {
		const scrollingElement = document.scrollingElement;
		if (!scrollingElement) throw new Error("missing document scrolling element");
		scrollingElement.scrollTop = 0;
		window.dispatchEvent(new WheelEvent("wheel"));
	});
	const jumpToLatest = page.getByRole("button", { name: zhCN.messages.returnToLatest });
	await expect(jumpToLatest).toBeVisible();
	await expect(assistant.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toHaveCount(1, {
		timeout: 8_000,
	});
	expect(
		await page.evaluate(() => document.scrollingElement?.scrollTop ?? Number.POSITIVE_INFINITY),
	).toBeLessThanOrEqual(72);
	await expect(activity).toBeHidden();
	await expectViewportBackground();

	await jumpToLatest.click();
	await expect(jumpToLatest).toBeHidden();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const scrollingElement = document.scrollingElement;
				if (!scrollingElement) return Number.POSITIVE_INFINITY;
				return (
					scrollingElement.scrollHeight - scrollingElement.clientHeight - scrollingElement.scrollTop
				);
			}),
		)
		.toBeLessThanOrEqual(1);
	await expectViewportBackground();

	const completedReply = assistant.filter({ hasText: "HOLD_ONE HOLD_TWO" });
	const copyAction = completedReply.getByRole("button", { name: zhCN.messages.copy });
	const correctionAction = page.getByRole("button", { name: "这不像极昼" });
	await expect(copyAction).toHaveCSS("opacity", "1");
	for (const action of [copyAction, correctionAction]) {
		const box = await action.boundingBox();
		expect(box?.width).toBeGreaterThanOrEqual(44);
		expect(box?.height).toBeGreaterThanOrEqual(44);
	}

	const composerForm = page.getByRole("form", { name: zhCN.composer.messageInputLabel });
	const presence = page.getByTestId("presence-asset");
	await page.emulateMedia({ reducedMotion: "reduce" });
	let previous: { x: number; width: number } | undefined;
	for (const width of [1280, 1920, 2560]) {
		await page.setViewportSize({ width, height: 800 });
		await expect
			.poll(async () => {
				const box = await thread.boundingBox();
				return box ? Math.round(width - box.x - box.width) : null;
			})
			.toBe(24);
		const box = await thread.boundingBox();
		const form = await composerForm.boundingBox();
		if (!box || !form) throw new Error("conversation surfaces must remain visible");
		expect(form.x).toBeCloseTo(box.x, 1);
		expect(form.width).toBeCloseTo(box.width, 1);
		if (previous) {
			expect(box.x).toBeGreaterThan(previous.x);
			expect(box.width).toBeGreaterThan(previous.width);
		}
		previous = box;
		const fixedBounds = await Promise.all([composerForm.boundingBox(), presence.boundingBox()]);
		for (const fraction of [0, 0.5, 1]) {
			await page.evaluate((fraction) => {
				const scrolling = document.scrollingElement;
				if (!scrolling) throw new Error("missing document scrolling element");
				scrolling.scrollTop = (scrolling.scrollHeight - scrolling.clientHeight) * fraction;
			}, fraction);
			await expect
				.poll(() => Promise.all([composerForm.boundingBox(), presence.boundingBox()]))
				.toEqual(fixedBounds);
		}
	}
	expect(browserErrors).toEqual([]);
});

test("reduced motion disables new-turn entrance animation", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_HOLD_A");
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	const streamingReply = page.getByTestId("streaming-assistant-message");
	await expect(streamingReply).toBeVisible();
	expect(await streamingReply.evaluate((element) => getComputedStyle(element).animationName)).toBe(
		"none",
	);
	await page.getByRole("button", { name: zhCN.composer.stopLabel }).click();
});
