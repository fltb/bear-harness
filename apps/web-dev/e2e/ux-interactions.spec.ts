import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

const feedbackBudgetMs = 100;

async function clickToCondition(
	trigger: Locator,
	condition: "detached" | "label-changed" | "submission-visible",
): Promise<number> {
	return trigger.evaluate(async (element, expected) => {
		const button = element as HTMLButtonElement;
		const initialLabel = button.getAttribute("aria-label");
		const startedAt = performance.now();
		button.click();
		return await new Promise<number>((resolve, reject) => {
			const deadline = startedAt + 1_000;
			const inspect = () => {
				// test-quality-allow querySelector: data-testid is the explicit visual-feedback contract.
				const submission = document.querySelector('[data-testid="conversation-submission"]');
				const satisfied =
					expected === "detached"
						? !button.isConnected
						: expected === "label-changed"
							? button.getAttribute("aria-label") !== initialLabel
							: submission instanceof HTMLElement && submission.offsetParent !== null;
				if (satisfied) {
					resolve(performance.now() - startedAt);
					return;
				}
				if (performance.now() >= deadline) {
					reject(new Error(`visual feedback did not reach ${expected}`));
					return;
				}
				requestAnimationFrame(inspect);
			};
			inspect();
		});
	}, condition);
}

test("primary conversation actions acknowledge input within 100ms", async ({ context, page }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await ensureReadyForConversation(page);
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_HOLD_A");
	const sendMs = await clickToCondition(
		page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }),
		"submission-visible",
	);
	await expect(page.getByTestId("streaming-assistant-message")).toContainText("HOLD_ONE");
	const stopMs = await clickToCondition(
		page.getByRole("button", { name: zhCN.composer.stopLabel }),
		"detached",
	);
	const userMessage = page
		.getByRole("article", { name: zhCN.messages.you })
		.filter({ hasText: "STREAM_HOLD_A" });
	const copyMs = await clickToCondition(
		userMessage.getByRole("button", { name: zhCN.messages.copy }),
		"label-changed",
	);
	const report = { copyMs, sendMs, stopMs };
	console.log(`UX_FEEDBACK ${JSON.stringify(report)}`);
	for (const elapsed of Object.values(report))
		expect(elapsed).toBeLessThanOrEqual(feedbackBudgetMs);
});

test("rapid motion interruption and resize leave one coherent surface", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await ensureReadyForConversation(page);
	const trigger = page.getByRole("button", { name: zhCN.sidebar.conversations, exact: true });
	const close = page.getByRole("button", {
		name: `${zhCN.backstage.close} ${zhCN.sidebar.conversations}`,
	});
	await trigger.click();
	await close.click();
	await trigger.click();
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(page.getByRole("application")).toHaveAttribute("data-layout", "window");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole("application")).toHaveAttribute("data-layout", "mobile");
	const navigation = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	await expect(navigation).toHaveCount(0);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	// test-quality-allow locator: the backdrop class is the motion surface contract.
	await expect(page.locator(".mobile-navigation-backdrop")).toHaveCount(0);
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(navigation).toBeVisible();
	// test-quality-allow locator: the backdrop class is the motion surface contract.
	await expect(page.locator(".mobile-navigation-backdrop")).toHaveCount(1);
});

test("stop, error, edit, correction, tool and choice feedback use the shared motion token", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	await page.evaluate(() => {
		const motionEvents: string[] = [];
		(window as unknown as { acceptanceMotionEvents: string[] }).acceptanceMotionEvents =
			motionEvents;
		document.addEventListener(
			"animationstart",
			(event) => motionEvents.push((event as AnimationEvent).animationName),
			true,
		);
	});
	const resetMotionEvents = () =>
		page.evaluate(() => {
			(window as unknown as { acceptanceMotionEvents: string[] }).acceptanceMotionEvents.length = 0;
		});
	const expectMotion = async (target: Locator, name: string) => {
		await expect(target).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { acceptanceMotionEvents: string[] }).acceptanceMotionEvents,
				),
			)
			.toContain(name);
	};

	await sendMessage(page, "E2E_OK motion states");
	const userMessage = page
		.getByRole("article", { name: zhCN.messages.you })
		.filter({ hasText: "E2E_OK motion states" });
	await resetMotionEvents();
	await userMessage.getByRole("button", { name: zhCN.messages.edit }).click();
	// test-quality-allow locator: the edit surface class is the reusable feedback-motion contract.
	await expectMotion(page.locator(".message-inline-edit"), "motion-feedback-enter");
	await page.getByRole("button", { name: zhCN.messages.cancel }).click();

	const assistantMessage = page
		.getByRole("article", { name: "极昼" })
		.filter({ hasText: "E2E_OK" });
	await resetMotionEvents();
	await assistantMessage.getByRole("button", { name: "这不像极昼" }).click();
	const correction = page.getByRole("dialog", { name: "这不像极昼" });
	await expectMotion(correction, "motion-modal-enter");
	await page.keyboard.press("Escape");

	await resetMotionEvents();
	await sendMessage(page, "E2E_TOOL_TRIGGER_DAMAGED_LOG");
	const tool = page.getByRole("article", { name: "host_state 已完成", exact: true });
	await expectMotion(tool, "motion-feedback-enter");

	await resetMotionEvents();
	await sendMessage(page, "E2E_STORY_ENTRY");
	const choices = page.getByRole("region", { name: "要进入《未送达的回报》吗？" });
	await expectMotion(choices, "motion-feedback-enter");

	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_HOLD_A");
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	await expect(page.getByTestId("streaming-assistant-message")).toContainText("HOLD_ONE");
	await resetMotionEvents();
	await page.getByRole("button", { name: zhCN.composer.stopLabel }).click();
	const stopped = page.getByRole("alert").filter({ hasText: zhCN.messages.responseStopped });
	await expectMotion(stopped, "motion-feedback-enter");

	await resetMotionEvents();
	await sendMessage(page, "UX_MODEL_ERROR");
	const error = page.getByRole("alert").filter({ hasText: "UX model failure" });
	await expectMotion(error, "motion-feedback-enter");
	await expect(error).not.toContainText("invalid_request_error");
});
