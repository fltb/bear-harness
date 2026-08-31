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
	await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
	await expect(thread.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	expect(gapWarnings).toEqual([]);
	await page.reload();
	await expect(thread.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(thread.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	expect(pageErrors).toEqual([]);
});

test("two Pi sessions can run concurrently, switch locally, and finish without stealing focus", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await sendMessage(page, "STREAM_HOLD_A");
	await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeVisible();
	await expect(thread.getByText(/HOLD_ONE/)).toBeVisible();

	await page.getByRole("button", { name: zhCN.sidebar.newConversation, exact: true }).click();
	await expect(thread.getByText(/HOLD_ONE/)).toBeHidden();
	await sendMessage(page, "E2E_OK session B stays focused");
	await expect(thread.getByText("E2E_OK", { exact: true })).toBeVisible();

	const sessionA = page
		.getByRole("navigation", { name: zhCN.sidebar.conversations })
		.getByRole("button", { name: /HOLD_ONE HOLD_TWO/ });
	await expect(sessionA).toBeVisible();
	await expect(thread.getByText("E2E_OK", { exact: true })).toBeVisible();
	await expect(thread.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toBeHidden();
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
