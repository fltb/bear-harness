import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

const soakMinutes = Number(process.env.BEAR_E2E_SOAK_MINUTES ?? "0");

function percentile(values: number[], fraction: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
}

if (Number.isFinite(soakMinutes) && soakMinutes > 0)
	test("long streaming conversation stays within the CI stability budget", async ({ page }) => {
		test.setTimeout(soakMinutes * 60_000 + 120_000);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.addInitScript(() => {
			const longTasks: Array<{ startTime: number; duration: number }> = [];
			const interactionTimings: number[] = [];
			new PerformanceObserver((entries) => {
				for (const entry of entries.getEntries())
					longTasks.push({ startTime: entry.startTime, duration: entry.duration });
			}).observe({ type: "longtask", buffered: true });
			new PerformanceObserver((entries) => {
				for (const entry of entries.getEntries()) interactionTimings.push(entry.duration);
			}).observe({ type: "event", buffered: true, durationThreshold: 16 });
			Object.defineProperty(window, "acceptanceLongTasks", { get: () => longTasks });
			Object.defineProperty(window, "acceptanceInteractionTimings", {
				get: () => interactionTimings,
			});
		});
		await ensureReadyForConversation(page);
		const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
		const send = page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true });
		const stop = page.getByRole("button", { name: zhCN.composer.stopLabel });
		const session = await page.context().newCDPSession(page);
		const garbageCollectionWindows: Array<{ startTime: number; endTime: number }> = [];
		const collectGarbage = async () => {
			const startTime = await page.evaluate(() => performance.now());
			await session.send("HeapProfiler.collectGarbage");
			const endTime = await page.evaluate(() => performance.now());
			garbageCollectionWindows.push({ startTime, endTime });
		};
		const scrollTimings: number[] = [];
		const heapSamples: Array<{ at: number; bytes: number }> = [];
		const startedAt = Date.now();
		const deadline = startedAt + soakMinutes * 60_000;
		let nextHeapSample = startedAt;
		let cycle = 0;
		while (Date.now() < deadline) {
			await composer.fill(`STREAM_FOCUS_HOLD soak ${cycle}`);
			await send.click();
			await expect(stop).toBeVisible({ timeout: 10_000 });
			await expect
				.poll(
					async () =>
						(await page.getByTestId("streaming-assistant-message").textContent())?.length ?? 0,
					{ timeout: 15_000 },
				)
				.toBeGreaterThan(0);
			scrollTimings.push(
				await page.evaluate(async (currentCycle) => {
					const scrollingElement = document.scrollingElement;
					if (!scrollingElement) throw new Error("missing document scrolling element");
					const scrollStarted = performance.now();
					window.scrollTo({
						top: currentCycle % 2 === 0 ? 0 : scrollingElement.scrollHeight,
					});
					window.dispatchEvent(new WheelEvent("wheel"));
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					return performance.now() - scrollStarted;
				}, cycle),
			);
			await stop.click();
			await expect(stop).toBeHidden({ timeout: 5_000 });
			if (Date.now() >= nextHeapSample) {
				await collectGarbage();
				const heap = await session.send("Runtime.getHeapUsage");
				heapSamples.push({ at: Date.now(), bytes: heap.usedSize });
				nextHeapSample = Date.now() + 60_000;
			}
			cycle += 1;
		}
		await collectGarbage();
		const finalHeap = await session.send("Runtime.getHeapUsage");
		heapSamples.push({ at: Date.now(), bytes: finalHeap.usedSize });
		const warmSamples = heapSamples.slice(Math.min(2, heapSamples.length - 1));
		const first = warmSamples[0];
		const last = warmSamples.at(-1);
		if (!first || !last) throw new Error("soak did not collect enough heap samples");
		const tenMinuteWindows = Math.max((last.at - first.at) / 600_000, 1);
		const heapSlope = Math.max(0, last.bytes - first.bytes) / tenMinuteWindows;
		const observedLongTasks = await page.evaluate(
			() =>
				(
					window as unknown as {
						acceptanceLongTasks: Array<{ startTime: number; duration: number }>;
					}
				).acceptanceLongTasks,
		);
		const longTasks = observedLongTasks.filter(
			(task) =>
				!garbageCollectionWindows.some(
					(window) =>
						task.startTime < window.endTime && task.startTime + task.duration > window.startTime,
				),
		);
		const browserInteractionTimings = await page.evaluate(
			() =>
				(window as unknown as { acceptanceInteractionTimings: number[] })
					.acceptanceInteractionTimings,
		);
		const interactionTimings = [...browserInteractionTimings, ...scrollTimings];
		const interactionP95 = interactionTimings.length > 0 ? percentile(interactionTimings, 0.95) : 0;
		const maxLongTask =
			longTasks.length > 0 ? Math.max(...longTasks.map((task) => task.duration)) : 0;
		const renderedTimelineRows = await page.getByTestId("timeline-entry-row").count();
		console.log(
			JSON.stringify({
				cycles: cycle,
				renderedTimelineRows,
				interactionSamples: interactionTimings.length,
				interactionP95,
				heapSamples: heapSamples.length,
				heapSlopeBytesPerTenMinutes: heapSlope,
				maxLongTask,
				excludedGarbageCollectionLongTasks: observedLongTasks.length - longTasks.length,
				pageErrors: errors,
			}),
		);
		expect(cycle).toBeGreaterThan(0);
		expect(renderedTimelineRows).toBeLessThanOrEqual(100);
		expect(interactionP95).toBeLessThanOrEqual(100);
		expect(heapSlope).toBeLessThanOrEqual(1024 * 1024);
		expect(longTasks.filter((task) => task.duration > 200)).toEqual([]);
		expect(errors).toEqual([]);
	});
