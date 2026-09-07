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
		id: "archived",
		label: zhCN.sidebar.archivedConversations,
		landmark: (dialog: Locator) =>
			dialog.getByRole("heading", { name: zhCN.sidebar.archivedConversations, exact: true }),
	},
	{
		id: "providers",
		label: zhCN.settings.systemModelSettings,
		landmark: (dialog: Locator) =>
			dialog.getByRole("region", { name: zhCN.settings.systemModelSettings }),
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
	if (viewport.mode === "mobile") {
		const trigger = page.getByRole("button", { name: zhCN.sidebar.conversations, exact: true });
		if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
	}
	await expect(navigation).toBeVisible();
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

async function assertSurface(page: Page, viewport: Viewport, surface: Locator): Promise<void> {
	await expect(surface).toBeVisible();
	await expect(surface).toBeInViewport();
	await expect
		.poll(
			async () => {
				const box = await surface.boundingBox();
				return (
					box !== null &&
					box.x >= -1 &&
					box.y >= -1 &&
					box.x + box.width <= viewport.width + 1 &&
					box.y + box.height <= viewport.height + 1
				);
			},
			{ message: `${viewport.mode} surface must fit inside the viewport` },
		)
		.toBe(true);
	await assertViewportIntegrity(page, viewport);
}

async function activeConversationRow(page: Page): Promise<Locator> {
	const navigation = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	// test-quality-allow locator: conversation id and aria-current are the public navigation contract
	const active = navigation.locator('[data-conversation-id][aria-current="page"]');
	await expect(active).toHaveCount(1);
	// Navigation actions are revealed by hovering the conversation row.
	await active.hover();
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
	await assertSurface(
		page,
		viewport,
		page.getByRole("textbox", { name: zhCN.composer.messageInputLabel }),
	);
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEditable();

	const workButton = page.getByRole("button", {
		name: `${zhCN.threadHead.runningWork} 0`,
		exact: true,
	});
	await workButton.click();
	const taskWorkspace = page.getByRole("region", { name: zhCN.threadHead.runningWork });
	await expect(taskWorkspace).toBeVisible();
	await expect(workButton).toHaveAttribute("aria-expanded", "true");
	await expect(taskWorkspace).toBeFocused();
	await assertSurface(page, viewport, taskWorkspace);
	const historyButton = taskWorkspace.getByRole("button", { name: zhCN.work.task.history });
	await historyButton.click();
	await expect(historyButton).toHaveAttribute("aria-expanded", "true");
	const history = taskWorkspace.getByRole("region", { name: zhCN.work.task.history });
	await expect(history).toBeVisible();
	await expect(history).toHaveAttribute("aria-busy", "false");
	await expect(history.getByRole("alert")).toHaveCount(0);
	await historyButton.click();
	await expect(historyButton).toHaveAttribute("aria-expanded", "false");
	await expect(history).toBeHidden();
	await taskWorkspace.getByRole("button", { name: zhCN.work.task.close }).click();
	await expect(taskWorkspace).toBeHidden();
	await expect(workButton).toHaveAttribute("aria-expanded", "false");
	await expect(workButton).toBeFocused();
	await workButton.click();
	await expect(taskWorkspace).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(taskWorkspace).toBeHidden();
	await expect(workButton).toHaveAttribute("aria-expanded", "false");
	await expect(workButton).toBeFocused();

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
	await assertSurface(page, viewport, rename);
	await page.getByRole("button", { name: zhCN.sidebar.saveConversation }).click();
	await expect(rename).toBeHidden();
	await expect(
		row.getByRole("button", { name: new RegExp(`^站点地图-${viewport.mode}`) }),
	).toBeVisible();

	await revealSidebar(page, viewport);
	const renamedRow = await activeConversationRow(page);
	await renamedRow.getByRole("button", { name: zhCN.sidebar.deleteConversation }).click();
	const deleteDialog = page.getByRole("dialog", { name: zhCN.sidebar.deleteConversationTitle });
	await expect(deleteDialog).toBeVisible();
	await assertSurface(page, viewport, deleteDialog);
	await expect(
		deleteDialog.getByRole("button", { name: zhCN.sidebar.deleteConversationConfirmAction }),
	).toBeEnabled();
	await deleteDialog.getByRole("button", { name: zhCN.messages.cancel }).click();
	await expect(deleteDialog).toBeHidden();
	await expect(
		renamedRow.getByRole("button", { name: zhCN.sidebar.deleteConversation }),
	).toBeFocused();

	await revealSidebar(page, viewport);
	const conversationNavigation = page.getByRole("navigation", {
		name: zhCN.sidebar.conversations,
		// Creating a conversation closes the mobile drawer; membership remains observable.
		includeHidden: true,
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
			.getByRole("article", { name: "极昼", exact: true })
			.getByText("E2E_OK", { exact: true }),
	).toBeVisible();
	await revealSidebar(page, viewport);
	const archiveRow = await activeConversationRow(page);
	await archiveRow.getByRole("button", { name: zhCN.sidebar.archiveConversation }).click();
	await expect.poll(() => conversationButtons.count()).toBe(beforeCreate);
	// Archiving the selected conversation does not select another one.
	await revealSidebar(page, viewport);
	await conversationNavigation.locator(`[data-conversation-id="${previousId}"]`).click();
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeVisible();
}

async function visitCharacterSettings(page: Page, viewport: Viewport): Promise<void> {
	await revealSidebar(page, viewport);
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	const dialog = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("region", { name: zhCN.currentRolePackage.selectorLabel }),
	).toBeVisible();
	await expect(
		dialog.getByRole("group", { name: zhCN.currentRolePackage.promptEditor }),
	).toBeVisible();
	await assertSurface(page, viewport, dialog);

	const localData = dialog.getByRole("region", { name: zhCN.currentRolePackage.localDataTitle });
	await localData.scrollIntoViewIfNeeded();
	await expect(localData).toBeVisible();
	await assertSurface(page, viewport, dialog);
	await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
	await expect(dialog).toBeHidden();
}

async function visitSystemSettings(page: Page, viewport: Viewport): Promise<void> {
	await revealSidebar(page, viewport);
	await page.getByRole("button", { name: zhCN.sidebar.systemSettings, exact: true }).click();
	const dialog = page.getByRole("dialog", { name: zhCN.sidebar.systemSettings });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: zhCN.settings.workAgent })).toHaveCount(0);
	await expect(dialog.getByText(zhCN.settings.optionalCodexAgent, { exact: true })).toHaveCount(0);

	for (const settingsPage of settingsPages) {
		await selectSettingsPage(page, dialog, viewport, settingsPage.label);
		await expect(settingsPage.landmark(dialog)).toBeVisible();
		await assertSurface(page, viewport, dialog);
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
			await assertSurface(page, viewport, confirmation);
			await expect(
				confirmation.getByRole("button", { name: zhCN.sidebar.deleteConversationConfirmAction }),
			).toBeEnabled();
			await confirmation.getByRole("button", { name: zhCN.messages.cancel }).click();
			await expect(confirmation).toBeHidden();
			await expect(archivedDelete).toBeFocused();
		}
	}
	await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
	await expect(dialog).toBeHidden();
}

