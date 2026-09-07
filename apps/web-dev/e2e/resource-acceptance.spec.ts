import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { activeConversationId, ensureReadyForConversation, getBootstrap } from "./helpers";

test("10,000 loaded authoritative entries keep a bounded virtual DOM and stable focus", async ({
	page,
}) => {
	test.setTimeout(360_000);
	const startedAt = performance.now();
	await ensureReadyForConversation(page);
	const conversationId = await activeConversationId(page);
	const bootstrap = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const activeEnvelope = await (
		await page.request.post("/rpc/conversation.activeGet", { headers, data: {} })
	).json();
	const original = activeEnvelope.data.activeConversation;
	if (!original) throw new Error("expected an active conversation");
	const entries = Array.from({ length: 10_000 }, (_, index) => ({
		type: "message",
		id: `virtual-message-${index}`,
		parentId: index > 0 ? `virtual-message-${index - 1}` : null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: `Virtual message ${index}`, timestamp: index },
	}));
	const latestEntries = entries.slice(-100);
	const detail = {
		...original,
		conversationId,
		branch: {
			...original.branch,
			entries: latestEntries,
			hasMoreBefore: true,
			activeLeafId: "virtual-message-9999",
			latestLeafIds: ["virtual-message-9999"],
		},
	};
	await page.route("**/rpc/**", async (route) => {
		const url = route.request().url();
		if (url.endsWith("/rpc/conversation.activeGet")) {
			await route.fulfill({ json: { ok: true, data: { activeConversation: detail } } });
			return;
		}
		if (url.endsWith("/rpc/conversation.select")) {
			await route.fulfill({ json: { ok: true, data: { activeConversation: detail } } });
			return;
		}
		if (url.endsWith("/rpc/conversation.open")) {
			await route.fulfill({ json: { ok: true, data: detail } });
			return;
		}
		if (url.endsWith("/rpc/conversation.history")) {
			const request = route.request().postDataJSON() as { beforeEntryId?: string };
			const prefix = "virtual-message-";
			const end = request.beforeEntryId?.startsWith(prefix)
				? Number(request.beforeEntryId.slice(prefix.length))
				: entries.length;
			const start = Math.max(0, end - 100);
			await route.fulfill({
				json: {
					ok: true,
					data: {
						entries: entries.slice(start, end),
						...(start > 0 ? { nextCursor: entries[start]?.id } : {}),
					},
				},
			});
			return;
		}
		await route.continue();
	});
	await page.reload();

	const timeline = page.getByTestId("virtual-timeline");
	await expect(timeline).toHaveAttribute("data-item-count", "100", { timeout: 30_000 });
	await page.evaluate(() => {
		window.scrollTo({ top: 0 });
		window.dispatchEvent(new WheelEvent("wheel"));
	});
	const loadOlder = page.getByRole("button", { name: zhCN.messages.native.loadOlder });
	for (let expectedCount = 200; expectedCount <= 10_000; expectedCount += 100) {
		await loadOlder.click();
		await expect(timeline).toHaveAttribute("data-item-count", String(expectedCount));
		if (expectedCount % 1_000 === 0)
			console.log(
				JSON.stringify({ loadedEntries: expectedCount, elapsedMs: performance.now() - startedAt }),
			);
	}
	await expect(loadOlder).toBeHidden();
	const renderedItems = page.getByTestId("virtual-timeline-item");
	await expect.poll(() => renderedItems.count()).toBeLessThan(80);
	await page.evaluate(() => {
		window.scrollTo({ top: 0 });
		window.dispatchEvent(new WheelEvent("wheel"));
	});
	const first = page.getByRole("article", { name: zhCN.messages.you }).filter({
		hasText: "Virtual message 0",
	});
	await expect(first).toBeVisible();
	const firstCopy = first.getByRole("button", { name: zhCN.messages.copy });
	await firstCopy.focus();
	await expect(firstCopy).toBeFocused();

	await page.evaluate(() => {
		const scrollingElement = document.scrollingElement;
		if (!scrollingElement) throw new Error("missing document scrolling element");
		window.scrollTo({ top: scrollingElement.scrollHeight / 2 });
		window.dispatchEvent(new WheelEvent("wheel"));
	});
	await expect
		.poll(async () => {
			const indexes = await renderedItems.evaluateAll((items) =>
				items.flatMap((item) => {
					const value = Number(item.getAttribute("data-index"));
					return Number.isFinite(value) ? [value] : [];
				}),
			);
			return indexes.some((index) => index > 4_000 && index < 6_000);
		})
		.toBe(true);
	await expect(firstCopy).toBeFocused();
	await expect.poll(() => renderedItems.count()).toBeLessThan(80);

	await page.evaluate(() => {
		const scrollingElement = document.scrollingElement;
		if (!scrollingElement) throw new Error("missing document scrolling element");
		window.scrollTo({ top: scrollingElement.scrollHeight });
		window.dispatchEvent(new WheelEvent("wheel"));
	});
	await expect(page.getByText("Virtual message 9999", { exact: true })).toBeVisible();
	await expect(firstCopy).toBeFocused();
	await expect.poll(() => renderedItems.count()).toBeLessThan(80);
	console.log(
		JSON.stringify({
			loadedEntries: 10_000,
			renderedItems: await renderedItems.count(),
			elapsedMs: performance.now() - startedAt,
		}),
	);
});

test("500 A/B switches preserve isolation within the frozen latency and heap budget", async ({
	page,
}) => {
	test.setTimeout(180_000);
	await ensureReadyForConversation(page);
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	const firstId = await activeConversationId(page);
	await composer.fill("A isolated draft");
	await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
	let secondId = firstId;
	await expect
		.poll(async () => {
			secondId = await activeConversationId(page);
			return secondId === firstId;
		})
		.toBe(false);
	await composer.fill("B isolated draft");

	const session = await page.context().newCDPSession(page);
	await session.send("HeapProfiler.collectGarbage");
	const before = await session.send("Runtime.getHeapUsage");
	const measurements = await sidebar.getByRole("button").evaluateAll(
		async (buttons, ids) => {
			const selected = buttons.filter((button) =>
				ids.includes(button.dataset.conversationId ?? ""),
			);
			if (selected.length !== 2) throw new Error("expected two conversation controls");
			const timings: number[] = [];
			for (let index = 0; index < 500; index += 1) {
				const target = selected[index % 2];
				if (!target) throw new Error("missing conversation control");
				const started = performance.now();
				target.click();
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				timings.push(performance.now() - started);
			}
			return timings;
		},
		[firstId, secondId],
	);
	await session.send("HeapProfiler.collectGarbage");
	const after = await session.send("Runtime.getHeapUsage");
	const ordered = [...measurements].sort((left, right) => left - right);
	const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
	const heapGrowth = Math.max(0, after.usedSize - before.usedSize);
	expect(p95).toBeLessThanOrEqual(250);
	expect(heapGrowth).toBeLessThanOrEqual(15 * 1024 * 1024);
	expect(heapGrowth).toBeLessThanOrEqual(before.usedSize * 0.1);

	await sidebar.locator(`[data-conversation-id="${firstId}"]`).click();
	await expect(composer).toHaveValue("A isolated draft");
	await sidebar.locator(`[data-conversation-id="${secondId}"]`).click();
	await expect(composer).toHaveValue("B isolated draft");
});
