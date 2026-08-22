import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, type Page } from "playwright/test";
import { parseWebDevBootstrap, type WebDevBootstrap } from "../src/http-client";

export async function getBootstrap(page: Page): Promise<WebDevBootstrap> {
	const response = await page.request.get("/bootstrap");
	await expect(response).toBeOK();
	return parseWebDevBootstrap(await response.json());
}

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
	const bootstrap = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const configureProvider = await (
		await page.request.post("/rpc/provider.customUpsert%3Av1", {
			headers,
			data: {
				providerId: "e2e-rule",
				name: "E2E Rule Provider",
				baseUrl: `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`,
				modelId: "rule-model",
			},
		})
	).json();
	expect(configureProvider).toMatchObject({ ok: true });
	const setKey = await (
		await page.request.post("/rpc/provider.setApiKey%3Av1", {
			headers,
			data: { providerId: "e2e-rule", apiKey: "e2e-rule-key", sessionOnly: true },
		})
	).json();
	expect(setKey).toMatchObject({ ok: true });
	const enableModel = await (
		await page.request.post("/rpc/model.enable%3Av1", {
			headers,
			data: { providerId: "e2e-rule", modelId: "rule-model", label: "E2E Rule Provider" },
		})
	).json();
	expect(enableModel).toMatchObject({ ok: true });
	const setDefault = await (
		await page.request.post("/rpc/model.defaults.setReply%3Av1", {
			headers,
			data: { reply: { providerId: "e2e-rule", modelId: "rule-model" } },
		})
	).json();
	expect(setDefault).toMatchObject({ ok: true });
	const defaults = await (
		await page.request.post("/rpc/model.defaults.get%3Av1", { headers, data: {} })
	).json();
	expect(defaults).toMatchObject({
		ok: true,
		data: { reply: { providerId: "e2e-rule", modelId: "rule-model" } },
	});

	let onboardingState = await (
		await page.request.post("/rpc/onboarding.get%3Av1", { headers, data: {} })
	).json();
	const onboardingAnswers: Record<string, string | undefined> = {
		settings_intro: undefined,
		nickname: "林",
		relationship: "collaborator",
		memory: "remember",
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
	await expect(page.getByRole("dialog", { name: "开始相处" })).toBeHidden();

	const conversationsBefore = await (
		await page.request.post("/rpc/conversation.list%3Av1", { headers, data: {} })
	).json();
	const previousConversationIds = new Set<string>(
		(conversationsBefore.data?.conversations ?? [])
			.map((conversation: { id?: unknown }) =>
				typeof conversation.id === "string" ? conversation.id : undefined,
			)
			.filter((id: string | undefined): id is string => id !== undefined),
	);
	const conversations = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const conversationItems = conversations.getByRole("button");
	const conversationCountBefore = await conversationItems.count();
	await page.getByRole("button", { name: zhCN.sidebar.newConversation }).click();
	await expect.poll(() => conversationItems.count()).toBeGreaterThan(conversationCountBefore);
	await expect
		.poll(() =>
			conversationItems.evaluateAll(
				(items) => items.filter((item) => item.getAttribute("aria-current") === "page").length,
			),
		)
		.toBe(1);
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled();
	await expect
		.poll(async () => {
			const conversations = await (
				await page.request.post("/rpc/conversation.list%3Av1", {
					headers,
					data: {},
				})
			).json();
			const listedIds = (conversations.data?.conversations ?? [])
				.map((conversation: { id?: unknown }) =>
					typeof conversation.id === "string" ? conversation.id : undefined,
				)
				.filter((id: string | undefined): id is string => id !== undefined);
			const candidateIds = listedIds.filter((id) => !previousConversationIds.has(id));
			for (const conversationId of candidateIds) {
				const route = await (
					await page.request.post("/rpc/model.route.get%3Av1", {
						headers,
						data: { conversationId },
					})
				).json();
				if (
					route.data?.selected?.providerId === "e2e-rule" &&
					route.data?.selected?.modelId === "rule-model"
				) {
					return route.data.selected;
				}
			}
			return undefined;
		})
		.toEqual({ providerId: "e2e-rule", modelId: "rule-model" });
	const model = page.getByRole("button", { name: zhCN.composer.modelLabel });
	await expect(model).toContainText("E2E Rule Provider");
}

export async function sendMessage(page: Page, text: string): Promise<void> {
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill(text);
	await page.getByRole("button", { name: zhCN.composer.sendLabel }).click();
}

export default async function globalTeardown(): Promise<void> {
	// Scoped-data cleanup is owned by the dev supervisor after Playwright stops it.
}
