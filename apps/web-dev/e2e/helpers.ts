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
	await page.request.post("/rpc/model.defaults.setReply%3Av1", {
		headers,
		data: { reply: { providerId: "e2e-rule", modelId: "rule-model" } },
	});

	let onboardingState = await (
		await page.request.post("/rpc/onboarding.get%3Av1", { headers, data: {} })
	).json();
	const onboardingAnswers: Record<string, string | undefined> = {
		door_closed: undefined,
		introduced: undefined,
		naming: "林",
		relation: "partner",
		memory_decision: "remember",
	};
	while (onboardingState.data.status === "active") {
		const stepId = onboardingState.data.currentStepId as string;
		if (!(stepId in onboardingAnswers)) throw new Error(`Unhandled onboarding step: ${stepId}`);
		onboardingState = await (
			await page.request.post("/rpc/onboarding.submit%3Av1", {
				headers,
				data: { stepId, answer: onboardingAnswers[stepId] },
			})
		).json();
	}
	await page.reload();
	await expect(page.getByRole("dialog", { name: "首次入场" })).toBeHidden();

	await page.getByRole("button", { name: zhCN.sidebar.newConversation }).click();
	const model = page.getByRole("button", { name: zhCN.composer.modelLabel });
	await expect(model).toContainText("E2E Rule Provider");
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill(text);
	await page.getByRole("button", { name: zhCN.composer.sendLabel }).click();
}
