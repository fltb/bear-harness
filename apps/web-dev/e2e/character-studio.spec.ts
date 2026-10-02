import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	providerHold,
	sendMessage,
} from "./helpers";

const copy = zhCN.studio;
test("Studio creates and resumes a complete draft, restores invalid YAML and applies on mobile", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await page.goto("/");
	await page.getByRole("button", { name: copy.library, exact: true }).click();
	const studio = page.getByRole("region", { name: copy.library, exact: true });
	await expect(studio).toBeVisible();
	await studio.getByRole("button", { name: copy.newRole, exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel(copy.name, { exact: true }).fill("Studio 测试角色");
	await dialog.getByLabel(copy.id, { exact: true }).fill("studio-browser-test");
	await dialog.getByRole("button", { name: copy.create, exact: true }).click();
	await studio
		.getByLabel(`${copy.identity} ${copy.required}`, { exact: true })
		.fill("一位修理旧收音机的朋友，名叫阿林。喜欢步行。 ");
	await studio.getByRole("button", { name: copy.save, exact: true }).click();
	await expect(studio.getByText(copy.saved, { exact: true })).toBeVisible();
	await studio.getByLabel(copy.filePath, { exact: true }).fill("canon/radio.md");
	await studio.getByRole("button", { name: copy.newFile, exact: true }).click();
	const canonSaved = page.waitForResponse((response) =>
		response.url().endsWith("/rpc/character.draftPatch"),
	);
	await studio
		.getByLabel(copy.source, { exact: true })
		.fill("# 收音机\n这台收音机是阿林从旧货市场带回来的。\n");
	await studio.getByRole("button", { name: copy.backLibrary, exact: true }).click();
	const restoreRevision = (await (await canonSaved).json()).data.draft.currentRevision;
	await studio.getByRole("button", { name: copy.backChat, exact: true }).click();
	await expect(studio).toHaveCount(0);
	await page.reload();
	await page.getByRole("button", { name: copy.library, exact: true }).click();
	await studio.getByRole("button", { name: copy.resume, exact: true }).click();
	await studio.getByRole("button", { name: "canon/radio.md", exact: true }).click();
	await expect(studio.getByLabel(copy.source, { exact: true })).toHaveValue(/旧货市场/);
	await studio.getByRole("button", { name: "character.yaml", exact: true }).click();
	const original = await studio.getByLabel(copy.source, { exact: true }).inputValue();
	await studio.getByLabel(copy.source, { exact: true }).fill("behavior: [broken YAML");
	await studio.getByRole("button", { name: copy.save, exact: true }).click();
	await expect(studio.getByText(copy.saved, { exact: true })).toBeVisible();
	await studio.getByRole("button", { name: copy.apply, exact: true }).click();
	await expect(page.getByRole("dialog").getByRole("heading", { name: copy.issues })).toBeVisible();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: zhCN.messages.cancel, exact: true })
		.click();
	await studio.getByText(copy.history, { exact: true }).click();
	await studio
		.getByRole("group", { name: `#${restoreRevision}`, exact: true })
		.getByRole("button", { name: copy.restore, exact: true })
		.click();
	await expect(studio.getByLabel(copy.source, { exact: true })).toHaveValue(original);
	await page.setViewportSize({ width: 390, height: 844 });
	await studio.getByRole("button", { name: copy.contents, exact: true }).click();
	await studio.getByRole("button", { name: copy.commonFields, exact: true }).click();
	await expect(studio.getByLabel(`${copy.identity} ${copy.required}`, { exact: true })).toHaveValue(
		/阿林/,
	);
	await expect(
		studio.getByLabel(`${copy.name} ${copy.required}`, { exact: true }),
	).toBeInViewport();
	await page.screenshot({ path: "/tmp/bear-studio-mobile.png", fullPage: true });
	await studio.getByRole("button", { name: copy.apply, exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: copy.confirmApply, exact: true })
		.click();
	await expect(studio.getByText(copy.applied, { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	await studio.getByRole("button", { name: copy.backLibrary, exact: true }).click();
	await expect(studio.getByRole("heading", { name: "Studio 测试角色", exact: true })).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await studio
		.getByRole("article")
		.filter({ has: page.getByRole("heading", { name: "Studio 测试角色", exact: true }) })
		.getByRole("button", { name: new RegExp(`^(${copy.edit}|${copy.resume})$`) })
		.click();
	await expect(studio.getByRole("button", { name: "canon/radio.md", exact: true })).toBeVisible();
	await page.screenshot({ path: "/tmp/bear-studio-desktop.png", fullPage: true });
});

test("Studio keeps the active Pi response and composer intact and refuses to apply while streaming", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const conversationId = await activeConversationId(page);
	const hold = providerHold(page);
	try {
		await sendMessage(page, `E2E_WAIT_TEXT_${hold.id}`);
		await hold.entered();
		const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
		await composer.fill("保留在输入框里的下一条消息");
		await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
		await page
			.getByRole("dialog")
			.getByRole("button", { name: copy.editRole, exact: true })
			.click();
		const studio = page.getByRole("region", { name: copy.library, exact: true });
		await expect(studio.getByRole("button", { name: "character.yaml", exact: true })).toBeVisible();
		await studio.getByRole("button", { name: copy.apply, exact: true }).click();
		await page
			.getByRole("dialog")
			.getByRole("button", { name: copy.confirmApply, exact: true })
			.click();
		await expect(studio.getByRole("alert")).toContainText(copy.busyRole);
		await hold.release();
		await studio.getByRole("button", { name: copy.backLibrary, exact: true }).click();
		await studio.getByRole("button", { name: copy.backChat, exact: true }).click();
		await expect(composer).toHaveValue("保留在输入框里的下一条消息");
		await activeConversationId(page, conversationId);
		await expect(
			page
				.getByRole("article", { name: "极昼", exact: true })
				.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true }),
		).toBeVisible();
	} finally {
		await hold.release();
	}
});

