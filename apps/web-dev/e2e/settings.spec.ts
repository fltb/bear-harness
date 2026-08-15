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
