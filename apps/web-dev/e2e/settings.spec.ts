import { zhCN } from "@bear-harness/i18n/locales";
import { CHANNEL_CONTRACTS } from "@bear-harness/protocol/schema";
import { expect, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	getBootstrap,
	sendMessage,
} from "./helpers";

test("WebDev exposes every registered Host RPC channel through its authenticated console", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	await Promise.all([
		page.waitForResponse((response) => response.url().includes("/debug/channels")),
		page.getByRole("button", { name: "Web Dev" }).click(),
	]);

	const panel = page.getByRole("complementary", {
		name: zhCN.webDev.ariaLabel,
	});
	const expectedChannels = Object.keys(CHANNEL_CONTRACTS).sort();
	const rpcChannel = panel.getByRole("button", { name: "Channel" });
	await rpcChannel.click();
	await expect(page.getByRole("option")).toHaveCount(expectedChannels.length);
	await expect(page.getByRole("option")).toHaveText(expectedChannels);
	await page.getByRole("option", { name: "settings.get", exact: true }).click();
	await expect(rpcChannel).toContainText("settings.get");
	await Promise.all([
		page.waitForResponse((response) => response.url().includes("/rpc/settings.get")),
		panel.getByRole("button", { name: zhCN.webDev.invokeHost }).click(),
	]);
	await expect(panel.getByRole("status")).toContainText('"ok"');
});

test("WebDev keeps authentication and HTTP request failure categories distinct", async ({
	page,
}) => {
	const { token } = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": token };

	const unauthorized = await page.request.get("/debug/channels");
	expect(unauthorized.status()).toBe(401);
	expect(await unauthorized.json()).toEqual({
		ok: false,
		error: { kind: "unauthorized", reason: "invalid_token" },
	});

	const unknownChannel = await page.request.post("/rpc/not-registered", {
		headers,
		data: {},
	});
	expect(unknownChannel.status()).toBe(404);
	expect(await unknownChannel.json()).toEqual({
		ok: false,
		error: { kind: "unknown_channel", reason: "unknown_channel" },
	});

	const malformedJson = await page.request.post("/rpc/onboarding.get", {
		headers: { ...headers, "content-type": "application/json" },
		data: Buffer.from("{", "utf8"),
	});
	expect(malformedJson.status()).toBe(400);
	expect(await malformedJson.json()).toEqual({
		ok: false,
		error: { kind: "malformed_json", reason: "malformed_json" },
	});

	const invalidRequest = await page.request.post("/rpc/onboarding.get", {
		headers,
		data: { characterId: "jizhou", unexpected: true },
	});
	// Schema rejection is a domain failure: it resolves HTTP 200 with the
	// validated envelope, exactly like the companion client observes it.
	expect(invalidRequest.status()).toBe(200);
	expect(await invalidRequest.json()).toEqual({
		ok: false,
		error: { kind: "invalid_request", reason: "request_validation_failed" },
	});

	const largePayload = await page.request.post("/rpc/onboarding.get", {
		headers: { ...headers, "content-type": "application/json" },
		data: "x".repeat(36 * 1024 * 1024 + 1),
	});
	expect(largePayload.status()).toBe(200);
	expect(await largePayload.json()).toEqual({
		ok: false,
		error: { kind: "invalid_request", reason: "request_validation_failed" },
	});
});

