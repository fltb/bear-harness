import { productUi } from "@bear-harness/product-config";
import { expect, type Page } from "playwright/test";

export async function ensureReadyForConversation(page: Page): Promise<void> {
	await page.goto("/");
	const modelSetup = page.getByRole("dialog", { name: productUi.modelSetup.dialogLabel });
	if (await modelSetup.isVisible()) {
		await modelSetup
			.getByRole("combobox", { name: productUi.settings.serviceLabel })
			.selectOption("e2e-rule");
		await modelSetup
			.getByRole("combobox", { name: productUi.modelSetup.modelLabel })
			.selectOption("rule-model");
		await modelSetup.getByRole("button", { name: productUi.modelSetup.continue }).click();
		await expect(modelSetup).toBeHidden();
	}

	const onboarding = page.getByRole("dialog", { name: "首次入场" });
	if (await onboarding.isVisible()) {
		await onboarding.getByRole("button", { name: "把门打开" }).click();
		await onboarding.getByRole("button", { name: productUi.messages.continue }).click();
		await onboarding.getByRole("textbox", { name: "希望我怎么称呼你？" }).fill("林");
		await onboarding.getByRole("button", { name: "确认" }).click();
		await onboarding.getByRole("button", { name: "一起做事的搭档" }).click();
		await onboarding.getByRole("button", { name: "可以，记住我们之间的事" }).click();
		await expect(onboarding).toBeHidden();
	}

	await page.getByRole("button", { name: productUi.sidebar.newConversation }).click();
	await expect(
		page.getByRole("textbox", { name: productUi.composer.messageInputLabel }),
	).toBeEnabled();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
	const composer = page.getByRole("textbox", { name: productUi.composer.messageInputLabel });
	await composer.fill(text);
	await page.getByRole("button", { name: productUi.composer.sendLabel }).click();
}
