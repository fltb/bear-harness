import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Locator, type Page, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

const viewports = [
	{ mode: "fullscreen", width: 1920, height: 1080 },
	{ mode: "window", width: 1280, height: 800 },
	{ mode: "mobile", width: 390, height: 844 },
] as const;

type Viewport = (typeof viewports)[number];

const settingsPages = [
	{
		id: "general",
		label: zhCN.settings.language,
		landmark: (dialog: Locator) =>
			dialog.getByRole("heading", { name: zhCN.settings.language, exact: true }),
	},
	{
		id: "conversation",
		label: zhCN.settings.conversationModelSettings,
		landmark: (dialog: Locator) =>
			dialog.getByRole("heading", {
				name: zhCN.settings.conversationModelSettings,
				exact: true,
			}),
	},
	{
		id: "archived",
		label: zhCN.sidebar.archivedConversations,
		landmark: (dialog: Locator) =>
			dialog.getByRole("heading", { name: zhCN.sidebar.archivedConversations, exact: true }),
	},
	{
		id: "providers",
		label: zhCN.settings.systemModelSettings,
		landmark: (dialog: Locator) =>
			dialog.getByRole("region", { name: zhCN.settings.providerSetupLabel }),
	},
	{
		id: "agents",
		label: zhCN.settings.workAgent,
		landmark: (dialog: Locator) =>
			dialog.getByRole("heading", { name: zhCN.settings.workAgent, exact: true }),
	},
	{
		id: "network",
		label: zhCN.settings.networkSection,
		landmark: (dialog: Locator) =>
			dialog.getByRole("heading", { name: zhCN.settings.networkSection, exact: true }),
	},
	{
		id: "memory",
		label: zhCN.settings.memoryVectorSection,
		landmark: (dialog: Locator) =>
			dialog.getByRole("heading", { name: zhCN.settings.memoryVectorSection, exact: true }),
	},
] as const;

async function revealSidebar(page: Page, viewport: Viewport): Promise<Locator> {
	const navigation = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	if (viewport.mode === "mobile" && ((await navigation.boundingBox())?.x ?? -1) < 0) {
		await page.getByRole("button", { name: zhCN.sidebar.conversations, exact: true }).click();
	}
	await expect
		.poll(async () => (await navigation.boundingBox())?.x ?? -999)
		.toBeGreaterThanOrEqual(-1);
	return navigation;
}

async function assertViewportIntegrity(page: Page, viewport: Viewport): Promise<void> {
	// test-quality-allow locator: whole-document geometry audit needs the rendered body
	const result = await page.locator("body").evaluate((body) => {
		const viewportWidth = window.innerWidth;
		// test-quality-allow querySelectorAll: geometry audit must inspect every rendered interactive control
		const clipped = [...body.querySelectorAll("button, input, textarea, select, [role='dialog']")]
			.filter((element) => {
				const closedMobileSidebar =
					element.closest(".sidebar") !== null &&
					element.closest(".shell")?.getAttribute("data-mobile-navigation-open") !== "true";
				const style = getComputedStyle(element);
				const rect = element.getBoundingClientRect();
				return (
					!closedMobileSidebar &&
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					rect.width > 0 &&
					rect.height > 0 &&
					rect.right > 0 &&
					rect.left < viewportWidth &&
					rect.bottom > 0 &&
					rect.top < window.innerHeight &&
					(rect.left < -1 || rect.right > viewportWidth + 1)
				);
			})
			.map((element) => ({
				tag: element.tagName,
				name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60),
				rect: element.getBoundingClientRect().toJSON(),
			}));
		return { bodyOverflow: body.scrollWidth - body.clientWidth, clipped };
	});
	expect(
		result.bodyOverflow,
		`${viewport.mode} body must not overflow horizontally`,
	).toBeLessThanOrEqual(1);
	expect(result.clipped, `${viewport.mode} visible controls must stay inside the viewport`).toEqual(
		[],
	);
}

async function capture(page: Page, viewport: Viewport, state: string): Promise<void> {
	await assertViewportIntegrity(page, viewport);
	// test-quality-allow locator: volatile hashes and local installation paths are masked in baselines
	const volatile = page.locator("code");
	await expect(page).toHaveScreenshot(`${state}-${viewport.mode}.png`, {
		animations: "disabled",
		caret: "hide",
		mask: (await volatile.count()) > 0 ? [volatile] : [],
	});
}

