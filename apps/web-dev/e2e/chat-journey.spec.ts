import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

test("chat streams once and edited history regenerates once through the UI", async ({ page }) => {
	await ensureReadyForConversation(page);

	await sendMessage(page, "STREAM_CHECK");
	await expect(page.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await page.reload();
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(page.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
});
