import AxeBuilder from "@axe-core/playwright";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

test("composer drafts remain isolated while switching conversations", async ({ page }) => {
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const activeId = async () =>
		sidebar
			.getByRole("button")
			.evaluateAll((buttons) =>
				buttons
					.find((button) => button.getAttribute("aria-current") === "page")
					?.getAttribute("data-conversation-id"),
			);
	const conversationA = await activeId();
	if (!conversationA) throw new Error("active conversation has no identity");
	await composer.fill("会话 A 的未发送草稿");

	await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
	await expect
		.poll(async () => {
			const current = await activeId();
			return Boolean(current && current !== conversationA);
		})
		.toBe(true);
	const conversationB = await activeId();
	if (!conversationB || conversationB === conversationA)
		throw new Error("new conversation was not activated");
	await expect(composer).toHaveValue("");
	await composer.fill("会话 B 的未发送草稿");

	await sidebar.locator(`[data-conversation-id="${conversationA}"]`).click();
	await expect(composer).toHaveValue("会话 A 的未发送草稿");
	await sidebar.locator(`[data-conversation-id="${conversationB}"]`).click();
	await expect(composer).toHaveValue("会话 B 的未发送草稿");
});

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
		window.dispatchEvent(new Event("scroll"));
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

test("a streamed reply enters once and its settled handoff does not animate again", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_HOLD_A");
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	const streamingReply = page.getByTestId("streaming-assistant-message");
	await expect(streamingReply).toContainText("HOLD_ONE");
	expect(await streamingReply.evaluate((element) => getComputedStyle(element).animationName)).toBe(
		"timeline-entry-in",
	);
	expect(
		await streamingReply.evaluate((element) => getComputedStyle(element).animationDuration),
	).toBe("0.12s");

	const settledReply = page
		.getByTestId("timeline-entry-row")
		.filter({ hasText: "HOLD_ONE HOLD_TWO" });
	await expect(settledReply).toBeVisible({ timeout: 15_000 });
	await expect(streamingReply).toHaveCount(0);
	expect(await settledReply.getAttribute("class")).not.toContain("timeline-entry-enter");
});

test("streaming preserves focus on an existing message action", async ({ page }) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_FOCUS_HOLD");
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	await expect(thread.getByText("FOCUS_ONE", { exact: false })).toBeVisible({ timeout: 10_000 });
	await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeVisible();
	const userMessage = thread
		.getByRole("article", { name: zhCN.messages.you })
		.filter({ hasText: "STREAM_FOCUS_HOLD" });
	const copyAction = userMessage.getByRole("button", { name: zhCN.messages.copy });
	await copyAction.focus();
	await expect(copyAction).toBeFocused();
	await expect(thread.getByText("FOCUS_ONE FOCUS_TWO", { exact: true })).toBeVisible({
		timeout: 20_000,
	});
	await expect(copyAction).toBeFocused();
});

test("zoom-equivalent reflow and blocked fonts keep the conversation usable", async ({ page }) => {
	await page.route("**/*", async (route) => {
		if (route.request().resourceType() === "font") {
			await route.abort();
			return;
		}
		await route.continue();
	});
	await page.addInitScript(() => {
		let cumulativeLayoutShift = 0;
		new PerformanceObserver((entries) => {
			for (const entry of entries.getEntries()) {
				if (!(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput) {
					cumulativeLayoutShift += (entry as PerformanceEntry & { value?: number }).value ?? 0;
				}
			}
		}).observe({ type: "layout-shift", buffered: true });
		Object.defineProperty(window, "acceptanceLayoutShift", {
			get: () => cumulativeLayoutShift,
		});
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	const send = page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true });
	for (const scale of [2, 4]) {
		await page.setViewportSize({ width: 1280 / scale, height: 800 });
		await expect(composer).toBeVisible();
		await expect(send).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
		).toBe(true);
		const clippedControls = await page.getByRole("button").evaluateAll((buttons) =>
			buttons
				.filter((button) => {
					const bounds = button.getBoundingClientRect();
					const intersectsViewport =
						bounds.right > 0 &&
						bounds.bottom > 0 &&
						bounds.left < window.innerWidth &&
						bounds.top < window.innerHeight;
					return (
						intersectsViewport &&
						(button.scrollWidth > button.clientWidth + 1 ||
							button.scrollHeight > button.clientHeight + 1)
					);
				})
				.map((button) => ({
					label: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
					clientWidth: button.clientWidth,
					scrollWidth: button.scrollWidth,
					clientHeight: button.clientHeight,
					scrollHeight: button.scrollHeight,
				})),
		);
		expect(clippedControls).toEqual([]);
	}
	await composer.fill("RICH_CONTENT_STREAM");
	await send.click();
	await expect(page.getByRole("heading", { name: "交接结果" })).toBeVisible();
	await expect(page.getByRole("code")).toBeVisible();
	await expect(page.getByRole("math")).toBeVisible();
	expect(
		await page.evaluate(
			() => (window as unknown as { acceptanceLayoutShift: number }).acceptanceLayoutShift,
		),
	).toBeLessThanOrEqual(0.1);
});