async function visitConversationContent(page: Page, viewport: Viewport): Promise<void> {
	await sendMessage(page, "E2E_STORY_ENTRY");
	const choices = page.getByRole("region", { name: "要进入《未送达的回报》吗？" });
	await expect(choices).toBeVisible();
	await choices.scrollIntoViewIfNeeded();
	await assertSurface(page, viewport, choices);
	const [choiceResponse] = await Promise.all([
		page.waitForResponse(
			(response) =>
				response.request().method() === "POST" && response.url().includes("/rpc/message.send"),
		),
		choices.getByRole("button", { name: "以后再说" }).click(),
	]);
	expect(await choiceResponse.json()).toMatchObject({ ok: true });

	await sendMessage(page, "E2E_MEDIA_PREVIEW");
	const mediaCard = page.getByRole("region", { name: "极昼的来处" });
	const mediaTrigger = mediaCard.getByRole("button", { name: zhCN.messages.openMedia });
	const mediaPreview = page.getByRole("dialog", { name: "极昼的来处" });
	await expect(mediaCard.getByRole("img", { name: "极昼的来处" })).toBeVisible();
	await expect(mediaPreview).toHaveCount(0);
	await mediaTrigger.click();
	await assertSurface(page, viewport, mediaPreview);
	const picture = mediaPreview.getByRole("img", { name: "极昼的来处" });
	await expect(picture).toBeVisible();
	await expect
		.poll(() =>
			picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
		)
		.toBe(true);
	if (viewport.mode === "mobile") {
		await expect(mediaPreview).toHaveJSProperty("clientWidth", viewport.width);
		await expect(mediaPreview).toHaveJSProperty("clientHeight", viewport.height);
	} else {
		await mediaPreview.getByRole("button", { name: zhCN.messages.expandMedia }).click();
		await expect(mediaPreview).toHaveJSProperty("clientWidth", viewport.width);
		await expect(mediaPreview).toHaveJSProperty("clientHeight", viewport.height);
		await mediaPreview.getByRole("button", { name: zhCN.messages.restoreMedia }).click();
		await assertSurface(page, viewport, mediaPreview);
	}
	await mediaPreview.getByRole("button", { name: zhCN.messages.originalMediaSize }).click();
	const fitMedia = mediaPreview.getByRole("button", { name: zhCN.messages.fitMedia });
	await expect(fitMedia).toHaveAttribute("aria-pressed", "true");
	await fitMedia.click();
	await expect(
		mediaPreview.getByRole("button", { name: zhCN.messages.originalMediaSize }),
	).toHaveAttribute("aria-pressed", "false");
	await mediaPreview.getByRole("button", { name: zhCN.messages.closeMedia }).click();
	await expect(mediaPreview).toHaveCount(0);
	await expect(mediaTrigger).toBeFocused();

	await sendMessage(page, "E2E_DELEGATE_ARTIFACT");
	const artifact = page.getByRole("button", {
		name: `${zhCN.work.timeline.viewArtifacts}: e2e-report.txt`,
		exact: true,
	});
	await expect(artifact).toBeVisible({ timeout: 30_000 });
	const artifactPreview = page.getByRole("dialog", { name: "e2e-report.txt" });
	await expect(artifactPreview).toHaveCount(0);
	await artifact.click();
	const safePreview = artifactPreview.getByRole("region", { name: "e2e-report.txt", exact: true });
	await expect(safePreview).toHaveAttribute("data-preview-state", "ready");
	await expect(safePreview).toHaveAttribute("aria-busy", "false");
	await expect(safePreview).toBeVisible();
	await expect(safePreview.getByRole("alert")).toHaveCount(0);
	await expect(
		artifactPreview
			.getByRole("list", { name: zhCN.work.result.tabsLabel })
			.getByRole("button")
			.filter({ hasText: "e2e-report.txt" }),
	).toHaveAttribute("aria-current", "true");
	await expect(
		artifactPreview.getByRole("region", { name: zhCN.work.result.provenance }),
	).toBeVisible();
	await expect(artifactPreview.getByRole("button", { name: zhCN.work.download })).toBeEnabled();
	await assertSurface(page, viewport, artifactPreview);
	const resultBox = await artifactPreview.boundingBox();
	const mainBox = await page.getByRole("main").boundingBox();
	if (!resultBox || !mainBox) throw new Error("Conversation and result require visible geometry");
	const presence = page.getByRole("img", { name: "极昼值守中", exact: true });
	if (viewport.mode === "fullscreen") {
		await expect(presence).toHaveCount(0);
		expect(resultBox.x).toBeGreaterThanOrEqual(mainBox.x + mainBox.width - 1);
		expect(Math.abs(resultBox.width - mainBox.width)).toBeLessThanOrEqual(1);
		const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
		await composer.fill("边看结果边继续聊");
		await expect(artifactPreview).toBeVisible();
		await mediaTrigger.click();
		await assertSurface(page, viewport, mediaPreview);
		await page.keyboard.press("Escape");
		await expect(mediaPreview).toHaveCount(0);
		await expect(mediaTrigger).toBeFocused();
		await expect(artifactPreview).toBeVisible();
		await expect(safePreview).toHaveAttribute("data-preview-state", "ready");
		await expect(composer).toHaveValue("边看结果边继续聊");
		await composer.fill("");
	} else if (viewport.mode === "window") {
		expect(resultBox.x).toBeGreaterThan(0);
		expect(Math.abs(resultBox.x + resultBox.width - viewport.width)).toBeLessThanOrEqual(1);
		expect(resultBox.x).toBeLessThan(mainBox.x + mainBox.width);
	} else {
		await expect(artifactPreview).toHaveJSProperty("clientWidth", viewport.width);
		await expect(artifactPreview).toHaveJSProperty("clientHeight", viewport.height);
	}
	await artifactPreview.getByRole("button", { name: zhCN.work.result.close }).click();
	await expect(artifactPreview).toHaveCount(0);
	if (viewport.mode === "fullscreen") await expect(presence).toBeVisible();
	if (viewport.mode !== "fullscreen") {
		await mediaTrigger.click();
		await assertSurface(page, viewport, mediaPreview);
		await page.keyboard.press("Escape");
		await expect(mediaPreview).toHaveCount(0);
		await expect(mediaTrigger).toBeFocused();
	}

	await assertSurface(
		page,
		viewport,
		page.getByRole("textbox", { name: zhCN.composer.messageInputLabel }),
	);
}

for (const viewport of viewports) {
	test.describe(`${viewport.mode} complete site-map reachability`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test(`reaches and validates every persistent UI surface through DOM at ${viewport.width}x${viewport.height}`, async ({
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
