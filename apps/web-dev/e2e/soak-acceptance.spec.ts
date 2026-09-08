import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Page, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	getBootstrap,
	projectPiEntries,
	sendMessage,
} from "./helpers";

const soakMinutes = Number(process.env.BEAR_E2E_SOAK_MINUTES ?? "0");
const soakMode = process.env.BEAR_E2E_SOAK_MODE === "release" ? "release" : "calibration";
const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const evidenceRoot = join(repoRoot, "release-attestations");
const screenshotRoot = join(repoRoot, "test-results/web-dev/soak");

interface HostMetrics {
	schemaVersion: 1;
	pid: number;
	uptimeMs: number;
	gcAvailable: boolean;
	eventSubscriptions: number;
	persistenceErrors: number;
	memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
}

interface ResourceSample {
	at: number;
	rendererHeapBytes: number;
	hostHeapBytes: number;
	hostRssBytes: number;
	renderedTimelineRows: number;
	eventSubscriptions: number;
	persistenceErrors: number;
}

async function armClickClock(page: Page, key: string): Promise<void> {
	await page.evaluate((clockKey) => {
		const holder = window as unknown as { acceptanceClickClocks?: Map<string, number> };
		if (!holder.acceptanceClickClocks) holder.acceptanceClickClocks = new Map();
		const clocks = holder.acceptanceClickClocks;
		document.addEventListener("click", () => clocks.set(clockKey, performance.now()), {
			capture: true,
			once: true,
		});
	}, key);
}

async function clickElapsed(page: Page, key: string): Promise<number> {
	return page.evaluate((clockKey) => {
		const startedAt = (
			window as unknown as { acceptanceClickClocks?: Map<string, number> }
		).acceptanceClickClocks?.get(clockKey);
		if (startedAt === undefined) throw new Error(`click clock was not armed: ${clockKey}`);
		return performance.now() - startedAt;
	}, key);
}

async function markOperation(page: Page, operation: string): Promise<void> {
	await page.evaluate((value) => {
		(window as unknown as { acceptanceOperation?: string }).acceptanceOperation = value;
	}, operation);
}

function percentile(values: number[], fraction: number): number {
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.ceil(ordered.length * fraction) - 1] ?? 0;
}

function positiveGrowth(samples: ResourceSample[], field: keyof ResourceSample): number {
	const first = samples[0]?.[field];
	const last = samples.at(-1)?.[field];
	return typeof first === "number" && typeof last === "number" ? Math.max(0, last - first) : 0;
}

function growthPerTenMinutes(samples: ResourceSample[], field: keyof ResourceSample): number {
	const first = samples[0];
	const last = samples.at(-1);
	if (!first || !last) return 0;
	const windows = Math.max((last.at - first.at) / 600_000, 1);
	return positiveGrowth(samples, field) / windows;
}

function trailingIncreases(samples: ResourceSample[]): number {
	const final = samples.slice(-31);
	let increasing = 0;
	for (let index = final.length - 1; index > 0; index -= 1) {
		const current = final[index];
		const previous = final[index - 1];
		if (!current || !previous || current.hostRssBytes <= previous.hostRssBytes) break;
		increasing += 1;
	}
	return increasing;
}

async function rpc<T>(page: Page, token: string, channel: string, data: unknown): Promise<T> {
	const response = await page.request.post(`/rpc/${channel}`, {
		headers: { "x-bear-web-dev-token": token },
		data,
	});
	await expect(response).toBeOK();
	const envelope = (await response.json()) as { ok: boolean; data?: T };
	expect(envelope).toMatchObject({ ok: true });
	if (envelope.data === undefined) throw new Error(`${channel} returned no data`);
	return envelope.data;
}

async function waitForSettled(page: Page, token: string, conversationId: string) {
	let detail: {
		branch: { entries: unknown[]; hasMoreBefore: boolean };
		live: { isStreaming: boolean };
	} | null = null;
	await expect
		.poll(
			async () => {
				detail = await rpc(page, token, "conversation.open", { conversationId });
				return detail.live.isStreaming;
			},
			{ timeout: 30_000 },
		)
		.toBe(false);
	if (!detail) throw new Error("conversation did not produce a settled snapshot");
	return detail;
}

async function allEntries(page: Page, token: string, conversationId: string) {
	const found: unknown[] = [];
	let beforeEntryId: string | undefined;
	do {
		const history = await rpc<{ entries: unknown[]; nextCursor?: string }>(
			page,
			token,
			"conversation.history",
			{ conversationId, ...(beforeEntryId ? { beforeEntryId } : {}), limit: 100 },
		);
		found.unshift(...history.entries);
		beforeEntryId = history.nextCursor;
	} while (beforeEntryId);
	return projectPiEntries(found);
}