async function activeConversationRow(page: Page): Promise<Locator> {
	const navigation = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	// test-quality-allow locator: conversation id and aria-current are the public navigation contract
	const active = navigation.locator('[data-conversation-id][aria-current="page"]');
	await expect(active).toHaveCount(1);
	// test-quality-allow locator: the action group is the active conversation button's public container
	return active.locator("..");
}

async function selectSettingsPage(
	page: Page,
	dialog: Locator,
	viewport: Viewport,
	label: string,
): Promise<void> {
	if (viewport.mode === "mobile") {
		await dialog
			.getByRole("button", { name: new RegExp(`^${zhCN.sidebar.systemSettings}`) })
			.click();
		await page.getByRole("option", { name: label, exact: true }).click();
		return;
	}
	await dialog.getByRole("button", { name: label, exact: true }).click();
}

async function visitConversationNavigation(page: Page, viewport: Viewport): Promise<void> {
	const application = page.getByRole("application", { name: zhCN.shell.productName });
	await expect(application).toHaveAttribute("data-layout", viewport.mode);
	await expect(page.getByText(zhCN.language.warningTitle, { exact: true })).toBeHidden();
	await capture(page, viewport, "layout");

	const workButton = page.getByRole("button", {
		name: new RegExp(zhCN.threadHead.runningWork),
	});
	await workButton.click();
	await expect(page.getByRole("menu", { name: zhCN.threadHead.runningWork })).toBeVisible();
	await capture(page, viewport, "work-menu");
	await page.keyboard.press("Escape");

	const navigation = await revealSidebar(page, viewport);
	const search = page.getByRole("searchbox", { name: zhCN.sidebar.search });
	await search.fill("没有这段对话");
	await expect(navigation.getByText(zhCN.sidebar.noSearchResults)).toBeVisible();
	await search.fill("");

	await revealSidebar(page, viewport);
	const row = await activeConversationRow(page);
	await row.getByRole("button", { name: zhCN.sidebar.renameConversation }).click();
	const rename = page.getByRole("textbox", { name: zhCN.sidebar.renameConversation });
	await expect(rename).toBeVisible();
	await rename.fill(`站点地图-${viewport.mode}`);
	await capture(page, viewport, "conversation-rename");
	await page.getByRole("button", { name: zhCN.sidebar.saveConversation }).click();

	await revealSidebar(page, viewport);
	const renamedRow = await activeConversationRow(page);
	await renamedRow.getByRole("button", { name: zhCN.sidebar.deleteConversation }).click();
	const deleteDialog = page.getByRole("dialog", { name: zhCN.sidebar.deleteConversationTitle });
	await expect(deleteDialog).toBeVisible();
	await capture(page, viewport, "conversation-delete-confirmation");
	await deleteDialog.getByRole("button", { name: zhCN.messages.cancel }).click();

	await revealSidebar(page, viewport);
	const conversationNavigation = page.getByRole("navigation", {
		name: zhCN.sidebar.conversations,
	});
	// test-quality-allow locator: conversation id is the explicit navigation identity contract
	const conversationButtons = conversationNavigation.locator("[data-conversation-id]");
	const beforeCreate = await conversationButtons.count();
	// test-quality-allow locator: aria-current identifies the renderer-local active conversation
	const currentConversation = conversationNavigation.locator(
		'[data-conversation-id][aria-current="page"]',
	);
	const previousId = await currentConversation.getAttribute("data-conversation-id");
	await page.getByRole("button", { name: zhCN.sidebar.newConversation, exact: true }).click();
	await expect.poll(() => conversationButtons.count()).toBe(beforeCreate + 1);
	await expect
		.poll(() => currentConversation.getAttribute("data-conversation-id"))
		.not.toBe(previousId);
	await sendMessage(page, "E2E_OK archived surface");
	await expect(
		page
			.getByRole("region", { name: zhCN.messages.conversation })
			.getByText("E2E_OK", { exact: true }),
	).toBeVisible();
	await revealSidebar(page, viewport);
	const archiveRow = await activeConversationRow(page);
	await archiveRow.getByRole("button", { name: zhCN.sidebar.archiveConversation }).click();
	await expect.poll(() => conversationButtons.count()).toBe(beforeCreate);
}

