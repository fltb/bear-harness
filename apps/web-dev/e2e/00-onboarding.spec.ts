import { productUi } from "@bear-harness/product-config";
import { expect, test } from "playwright/test";

test("browser requires a reply model before the role-defined onboarding", async ({ page }) => {
	await page.goto("/");

	const modelSetup = page.getByRole("dialog", { name: productUi.modelSetup.dialogLabel });
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: productUi.modelSetup.title })).toBeVisible();
	await expect(
		modelSetup.getByRole("combobox", { name: productUi.settings.serviceLabel }),
	).toBeVisible();
	await expect(
		modelSetup.getByRole("combobox", { name: productUi.modelSetup.modelLabel }),
	).toBeVisible();

	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const providerResult = await (
		await page.request.post("/rpc/provider.list%3Av1", { headers, data: {} })
	).json();
	const provider = providerResult.data.providers.find(
		(item: { authType: string; availableModels: Array<{ id: string }> }) =>
			item.authType === "api_key" && item.availableModels.length > 0,
	);
	if (!provider) throw new Error("test catalog has no API-key provider");
	await page.request.post("/rpc/provider.setApiKey%3Av1", {
		headers,
		data: { providerId: provider.id, apiKey: "test-key", sessionOnly: true },
	});
	await page.request.post("/rpc/voice.pin%3Av1", {
		headers,
		data: {
			providerId: provider.id,
			modelId: provider.availableModels[0].id,
			label: provider.name,
		},
	});
	await page.reload();

	const onboarding = page.getByRole("dialog", { name: "首次入场" });
	await expect(onboarding).toBeVisible();
	await onboarding.getByRole("button", { name: "把门打开" }).dblclick();
	await expect.poll(() => onboarding.getAttribute("data-onboarding-step")).toBe("introduced");
	await expect(onboarding.getByRole("alert")).toHaveCount(0);
	await onboarding.getByRole("button", { name: productUi.messages.continue }).click();
	await onboarding.getByRole("textbox", { name: "希望我怎么称呼你？" }).fill("林");
	await onboarding.getByRole("button", { name: "确认" }).click();
	await onboarding.getByRole("button", { name: "一起做事的搭档" }).click();
	await onboarding.getByRole("button", { name: "可以，记住我们之间的事" }).click();

	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
});
