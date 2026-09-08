import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, type Page, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

const feedbackBudgetMs = 100;
const idleMinutes = Number(process.env.BEAR_E2E_UX_IDLE_MINUTES ?? "0");

function percentile(values: number[], fraction: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
}

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

async function installStreamingMetrics(page: Page): Promise<void> {
	await page.evaluate(() => {
		const longTasks: Array<{ duration: number; startTime: number; streamedCharacters: number }> =
			[];
		const frameGaps: number[] = [];
		const chunkPaintLatencies: number[] = [];
		let cumulativeLayoutShift = 0;
		let maximumHorizontalShift = 0;
		let lastFrame = performance.now();
		let running = true;
		const stableSurfaceX = new Map<Element, number>();

		new PerformanceObserver((entries) => {
			for (const entry of entries.getEntries())
				longTasks.push({
					duration: entry.duration,
					startTime: entry.startTime,
					streamedCharacters:
						// test-quality-allow querySelector: data-testid is the explicit streaming projection contract.
						document.querySelector('[data-testid="streaming-assistant-message"]')?.textContent
							?.length ?? 0,
				});
		}).observe({ type: "longtask", buffered: false });
		new PerformanceObserver((entries) => {
			for (const entry of entries.getEntries()) {
				const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
				if (shift.hadRecentInput) continue;
				cumulativeLayoutShift += shift.value ?? 0;
			}
		}).observe({ type: "layout-shift", buffered: false });

		const sampleFrame = (now: number) => {
			if (!running) return;
			frameGaps.push(now - lastFrame);
			lastFrame = now;
			// test-quality-allow querySelectorAll: these public layout classes define the two stable surfaces.
			for (const surface of document.querySelectorAll(".thread, .composer")) {
				const x = surface.getBoundingClientRect().x;
				const previous = stableSurfaceX.get(surface);
				if (previous !== undefined)
					maximumHorizontalShift = Math.max(maximumHorizontalShift, Math.abs(x - previous));
				stableSurfaceX.set(surface, x);
			}
			requestAnimationFrame(sampleFrame);
		};
		requestAnimationFrame(sampleFrame);
		const observer = new MutationObserver((records) => {
			// test-quality-allow querySelector: data-testid is the explicit streaming projection contract.
			if (!document.querySelector('[data-testid="streaming-assistant-message"]')) return;
			const mutationAt = performance.now();
			if (records.length === 0) return;
			requestAnimationFrame(() => chunkPaintLatencies.push(performance.now() - mutationAt));
		});
		observer.observe(document, { childList: true, characterData: true, subtree: true });
		Object.defineProperty(window, "bearUxMetrics", {
			value: {
				finish: () => {
					running = false;
					observer.disconnect();
					return {
						chunkPaintLatencies,
						cumulativeLayoutShift,
						frameGaps,
						longTasks,
						maximumHorizontalShift,
					};
				},
			},
		});
	});
}