async function visitCharacterSettings(page: Page, viewport: Viewport): Promise<void> {
	await revealSidebar(page, viewport);
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	const dialog = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("tab", { name: zhCN.backstage.roleManagement })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await capture(page, viewport, "character-role-package");

	await dialog.getByRole("tab", { name: zhCN.currentRolePackage.storageTab }).click();
	await expect(
		dialog.getByRole("textbox", { name: zhCN.currentRolePackage.storageDefinition }),
	).toBeVisible();
	await capture(page, viewport, "character-package-storage");

	const localData = dialog.getByRole("region", { name: zhCN.currentRolePackage.localDataTitle });
	await localData.scrollIntoViewIfNeeded();
	await expect(localData).toBeVisible();
	await capture(page, viewport, "character-local-data");

	await dialog.getByRole("tab", { name: zhCN.backstage.canon }).click();
	await expect(dialog.getByRole("heading", { name: zhCN.canonStudio.sources })).toBeVisible();
	await capture(page, viewport, "canon-sources");
	const modules = dialog.getByRole("heading", { name: zhCN.canonStudio.modules });
	await modules.scrollIntoViewIfNeeded();
	await expect(modules).toBeVisible();
	await capture(page, viewport, "canon-modules");
	await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
}

async function visitSystemSettings(page: Page, viewport: Viewport): Promise<void> {
	await revealSidebar(page, viewport);
	await page.getByRole("button", { name: zhCN.sidebar.systemSettings, exact: true }).click();
	const dialog = page.getByRole("dialog", { name: zhCN.sidebar.systemSettings });
	await expect(dialog).toBeVisible();

	for (const settingsPage of settingsPages) {
		await selectSettingsPage(page, dialog, viewport, settingsPage.label);
		await expect(settingsPage.landmark(dialog)).toBeVisible();
		await capture(page, viewport, `settings-${settingsPage.id}`);
		if (settingsPage.id === "archived") {
			const archivedDelete = dialog.getByRole("button", {
				name: zhCN.sidebar.deleteConversation,
			});
			await expect(archivedDelete).toHaveCount(1);
			await archivedDelete.click();
			const confirmation = page.getByRole("dialog", {
				name: zhCN.sidebar.deleteConversationTitle,
			});
			await expect(confirmation).toBeVisible();
			await capture(page, viewport, "archived-delete-confirmation");
			await confirmation.getByRole("button", { name: zhCN.messages.cancel }).click();
		}
	}
	await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
}

async function visitConversationContent(page: Page, viewport: Viewport): Promise<void> {
	await sendMessage(page, "E2E_STORY_ENTRY");
	const choices = page.getByRole("region", { name: "要进入《未送达的回报》吗？" });
	await expect(choices).toBeVisible();
	await capture(page, viewport, "conversation-choices");
	await choices.getByRole("button", { name: "以后再说" }).click();

	await sendMessage(page, "E2E_MEDIA_PREVIEW");
	const mediaCard = page.getByRole("region", { name: "继任规程" });
	await expect(mediaCard).toBeVisible();
	await mediaCard.getByRole("button", { name: zhCN.messages.openMedia }).click();
	const mediaPreview = page.getByRole("complementary", { name: "继任规程" });
	await expect(mediaPreview).toBeVisible();
	await capture(page, viewport, "media-preview");
	await mediaPreview.getByRole("button", { name: zhCN.messages.closeMedia }).click();

	await sendMessage(page, "E2E_DELEGATE_ARTIFACT");
	const artifact = page.getByRole("button", { name: /查看成果: e2e-report\.txt/ });
	await expect(artifact).toBeVisible({ timeout: 30_000 });
	await artifact.click();
	const artifactPreview = page.getByRole("dialog", { name: "e2e-report.txt" });
	await expect(artifactPreview).toBeVisible();
	await expect(
		artifactPreview.getByText("Artifact generated by the E2E external Run."),
	).toBeVisible();
	await capture(page, viewport, "artifact-preview");
	await artifactPreview.getByRole("button", { name: zhCN.work.result.close }).click();
}

for (const viewport of viewports) {
	test.describe(`${viewport.mode} complete site-map reachability`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test(`reaches and visually validates every persistent UI surface at ${viewport.width}x${viewport.height}`, async ({
			page,
		}) => {
			test.setTimeout(120_000);
			await ensureReadyForConversation(page);
			await visitConversationNavigation(page, viewport);
			await visitCharacterSettings(page, viewport);
			await visitSystemSettings(page, viewport);
			await visitConversationContent(page, viewport);
		});
	});
}
