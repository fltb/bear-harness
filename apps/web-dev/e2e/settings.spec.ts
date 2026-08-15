import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { expect, test } from "playwright/test";

test("browser completes the real role-defined onboarding without a provider gate", async ({
	page,
}) => {
	await page.goto("/");

	const onboarding = page.getByRole("dialog");
	await expect(onboarding).toBeVisible();
	const advance = async () => {
		const previous = await onboarding.getAttribute("data-onboarding-step");
		await onboarding.getByRole("button").first().click();
		await expect.poll(() => onboarding.getAttribute("data-onboarding-step")).not.toBe(previous);
	};

	await onboarding.getByRole("button").first().dblclick();
	await expect.poll(() => onboarding.getAttribute("data-onboarding-step")).toBe("introduced");
	await expect(onboarding.getByRole("alert")).toHaveCount(0);
	await page.waitForTimeout(500);
	await expect(onboarding).toHaveAttribute("data-onboarding-step", "introduced");
	await advance();

	const name = onboarding.getByRole("textbox");
	await name.fill("林");
	await advance();
	await advance();
	await onboarding.getByRole("button").first().click();

	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
});

test("WebDev exposes every registered Host RPC channel through its authenticated console", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Web Dev" }).click();

	const panel = page.getByRole("complementary", { name: "Web Dev 调试工具" });
	const expectedChannels = Object.keys(REQUEST_SCHEMAS).sort();
	const rpcChannel = panel.getByRole("combobox");
	await expect.poll(() => rpcChannel.locator("option").count()).toBe(expectedChannels.length);
	await expect(rpcChannel.locator("option")).toHaveText(expectedChannels);
	await panel.getByRole("button", { name: "调用真实 Host" }).click();
	await expect(panel.locator("pre")).toContainText('"ok"');
});

test("browser drives conversation, backstage, settings, queue and declared disabled controls", async ({
	page,
}) => {
	await page.goto("/");

	const conversations = page.getByRole("navigation", { name: "对话" });
	const before = await conversations.getByRole("button").count();
	await page.getByRole("button", { name: "新建对话" }).click();
	await expect.poll(() => conversations.getByRole("button").count()).toBe(before + 1);
	await expect(conversations.locator("[aria-current='page']")).toHaveCount(1);
	await conversations.getByRole("button").last().click();
	await expect(conversations.getByRole("button").last()).toHaveAttribute("aria-current", "page");

	const queue = page.getByRole("button", { name: "进行中的事 0" });
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("menu", { name: "进行中的事" })).toBeVisible();
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "false");

	await expect(page.getByRole("button", { name: "搜索 ⌘K" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "添加材料（尚未接入）" })).toBeDisabled();

	await page.getByRole("button", { name: "幕后" }).click();
	const backstage = page.getByRole("dialog");
	await expect(backstage).toBeVisible();
	await backstage.getByRole("tab", { name: "系统设置" }).click();
	const relationshipMemory = backstage.getByRole("switch");
	await expect(relationshipMemory).toBeEnabled();
	const previousMemory = await relationshipMemory.getAttribute("aria-checked");
	await relationshipMemory.click();
	await expect(relationshipMemory).not.toHaveAttribute("aria-checked", previousMemory ?? "");
});
