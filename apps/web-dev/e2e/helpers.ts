import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, type Page } from "playwright/test";
import { parseWebDevBootstrap, type WebDevBootstrap } from "../src/http-client";

export interface ProjectedPiEntry {
	id: string;
	kind: string;
	role?: string;
	text?: string;
	version?: {
		current: number;
		leafIds: string[];
	};
}

export function projectPiEntries(entries: unknown[]): ProjectedPiEntry[] {
	return entries.flatMap((raw) => {
		if (!raw || typeof raw !== "object" || !("id" in raw) || !("kind" in raw)) return [];
		const entry = raw as Record<string, unknown>;
		if (typeof entry.id !== "string" || typeof entry.kind !== "string") return [];
		return [
			{
				id: entry.id,
				kind: entry.kind,
				...(typeof entry.role === "string" ? { role: entry.role } : {}),
				...(typeof entry.text === "string" ? { text: entry.text } : {}),
				...(isVersion(entry.version) ? { version: entry.version } : {}),
			},
		];
	});
}

function isVersion(value: unknown): value is { current: number; leafIds: string[] } {
	return Boolean(
		value &&
			typeof value === "object" &&
			"current" in value &&
			typeof value.current === "number" &&
			"leafIds" in value &&
			Array.isArray(value.leafIds) &&
			value.leafIds.every((id) => typeof id === "string"),
	);
}

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
	// Establish the canonical Host state before mounting a renderer. Mounting the
	// previous default first can legitimately publish that selection back to Host
	// while this helper is resetting the shared E2E fixture.
	const bootstrap = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const configureProvider = await (
		await page.request.post("/rpc/provider.customUpsert%3Av1", {
			headers,
			data: {
				providerId: "e2e-rule",
				name: "E2E Rule Provider",
				baseUrl: `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`,
				models: [{ id: "rule-model" }],
			},
		})
	).json();
	expect(configureProvider).toMatchObject({ ok: true });
	const setKey = await (
		await page.request.post("/rpc/provider.setApiKey%3Av1", {
			headers,
			data: {
				providerId: "e2e-rule",
				apiKey: "e2e-rule-key",
				sessionOnly: true,
			},
		})
	).json();
	expect(setKey).toMatchObject({ ok: true });
	const enableModel = await (
		await page.request.post("/rpc/model.enable%3Av1", {
			headers,
			data: {
				providerId: "e2e-rule",
				modelId: "rule-model",
				label: "E2E Rule Provider",
			},
		})
	).json();
	expect(enableModel).toMatchObject({ ok: true });
	const setDefault = await (
		await page.request.post("/rpc/model.systemDefaults.set%3Av1", {
			headers,
			data: {
				reply: { providerId: "e2e-rule", modelId: "rule-model" },
				vision: { mode: "auto" },
			},
		})
	).json();
	expect(setDefault).toMatchObject({ ok: true });
	const systemDefaults = await (
		await page.request.post("/rpc/model.systemDefaults.get%3Av1", {
			headers,
			data: {},
		})
	).json();
	expect(systemDefaults).toMatchObject({
		ok: true,
		data: { reply: { providerId: "e2e-rule", modelId: "rule-model" } },
	});
	const initializedDefaults = await (
		await page.request.post("/rpc/model.defaults.initialize%3Av1", {
			headers,
			data: {},
		})
	).json();
	expect(initializedDefaults).toMatchObject({
		ok: true,
		data: {
			reply: { providerId: "e2e-rule", modelId: "rule-model" },
			onboardingComplete: expect.any(Boolean),
		},
	});
	const completeRoleModel = await (
		await page.request.post("/rpc/model.defaults.completeOnboarding%3Av1", {
			headers,
			data: {},
		})
	).json();
	expect(completeRoleModel).toMatchObject({
		ok: true,
		data: { onboardingComplete: true },
	});
	const completeSystemSetup = await (
		await page.request.post("/rpc/settings.set%3Av1", {
			headers,
			data: { settings: { firstRunStage: "role" } },
		})
	).json();
	expect(completeSystemSetup).toMatchObject({
		ok: true,
		data: { settings: { firstRunStage: "role" } },
	});

	let onboardingState = await (
		await page.request.post("/rpc/onboarding.get%3Av1", { headers, data: {} })
	).json();
	const onboardingAnswers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "林",
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
	// Every acceptance case starts from a fresh Pi Session. The WebDev suite
	// intentionally shares one Host process, so remove completed prior-test
	// Sessions before mounting the next renderer instead of eventually hitting
	// the bounded Catalog limit or inheriting a stale UI-local selection.
	for (const archived of [false, true]) {
		const previous = (await (
			await page.request.post("/rpc/conversation.list%3Av1", {
				headers,
				data: archived ? { archived: true } : {},
			})
		).json()) as { data: { sessions: Array<{ id: string }> } };
		for (const session of previous.data.sessions) {
			const deleted = await (
				await page.request.post("/rpc/conversation.delete%3Av1", {
					headers,
					data: { id: session.id },
				})
			).json();
			expect(deleted).toMatchObject({ ok: true });
		}
	}
	await page.goto("/");
	await expect(page.getByRole("dialog", { name: "开始相处" })).toBeHidden();

	const conversations = page.getByRole("navigation", {
		name: zhCN.sidebar.conversations,
	});
	const conversationItems = conversations.getByRole("button");
	const [createResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/rpc/conversation.create%3Av1"),
		),
		page
			.getByRole("button", {
				name: zhCN.sidebar.newConversation,
				description: zhCN.sidebar.newConversation,
				exact: true,
			})
			.click(),
	]);
	const created = (await createResponse.json()) as {
		ok: boolean;
		data?: { sessionId?: string };
		error?: unknown;
	};
	expect(created).toMatchObject({ ok: true, data: { sessionId: expect.any(String) } });
	const conversationId = created.data?.sessionId;
	if (!conversationId) throw new Error("new conversation response omitted its session id");
	const selectedRoute = await (
		await page.request.post("/rpc/model.route.set%3Av1", {
			headers,
			data: {
				conversationId,
				selected: { providerId: "e2e-rule", modelId: "rule-model" },
			},
		})
	).json();
	expect(selectedRoute).toMatchObject({
		ok: true,
		data: { selected: { providerId: "e2e-rule", modelId: "rule-model" } },
	});
	// The route mutation above intentionally uses the authenticated acceptance
	// console. Reload so the Renderer proves that both the Pi Session and its
	// selected model are reconstructed from authoritative reads, not local state.
	await page.reload();
	await expect
		.poll(
			() =>
				conversationItems.evaluateAll(
					(items) => items.filter((item) => item.getAttribute("aria-current") === "page").length,
				),
			{ timeout: 15_000 },
		)
		.toBe(1);
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled({
		timeout: 15_000,
	});
	const model = page.locator(".composer-model-trigger");
	await expect(model).toContainText("E2E Rule Provider", { timeout: 15_000 });
}

export async function sendMessage(page: Page, text: string): Promise<void> {
	const composer = page.getByRole("textbox", {
		name: zhCN.composer.messageInputLabel,
	});
	const send = page.getByRole("button", { name: zhCN.composer.sendLabel });
	await composer.fill(text);
	await expect(send).toBeEnabled();
	const [response] = await Promise.all([
		page.waitForResponse(
			(candidate) =>
				candidate.request().method() === "POST" &&
				candidate.url().includes("/rpc/message.send%3Av1"),
		),
		send.click(),
	]);
	expect(await response.json()).toMatchObject({ ok: true });
}

export default async function globalTeardown(): Promise<void> {
	// Scoped-data cleanup is owned by the dev supervisor after Playwright stops it.
}
