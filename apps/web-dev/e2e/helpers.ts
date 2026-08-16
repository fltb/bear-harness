import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, type Page } from "playwright/test";

export async function selectKobalteOption(
	page: Page,
	trigger: Locator,
	optionName: string | RegExp,
): Promise<void> {
	await trigger.click();
	const option = page.getByRole("option", {
		name: optionName,
		exact: typeof optionName === "string",
	});
	await expect(option).toBeVisible();
	await option.click();
}

export async function ensureReadyForConversation(page: Page): Promise<void> {
	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	await page.request.post("/rpc/provider.setApiKey%3Av1", {
		headers,
		data: { providerId: "e2e-rule", apiKey: "e2e-rule-key", sessionOnly: true },
	});
	await page.request.post("/rpc/model.enable%3Av1", {
		headers,
		data: { providerId: "e2e-rule", modelId: "rule-model", label: "E2E Rule Provider" },
	});
	await page.reload();

	const onboardingState = await (
		await page.request.post("/rpc/onboarding.get%3Av1", { headers, data: {} })
	).json();
	const onboarding = page.getByRole("dialog", { name: "首次入场" });
	if (onboardingState.data.status === "active") {
		await expect(onboarding).toBeVisible();
		await onboarding.getByRole("button", { name: "把门打开" }).click();
		await onboarding.getByRole("button", { name: zhCN.messages.continue }).click();
		await onboarding.getByRole("textbox", { name: "希望我怎么称呼你？" }).fill("林");
		await onboarding.getByRole("button", { name: "确认" }).click();
		await onboarding.getByRole("button", { name: "一起做事的搭档" }).click();
		await onboarding.getByRole("button", { name: "可以，记住我们之间的事" }).click();
		await expect(onboarding).toBeHidden();
	}

	await page.getByRole("button", { name: zhCN.sidebar.newConversation }).click();
	const model = page.getByRole("button", { name: zhCN.composer.modelLabel });
	await Promise.all([
		page.waitForResponse((response) => response.url().includes("/rpc/model.route.set%3Av1")),
		selectKobalteOption(page, model, /^E2E Rule Provider \(/),
	]);
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill(text);
	await page.getByRole("button", { name: zhCN.composer.sendLabel }).click();
}
