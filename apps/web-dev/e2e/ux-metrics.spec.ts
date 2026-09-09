import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Page, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

const idleMinutes = Number(process.env.BEAR_E2E_UX_IDLE_MINUTES ?? "0");

function percentile(values: number[], fraction: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
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
