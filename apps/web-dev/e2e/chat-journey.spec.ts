import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Page, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	getBootstrap,
	projectPiEntries,
	providerHold,
	sendMessage,
} from "./helpers";

async function nativeEntries(page: Page, conversationId: string) {
	const { token } = await getBootstrap(page);
	const response = await page.request.post("/rpc/conversation.open", {
		headers: { "x-bear-web-dev-token": token },
		data: { conversationId },
	});
	const envelope = await response.json();
	expect(envelope).toMatchObject({ ok: true });
	return projectPiEntries(envelope.data.branch.entries);
}

test("accepted send waits visibly before first text and survives authoritative refresh", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ensureReadyForConversation(page);
	const conversationId = await activeConversationId(page);
	const hold = providerHold(page);
	const message = `E2E_WAIT_TEXT_${hold.id}`;
	const reply = `E2E_WAIT_DONE_${hold.id}`;
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const user = thread.getByRole("article", { name: zhCN.messages.you, exact: true });
	try {
		await sendMessage(page, message);
		await hold.entered();
		await expect(page.getByTestId("conversation-activity")).toBeVisible();
		await expect(
			page
				.getByTestId("conversation-submission")
				.filter({ hasText: zhCN.messages.submission.send.submitting }),
		).toHaveCount(0);
		await expect(user.getByText(message, { exact: true })).toHaveCount(1);
		await expect(assistant).toHaveCount(0);
		await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeEnabled();
		await page.reload();
		await expect(thread).toBeVisible({ timeout: 15_000 });
		await activeConversationId(page, conversationId);
		await expect(page.getByTestId("conversation-activity")).toBeVisible();
		await expect(user.getByText(message, { exact: true })).toHaveCount(1);
		await expect(assistant.getByText(reply, { exact: true })).toHaveCount(0);
		await hold.release();
		await expect(assistant.getByText(reply, { exact: true })).toHaveCount(1);
		await expect(page.getByTestId("conversation-activity")).toBeHidden();
		const entries = await nativeEntries(page, conversationId);
		expect(entries.filter((entry) => entry.role === "user" && entry.text === message)).toHaveLength(
			1,
		);
		expect(
			entries.filter((entry) => entry.role === "assistant" && entry.text?.trim() === reply),
		).toHaveLength(1);
		expect(pageErrors).toEqual([]);
	} finally {
		await hold.release();
	}
});