test("60 second native stream meets rendering smoothness and stability budgets", async ({
	page,
}) => {
	test.setTimeout(100_000);
	await ensureReadyForConversation(page);
	await installStreamingMetrics(page);
	await sendMessage(page, "UX_STREAM_60_SECONDS");
	await expect(page.getByText("UX_STREAM_COMPLETE", { exact: false })).toBeVisible({
		timeout: 75_000,
	});
	const metrics = await page.evaluate(() =>
		(
			window as unknown as {
				bearUxMetrics: {
					finish(): {
						chunkPaintLatencies: number[];
						cumulativeLayoutShift: number;
						frameGaps: number[];
						longTasks: Array<{
							duration: number;
							startTime: number;
							streamedCharacters: number;
						}>;
						maximumHorizontalShift: number;
					};
				};
			}
		).bearUxMetrics.finish(),
	);
	const droppedFrames = metrics.frameGaps.reduce(
		(total, gap) => total + Math.max(0, Math.round(gap / (1_000 / 60)) - 1),
		0,
	);
	const droppedFrameRatio = droppedFrames / (metrics.frameGaps.length + droppedFrames);
	const report = {
		chunkPaintP95Ms: percentile(metrics.chunkPaintLatencies, 0.95),
		cls: metrics.cumulativeLayoutShift,
		droppedFrameRatio,
		frameSamples: metrics.frameGaps.length,
		longTaskCount: metrics.longTasks.filter((task) => task.duration > 50).length,
		longTasks: metrics.longTasks.filter((task) => task.duration > 50),
		maxLongTaskMs: Math.max(0, ...metrics.longTasks.map((task) => task.duration)),
		maxHorizontalShiftPx: metrics.maximumHorizontalShift,
	};
	console.log(`UX_METRICS ${JSON.stringify(report)}`);
	expect(metrics.chunkPaintLatencies.length).toBeGreaterThan(100);
	expect(report.chunkPaintP95Ms).toBeLessThanOrEqual(50);
	expect(report.longTaskCount).toBe(0);
	expect(report.droppedFrameRatio).toBeLessThan(0.01);
	expect(report.cls).toBeLessThanOrEqual(0.1);
	expect(report.maxHorizontalShiftPx).toBe(0);
});

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
	await page.setViewportSize({ width: 390, height: 844 });
	// Crossing responsive modes intentionally closes a UI-local drawer. The
	// interrupted exit must settle closed, with no orphaned backdrop.
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
	const animationName = async (target: Locator) => {
		await expect(target).toBeVisible();
		return target.evaluate((element) => getComputedStyle(element).animationName);
	};

	await sendMessage(page, "E2E_OK motion states");
	const userMessage = page
		.getByRole("article", { name: zhCN.messages.you })
		.filter({ hasText: "E2E_OK motion states" });
	await userMessage.getByRole("button", { name: zhCN.messages.edit }).click();
	// test-quality-allow locator: the edit surface class is the reusable feedback-motion contract.
	expect(await animationName(page.locator(".message-inline-edit"))).toBe("motion-feedback-enter");
	await page.getByRole("button", { name: zhCN.messages.cancel }).click();

	const assistantMessage = page
		.getByRole("article", { name: "极昼" })
		.filter({ hasText: "E2E_OK" });
	await assistantMessage.getByRole("button", { name: "这不像极昼" }).click();
	const correction = page.getByRole("dialog", { name: "这不像极昼" });
	expect(await animationName(correction)).toBe("motion-modal-enter");
	await page.keyboard.press("Escape");

	await sendMessage(page, "E2E_TOOL_TRIGGER_DAMAGED_LOG");
	const tool = page.getByRole("article", { name: "host_state 已完成", exact: true });
	expect(await animationName(tool)).toBe("motion-feedback-enter");

	await sendMessage(page, "E2E_STORY_ENTRY");
	const choices = page.getByRole("region", { name: "要进入《未送达的回报》吗？" });
	expect(await animationName(choices)).toBe("motion-feedback-enter");

	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill("STREAM_HOLD_A");
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	await expect(page.getByTestId("streaming-assistant-message")).toContainText("HOLD_ONE");
	await page.getByRole("button", { name: zhCN.composer.stopLabel }).click();
	const stopped = page.getByRole("alert").filter({ hasText: zhCN.messages.responseStopped });
	expect(await animationName(stopped)).toBe("motion-feedback-enter");

	await sendMessage(page, "UX_MODEL_ERROR");
	const error = page.getByRole("alert").filter({ hasText: "UX model failure" });
	expect(await animationName(error)).toBe("motion-feedback-enter");
	await expect(error).not.toContainText("invalid_request_error");
});

const visualStates = ["empty", "streaming", "rich", "tool", "run", "artifact", "error"] as const;

async function prepareVisualState(page: Page, state: (typeof visualStates)[number]): Promise<void> {
	if (state === "empty") return;
	if (state === "streaming") {
		const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
		await composer.fill("STREAM_HOLD_A");
		await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
		await expect(page.getByTestId("streaming-assistant-message")).toContainText("HOLD_ONE");
		return;
	}
	if (state === "rich") {
		await sendMessage(page, "RICH_CONTENT_STREAM");
		await expect(page.getByRole("heading", { name: "交接结果" })).toBeVisible();
		return;
	}
	if (state === "tool") {
		await sendMessage(page, "E2E_TOOL_TRIGGER_DAMAGED_LOG");
		await expect(
			page.getByRole("article", { name: "host_state 已完成", exact: true }),
		).toBeVisible();
		return;
	}
	if (state === "error") {
		await sendMessage(page, "UX_MODEL_ERROR");
		await expect(page.getByRole("alert").filter({ hasText: "UX model failure" })).toBeVisible();
		return;
	}
	await sendMessage(page, "E2E_DELEGATE_ARTIFACT");
	const artifact = page.getByRole("button", {
		name: `${zhCN.work.timeline.viewArtifacts}: e2e-report.txt`,
		exact: true,
	});
	await expect(artifact).toBeVisible({ timeout: 30_000 });
	if (state === "artifact") {
		await artifact.click();
		await expect(page.getByRole("dialog", { name: "e2e-report.txt" })).toBeVisible();
	}
}

