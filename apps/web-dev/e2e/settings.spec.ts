import { zhCN } from "@bear-harness/product-config/locales";
import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation } from "./helpers";

test("WebDev exposes every registered Host RPC channel through its authenticated console", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Web Dev" }).click();

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

test("browser drives conversation, search, materials, backstage, settings and queue", async ({
	page,
}) => {
	await page.goto("/");

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

	const queue = page.getByRole("button", { name: `${zhCN.titlebar.runningWork} 0` });
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("menu", { name: zhCN.titlebar.runningWork })).toBeVisible();
	await queue.click();
	await expect(queue).toHaveAttribute("aria-expanded", "false");

	const search = page.getByRole("searchbox", { name: zhCN.sidebar.search });
	await search.fill("不存在的对话");
	await expect(conversationItems).toHaveCount(0);
	await search.fill("");
	await expect(page.getByRole("button", { name: zhCN.composer.attachLabel })).toBeDisabled();
	await expect(page.getByRole("button", { name: zhCN.composer.modelLabel })).toContainText(
		zhCN.composer.chooseModel,
	);

	await page.getByRole("button", { name: zhCN.titlebar.backstage }).click();
	const backstage = page.getByRole("dialog", { name: zhCN.backstage.title });
	await expect(backstage).toBeVisible();
	await backstage.getByRole("tab", { name: zhCN.backstage.systemSettings }).click();
	const settingsPanel = backstage.getByRole("tabpanel", {
		name: zhCN.backstage.systemSettings,
	});
	await expect(settingsPanel.getByText(zhCN.settings.modelPool, { exact: true })).toBeVisible();
	await expect(settingsPanel.getByRole("button", { name: zhCN.settings.addModel })).toBeVisible();
	await settingsPanel.getByRole("button", { name: zhCN.settings.advancedToggle }).click();
	await expect(
		settingsPanel.getByRole("button", { name: new RegExp(`^${zhCN.settings.serviceLabel}`) }),
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
	expect(
		semanticViolations,
		"every backstage foreground must resolve through its declared semantic role",
	).toEqual([]);
	await backstage.getByRole("tab", { name: zhCN.backstage.relationshipArchive }).click();
	const relationshipMemory = backstage.getByRole("switch", {
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

	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	let backstage = page.getByRole("dialog", { name: zhCN.backstage.title });
	await expect(backstage.getByRole("tab", { name: zhCN.backstage.roleManagement })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(backstage.getByText(zhCN.backstage.roleImport, { exact: true })).toBeVisible();
	await backstage.getByRole("button", { name: zhCN.backstage.close }).click();

	await page.getByRole("button", { name: zhCN.sidebar.systemSettings, exact: true }).click();
	backstage = page.getByRole("dialog", { name: zhCN.backstage.title });
	await expect(backstage.getByRole("tab", { name: zhCN.backstage.systemSettings })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(backstage.getByText(zhCN.settings.modelPool, { exact: true })).toBeVisible();
});