test("conversation and presence motion obey the frozen timing budget", async ({ page }) => {
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_HOLD_A");
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	const streamingReply = page.getByTestId("streaming-assistant-message");
	await expect(streamingReply).toBeVisible();
	expect(
		await streamingReply.evaluate((element) => getComputedStyle(element).animationDuration),
	).toBe("0.12s");
	const presence = page.getByTestId("presence-asset");
	await expect(presence).toBeVisible();
	expect(
		await presence.evaluate((element) => {
			const stateContainer = element.closest("[data-activity-state]");
			return stateContainer ? getComputedStyle(stateContainer).animationDuration : "missing";
		}),
	).toBe("8s");
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const before = await thread.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		return { x: bounds.x, width: bounds.width, height: bounds.height };
	});
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	const after = await thread.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		return { x: bounds.x, width: bounds.width, height: bounds.height };
	});
	expect(after).toEqual(before);

	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(page.getByTestId("presence-stage")).toHaveAttribute(
		"data-document-visible",
		"false",
	);
	expect(
		await presence.evaluate((element) => {
			const stateContainer = element.closest("[data-activity-state]");
			return stateContainer ? getComputedStyle(stateContainer).animationPlayState : "missing";
		}),
	).toBe("paused");
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});

	await page.emulateMedia({ reducedMotion: "reduce" });
	expect(
		await presence.evaluate((element) => {
			const stateContainer = element.closest("[data-activity-state]");
			return stateContainer ? getComputedStyle(stateContainer).animationName : "missing";
		}),
	).toBe("none");
	expect(await streamingReply.evaluate((element) => getComputedStyle(element).animationName)).toBe(
		"none",
	);
	await page.getByRole("button", { name: zhCN.composer.stopLabel }).click();
});

test("long replies expose code copy and local reading navigation", async ({ context, page }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("LONG_RICH_CONTENT");
	await page.getByRole("button", { name: zhCN.composer.sendLabel }).click();

	const response = page.getByRole("article", { name: "极昼" }).filter({ hasText: "长回复验收" });
	await expect(
		response.getByRole("button", { name: zhCN.messages.jumpToResponseEnd }),
	).toBeVisible();
	await expect(
		response.getByRole("button", { name: zhCN.messages.jumpToResponseStart }),
	).toBeVisible();
	await expect(
		response.getByRole("button", { name: zhCN.messages.copyFullResponse }),
	).toBeVisible();

	await response.getByRole("button", { name: zhCN.messages.copyCode }).click();
	await expect(response.getByRole("button", { name: zhCN.messages.codeCopied })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		'const exactSource = "<safe>";\n',
	);

	await page.evaluate(() => {
		const scrollingElement = document.scrollingElement;
		if (!scrollingElement) throw new Error("missing document scrolling element");
		scrollingElement.scrollTop = 0;
		window.dispatchEvent(new WheelEvent("wheel"));
	});
	const jumpToLatest = page.getByRole("button", { name: zhCN.messages.returnToLatest });
	await expect(jumpToLatest).toBeVisible();
	const jumpBox = await jumpToLatest.boundingBox();
	const footerBox = await response
		.getByRole("button", { name: zhCN.messages.copyFullResponse })
		.boundingBox();
	if (!jumpBox || !footerBox) throw new Error("navigation controls have no layout boxes");
	const overlaps = !(
		jumpBox.x + jumpBox.width <= footerBox.x ||
		footerBox.x + footerBox.width <= jumpBox.x ||
		jumpBox.y + jumpBox.height <= footerBox.y ||
		footerBox.y + footerBox.height <= jumpBox.y
	);
	expect(overlaps).toBe(false);

	await response.getByRole("button", { name: zhCN.messages.jumpToResponseStart }).click();
	const atStart = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
	await response.getByRole("button", { name: zhCN.messages.jumpToResponseEnd }).click();
	await expect
		.poll(() => page.evaluate(() => document.scrollingElement?.scrollTop ?? 0))
		.toBeGreaterThan(atStart);
});

test("the main conversation has no serious automated accessibility violations", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("RICH_CONTENT_STREAM");
	await page.getByRole("button", { name: zhCN.composer.sendLabel }).click();
	await expect(page.getByRole("heading", { name: "交接结果" })).toBeVisible();
	const result = await new AxeBuilder({ page }).include("main").analyze();
	const blocking = result.violations.filter(
		(violation) => violation.impact === "critical" || violation.impact === "serious",
	);
	expect(blocking).toEqual([]);
});
