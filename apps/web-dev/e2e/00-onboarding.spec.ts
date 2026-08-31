import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { selectKobalteOption } from "./helpers";

test("browser requires a reply model before the role-defined onboarding", async ({ page }) => {
	let eventRequests = 0;
	page.on("request", (request) => {
		if (request.url().includes("/rpc/events.subscribe%3Av1")) {
			eventRequests++;
			expect(request.headers().accept).toBe("application/x-ndjson");
		}
	});
	const provider = {
		id: "e2e-rule",
		name: "E2E Rule Provider",
		modelId: "rule-model",
	};
	await page.goto("/");
	const modelSetup = page.getByRole("dialog", {
		name: zhCN.modelSetup.dialogLabel,
	});
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.title })).toBeVisible();
	const providerSetup = modelSetup.getByRole("region", {
		name: zhCN.settings.providerSetupLabel,
	});
	await providerSetup.getByText(zhCN.settings.customProvider, { exact: true }).click();
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customProviderId })
		.fill(provider.id);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customServiceName })
		.fill(provider.name);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customBaseUrl })
		.fill(`http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.customModels })
		.fill(provider.modelId);
	await providerSetup
		.getByRole("textbox", { name: zhCN.settings.apiKeyLabel })
		.fill("e2e-rule-key");
	await providerSetup.getByRole("button", { name: zhCN.settings.addProvider }).click();
	const replyModel = modelSetup.getByRole("button", { name: zhCN.modelSetup.modelLabel });
	await expect(replyModel).toBeVisible();
	await selectKobalteOption(page, replyModel, /rule-model/);
	await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.continue })).toBeEnabled();
	expect(eventRequests).toBeGreaterThanOrEqual(1);
	await page.reload();
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.continue })).toBeEnabled();
	await modelSetup.getByRole("button", { name: zhCN.modelSetup.continue }).click();
	const embeddingSetup = page.getByRole("dialog", {
		name: zhCN.settings.memoryVectorSection,
	});
	await expect(embeddingSetup).toBeVisible();
	const embeddingContinue = embeddingSetup.getByRole("button", {
		name: zhCN.messages.continue,
	});
	await expect(embeddingContinue).toBeEnabled();
	await embeddingContinue.click();

	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.roleTitle })).toBeVisible();
	await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.confirmRole })).toBeEnabled();
	// A renderer restart after system setup resumes at the character-owned route
	// confirmation and never repeats providers or embedding.
	await page.reload();
	await expect(embeddingSetup).toBeHidden();
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.roleTitle })).toBeVisible();
	await modelSetup.getByRole("button", { name: zhCN.modelSetup.confirmRole }).click();

	const onboarding = page.getByRole("dialog", { name: "开始相处" });
	await expect(onboarding).toBeVisible();
	// Setup progress is Host-owned: a new renderer resumes role onboarding and
	// never regresses to either system or character model setup.
	await page.reload();
	await expect(modelSetup).toBeHidden();
	await expect(embeddingSetup).toBeHidden();
	await expect(onboarding).toBeVisible();
	const [submitResponse, resyncResponse] = await Promise.all([
		page.waitForResponse((response) => response.url().includes("/rpc/onboarding.submit%3Av1")),
		page.waitForResponse(async (response) => {
			if (!response.url().includes("/rpc/onboarding.get%3Av1")) return false;
			const payload = await response.json();
			return payload.ok === true && payload.data?.currentStepId === "nickname";
		}),
		onboarding.getByRole("button", { name: "让他进来" }).click(),
	]);
	const submitted = await submitResponse.json();
	const resynced = await resyncResponse.json();
	expect(submitted.ok).toBe(true);
	expect(submitted.data.currentStepId).toBe("nickname");
	expect(resynced.ok).toBe(true);
	expect(resynced.data.currentStepId).toBe("nickname");
	await expect.poll(() => onboarding.getAttribute("data-onboarding-step")).toBe("nickname");
	await onboarding.getByRole("textbox", { name: "你的称呼" }).fill("林");
	await onboarding.getByRole("button", { name: "告诉他" }).click();

	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
	await page.reload();
	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
	expect(eventRequests).toBeGreaterThanOrEqual(3); // one persistent connection per observed page load
});
