import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, type Page } from "playwright/test";
import { parseWebDevBootstrap, type WebDevBootstrap } from "../src/http-client";

export interface ProjectedPiEntry {
	id: string;
	type: string;
	role?: string;
	text?: string;
}

export function projectPiEntries(entries: unknown[]): ProjectedPiEntry[] {
	return entries.flatMap((raw) => {
		if (!raw || typeof raw !== "object" || !("id" in raw) || !("type" in raw)) return [];
		const entry = raw as Record<string, unknown>;
		if (typeof entry.id !== "string" || typeof entry.type !== "string") return [];
		const message =
			entry.message && typeof entry.message === "object"
				? (entry.message as Record<string, unknown>)
				: undefined;
		return [
			{
				id: entry.id,
				type: entry.type,
				...(typeof message?.role === "string" ? { role: message.role } : {}),
				...(message ? { text: messageText(message.content) } : {}),
			},
		];
	});
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
				? [String(part.text)]
				: [],
		)
		.join("\n");
}

export async function getBootstrap(page: Page): Promise<WebDevBootstrap> {
	const response = await page.request.get("/bootstrap");
	await expect(response).toBeOK();
	return parseWebDevBootstrap(await response.json());
}

export async function activeConversationId(page: Page, expectedId?: string): Promise<string> {
	const navigation = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	let id: string | undefined;
	// Selection and the conversation list are authoritative projections that can
	// settle separately after create or reload. Read only their joined UI state.
	await expect
		.poll(async () => {
			id = await navigation.getByRole("button").evaluateAll((buttons) => {
				const selected = buttons.filter((button) => button.getAttribute("aria-current") === "page");
				return selected.length === 1
					? selected[0]?.getAttribute("data-conversation-id") || undefined
					: undefined;
			});
			return id;
		})
		.toEqual(expectedId ?? expect.stringMatching(/\S/));
	if (!id) throw new Error("active conversation has no identity");
	return id;
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
	const characters = (await (
		await page.request.post("/rpc/character.list", { headers, data: {} })
	).json()) as { data: { characters: Array<{ id: string }> } };
	if (characters.data.characters.some((character) => character.id === "e2e-plugin-trust")) {
		for (const channel of ["character.runtimeDelete", "character.packageDelete"] as const) {
			const deleted = await (
				await page.request.post(`/rpc/${channel}`, {
					headers,
					data: { characterId: "e2e-plugin-trust" },
				})
			).json();
			expect(deleted).toMatchObject({ ok: true });
		}
	}
	const configureProvider = await (
		await page.request.post("/rpc/provider.customUpsert", {
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
		await page.request.post("/rpc/provider.setApiKey", {
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
		await page.request.post("/rpc/model.enable", {
			headers,
			data: {
				providerId: "e2e-rule",
				modelId: "rule-model",
				label: "E2E Rule Provider",
			},
		})
	).json();
	expect(enableModel).toMatchObject({ ok: true });
	const completeSystemModel = await (
		await page.request.post("/rpc/systemOnboarding.completeModel", {
			headers,
			data: {
				reply: { providerId: "e2e-rule", modelId: "rule-model" },
				vision: { mode: "auto" },
				licensesAcknowledged: {
					bear: "GPL-3.0-only",
					...(process.platform === "win32" ? { gitForWindows: "GPL-2.0-only" } : {}),
				},
			},
		})
	).json();
	expect(completeSystemModel).toMatchObject({
		ok: true,
		data: {
			defaults: {
				reply: { providerId: "e2e-rule", modelId: "rule-model" },
			},
		},
	});
	const completeSystemEmbedding = await (
		await page.request.post("/rpc/systemOnboarding.completeEmbedding", {
			headers,
			data: { choice: "none" },
		})
	).json();
	expect(completeSystemEmbedding).toMatchObject({
		ok: true,
		data: {
			settings: {
				firstRunStage: "role",
				memoryVectorService: { enabled: false, provider: "none" },
			},
		},
	});
	const completeRoleModel = await (
		await page.request.post("/rpc/model.defaults.completeOnboarding", {
			headers,
			data: {},
		})
	).json();
	expect(completeRoleModel).toMatchObject({
		ok: true,
		data: { onboardingComplete: true },
	});

	let onboardingState = await (
		await page.request.post("/rpc/onboarding.get", { headers, data: {} })
	).json();
	const onboardingAnswers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "林",
	};
	while (onboardingState.data.status === "active") {
		const stepId = onboardingState.data.currentStepId as string;
		if (!(stepId in onboardingAnswers)) throw new Error(`Unhandled onboarding step: ${stepId}`);
		onboardingState = await (
			await page.request.post("/rpc/onboarding.submit", {
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
			await page.request.post("/rpc/conversation.list", {
				headers,
				data: archived ? { archived: true } : {},
			})
		).json()) as { data: { conversations: Array<{ conversationId: string }> } };
		for (const conversation of previous.data.conversations) {
			const deleted = await (
				await page.request.post("/rpc/conversation.delete", {
					headers,
					data: { conversationId: conversation.conversationId },
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
	const application = page.getByRole("application", { name: zhCN.shell.productName });
	await expect(application).toHaveAttribute("data-layout", /^(fullscreen|window|mobile)$/);
	const mobileNavigation = (await application.getAttribute("data-layout")) === "mobile";
	const created = (
		mobileNavigation
			? await (
					await page.request.post("/rpc/conversation.create", {
						headers,
						data: {},
					})
				).json()
			: await (
					await Promise.all([
						page.waitForResponse(
							(response) =>
								response.request().method() === "POST" &&
								response.url().includes("/rpc/conversation.create"),
						),
						page
							.getByRole("button", {
								name: zhCN.sidebar.newConversation,
								exact: true,
							})
							.click(),
					])
				)[0].json()
	) as {
		ok: boolean;
		data?: { conversationId?: string };
		error?: unknown;
	};
	expect(created).toMatchObject({ ok: true, data: { conversationId: expect.any(String) } });
	const conversationId = created.data?.conversationId;
	if (!conversationId) throw new Error("new conversation response omitted its session id");
	const selectedRoute = await (
		await page.request.post("/rpc/model.route.set", {
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
	if (mobileNavigation)
		await page.getByRole("button", { name: zhCN.sidebar.conversations, exact: true }).click();
	await expect
		.poll(
			() =>
				conversationItems.evaluateAll(
					(items) => items.filter((item) => item.getAttribute("aria-current") === "page").length,
				),
			{ timeout: 15_000 },
		)
		.toBe(1);
	if (mobileNavigation)
		await page
			.getByRole("button", { name: `${zhCN.backstage.close} ${zhCN.sidebar.conversations}` })
			.click();
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
	const send = page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true });
	await composer.fill(text);
	await expect(send).toBeEnabled();
	const [response] = await Promise.all([
		page.waitForResponse(
			(candidate) =>
				candidate.request().method() === "POST" && candidate.url().includes("/rpc/message.send"),
		),
		send.click(),
	]);
	expect(await response.json()).toMatchObject({ ok: true });
}

/** Hold an authored provider response, never a Host lifecycle or executor event. */
export function providerHold(page: Page) {
	const id = crypto.randomUUID();
	const url = `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/control/holds/${id}`;
	return {
		id,
		async entered() {
			await expect
				.poll(async () => (await (await page.request.get(url)).json()).entered, {
					timeout: 30_000,
				})
				.toBe(true);
		},
		async cancelled() {
			await expect
				.poll(async () => (await (await page.request.get(url)).json()).cancelled)
				.toBe(true);
		},
		async release() {
			await expect(await page.request.post(url, { timeout: 5_000 })).toBeOK();
		},
	};
}

export default async function globalTeardown(): Promise<void> {
	// Scoped-data cleanup is owned by the dev supervisor after Playwright stops it.
}