test("browser drives conversation, search, materials, backstage, settings and queue", async ({
	page,
}) => {
	await ensureReadyForConversation(page);

	const conversations = page.getByRole("navigation", {
		name: zhCN.sidebar.conversations,
	});
	const bootstrap = await getBootstrap(page);
	const activeId = await activeConversationId(page);
	const renamed = await page.request.post("/rpc/conversation.rename", {
		headers: { "x-bear-web-dev-token": bootstrap.token },
		data: { characterId: "jizhou", conversationId: activeId, title: zhCN.sidebar.newConversation },
	});
	await expect(renamed).toBeOK();
	const conversationItems = conversations.getByRole("button");
	await expect
		.poll(() =>
			conversationItems.evaluateAll(
				(items, id) =>
					items.find((item) => item.getAttribute("data-conversation-id") === id)?.textContent,
				activeId,
			),
		)
		.toContain(zhCN.sidebar.newConversation);
	const before = await conversationItems.count();
	const newConversationControl = page.getByTitle(zhCN.sidebar.newConversation, { exact: true });
	await expect(newConversationControl).toHaveCount(1);
	await newConversationControl.click();
	await expect.poll(() => conversationItems.count()).toBeGreaterThanOrEqual(before);
	await expect
		.poll(() =>
			conversationItems.evaluateAll(
				(items) => items.filter((item) => item.getAttribute("aria-current") === "page").length,
			),
		)
		.toBe(1);

	const queue = page.getByRole("button", {
		name: `${zhCN.threadHead.runningWork} 0`,
	});
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "true");
	const taskWorkspace = page.getByRole("dialog", { name: zhCN.work.activity.workspace });
	await expect(taskWorkspace).toBeVisible();
	await expect(
		taskWorkspace.getByRole("heading", { name: zhCN.work.task.unfinished, exact: true }),
	).toBeVisible();
	await expect(taskWorkspace.getByRole("button", { name: zhCN.work.task.history })).toBeVisible();
	await taskWorkspace.getByRole("button", { name: zhCN.work.task.close, exact: true }).click();
	await expect(queue).toHaveAttribute("aria-expanded", "false");
	await expect(taskWorkspace).toBeHidden();

	const search = page.getByRole("searchbox", { name: zhCN.sidebar.search });
	await search.fill("不存在的对话");
	await expect(conversationItems).toHaveCount(0);
	await search.fill("");
	await expect(page.getByRole("button", { name: zhCN.composer.attachLabel })).toBeEnabled();
	await expect(page.getByRole("button", { name: zhCN.composer.modelLabel })).toContainText(
		"E2E Rule Provider",
	);

	const systemSettingsButton = page.getByRole("button", {
		name: zhCN.sidebar.systemSettings,
		exact: true,
	});
	await expect(systemSettingsButton).toBeEnabled();
	await systemSettingsButton.click();
	const backstage = page.getByRole("dialog", {
		name: zhCN.sidebar.systemSettings,
	});
	await expect(backstage).toBeVisible();
	const settingsPanel = backstage;
	const systemModelSettingsNavigation = settingsPanel.getByRole("button", {
		name: zhCN.settings.systemModelSettings,
		exact: true,
	});
	await expect(systemModelSettingsNavigation).toBeVisible();
	await systemModelSettingsNavigation.click();
	await expect(
		settingsPanel.getByRole("region", { name: zhCN.settings.systemModelSettings }),
	).toBeVisible();
	// test-quality-allow locator: typography contract requires all rendered text controls
	const typographyElements = settingsPanel.locator("label, p, button, input, select, h3");
	const undersizedType = await typographyElements.evaluateAll((elements) =>
		elements
			.filter((element) => {
				const style = getComputedStyle(element);
				return (
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					parseFloat(style.fontSize) < 12
				);
			})
			.map((element) => ({
				tag: element.tagName,
				size: getComputedStyle(element).fontSize,
				text: element.textContent?.trim().slice(0, 60),
			})),
	);
	expect(
		undersizedType,
		"settings typography must remain readable at every hierarchy level",
	).toEqual([]);
	// test-quality-allow locator: semantic theme contract requires the complete rendered subtree
	const semanticElements = backstage.locator("*, option");
	const semanticViolations = await semanticElements.evaluateAll((elements) => {
		const root = elements[0]?.closest('[role="dialog"]');
		if (!root) return [{ tag: "ROOT", role: "missing", actual: "", expected: "" }];
		const roles = ["default", "muted", "accent", "danger", "on-action"];
		const requiredThemeTokens = [
			"--sys-surface",
			"--sys-surface-raised",
			"--sys-text",
			"--sys-text-muted",
			"--sys-accent",
			"--sys-danger",
			"--sys-border",
		];
		const missingTokens = requiredThemeTokens.filter(
			(token) => getComputedStyle(root).getPropertyValue(token).trim() === "",
		);
		if (missingTokens.length > 0) {
			return missingTokens.map((token) => ({
				tag: "ROOT",
				role: token,
				actual: "missing",
				expected: "theme token",
			}));
		}
		const expected = new Map<string, string>();
		for (const role of roles) {
			const probe = document.createElement("span");
			probe.style.color = `var(--semantic-role-${role})`;
			root.append(probe);
			expected.set(role, getComputedStyle(probe).color);
			probe.remove();
		}
		return elements
			.filter((element) => {
				if (element.tagName === "OPTION") return false;
				const style = getComputedStyle(element);
				if (style.display === "none" || style.visibility === "hidden") return false;
				const role = style.getPropertyValue("--semantic-fg-role").trim();
				return !expected.has(role) || style.color !== expected.get(role);
			})
			.map((element) => ({
				tag: element.tagName,
				role: getComputedStyle(element).getPropertyValue("--semantic-fg-role").trim(),
				actual: getComputedStyle(element).color,
				expected: expected.get(
					getComputedStyle(element).getPropertyValue("--semantic-fg-role").trim(),
				),
				text: element.textContent?.trim().slice(0, 80),
			}));
	});
	await expect(
		semanticViolations,
		"every backstage foreground must resolve through its declared semantic role",
	).toEqual([]);
	await backstage.getByRole("button", { name: zhCN.backstage.close }).click();
});

