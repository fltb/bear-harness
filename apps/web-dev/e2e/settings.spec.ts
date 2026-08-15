import { productUi } from "@bear-harness/product-config";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
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
	await expect(onboarding).toHaveAttribute("data-onboarding-step", "introduced");
	await onboarding.getByRole("button", { name: productUi.messages.continue }).click();

	const name = onboarding.getByRole("textbox", { name: "希望我怎么称呼你？" });
	await name.fill("林");
	await onboarding.getByRole("button", { name: "确认" }).click();
	await onboarding.getByRole("button", { name: "一起做事的搭档" }).click();
	await onboarding.getByRole("button", { name: "可以，记住我们之间的事" }).click();

	await expect(onboarding).toBeHidden();
	await expect(page.getByRole("button", { name: "Web Dev" })).toBeVisible();
});

test("WebDev exposes every registered Host RPC channel through its authenticated console", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Web Dev" }).click();

	const panel = page.getByRole("complementary", { name: productUi.webDev.ariaLabel });
	const expectedChannels = Object.keys(REQUEST_SCHEMAS).sort();
	const rpcChannel = panel.getByRole("combobox");
	await expect(rpcChannel.getByRole("option")).toHaveCount(expectedChannels.length);
	await expect(rpcChannel.getByRole("option")).toHaveText(expectedChannels);
	await panel.getByRole("button", { name: productUi.webDev.invokeHost }).click();
	await expect(panel.getByRole("status")).toContainText('"ok"');
});

test("browser drives conversation, search, materials, backstage, settings and queue", async ({
	page,
}) => {
	await page.goto("/");

	const conversations = page.getByRole("navigation", { name: productUi.sidebar.conversations });
	const conversationItems = conversations.getByRole("button");
	const before = await conversationItems.count();
	await page.getByRole("button", { name: productUi.sidebar.newConversation }).click();
	await expect(conversationItems).toHaveCount(before + 1);
	await expect
		.poll(() =>
			conversationItems.evaluateAll(
				(items) => items.filter((item) => item.getAttribute("aria-current") === "page").length,
			),
		)
		.toBe(1);

	const queue = page.getByRole("button", { name: `${productUi.titlebar.runningWork} 0` });
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("menu", { name: productUi.titlebar.runningWork })).toBeVisible();
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "false");

	const search = page.getByRole("searchbox", { name: productUi.sidebar.search });
	await search.fill("不存在的对话");
	await expect(conversationItems).toHaveCount(0);
	await search.fill("");
	await expect(page.getByRole("button", { name: productUi.composer.attachLabel })).toBeEnabled();

	await page.getByRole("button", { name: productUi.titlebar.backstage }).click();
	const backstage = page.getByRole("dialog");
	await expect(backstage).toBeVisible();
	await backstage.getByRole("tab", { name: productUi.backstage.systemSettings }).click();
	const settingsPanel = backstage.getByRole("tabpanel", {
		name: productUi.backstage.systemSettings,
	});
	await expect(
		settingsPanel.getByRole("heading", { name: productUi.settings.primaryModelSection }),
	).toBeVisible();
	await expect(
		settingsPanel.getByRole("heading", { name: productUi.settings.fallbackModelSection }),
	).toBeVisible();
	await settingsPanel.getByRole("button", { name: productUi.settings.advancedToggle }).click();
	const textFallback = settingsPanel.getByRole("switch", {
		name: productUi.settings.textFallbackEnable,
	});
	if ((await textFallback.getAttribute("aria-checked")) === "false") await textFallback.click();
	const multimodalFallback = settingsPanel.getByRole("switch", {
		name: productUi.settings.multimodalFallbackEnable,
	});
	if ((await multimodalFallback.getAttribute("aria-checked")) === "false")
		await multimodalFallback.click();
	await expect(settingsPanel.getByRole("combobox")).not.toHaveCount(0);
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
		const root = elements[0]?.closest(".backstage-sheet");
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
	expect(
		semanticViolations,
		"every backstage foreground must resolve through its declared semantic role",
	).toEqual([]);
	const relationshipMemory = backstage.getByRole("switch", {
		name: productUi.settings.relationshipMemory,
	});
	await expect(relationshipMemory).toBeEnabled();
	const previousMemory = await relationshipMemory.getAttribute("aria-checked");
	await relationshipMemory.click();
	await expect(relationshipMemory).not.toHaveAttribute("aria-checked", previousMemory ?? "");
});
