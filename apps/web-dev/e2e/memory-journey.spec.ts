import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, sendMessage } from "./helpers";

test("direct memory capture, scoped context, and user management stay deterministic", async ({
	page,
}) => {
	await ensureReadyForConversation(page);

	const bootstrap = (await (await page.request.get("/bootstrap")).json()) as { token: string };
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const sourceText = "E2E_DIRECT_MEMORY_A：我们约定暗号是北辰";
	const replacementText = "E2E_DIRECT_MEMORY_A：我们约定暗号是南星";
	const secondSourceText = "E2E_DIRECT_MEMORY_B：我们约定暗号是北辰";

	const memoryEntries = async (): Promise<
		Array<{ id: string; text: string; createdBy: string; sourceEntryId?: string; status?: string }>
	> => {
		const response = await page.request.post("/rpc/memory.list%3Av1", { headers, data: {} });
		const payload = (await response.json()) as {
			ok: boolean;
			data?: {
				entries?: Array<{
					id: string;
					text: string;
					createdBy: string;
					sourceEntryId?: string;
					status?: string;
				}>;
			};
		};
		expect(payload).toMatchObject({ ok: true });
		return payload.data?.entries ?? [];
	};

	const captureMessage = async (text: string): Promise<string> => {
		await sendMessage(page, text);
		await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
		const conversation = page.getByRole("region", { name: zhCN.messages.conversation });
		const message = conversation
			.getByRole("article", { name: zhCN.messages.userMeta })
			.filter({ hasText: text });
		await expect(message).toBeVisible();
		await expect(message).toHaveCount(1);
		const sourceEntryId = await message.getAttribute("data-message-id");
		expect(sourceEntryId).toBeTruthy();
		await message.getByRole("button", { name: zhCN.messages.operations }).click();
		await message.getByRole("button", { name: zhCN.messages.rememberMoment }).click();
		return sourceEntryId as string;
	};
	const expectMemoryContext = async (expected: string): Promise<void> => {
		await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
		const conversation = page.getByRole("region", { name: zhCN.messages.conversation });
		const latestAssistant = conversation.getByRole("article").filter({
			has: page.getByRole("button", { name: zhCN.messages.continue }),
		});
		const matchingResponse = latestAssistant.getByText(expected, { exact: true });
		await expect.poll(() => matchingResponse.count()).toBeGreaterThan(0);
		await expect(matchingResponse).toBeVisible();
	};

	const setRelationshipMemory = async (enabled: boolean): Promise<void> => {
		await page.getByRole("button", { name: zhCN.sidebar.characterSettings }).click();
		const dialog = page.getByRole("dialog", { name: zhCN.backstage.title });
		await dialog.getByRole("tab", { name: zhCN.backstage.relationshipArchive }).click();
		const memorySwitch = dialog.getByRole("switch", {
			name: zhCN.settings.relationshipMemory,
		});
		await expect(memorySwitch).toBeVisible();
		if ((await memorySwitch.getAttribute("aria-checked")) !== String(enabled)) {
			await memorySwitch.click();
		}
		await expect(memorySwitch).toHaveAttribute("aria-checked", String(enabled));
		await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
	};

	const openRelationshipMemory = async (query: string) => {
		await page.getByRole("button", { name: zhCN.sidebar.characterSettings }).click();
		const dialog = page.getByRole("dialog", { name: zhCN.backstage.title });
		await expect(dialog).toBeVisible();
		const memoryTab = dialog.getByRole("tab", { name: zhCN.backstage.memory });
		await memoryTab.click();
		await expect(memoryTab).toHaveAttribute("aria-selected", "true");
		const relationshipTab = dialog.getByRole("tab", { name: zhCN.memory.scopes.relationship });
		await relationshipTab.click();
		await expect(relationshipTab).toHaveAttribute("aria-selected", "true");
		const search = dialog.getByRole("searchbox", { name: zhCN.memory.searchLabel });
		await search.fill(query);
		await search.press("Enter");
		const entries = dialog.getByRole("region", { name: zhCN.memory.defaultEntriesTitle });
		await expect(entries).toBeVisible();
		return entries;
	};

	await setRelationshipMemory(true);

	const sourceEntryId = await captureMessage(sourceText);
	await expect
		.poll(async () => (await memoryEntries()).find((entry) => entry.text === sourceText))
		.toMatchObject({
			text: sourceText,
			createdBy: "user_capture",
			sourceEntryId,
			status: "active",
		});

	await sendMessage(page, `检查记忆上下文 ${sourceText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是北辰");

	let entries = await openRelationshipMemory(sourceText);
	await expect.poll(() => entries.getByText(sourceText, { exact: true }).count()).toBe(1);
	const sourceEntry = entries.getByRole("listitem").filter({ hasText: sourceText });
	await expect(sourceEntry).toBeVisible();
	await sourceEntry.getByRole("button", { name: zhCN.memory.edit }).click();
	await entries.getByRole("textbox", { name: zhCN.memory.editedContent }).fill(replacementText);
	await entries.getByRole("button", { name: zhCN.memory.saveEdit }).click();
	await expect(entries.getByRole("status")).toHaveText(zhCN.memory.revised);
	await expect(entries.getByText(replacementText, { exact: true })).toBeVisible();
	await expect(entries.getByText(sourceText, { exact: true })).toHaveCount(0);
	await page
		.getByRole("dialog", { name: zhCN.backstage.title })
		.getByRole("button", {
			name: zhCN.backstage.close,
		})
		.click();

	await sendMessage(page, `检查记忆上下文 ${replacementText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是南星");

	await setRelationshipMemory(false);
	await sendMessage(page, `检查记忆上下文 ${replacementText}`);
	await expectMemoryContext("MEMORY_CONTEXT:ABSENT");

	await setRelationshipMemory(true);
	await sendMessage(page, `检查记忆上下文 ${replacementText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是南星");

	const conversations = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const conversationItems = conversations.getByRole("button");
	const conversationCountBeforeSecondCapture = await conversationItems.count();

	await page.getByRole("button", { name: zhCN.sidebar.newConversation }).click();
	await expect
		.poll(() => conversationItems.count())
		.toBeGreaterThan(conversationCountBeforeSecondCapture);
	await expect
		.poll(() =>
			conversationItems.evaluateAll(
				(items) => items.filter((item) => item.getAttribute("aria-current") === "page").length,
			),
		)
		.toBe(1);
	await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled();
	const secondSourceEntryId = await captureMessage(secondSourceText);
	await expect
		.poll(async () => (await memoryEntries()).find((entry) => entry.text === secondSourceText))
		.toMatchObject({
			text: secondSourceText,
			createdBy: "user_capture",
			sourceEntryId: secondSourceEntryId,
			status: "active",
		});
	await sendMessage(page, `检查记忆上下文 ${secondSourceText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是北辰");

	entries = await openRelationshipMemory(secondSourceText);
	const secondEntry = entries.getByRole("listitem").filter({ hasText: secondSourceText });
	await expect.poll(() => entries.getByText(secondSourceText, { exact: true }).count()).toBe(1);
	await expect(secondEntry).toBeVisible();
	await secondEntry.getByRole("button", { name: zhCN.memory.forget }).click();
	await expect(entries.getByRole("status")).toHaveText(zhCN.memory.forget);
	await expect(entries.getByText(secondSourceText, { exact: true })).toHaveCount(0);
	await page
		.getByRole("dialog", { name: zhCN.backstage.title })
		.getByRole("button", {
			name: zhCN.backstage.close,
		})
		.click();

	await sendMessage(page, `检查记忆上下文 ${replacementText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是南星");

	entries = await openRelationshipMemory(replacementText);
	await expect.poll(() => entries.getByText(replacementText, { exact: true }).count()).toBe(1);
	const revisedEntry = entries.getByRole("listitem").filter({ hasText: replacementText });
	await expect(revisedEntry).toBeVisible();
	await revisedEntry.getByRole("button", { name: zhCN.memory.invalidate }).click();
	await expect(entries.getByRole("status")).toBeVisible();
	await expect(entries.getByRole("status")).toHaveText(zhCN.memory.invalidated);
	await expect
		.poll(async () => (await memoryEntries()).find((entry) => entry.text === replacementText))
		.toMatchObject({
			text: replacementText,
			status: "invalidated",
		});
	await page
		.getByRole("dialog", { name: zhCN.backstage.title })
		.getByRole("button", {
			name: zhCN.backstage.close,
		})
		.click();

	await sendMessage(page, `检查记忆上下文 ${replacementText}`);
	await expectMemoryContext("MEMORY_CONTEXT:ABSENT");

	await setRelationshipMemory(false);
	await page.reload();
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings }).click();
	await page
		.getByRole("dialog", { name: zhCN.backstage.title })
		.getByRole("tab", { name: zhCN.backstage.relationshipArchive })
		.click();
	await expect(
		page.getByRole("switch", { name: zhCN.settings.relationshipMemory }),
	).toHaveAttribute("aria-checked", "false");
});
