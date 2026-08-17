import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { selectKobalteOption } from "./helpers";

test("browser requires a reply model before the role-defined onboarding", async ({ page }) => {
	await page.goto("/");

	const modelSetup = page.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.title })).toBeVisible();
	await expect(modelSetup.getByRole("button", { name: zhCN.settings.serviceLabel })).toBeVisible();
	await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.modelLabel })).toBeDisabled();

	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const provider = {
		id: "e2e-onboarding",
		name: "E2E Onboarding Provider",
		modelId: "onboarding-model",
	};
	const configured = await (
		await page.request.post("/rpc/provider.customUpsert%3Av1", {
			headers: { "x-bear-web-dev-token": bootstrap.token },
			data: {
				providerId: provider.id,
				name: provider.name,
				baseUrl: "https://example.invalid/v1",
				modelId: provider.modelId,
			},
		})
	).json();
	expect(configured).toMatchObject({ ok: true });
	await page.reload();
	await expect(modelSetup).toBeVisible();
	await selectKobalteOption(
		page,
		modelSetup.getByRole("button", { name: zhCN.settings.serviceLabel }),
		provider.name,
	);
	await modelSetup.getByLabel(zhCN.settings.apiKeyLabel).fill("test-provider-key");
	await modelSetup.getByRole("button", { name: zhCN.settings.saveKey }).click();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const enabled = await (
		await page.request.post("/rpc/model.enable%3Av1", {
			headers,
			data: { providerId: provider.id, modelId: provider.modelId, label: provider.name },
		})
	).json();
	expect(enabled).toMatchObject({ ok: true });
	const defaults = await (
		await page.request.post("/rpc/model.defaults.setReply%3Av1", {
			headers,
			data: { reply: { providerId: provider.id, modelId: provider.modelId } },
		})
	).json();
	expect(defaults).toMatchObject({ ok: true });
	await page.reload();
	await expect(modelSetup).toBeHidden();

	const onboarding = page.getByRole("dialog", { name: "首次入场" });
	await expect(onboarding).toBeVisible();
	const [submitResponse, resyncResponse] = await Promise.all([
		page.waitForResponse((response) => response.url().includes("/rpc/onboarding.submit%3Av1")),
		page.waitForResponse((response) => response.url().includes("/rpc/onboarding.get%3Av1")),
		onboarding.getByRole("button", { name: "把门打开" }).click(),
	]);
	const submitted = await submitResponse.json();
	const resynced = await resyncResponse.json();
	expect(submitted.ok).toBe(true);
	expect(submitted.data.currentStepId).toBe("introduced");
	expect(resynced.ok).toBe(true);
	expect(resynced.data.currentStepId).toBe("introduced");
	await expect.poll(() => onboarding.getAttribute("data-onboarding-step")).toBe("introduced");
	await expect(onboarding.getByRole("alert")).toHaveCount(0);
	await onboarding.getByRole("button", { name: zhCN.messages.continue }).click();
	await onboarding.getByRole("textbox", { name: "希望我怎么称呼你？" }).fill("林");
	await onboarding.getByRole("button", { name: "确认" }).click();
	await onboarding.getByRole("button", { name: "一起做事的搭档" }).click();
	await onboarding.getByRole("button", { name: "可以，记住我们之间的事" }).click();

	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
});
