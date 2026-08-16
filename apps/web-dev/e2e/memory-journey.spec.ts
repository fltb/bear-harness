import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

test("relationship-memory setting and edits change the next model context", async ({ page }) => {
	await ensureReadyForConversation(page);

	await page.getByRole("button", { name: zhCN.titlebar.backstage }).click();
	let backstage = page.getByRole("dialog", { name: zhCN.backstage.title });
	await backstage.getByRole("tab", { name: zhCN.backstage.relationshipArchive }).click();
	const memorySwitch = backstage.getByRole("switch", {
		name: zhCN.settings.relationshipMemory,
	});
	if ((await memorySwitch.getAttribute("aria-checked")) !== "true") await memorySwitch.click();
	await expect(memorySwitch).toHaveAttribute("aria-checked", "true");
	await backstage.getByRole("button", { name: zhCN.backstage.close }).click();

	await sendMessage(page, "请记住：我们约定暗号是北辰");
	await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
	await sendMessage(page, "检查记忆上下文");
	const originalReply = page.getByText("MEMORY_CONTEXT:我们约定暗号是北辰", { exact: true });
	await expect(originalReply).toHaveCount(1);

	await page.getByRole("button", { name: zhCN.titlebar.backstage }).click();
	backstage = page.getByRole("dialog", { name: zhCN.backstage.title });
	await backstage.getByRole("tab", { name: zhCN.backstage.memory }).click();
	await backstage.getByRole("tab", { name: zhCN.memory.scopes.relationship }).click();
	const entries = backstage.getByRole("region", { name: zhCN.memory.defaultEntriesTitle });
	await expect(entries.getByText("我们约定暗号是北辰", { exact: true })).toBeVisible();
	await entries.getByRole("button", { name: zhCN.memory.edit }).click();
	const editor = entries.getByRole("textbox", { name: zhCN.memory.editedContent });
	await editor.fill("我们约定暗号是南星");
	await entries.getByRole("button", { name: zhCN.memory.saveEdit }).click();
	await expect(entries.getByText("我们约定暗号是南星", { exact: true })).toBeVisible();
	await expect(entries.getByText("我们约定暗号是北辰", { exact: true })).toBeHidden();
	await backstage.getByRole("button", { name: zhCN.backstage.close }).click();

	await sendMessage(page, "检查记忆上下文");
	await expect(page.getByText("MEMORY_CONTEXT:我们约定暗号是南星", { exact: true })).toHaveCount(1);

	await page.getByRole("button", { name: zhCN.titlebar.backstage }).click();
	backstage = page.getByRole("dialog", { name: zhCN.backstage.title });
	await backstage.getByRole("tab", { name: zhCN.backstage.relationshipArchive }).click();
	await backstage.getByRole("switch", { name: zhCN.settings.relationshipMemory }).click();
	await expect(
		backstage.getByRole("switch", { name: zhCN.settings.relationshipMemory }),
	).toHaveAttribute("aria-checked", "false");
	await backstage.getByRole("button", { name: zhCN.backstage.close }).click();

	await sendMessage(page, "检查记忆上下文");
	await expect(page.getByText("MEMORY_CONTEXT:ABSENT", { exact: true })).toHaveCount(1);
	await page.reload();
	await page.getByRole("button", { name: zhCN.titlebar.backstage }).click();
	await page
		.getByRole("dialog", { name: zhCN.backstage.title })
		.getByRole("tab", { name: zhCN.backstage.relationshipArchive })
		.click();
	await expect(
		page.getByRole("switch", { name: zhCN.settings.relationshipMemory }),
	).toHaveAttribute("aria-checked", "false");
});