test("Studio copies installed content and uploads, downloads and removes an asset in the draft", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	await page.getByRole("button", { name: copy.library, exact: true }).click();
	const studio = page.getByRole("region", { name: copy.library, exact: true });
	await studio
		.getByRole("article")
		.filter({ has: page.getByRole("heading", { name: "极昼", exact: true }) })
		.getByRole("button", { name: copy.copy, exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel(copy.name, { exact: true }).fill("复制测试");
	await dialog.getByLabel(copy.id, { exact: true }).fill("studio-copy-test");
	await dialog.getByRole("button", { name: copy.create, exact: true }).click();
	await expect(studio.getByLabel(`${copy.name} ${copy.required}`, { exact: true })).toHaveValue(
		"复制测试",
	);
	await expect(
		studio.getByRole("button", { name: "canon/old-station.md", exact: true }),
	).toBeVisible();
	const asset = Buffer.from([0, 1, 2, 250, 255]);
	await studio
		.getByLabel(copy.upload, { exact: true })
		.setInputFiles({ name: "test.bin", mimeType: "application/octet-stream", buffer: asset });
	await expect(studio.getByRole("heading", { name: "assets/test.bin", exact: true })).toBeVisible();
	const downloadEvent = page.waitForEvent("download");
	await studio.getByRole("button", { name: copy.downloadFile, exact: true }).click();
	const download = await downloadEvent;
	expect(download.suggestedFilename()).toBe("test.bin");
	const stream = await download.createReadStream();
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	expect(Buffer.concat(chunks)).toEqual(asset);
	page.once("dialog", (prompt) => prompt.accept());
	await studio.getByRole("button", { name: copy.remove, exact: true }).click();
	await expect(studio.getByRole("button", { name: "assets/test.bin", exact: true })).toHaveCount(0);
	await studio.getByRole("button", { name: copy.backLibrary, exact: true }).click();
	await expect(studio.getByRole("heading", { name: "复制测试", exact: true })).toHaveCount(0);
	await expect(studio.getByRole("heading", { name: "极昼", exact: true })).toBeVisible();
});

test("Studio edits real advanced fields, previews package assets, exports ZIP and runs an isolated Pi trial", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await ensureReadyForConversation(page);
	const originalConversation = await activeConversationId(page);
	await page.getByRole("button", { name: copy.library, exact: true }).click();
	const studio = page.getByRole("region", { name: copy.library, exact: true });
	await studio
		.getByRole("article")
		.filter({ has: page.getByRole("heading", { name: "极昼", exact: true }) })
		.getByRole("button", { name: new RegExp(`^(${copy.edit}|${copy.resume})$`) })
		.click();
	await studio
		.getByRole("button", { name: `${copy.sections.scenes} · scenes`, exact: true })
		.click();
	const sceneLabel = studio.getByRole("textbox", { name: /scenes\.0\.label/ });
	await sceneLabel.fill("Studio scene label");
	await studio.getByRole("button", { name: copy.save, exact: true }).click();
	await studio.getByRole("button", { name: "character.yaml", exact: true }).click();
	await expect(studio.getByLabel(copy.source, { exact: true })).toHaveValue(/Studio scene label/);
	await studio.getByRole("button", { name: copy.preview, exact: true }).click();
	const preview = page.getByRole("dialog", { name: copy.preview, exact: true });
	await expect(preview.getByRole("img", { name: "Studio scene label", exact: true })).toBeVisible();
	await preview.getByRole("button", { name: zhCN.backstage.close, exact: true }).click();
	const download = page.waitForEvent("download");
	await studio.getByRole("button", { name: copy.exportZip, exact: true }).click();
	expect((await download).suggestedFilename()).toBe("jizhou.zip");
	await studio.getByRole("button", { name: copy.trial, exact: true }).click();
	const trial = page.getByRole("dialog", { name: copy.trial, exact: true });
	await trial.getByRole("button", { name: copy.trialStart, exact: true }).click();
	const hold = providerHold(page);
	try {
		await trial.getByLabel(copy.trialMessage, { exact: true }).fill(`E2E_WAIT_TEXT_${hold.id}`);
		await trial.getByRole("button", { name: copy.trialSend, exact: true }).click();
		await hold.entered();
		await expect(trial.getByRole("button", { name: copy.trialStop, exact: true })).toBeEnabled();
		await hold.release();
		await expect(trial.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toBeVisible();
		await trial.getByRole("button", { name: copy.trialReset, exact: true }).click();
		await expect(trial.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(0);
		await trial.getByRole("button", { name: zhCN.backstage.close, exact: true }).click();
		await studio.getByRole("button", { name: copy.backLibrary, exact: true }).click();
		await studio.getByRole("button", { name: copy.backChat, exact: true }).click();
		await activeConversationId(page, originalConversation);
		await expect(page.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(0);
	} finally {
		await hold.release();
	}
});
