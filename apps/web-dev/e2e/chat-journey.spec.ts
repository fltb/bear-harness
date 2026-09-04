import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

test("chat streams once and edited history regenerates once through the UI", async ({ page }) => {
	const gapWarnings: string[] = [];
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.exposeFunction("recordChatWarning", (message: string) => gapWarnings.push(message));
	await page.addInitScript(() => {
		const observer = new MutationObserver(() => {
			if (document.body?.textContent?.includes("event sequence gap")) {
				void (
					window as unknown as { recordChatWarning(message: string): Promise<void> }
				).recordChatWarning("event sequence gap");
			}
		});
		observer.observe(document, { childList: true, subtree: true, characterData: true });
	});
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });

	await sendMessage(page, "STREAM_CHECK");
	await expect(thread.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	await expect(thread.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(thread.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
	await expect(thread.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	expect(gapWarnings).toEqual([]);
	await page.reload();
	await expect(thread.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(thread.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	expect(pageErrors).toEqual([]);
});

test("one MessageContent projection renders rich streaming output and the settled snapshot", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await sendMessage(page, "RICH_CONTENT_STREAM");

	const response = thread.getByRole("article", { name: "极昼" }).filter({ hasText: "交接结果" });
	await expect(response.getByRole("heading", { name: "交接结果" })).toBeVisible();
	expect(await response.getByText("状态：完成").evaluate((element) => element.tagName)).toBe(
		"STRONG",
	);
	await expect(response.getByRole("listitem")).toHaveCount(2);
	await expect(response.getByRole("table")).toBeVisible();
	expect(
		await response
			.getByText("const total = price * nights;")
			.evaluate((element) => [element.parentElement?.tagName, element.tagName]),
	).toEqual(["PRE", "CODE"]);
	await expect(response.getByRole("math")).toBeVisible();
	await expect(response.getByTestId("message-content")).not.toHaveAttribute("aria-busy", "true");

	await page.reload();
	const settled = thread.getByRole("article", { name: "极昼" }).filter({ hasText: "交接结果" });
	await expect(settled.getByRole("heading", { name: "交接结果" })).toBeVisible();
	await expect(settled.getByText("const total = price * nights;")).toBeVisible();
	await expect(settled.getByRole("math")).toBeVisible();
});

test("refreshing a running conversation restores its authoritative stream", async ({ page }) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await sendMessage(page, "STREAM_HOLD_A");
	await expect(thread.getByText("HOLD_ONE", { exact: false })).toBeVisible();

	await page.reload();

	await expect(thread.getByText("HOLD_ONE", { exact: false })).toBeVisible();
	const announcement = page.getByTestId("conversation-announcement");
	await expect(announcement).toHaveText(zhCN.messages.responding);
	await expect(thread.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await expect(announcement).toHaveText("");
});

test("two Pi sessions can run concurrently, switch locally, and finish without stealing focus", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const sessionAId = await sidebar
		.getByRole("button")
		.evaluateAll((buttons) =>
			buttons
				.find((button) => button.getAttribute("aria-current") === "page")
				?.getAttribute("data-conversation-id"),
		);
	if (!sessionAId) throw new Error("active conversation has no identity");
	await sendMessage(page, "STREAM_HOLD_A");
	await expect(
		sidebar.locator(`[data-conversation-id="${sessionAId}"] .conversation-running`),
	).toBeVisible();
	await expect(page.getByTestId("conversation-announcement")).toHaveText(zhCN.messages.responding);
	await expect(thread.getByText(/HOLD_ONE/)).toBeVisible();

	await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
	await expect(thread.getByText(/HOLD_ONE/)).toBeHidden();
	await sendMessage(page, "E2E_OK session B stays focused");
	await expect(thread.getByText("E2E_OK", { exact: true })).toBeVisible();

	const sessionA = sidebar.locator(`[data-conversation-id="${sessionAId}"]`);
	await expect(sessionA).toBeVisible();
	await expect(thread.getByText("E2E_OK", { exact: true })).toBeVisible();
	await expect(thread.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toBeHidden();
	await expect(sessionA.getByRole("status", { name: zhCN.sidebar.responseReady })).toBeVisible({
		timeout: 15_000,
	});
	await sessionA.click();
	await expect(thread.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toBeVisible();
	await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
});

test("a local path is ordinary natural-language user input", async ({ page }) => {
	await ensureReadyForConversation(page);
	const path = fileURLToPath(new URL("./fixtures/local-note.txt", import.meta.url));
	const message = `请读一下这个本机文件并告诉我重点：${path}`;
	await sendMessage(page, message);
	await expect(
		page.getByRole("region", { name: zhCN.messages.conversation }).getByText(message, {
			exact: true,
		}),
	).toHaveCount(1);
});

test("latest assistant reply branches through the UI and activates the native fork", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const activeConversationId = async () =>
		sidebar
			.getByRole("button")
			.evaluateAll((buttons) =>
				buttons
					.find((button) => button.getAttribute("aria-current") === "page")
					?.getAttribute("data-conversation-id"),
			);
	const previousConversationId = await activeConversationId();
	await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
	await expect
		.poll(async () => {
			const current = await activeConversationId();
			return Boolean(current && current !== previousConversationId);
		})
		.toBe(true);
	const sourceConversationId = await activeConversationId();
	if (!sourceConversationId) throw new Error("source conversation has no identity");

	await sendMessage(page, "E2E_OK branch source");
	const reply = thread.getByText("E2E_OK", { exact: true });
	await expect(reply).toBeVisible();
	await thread.getByRole("button", { name: zhCN.messages.branch }).click();

	await expect
		.poll(async () => {
			const current = await activeConversationId();
			return Boolean(current && current !== sourceConversationId);
		})
		.toBe(true);
	const forkConversationId = await activeConversationId();
	if (!forkConversationId) throw new Error("fork conversation has no identity");
	await expect(thread.getByText("E2E_OK", { exact: true })).toBeVisible();
	await expect(sidebar.locator(`[data-conversation-id="${sourceConversationId}"]`)).toBeVisible();
	await expect(sidebar.locator(`[data-conversation-id="${forkConversationId}"]`)).toHaveAttribute(
		"aria-current",
		"page",
	);
});