test("historical edit shows resubmission before acceptance and then native execution", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const user = thread.getByRole("article", { name: zhCN.messages.you, exact: true });
	await sendMessage(page, "E2E_OK original before edit");
	await expect(assistant.getByText("E2E_OK", { exact: true })).toHaveCount(1);
	const hold = providerHold(page);
	const message = `E2E_WAIT_TEXT_${hold.id}`;
	const allowed = Promise.withResolvers<void>();
	await page.route("**/rpc/message.edit", async (route) => {
		await allowed.promise;
		await route.continue();
	});
	try {
		await thread
			.getByRole("article", { name: zhCN.messages.you })
			.getByRole("button", { name: zhCN.messages.edit })
			.click();
		const editor = thread.getByRole("textbox", { name: zhCN.messages.editLabel });
		await editor.fill(message);
		await editor.press("Enter");
		await expect(page.getByTestId("conversation-submission")).toContainText(
			zhCN.messages.submission.edit.submitting,
		);
		await expect(editor).toBeHidden();
		const accepted = page.waitForResponse("**/rpc/message.edit");
		allowed.resolve();
		expect(await (await accepted).json()).toMatchObject({ ok: true });
		await hold.entered();
		await expect(page.getByTestId("conversation-activity")).toBeVisible();
		await expect(
			page
				.getByTestId("conversation-submission")
				.filter({ hasText: zhCN.messages.submission.edit.submitting }),
		).toHaveCount(0);
		await expect(editor).toBeHidden();
		await expect(user.getByText(message, { exact: true })).toHaveCount(1);
		await expect(assistant.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(0);
		await hold.release();
		await expect(assistant.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(1);
		await expect(user.getByText("E2E_OK original before edit", { exact: true })).toHaveCount(0);
		await page.reload();
		await expect(user.getByText(message, { exact: true })).toHaveCount(1);
		await expect(assistant.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(1);
		expect(pageErrors).toEqual([]);
	} finally {
		allowed.resolve();
		await page.unroute("**/rpc/message.edit");
		await hold.release();
	}
});

test("correction accepts before completion and Stop cancels its real provider request", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ensureReadyForConversation(page);
	const hold = providerHold(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	try {
		await sendMessage(page, `E2E_CORRECTION_${hold.id}`);
		await expect(assistant.getByText("E2E_CORRECTION_ORIGINAL", { exact: true })).toHaveCount(1);
		await thread
			.getByRole("article", { name: "极昼" })
			.getByRole("button", { name: "这不像极昼" })
			.click();
		const accepted = page.waitForResponse("**/rpc/message.correct");
		await page.getByRole("button", { name: "语气不像他" }).click();
		expect(await (await accepted).json()).toMatchObject({ ok: true });
		await hold.entered();
		await expect(page.getByTestId("conversation-activity")).toBeVisible();
		const stop = page.getByRole("button", { name: zhCN.composer.stopLabel });
		await expect(stop).toBeEnabled();
		await stop.click();
		await hold.cancelled();
		await expect(page.getByTestId("conversation-activity")).toBeHidden();
		await expect(stop).toBeHidden();
		await expect(assistant.getByText("E2E_CORRECTION_REPLACED", { exact: true })).toHaveCount(0);
		await sendMessage(page, "E2E_OK after cancelled correction");
		await expect(assistant.getByText("E2E_OK", { exact: true })).toHaveCount(1);
		expect(pageErrors).toEqual([]);
	} finally {
		await hold.release();
	}
});

test("native retry stays visible and tool turns do not duplicate authoritative messages", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ensureReadyForConversation(page);
	const conversationId = await activeConversationId(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const user = thread.getByRole("article", { name: zhCN.messages.you, exact: true });
	const retry = providerHold(page);
	const tool = providerHold(page);
	try {
		await sendMessage(page, `E2E_WAIT_RETRY_${retry.id}`);
		await expect(page.getByTestId("conversation-activity")).toContainText(
			zhCN.messages.activity.retry,
		);
		await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeEnabled();
		await retry.entered();
		await retry.release();
		await expect(assistant.getByText(`E2E_WAIT_DONE_${retry.id}`, { exact: true })).toHaveCount(1);
		await expect(page.getByTestId("conversation-activity")).toBeHidden();
		await sendMessage(page, `E2E_WAIT_TOOL_${tool.id}`);
		await tool.entered();
		await expect(page.getByTestId("conversation-activity")).toBeVisible();
		await expect(user.getByText(`E2E_WAIT_TOOL_${tool.id}`, { exact: true })).toHaveCount(1);
		const entries = await nativeEntries(page, conversationId);
		expect(entries.some((entry) => entry.role === "toolResult")).toBe(true);
		await tool.release();
		await expect(assistant.getByText(`E2E_WAIT_DONE_${tool.id}`, { exact: true })).toHaveCount(1);
		await page.reload();
		for (const [mode, hold] of [
			["RETRY", retry],
			["TOOL", tool],
		] as const) {
			await expect(user.getByText(`E2E_WAIT_${mode}_${hold.id}`, { exact: true })).toHaveCount(1);
			await expect(assistant.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(1);
		}
		expect(pageErrors).toEqual([]);
	} finally {
		await Promise.all([retry.release(), tool.release()]);
	}
});

test("switching away from a pretext response does not leak activity or block the other session", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ensureReadyForConversation(page);
	const sessionA = await activeConversationId(page);
	const hold = providerHold(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const user = thread.getByRole("article", { name: zhCN.messages.you, exact: true });
	try {
		await sendMessage(page, `E2E_WAIT_TEXT_${hold.id}`);
		await hold.entered();
		await expect(page.getByTestId("conversation-activity")).toBeVisible();
		const [created] = await Promise.all([
			page.waitForResponse("**/rpc/conversation.create"),
			page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click(),
		]);
		const creation = await created.json();
		expect(creation).toMatchObject({ ok: true, data: { conversationId: expect.any(String) } });
		const sessionB = await activeConversationId(page, creation.data.conversationId);
		await expect(page.getByTestId("conversation-activity")).toBeHidden();
		await expect(page.getByTestId("conversation-submission")).toBeHidden();
		await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeHidden();
		expect(sessionB).not.toBe(sessionA);
		await sendMessage(page, "E2E_OK while another session waits");
		await expect(assistant.getByText("E2E_OK", { exact: true })).toHaveCount(1);
		await expect(page.getByTestId("conversation-activity")).toBeHidden();
		await expect(
			page.locator(`[data-conversation-id="${sessionA}"] .conversation-running`),
		).toBeVisible();
		await page.locator(`[data-conversation-id="${sessionA}"]`).click();
		await expect(page.getByTestId("conversation-activity")).toBeVisible();
		await expect(assistant.getByText("E2E_OK", { exact: true })).toHaveCount(0);
		await expect(user.getByText(`E2E_WAIT_TEXT_${hold.id}`, { exact: true })).toHaveCount(1);
		await hold.release();
		await expect(assistant.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(1);
		await page.locator(`[data-conversation-id="${sessionB}"]`).click();
		await expect(assistant.getByText("E2E_OK", { exact: true })).toHaveCount(1);
		await expect(assistant.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toHaveCount(0);
		expect(pageErrors).toEqual([]);
	} finally {
		await hold.release();
	}
});

test("chat streams once and preserves edited history through the UI", async ({ page }) => {
	const gapWarnings: string[] = [];
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.exposeFunction("recordChatWarning", (message: string) => gapWarnings.push(message));
	await page.addInitScript(() => {
		const observer = new MutationObserver(() => {
			if (document.body?.textContent?.includes("event sequence gap")) {
				void (
					window as unknown as { recordChatWarning(message: string): Promise<void> }
				).recordChatWarning("event sequence gap");
			}
		});
		observer.observe(document, { childList: true, subtree: true, characterData: true });
	});
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const user = thread.getByRole("article", { name: zhCN.messages.you, exact: true });

	await sendMessage(page, "STREAM_CHECK");
	await expect(user.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	await expect(assistant.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(thread.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
	await expect(assistant.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	expect(gapWarnings).toEqual([]);
	await page.reload();
	await expect(assistant.getByText("STREAM_ONE STREAM_TWO", { exact: true })).toHaveCount(1);
	await expect(user.getByText("STREAM_CHECK", { exact: true })).toHaveCount(1);
	expect(pageErrors).toEqual([]);
});

test("one MessageContent projection renders rich streaming output and the settled snapshot", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await sendMessage(page, "RICH_CONTENT_STREAM");

	const response = thread.getByRole("article", { name: "极昼" }).filter({ hasText: "交接结果" });
	await expect(response.getByRole("heading", { name: "交接结果" })).toBeVisible();
	expect(await response.getByText("状态：完成").evaluate((element) => element.tagName)).toBe(
		"STRONG",
	);
	await expect(response.getByRole("listitem")).toHaveCount(2);
	await expect(response.getByRole("table")).toBeVisible();
	expect(
		await response
			.getByText("const total = price * nights;")
			.evaluate((element) => [element.parentElement?.tagName, element.tagName]),
	).toEqual(["PRE", "CODE"]);
	await expect(response.getByRole("math")).toBeVisible();
	await expect(response.getByTestId("message-content")).not.toHaveAttribute("aria-busy", "true");

	await page.reload();
	const settled = thread.getByRole("article", { name: "极昼" }).filter({ hasText: "交接结果" });
	await expect(settled.getByRole("heading", { name: "交接结果" })).toBeVisible();
	await expect(settled.getByText("const total = price * nights;")).toBeVisible();
	await expect(settled.getByRole("math")).toBeVisible();
});

test("refreshing a running conversation restores its authoritative stream", async ({ page }) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	await sendMessage(page, "STREAM_HOLD_A");
	await expect(assistant.getByText("HOLD_ONE", { exact: false })).toBeVisible();

	await page.reload();

	await expect(assistant.getByText("HOLD_ONE", { exact: false })).toBeVisible();
	const activity = page.getByTestId("conversation-activity");
	await expect(activity).toBeVisible();
	await expect(assistant.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await expect(activity).toBeHidden();
});

test("two Pi sessions can run concurrently, switch locally, and finish without stealing focus", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const sessionAId = await activeConversationId(page);
	await sendMessage(page, "STREAM_HOLD_A");
	await expect(
		sidebar.locator(`[data-conversation-id="${sessionAId}"] .conversation-running`),
	).toBeVisible();
	await expect(page.getByTestId("conversation-activity")).toBeVisible();
	await expect(assistant.getByText(/HOLD_ONE/)).toBeVisible();

	await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
	await expect(assistant.getByText(/HOLD_ONE/)).toBeHidden();
	await expect(page.getByTestId("conversation-activity")).toBeHidden();
	await expect(page.getByTestId("conversation-submission")).toBeHidden();
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled();
	await sendMessage(page, "E2E_OK session B stays focused");
	await expect(assistant.getByText("E2E_OK", { exact: true })).toBeVisible();

	const sessionA = sidebar.locator(`[data-conversation-id="${sessionAId}"]`);
	await expect(sessionA).toBeVisible();
	await expect(assistant.getByText("E2E_OK", { exact: true })).toBeVisible();
	await expect(assistant.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toBeHidden();
	await expect(sessionA.getByRole("status", { name: zhCN.sidebar.responseReady })).toBeVisible({
		timeout: 15_000,
	});
	await sessionA.click();
	await expect(assistant.getByText("HOLD_ONE HOLD_TWO", { exact: true })).toBeVisible();
	await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
});

test("a local path is ordinary natural-language user input", async ({ page }) => {
	await ensureReadyForConversation(page);
	const path = fileURLToPath(new URL("./fixtures/local-note.txt", import.meta.url));
	const message = `请读一下这个本机文件并告诉我重点：${path}`;
	await sendMessage(page, message);
	await expect(
		page
			.getByRole("region", { name: zhCN.messages.conversation })
			.getByRole("article", { name: zhCN.messages.you, exact: true })
			.getByText(message, { exact: true }),
	).toHaveCount(1);
});

test("latest assistant reply branches through the UI and activates the native fork", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const assistant = thread.getByRole("article", { name: "极昼", exact: true });
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const previousConversationId = await activeConversationId(page);
	await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
	await expect
		.poll(async () => {
			const current = await activeConversationId(page);
			return Boolean(current && current !== previousConversationId);
		})
		.toBe(true);
	const sourceConversationId = await activeConversationId(page);

	await sendMessage(page, "E2E_OK branch source");
	const reply = assistant.getByText("E2E_OK", { exact: true });
	await expect(reply).toBeVisible();
	await thread.getByRole("button", { name: zhCN.messages.branch }).click();

	await expect
		.poll(async () => {
			const current = await activeConversationId(page);
			return Boolean(current && current !== sourceConversationId);
		})
		.toBe(true);
	const forkConversationId = await activeConversationId(page);
	await expect(assistant.getByText("E2E_OK", { exact: true })).toBeVisible();
	await expect(sidebar.locator(`[data-conversation-id="${sourceConversationId}"]`)).toBeVisible();
	await expect(sidebar.locator(`[data-conversation-id="${forkConversationId}"]`)).toHaveAttribute(
		"aria-current",
		"page",
	);
});
