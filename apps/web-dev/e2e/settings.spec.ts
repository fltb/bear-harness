import { zhCN } from "@bear-harness/i18n/locales";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, getBootstrap } from "./helpers";

test("WebDev exposes every registered Host RPC channel through its authenticated console", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	await Promise.all([
		page.waitForResponse((response) => response.url().includes("/debug/channels")),
		page.getByRole("button", { name: "Web Dev" }).click(),
	]);

	const panel = page.getByRole("complementary", { name: zhCN.webDev.ariaLabel });
	const expectedChannels = Object.keys(REQUEST_SCHEMAS).sort();
	const rpcChannel = panel.getByRole("button", { name: "Channel" });
	await rpcChannel.click();
	await expect(page.getByRole("option")).toHaveCount(expectedChannels.length);
	await expect(page.getByRole("option")).toHaveText(expectedChannels);
	await page.keyboard.press("Escape");
	await panel.getByRole("button", { name: zhCN.webDev.invokeHost }).click();
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

	const unknownChannel = await page.request.post("/rpc/not-registered%3Av1", {
		headers,
		data: {},
	});
	expect(unknownChannel.status()).toBe(404);
	expect(await unknownChannel.json()).toEqual({
		ok: false,
		error: { kind: "unknown_channel", reason: "unknown_channel" },
	});

	const malformedJson = await page.request.post("/rpc/onboarding.get%3Av1", {
		headers: { ...headers, "content-type": "application/json" },
		data: Buffer.from("{", "utf8"),
	});
	expect(malformedJson.status()).toBe(400);
	expect(await malformedJson.json()).toEqual({
		ok: false,
		error: { kind: "malformed_json", reason: "malformed_json" },
	});

	const invalidRequest = await page.request.post("/rpc/onboarding.get%3Av1", {
		headers,
		data: { unexpected: true },
	});
	// Schema rejection is a domain failure: it resolves HTTP 200 with the
	// validated envelope, exactly like the companion client observes it.
	expect(invalidRequest.status()).toBe(200);
	expect(await invalidRequest.json()).toEqual({
		ok: false,
		error: { kind: "invalid_request", reason: "request_validation_failed" },
	});

	const oversized = await page.request.post("/rpc/onboarding.get%3Av1", {
		headers: { ...headers, "content-type": "application/json" },
		data: "x".repeat(64 * 1024 + 1),
	});
	expect(oversized.status()).toBe(413);
	expect(await oversized.json()).toEqual({
		ok: false,
		error: { kind: "body_too_large", reason: "request_body_too_large" },
	});
});

test("browser drives conversation, search, materials, backstage, settings and queue", async ({
	page,
}) => {
	await ensureReadyForConversation(page);

	const conversations = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const conversationItems = conversations.getByRole("button");
	const before = await conversationItems.count();
	await page.getByRole("button", { name: zhCN.sidebar.newConversation }).click();
	await expect.poll(() => conversationItems.count()).toBeGreaterThan(before);
	await expect
		.poll(() =>
			conversationItems.evaluateAll(
				(items) => items.filter((item) => item.getAttribute("aria-current") === "page").length,
			),
		)
		.toBe(1);

	const queue = page.getByRole("button", { name: `${zhCN.threadHead.runningWork} 0` });
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("menu", { name: zhCN.threadHead.runningWork })).toBeVisible();
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "false");

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
	const backstage = page.getByRole("dialog", { name: zhCN.sidebar.systemSettings });
	await expect(backstage).toBeVisible();
	const settingsPanel = backstage;
	await expect(
		settingsPanel.getByText(zhCN.settings.systemModelSettings, { exact: true }),
	).toBeVisible();
	await expect(
		settingsPanel.getByRole("region", { name: zhCN.settings.providerSetupLabel }),
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
			"--surface",
			"--surface-alt",
			"--text",
			"--text-muted",
			"--accent",
			"--danger",
			"--line",
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
	const characterSettingsButton = page.getByRole("button", {
		name: zhCN.sidebar.characterSettings,
		exact: true,
	});
	await expect(characterSettingsButton).toBeEnabled();
	await characterSettingsButton.click();
	const characterBackstage = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await expect(characterBackstage).toBeVisible();
	await characterBackstage.getByRole("tab", { name: zhCN.backstage.relationshipArchive }).click();
	const relationshipMemory = characterBackstage.getByRole("switch", {
		name: zhCN.settings.relationshipMemory,
	});
	await expect(relationshipMemory).toBeEnabled();
	const previousMemory = await relationshipMemory.getAttribute("aria-checked");
	await relationshipMemory.click();
	await expect(relationshipMemory).not.toHaveAttribute("aria-checked", previousMemory ?? "");
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
	let backstage = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await expect(backstage).toBeVisible();
	await expect(backstage.getByRole("tab", { name: zhCN.backstage.roleManagement })).toHaveAttribute(
		"aria-selected",
		"true",
	);
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
		backstage.getByText(zhCN.settings.systemModelSettings, { exact: true }),
	).toBeVisible();
});