test("bottom actions open distinct character and system settings destinations", async ({
	page,
}) => {
	await ensureReadyForConversation(page);

	const characterSettingsButton = page.getByRole("button", {
		name: zhCN.sidebar.characterSettings,
		exact: true,
	});
	await expect(characterSettingsButton).toBeEnabled();
	await characterSettingsButton.click();
	let backstage = page.getByRole("dialog", {
		name: zhCN.sidebar.characterSettings,
	});
	await expect(backstage).toBeVisible();
	await expect(
		backstage.getByRole("region", { name: zhCN.currentRolePackage.selectorLabel }),
	).toBeVisible();
	await expect(backstage.getByText(zhCN.backstage.roleImport, { exact: true })).toBeVisible();
	await backstage.getByRole("button", { name: zhCN.backstage.close }).click();

	const systemSettingsButton = page.getByRole("button", {
		name: zhCN.sidebar.systemSettings,
		exact: true,
	});
	await expect(systemSettingsButton).toBeEnabled();
	await systemSettingsButton.click();
	backstage = page.getByRole("dialog", { name: zhCN.sidebar.systemSettings });
	await expect(backstage).toBeVisible();
	await expect(
		backstage.getByRole("button", {
			name: zhCN.settings.systemModelSettings,
			exact: true,
		}),
	).toBeVisible();
});

test("settings re-adds the last provider with the same identity and can chat after reload", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const openSettings = async () => {
		await page.getByRole("button", { name: zhCN.sidebar.systemSettings, exact: true }).click();
		await page
			.getByRole("dialog", { name: zhCN.sidebar.systemSettings })
			.getByRole("button", { name: zhCN.settings.systemModelSettings })
			.click();
	};
	await openSettings();
	const settings = page.getByRole("dialog", { name: zhCN.sidebar.systemSettings });
	const remove = settings.getByRole("button", { name: zhCN.settings.deleteProvider });
	await expect(remove).toHaveCount(1);
	await remove.click();
	await expect(remove).toHaveCount(0);
	await settings.getByRole("button", { name: zhCN.backstage.close }).click();
	await page.reload();
	await openSettings();
	await expect(page.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel })).toHaveCount(0);
	const { token } = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": token };
	const state = await page.request.post("/rpc/settings.get", { headers, data: {} });
	expect(await state.json()).toMatchObject({
		ok: true,
		data: { settings: { firstRunStage: "role" } },
	});
	const defaults = await page.request.post("/rpc/model.defaults.get", {
		headers,
		data: { characterId: "jizhou" },
	});
	expect(await defaults.json()).toMatchObject({ ok: true, data: { onboardingComplete: true } });
	await settings.getByRole("button", { name: zhCN.settings.addProvider }).click();
	const add = page.getByRole("dialog", { name: zhCN.settings.addProvider });
	await add.getByText(zhCN.settings.advancedToggle, { exact: true }).click();
	await add.getByLabel(zhCN.settings.customProviderId, { exact: true }).fill("e2e-rule");
	await add.getByLabel(zhCN.settings.customServiceName, { exact: true }).fill("Replacement");
	await add
		.getByLabel(zhCN.settings.customBaseUrl, { exact: true })
		.fill(`http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`);
	await add
		.getByLabel(zhCN.settings.customModels, { exact: true })
		.fill("rule-model, replacement-model");
	await add.getByLabel(zhCN.settings.apiKeyLabel, { exact: true }).fill("e2e-replacement-key");
	await add.getByRole("button", { name: zhCN.settings.addProvider, exact: true }).click();
	await expect(add).not.toBeVisible();
	await expect(settings.getByText("Replacement", { exact: true })).toBeVisible();
	await settings.getByRole("button", { name: zhCN.settings.systemDefaultReplyModel }).click();
	await page.getByRole("option", { name: /rule-model/ }).click();
	await settings.getByRole("button", { name: zhCN.backstage.close }).click();
	await page.getByRole("button", { name: zhCN.composer.modelLabel }).click();
	const [selection] = await Promise.all([
		page.waitForResponse((response) => response.url().includes("/rpc/model.route.set")),
		page.getByRole("option", { name: /replacement-model/ }).click(),
	]);
	expect(await selection.json()).toEqual({ ok: true, data: expect.anything() });
	await expect(page.getByRole("button", { name: zhCN.composer.modelLabel })).toContainText(
		"Replacement",
	);
	await page.reload();
	await expect(page.getByRole("button", { name: zhCN.composer.modelLabel })).toContainText(
		"Replacement",
	);
	await sendMessage(page, "E2E_MODEL_ID");
	await expect(
		page
			.getByRole("article", { name: "极昼", exact: true })
			.getByText("E2E_MODEL_ID:replacement-model", { exact: true }),
	).toBeVisible();
});