for (const viewport of [
	{ name: "mobile", width: 390, height: 844 },
	{ name: "window", width: 1280, height: 800 },
	{ name: "fullscreen", width: 1920, height: 1080 },
] as const) {
	for (const state of visualStates) {
		test(`${state} conversation visual baseline at ${viewport.name}`, async ({ page }) => {
			test.setTimeout(60_000);
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await ensureReadyForConversation(page);
			await prepareVisualState(page, state);
			const masks = [];
			if (state === "artifact") {
				const dialog = page.getByRole("dialog", { name: "e2e-report.txt" });
				const provenance = dialog.getByRole("region", { name: zhCN.work.result.provenance });
				masks.push(
					dialog.getByTestId("artifact-created-at"),
					provenance.getByTestId("artifact-producer-run"),
					provenance.getByTestId("artifact-trigger-entry"),
					provenance.getByRole("list", { name: zhCN.work.result.evidence }),
				);
			}
			await expect(page).toHaveScreenshot(`main-conversation-${state}-${viewport.name}.png`, {
				maxDiffPixelRatio: 0.005,
				mask: masks,
			});
		});
	}
}

if (Number.isFinite(idleMinutes) && idleMinutes > 0)
	test("hidden idle conversation stays paused within its configured resource budget", async ({
		page,
	}) => {
		test.setTimeout(idleMinutes * 60_000 + 60_000);
		await ensureReadyForConversation(page);
		const session = await page.context().newCDPSession(page);
		await session.send("Performance.enable");
		const readMetrics = async () => {
			const values = await session.send("Performance.getMetrics");
			return new Map(values.metrics.map((metric) => [metric.name, metric.value]));
		};
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
		const presence = page.getByTestId("presence-asset");
		expect(
			await presence.evaluate((element) => {
				const state = element.closest("[data-activity-state]");
				return state ? getComputedStyle(state).animationPlayState : "missing";
			}),
		).toBe("paused");
		// Do not mistake one-time browser/bootstrap allocation for idle retention.
		// The measured interval begins only after a bounded hidden-page warm-up and GC.
		await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
		await session.send("HeapProfiler.collectGarbage");
		const beforeMetrics = await readMetrics();
		const beforeHeap = await session.send("Runtime.getHeapUsage");
		await new Promise<void>((resolve) => setTimeout(resolve, idleMinutes * 60_000));
		await session.send("HeapProfiler.collectGarbage");
		const afterHeap = await session.send("Runtime.getHeapUsage");
		const afterMetrics = await readMetrics();
		const taskSeconds =
			(afterMetrics.get("TaskDuration") ?? 0) - (beforeMetrics.get("TaskDuration") ?? 0);
		const scriptSeconds =
			(afterMetrics.get("ScriptDuration") ?? 0) - (beforeMetrics.get("ScriptDuration") ?? 0);
		const heapGrowthBytes = Math.max(0, afterHeap.usedSize - beforeHeap.usedSize);
		const report = {
			afterHeapBytes: afterHeap.usedSize,
			beforeHeapBytes: beforeHeap.usedSize,
			heapGrowthBytes,
			idleMinutes,
			scriptSeconds,
			taskSeconds,
		};
		console.log(`UX_IDLE ${JSON.stringify(report)}`);
		expect(taskSeconds).toBeLessThanOrEqual(idleMinutes * 0.6);
		expect(scriptSeconds).toBeLessThanOrEqual(idleMinutes * 0.2);
		expect(heapGrowthBytes).toBeLessThanOrEqual(1024 * 1024);
	});
