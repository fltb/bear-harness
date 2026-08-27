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

	await sendMessage(page, "STREAM_CHECK");
	await expect(page.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	expect(gapWarnings).toEqual([]);
	await page.reload();
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(page.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	expect(pageErrors).toEqual([]);
});
