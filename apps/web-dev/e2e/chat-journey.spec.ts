import { productUi } from "@bear-harness/product-config";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

test("chat streams once and edited history regenerates once through the UI", async ({ page }) => {
	await ensureReadyForConversation(page);

	await sendMessage(page, "STREAM_CHECK");
	await expect(page.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	await expect(page.getByRole("status", { name: productUi.messages.responding })).toBeVisible();
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(page.getByRole("status", { name: productUi.messages.responding })).toBeHidden();
	await expect(page.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);

	const userMessage = page
		.getByRole("article")
		.filter({ has: page.getByText("STREAM_CHECK", { exact: true }) });
	await userMessage.getByRole("button", { name: productUi.messages.edit }).click();
	const editor = userMessage.getByRole("textbox", { name: productUi.messages.editLabel });
	await editor.fill("规则：回复 EDITED_OK");
	await userMessage.getByRole("button", { name: productUi.messages.save }).click();

	await expect(page.getByText("EDITED_OK", { exact: true })).toHaveCount(1);
	await expect(page.getByRole("status", { name: productUi.messages.responding })).toBeHidden();
	await page.reload();
	await expect(page.getByText("EDITED_OK", { exact: true })).toHaveCount(1);
	await expect(page.getByText("规则：回复 EDITED_OK", { exact: true })).toHaveCount(1);
});