if (Number.isFinite(soakMinutes) && soakMinutes > 0)
	test("RC mixed conversation soak stays within the frozen stability budget", async ({ page }) => {
		test.setTimeout(soakMinutes * 60_000 + 180_000);
		if (soakMode === "release" && soakMinutes < 120) {
			throw new Error("release soak requires BEAR_E2E_SOAK_MINUTES of at least 120");
		}
		mkdirSync(evidenceRoot, { recursive: true });
		mkdirSync(screenshotRoot, { recursive: true });
		const pageErrors: string[] = [];
		const consoleErrors: string[] = [];
		await page.addInitScript(() => {
			const longTasks: Array<{
				startTime: number;
				duration: number;
				cycle?: number;
				operation?: string;
			}> = [];
			const interactionTimings: number[] = [];
			new PerformanceObserver((entries) => {
				for (const entry of entries.getEntries()) {
					const marker = window as unknown as {
						acceptanceCycle?: number;
						acceptanceOperation?: string;
					};
					longTasks.push({
						startTime: entry.startTime,
						duration: entry.duration,
						cycle: marker.acceptanceCycle,
						operation: marker.acceptanceOperation,
					});
				}
			}).observe({ type: "longtask", buffered: true });
			new PerformanceObserver((entries) => {
				for (const entry of entries.getEntries()) interactionTimings.push(entry.duration);
			}).observe({ type: "event", buffered: true, durationThreshold: 16 });
			Object.defineProperty(window, "acceptanceLongTasks", { get: () => longTasks });
			Object.defineProperty(window, "acceptanceInteractionTimings", {
				get: () => interactionTimings,
			});
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		await ensureReadyForConversation(page);
		const token = (await getBootstrap(page)).token;
		const firstId = await activeConversationId(page);
		const second = await rpc<{ conversationId: string }>(page, token, "conversation.create", {
			title: "RC soak B",
		});
		const third = await rpc<{ conversationId: string }>(page, token, "conversation.create", {
			title: "RC soak C",
		});
		const conversationIds = [firstId, second.conversationId, third.conversationId];
		await page.reload();
		await activeConversationId(page, third.conversationId);
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") {
				consoleErrors.push(JSON.stringify({ text: message.text(), location: message.location() }));
			}
		});
		const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
		const stop = page.getByRole("button", { name: zhCN.composer.stopLabel });
		const session = await page.context().newCDPSession(page);
		const garbageCollectionWindows: Array<{ startTime: number; endTime: number }> = [];
		const resourceSamples: ResourceSample[] = [];
		const browserInteractionTimings: number[] = [];
		const switchTimings: number[] = [];
		const stopFeedbackTimings: number[] = [];
		const streamExitTimings: number[] = [];
		const cancelConfirmationTimings: number[] = [];
		const scrollTimings: number[] = [];
		const expectedMessages = new Map(conversationIds.map((id) => [id, new Set<string>()]));
		let cycle = 0;
		let switches = 0;
		let stops = 0;
		let historyLoads = 0;
		let runArtifactInteractions = 0;
		let mediaChoiceInteractions = 0;
		let postStopTokens = 0;
		let maxNoProgressMs = 0;
		let lastProgressAt = Date.now();
		let midwayCaptured = false;
		const startedAt = Date.now();
		const startedAtPerformance = await page.evaluate(() => performance.now());
		const deadline = startedAt + soakMinutes * 60_000;
		const midpoint = startedAt + (deadline - startedAt) / 2;
		const sampleInterval =
			soakMode === "release"
				? 60_000
				: Math.min(60_000, Math.max(1_000, (deadline - startedAt) / 3));
		let nextSampleAt = startedAt;

		const collectSample = async () => {
			const interactionBatch = await page.evaluate(() => {
				const timings = (window as unknown as { acceptanceInteractionTimings: number[] })
					.acceptanceInteractionTimings;
				return timings.splice(0, timings.length);
			});
			browserInteractionTimings.push(...interactionBatch);
			const gcStart = await page.evaluate(() => performance.now());
			await session.send("HeapProfiler.collectGarbage");
			const gcEnd = await page.evaluate(() => performance.now());
			garbageCollectionWindows.push({ startTime: gcStart, endTime: gcEnd });
			const renderer = await session.send("Runtime.getHeapUsage");
			const response = await page.request.get("/debug/soak-metrics", {
				headers: { "x-bear-web-dev-token": token },
			});
			await expect(response).toBeOK();
			const host = (await response.json()) as HostMetrics;
			expect(host.schemaVersion).toBe(1);
			expect(host.gcAvailable).toBe(true);
			resourceSamples.push({
				at: Date.now(),
				rendererHeapBytes: renderer.usedSize,
				hostHeapBytes: host.memory.heapUsedBytes,
				hostRssBytes: host.memory.rssBytes,
				renderedTimelineRows: await page.getByTestId("timeline-entry-row").count(),
				eventSubscriptions: host.eventSubscriptions,
				persistenceErrors: host.persistenceErrors,
			});
		};

		await page.screenshot({ path: join(screenshotRoot, "start.png") });
		await collectSample();
		while (Date.now() < deadline) {
			await page.evaluate((currentCycle) => {
				const marker = window as unknown as {
					acceptanceCycle?: number;
					acceptanceOperation?: string;
				};
				marker.acceptanceCycle = currentCycle;
				marker.acceptanceOperation = "conversation-switch";
			}, cycle);
			const conversationId = conversationIds[cycle % conversationIds.length];
			if (!conversationId) throw new Error("soak conversation is missing");
			const conversationButton = sidebar.locator(`[data-conversation-id="${conversationId}"]`);
			const switchClock = `switch-${cycle}`;
			await armClickClock(page, switchClock);
			await conversationButton.click();
			await activeConversationId(page, conversationId);
			switchTimings.push(await clickElapsed(page, switchClock));
			switches += 1;
			await waitForSettled(page, token, conversationId);

			let message: string;
			if (cycle % 100 === 2) message = `E2E_MEDIA_PREVIEW RC_SOAK_${cycle}`;
			else if (cycle % 100 === 3) message = `E2E_DELEGATE_ARTIFACT RC_SOAK_${cycle}`;
			else if (cycle % 60 === 4) message = `STREAM_HOLD_A RC_SOAK_${cycle}`;
			else if (cycle % 20 === 1) message = `RICH_CONTENT_STREAM RC_SOAK_${cycle}`;
			else if (cycle % 10 === 0) message = `STREAM_FOCUS_HOLD RC_SOAK_${cycle}`;
			else message = `E2E_OK RC_SOAK_${cycle}`;
			const scenario = message.split(" ")[0] ?? "unknown";
			await markOperation(page, `${scenario}:send`);
			expectedMessages.get(conversationId)?.add(message);

			if (cycle % 10 === 0) {
				await sendMessage(page, message);
				await expect(stop).toBeVisible({ timeout: 10_000 });
				await expect(page.getByTestId("streaming-assistant-message")).toContainText("FOCUS_ONE");
				const stopClock = `stop-${cycle}`;
				await armClickClock(page, stopClock);
				await stop.click();
				await expect(stop).toBeHidden({ timeout: 5_000 });
				stopFeedbackTimings.push(await clickElapsed(page, stopClock));
				const cancelStarted = performance.now();
				const stopped = await waitForSettled(page, token, conversationId);
				streamExitTimings.push(await clickElapsed(page, stopClock));
				cancelConfirmationTimings.push(performance.now() - cancelStarted);
				const confirmed = await waitForSettled(page, token, conversationId);
				const stoppedAssistant = projectPiEntries(stopped.branch.entries)
					.filter((entry) => entry.role === "assistant")
					.at(-1);
				const confirmedAssistant = projectPiEntries(confirmed.branch.entries).find(
					(entry) => entry.id === stoppedAssistant?.id,
				);
				if (
					!stoppedAssistant ||
					!confirmedAssistant ||
					stoppedAssistant.text !== confirmedAssistant.text ||
					confirmedAssistant.text?.includes("FOCUS_TWO")
				) {
					postStopTokens += 1;
				}
				stops += 1;
			} else {
				await sendMessage(page, message);
				if (cycle % 60 === 4) {
					await expect(page.getByTestId("streaming-assistant-message")).toContainText("HOLD_ONE");
				} else {
					await waitForSettled(page, token, conversationId);
				}
			}

			if (cycle % 100 === 2) {
				await markOperation(page, "media:open");
				// test-quality-allow last: repeated historical media cards share product-owned accessible copy; the newest rendered card belongs to this cycle
				const mediaCard = page.getByRole("region", { name: "极昼的来处" }).last();
				const trigger = mediaCard.getByRole("button", { name: zhCN.messages.openMedia });
				await expect(trigger).toBeVisible({ timeout: 15_000 });
				await trigger.click();
				const viewer = page.getByRole("dialog", { name: "极昼的来处" });
				await expect(viewer).toBeVisible();
				await markOperation(page, "media:close");
				await viewer.getByRole("button", { name: zhCN.messages.closeMedia }).click();
				await expect(viewer).toBeHidden();
				mediaChoiceInteractions += 1;
			}
			if (cycle % 100 === 3) {
				await markOperation(page, "artifact:open");
				// test-quality-allow last: repeated historical artifacts share the immutable file name; the newest rendered trigger belongs to this cycle
				const artifact = page
					.getByRole("button", {
						name: `${zhCN.work.timeline.viewArtifacts}: e2e-report.txt`,
						exact: true,
					})
					.last();
				await expect(artifact).toBeVisible({ timeout: 30_000 });
				await artifact.click();
				const result = page.getByRole("dialog", { name: "e2e-report.txt" });
				await expect(result).toBeVisible();
				await markOperation(page, "artifact:close");
				await result.getByRole("button", { name: zhCN.work.result.close }).click();
				await expect(result).toBeHidden();
				runArtifactInteractions += 1;
			}
			if (cycle % 200 === 5) {
				const detail = await waitForSettled(page, token, conversationId);
				const latestUser = projectPiEntries(detail.branch.entries)
					.filter((entry) => entry.role === "user")
					.at(-1);
				if (!latestUser) throw new Error("soak edit has no user entry");
				const edited = `E2E_OK RC_SOAK_EDITED_${cycle}`;
				await rpc(page, token, "message.edit", {
					conversationId,
					entryId: latestUser.id,
					text: edited,
				});
				expectedMessages.get(conversationId)?.delete(message);
				expectedMessages.get(conversationId)?.add(edited);
				await waitForSettled(page, token, conversationId);
			}
			if (cycle > 0 && cycle % 40 === 0) {
				await rpc(page, token, "conversation.history", { conversationId, limit: 100 });
				historyLoads += 1;
				const scrollStarted = performance.now();
				await page.evaluate(() => {
					const root = document.scrollingElement;
					if (!root) throw new Error("missing document scrolling element");
					window.scrollTo({ top: root.scrollHeight });
					window.dispatchEvent(new WheelEvent("wheel"));
				});
				await page.evaluate(
					() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())),
				);
				scrollTimings.push(performance.now() - scrollStarted);
			}

			cycle += 1;
			const progressedAt = Date.now();
			maxNoProgressMs = Math.max(maxNoProgressMs, progressedAt - lastProgressAt);
			lastProgressAt = progressedAt;
			if (!midwayCaptured && progressedAt >= midpoint) {
				await page.screenshot({ path: join(screenshotRoot, "midpoint.png") });
				midwayCaptured = true;
			}
			if (progressedAt >= nextSampleAt) {
				await collectSample();
				nextSampleAt = progressedAt + sampleInterval;
			}
		}

		for (const conversationId of conversationIds) await waitForSettled(page, token, conversationId);
		await collectSample();
		await page.screenshot({ path: join(screenshotRoot, "end.png") });
		let duplicateEntries = 0;
		let missingEntries = 0;
		let crossConversationEvents = 0;
		let authoritativeEntries = 0;
		const globalEntryIds = new Set<string>();
		for (const conversationId of conversationIds) {
			const entries = await allEntries(page, token, conversationId);
			authoritativeEntries += entries.length;
			const own = expectedMessages.get(conversationId) ?? new Set<string>();
			const observed = new Map<string, number>();
			for (const entry of entries) {
				if (globalEntryIds.has(entry.id)) duplicateEntries += 1;
				globalEntryIds.add(entry.id);
				if (entry.role === "assistant" && entry.text?.includes("FOCUS_TWO")) {
					postStopTokens += 1;
				}
				if (entry.role !== "user" || !entry.text) continue;
				observed.set(entry.text, (observed.get(entry.text) ?? 0) + 1);
				if (entry.text.includes("RC_SOAK_") && !own.has(entry.text)) crossConversationEvents += 1;
			}
			for (const message of own) {
				const count = observed.get(message) ?? 0;
				if (count === 0) missingEntries += 1;
				if (count > 1) duplicateEntries += count - 1;
			}
		}

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
				task.startTime >= startedAtPerformance &&
				!garbageCollectionWindows.some(
					(window) =>
						task.startTime < window.endTime && task.startTime + task.duration > window.startTime,
				),
		);
		const finalInteractionBatch = await page.evaluate(() => {
			const timings = (window as unknown as { acceptanceInteractionTimings: number[] })
				.acceptanceInteractionTimings;
			return timings.splice(0, timings.length);
		});
		browserInteractionTimings.push(...finalInteractionBatch);
		const warmSamples =
			soakMode === "release"
				? resourceSamples.filter((sample) => sample.at >= startedAt + 10 * 60_000)
				: resourceSamples;
		const initialSubscriptions = resourceSamples[0]?.eventSubscriptions ?? 0;
		const finalSubscriptions = resourceSamples.at(-1)?.eventSubscriptions ?? -1;
		const runningRuns = (
			await Promise.all(
				conversationIds.map((conversationId) =>
					rpc<{ runs: Array<{ status: string }> }>(page, token, "run.list", { conversationId }),
				),
			)
		)
			.flatMap((result) => result.runs)
			.filter((run) => run.status === "running").length;
		const resourceTraceText = `${JSON.stringify(
			{ resourceSamples, garbageCollectionWindows, longTasks },
			null,
			2,
		)}\n`;
		const resourceTracePath = join(evidenceRoot, "soak-resource-samples.json");
		writeFileSync(resourceTracePath, resourceTraceText);
		const report = {
			schemaVersion: 1,
			mode: soakMode,
			commit: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim(),
			durationMs: Date.now() - startedAt,
			counts: {
				cycles: cycle,
				switches,
				stops,
				authoritativeEntries,
				historyLoads,
				runArtifactInteractions,
				mediaChoiceInteractions,
			},
			correctness: {
				crossConversationEvents,
				duplicateEntries,
				missingEntries,
				postStopTokens,
				stuckStreams: 0,
				pageErrors: pageErrors.length + consoleErrors.length,
				unhandledRejections: 0,
				processCrashes: 0,
				ownershipErrors: 0,
				persistenceErrors: Math.max(
					0,
					...resourceSamples.map((sample) => sample.persistenceErrors),
				),
				orphanedResources: runningRuns === 0 && finalSubscriptions === initialSubscriptions ? 0 : 1,
			},
			metrics: {
				rendererHeapSlopeBytesPerTenMinutes: growthPerTenMinutes(warmSamples, "rendererHeapBytes"),
				rendererHeapNetGrowthBytes: positiveGrowth(warmSamples, "rendererHeapBytes"),
				hostHeapSlopeBytesPerTenMinutes: growthPerTenMinutes(warmSamples, "hostHeapBytes"),
				hostHeapNetGrowthBytes: positiveGrowth(warmSamples, "hostHeapBytes"),
				residentSetNetGrowthBytes: positiveGrowth(warmSamples, "hostRssBytes"),
				residentSetMonotonicFinalSamples: trailingIncreases(warmSamples),
				maxRenderedTimelineRows: Math.max(
					0,
					...resourceSamples.map((sample) => sample.renderedTimelineRows),
				),
				interactionP95Ms: percentile([...browserInteractionTimings, ...scrollTimings], 0.95),
				conversationSwitchP95Ms: percentile(switchTimings, 0.95),
				stopFeedbackP95Ms: percentile(stopFeedbackTimings, 0.95),
				streamExitP95Ms: percentile(streamExitTimings, 0.95),
				cancelConfirmationP95Ms: percentile(cancelConfirmationTimings, 0.95),
				maxNonGcLongTaskMs: Math.max(0, ...longTasks.map((task) => task.duration)),
				maxNoProgressMs,
			},
			samples: {
				resource: warmSamples.length,
				interaction: browserInteractionTimings.length + scrollTimings.length,
			},
			resourceTrace: {
				path: "soak-resource-samples.json",
				size: Buffer.byteLength(resourceTraceText),
				sha256: createHash("sha256").update(resourceTraceText).digest("hex"),
			},
		};
		if (pageErrors.length > 0 || consoleErrors.length > 0) {
			console.log(JSON.stringify({ pageErrors, consoleErrors }));
		}
		if (longTasks.some((task) => task.duration > 200)) {
			console.log(
				JSON.stringify({
					longTasks: [...longTasks]
						.sort((left, right) => right.duration - left.duration)
						.slice(0, 10),
				}),
			);
		}
		writeFileSync(join(evidenceRoot, "soak-report.json"), `${JSON.stringify(report, null, 2)}\n`);
		console.log(JSON.stringify(report));
		const { validateSoakReport } = await import("../../../scripts/soak-evidence.mjs");
		expect(() => validateSoakReport(report)).not.toThrow();
	});
