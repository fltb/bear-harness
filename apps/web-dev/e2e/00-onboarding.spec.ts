import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { getBootstrap } from "./helpers";

test("browser requires a reply model before the role-defined onboarding", async ({ page }) => {
	const bootstrap = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const provider = {
		id: "e2e-rule",
		name: "E2E Rule Provider",
		modelId: "rule-model",
	};
	const configured = await (
		await page.request.post("/rpc/provider.customUpsert%3Av1", {
			headers,
			data: {
				providerId: provider.id,
				name: provider.name,
				baseUrl: `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`,
				models: [{ id: provider.modelId }],
			},
		})
	).json();
	expect(configured).toMatchObject({ ok: true });
	const setKey = await (
		await page.request.post("/rpc/provider.setApiKey%3Av1", {
			headers,
			data: { providerId: provider.id, apiKey: "e2e-rule-key", sessionOnly: true },
		})
	).json();
	expect(setKey).toMatchObject({ ok: true });
	const enableModel = await (
		await page.request.post("/rpc/model.enable%3Av1", {
			headers,
			data: { providerId: provider.id, modelId: provider.modelId, label: provider.name },
		})
	).json();
	expect(enableModel).toMatchObject({ ok: true });
	const providerList = await (
		await page.request.post("/rpc/provider.list%3Av1", {
			headers,
			data: {},
		})
	).json();
	expect(providerList).toMatchObject({ ok: true });
	expect(providerList.data.providers).toContainEqual(
		expect.objectContaining({
			id: provider.id,
			name: provider.name,
			availableModels: expect.arrayContaining([expect.objectContaining({ id: provider.modelId })]),
		}),
	);
	await page.goto("/");
	const modelSetup = page.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("heading", { name: zhCN.modelSetup.title })).toBeVisible();
	await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.continue })).toBeDisabled();
	const defaultResponse = await page.request.post("/rpc/model.defaults.setReply%3Av1", {
		headers,
		data: { reply: { providerId: provider.id, modelId: provider.modelId } },
	});
	expect(await defaultResponse.json()).toMatchObject({ ok: true });
	await page.reload();
	await expect(modelSetup).toBeVisible();
	await expect(modelSetup.getByRole("button", { name: zhCN.modelSetup.continue })).toBeEnabled();
	await modelSetup.getByRole("button", { name: zhCN.modelSetup.continue }).click();
	const embeddingSetup = page.getByRole("dialog", { name: zhCN.settings.memoryVectorSection });
	await expect(embeddingSetup).toBeVisible();
	const embeddingContinue = embeddingSetup.getByRole("button", { name: zhCN.messages.continue });
	await expect(embeddingContinue).toBeDisabled();
	const noneRadio = embeddingSetup.getByRole("radio", {
		name: zhCN.settings.vectorProviders.none,
		exact: true,
	});
	await embeddingSetup.getByText(zhCN.settings.vectorProviders.none, { exact: true }).click();
	await expect(noneRadio).toBeChecked();
	await expect(embeddingContinue).toBeEnabled();
	await embeddingContinue.click();

	const onboarding = page.getByRole("dialog", { name: "开始相处" });
	await expect(onboarding).toBeVisible();
	const [submitResponse, resyncResponse] = await Promise.all([
		page.waitForResponse((response) => response.url().includes("/rpc/onboarding.submit%3Av1")),
		page.waitForResponse((response) => response.url().includes("/rpc/onboarding.get%3Av1")),
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
});
