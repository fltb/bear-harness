import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, getBootstrap, sendMessage } from "./helpers";

test("direct memory capture, scoped context, and user management stay deterministic", async ({
	page,
}) => {
	await ensureReadyForConversation(page);

	const bootstrap = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const sourceText = "E2E_DIRECT_MEMORY_A：我们约定暗号是北辰";
	const secondSourceText = "E2E_DIRECT_MEMORY_B：我们约定暗号是北辰";

	const memoryEntries = async (): Promise<
		Array<{ id: string; text: string; sourceEntryId?: string }>
	> => {
		const response = await page.request.post("/rpc/memory.list%3Av1", { headers, data: {} });
		const payload = (await response.json()) as {
			ok: boolean;
			data?: {
				entries?: Array<{ id: string; text: string; sourceEntryId?: string }>;
			};
		};
		expect(payload).toMatchObject({ ok: true });
		return payload.data?.entries ?? [];
	};

	const captureMessage = async (
		expectedAssistantText: string,
	): Promise<{ content: string; memoryId: string; sourceEntryId: string }> => {
		await sendMessage(page, expectedAssistantText);
		await expect(page.getByRole("status", { name: zhCN.messages.responding })).toBeHidden();
		const conversation = page.getByRole("region", { name: zhCN.messages.conversation });
		const message = conversation.getByRole("article").filter({
			has: page.getByRole("button", { name: zhCN.messages.operations }),
		});
		await expect(message).toHaveCount(1);
		const sourceEntryId = await message.getAttribute("data-message-id");
		expect(sourceEntryId).toBeTruthy();
		const renderedContent = message.getByText(expectedAssistantText, { exact: true });
		await expect(renderedContent).toBeVisible();
		const content = expectedAssistantText;
		await message.getByRole("button", { name: zhCN.messages.operations }).click();
		const captureResponsePromise = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				response.url().includes("/rpc/memory.capture%3Av1"),
		);
		await message.getByRole("button", { name: zhCN.messages.rememberMoment }).click();
		const captureResponse = await captureResponsePromise;
		expect(captureResponse.status()).toBe(200);
		const capturePayload = (await captureResponse.json()) as {
			ok: boolean;
			data?: {
				memoryId: string;
				sourceEntryId: string;
				createdBy: "user_capture" | "assistant_tool";
			};
		};
		expect(capturePayload).toMatchObject({
			ok: true,
			data: {
				memoryId: expect.any(String),
				sourceEntryId: expect.any(String),
				createdBy: "user_capture",
			},
		});
		await expect(page.getByRole("status", { name: zhCN.messages.rememberMoment })).toBeVisible();
		const capture = capturePayload.data;
		if (!capture) throw new Error("memory.capture succeeded without response data");
		return { content, memoryId: capture.memoryId, sourceEntryId: capture.sourceEntryId };
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
		const characterSettingsButton = page.getByRole("button", {
			name: zhCN.sidebar.characterSettings,
			exact: true,
		});
		await expect(characterSettingsButton).toBeEnabled();
		await characterSettingsButton.click();
		const dialog = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
		await expect(dialog).toBeVisible();
		const relationshipTab = dialog.getByRole("tab", {
			name: zhCN.backstage.relationshipArchive,
		});
		await relationshipTab.click();
		await expect(relationshipTab).toHaveAttribute("aria-selected", "true");
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
		const characterSettingsButton = page.getByRole("button", {
			name: zhCN.sidebar.characterSettings,
			exact: true,
		});
		await expect(characterSettingsButton).toBeEnabled();
		await characterSettingsButton.click();
		const dialog = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
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

	const firstCapture = await captureMessage(sourceText);
	const capturedSourceText = firstCapture.content;
	const replacementText = capturedSourceText.replace("北辰", "南星");
	await expect
		.poll(async () => (await memoryEntries()).find((entry) => entry.id === firstCapture.memoryId))
		.toMatchObject({
			id: firstCapture.memoryId,
			text: capturedSourceText,
			sourceEntryId: firstCapture.sourceEntryId,
		});

	await sendMessage(page, `检查记忆上下文 ${capturedSourceText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是北辰");

	let entries = await openRelationshipMemory(capturedSourceText);
	await expect.poll(() => entries.getByText(capturedSourceText, { exact: true }).count()).toBe(1);
	const sourceEntry = entries.getByRole("listitem").filter({ hasText: capturedSourceText });
	await expect(sourceEntry).toBeVisible();
	await sourceEntry.getByRole("button", { name: zhCN.memory.edit }).click();
	await entries.getByRole("textbox", { name: zhCN.memory.editedContent }).fill(replacementText);
	await entries.getByRole("button", { name: zhCN.memory.saveEdit }).click();
	await expect(entries.getByRole("status")).toHaveText(zhCN.memory.revised);
	await expect.poll(() => entries.getByText(replacementText, { exact: true }).count()).toBe(1);
	await expect(entries.getByText(capturedSourceText, { exact: true })).toHaveCount(0);
	await page
		.getByRole("dialog", { name: zhCN.sidebar.characterSettings })
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
	const secondCapture = await captureMessage(secondSourceText);
	const capturedSecondText = secondCapture.content;
	await expect
		.poll(async () => (await memoryEntries()).find((entry) => entry.id === secondCapture.memoryId))
		.toMatchObject({
			id: secondCapture.memoryId,
			text: capturedSecondText,
			sourceEntryId: secondCapture.sourceEntryId,
		});
	await sendMessage(page, `检查记忆上下文 ${capturedSecondText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是北辰");

	entries = await openRelationshipMemory(capturedSecondText);
	let secondEntry = entries.getByRole("listitem").filter({ hasText: capturedSecondText });
	await expect.poll(() => entries.getByText(capturedSecondText, { exact: true }).count()).toBe(1);
	await expect(secondEntry).toBeVisible();
	await secondEntry.getByRole("button", { name: zhCN.memory.exclude }).click();
	await expect(secondEntry.getByText(zhCN.memory.excludedNote)).toBeVisible();
	await expect(secondEntry.getByRole("button", { name: zhCN.memory.included })).toBeVisible();
	await secondEntry.getByRole("button", { name: zhCN.memory.included }).click();
	await expect(secondEntry.getByRole("button", { name: zhCN.memory.exclude })).toBeVisible();
	await expect(secondEntry.getByText(zhCN.memory.excludedNote)).toHaveCount(0);
	await page
		.getByRole("dialog", { name: zhCN.sidebar.characterSettings })
		.getByRole("button", {
			name: zhCN.backstage.close,
		})
		.click();

	await sendMessage(page, `检查记忆上下文 ${capturedSecondText}`);
	await expectMemoryContext("MEMORY_CONTEXT:我们约定暗号是北辰");

	entries = await openRelationshipMemory(capturedSecondText);
	secondEntry = entries.getByRole("listitem").filter({ hasText: capturedSecondText });
	await expect(secondEntry).toBeVisible();
	await secondEntry.getByRole("button", { name: zhCN.memory.forget }).click();
	await expect(entries.getByRole("status")).toHaveText(zhCN.memory.forget);
	await expect
		.poll(async () => (await memoryEntries()).some((entry) => entry.text === capturedSecondText))
		.toBe(false);
	await page
		.getByRole("dialog", { name: zhCN.sidebar.characterSettings })
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
	await revisedEntry.getByRole("button", { name: zhCN.memory.forget }).click();
	await expect(entries.getByRole("status")).toHaveText(zhCN.memory.forget);
	await expect
		.poll(async () => (await memoryEntries()).some((entry) => entry.text === replacementText))
		.toBe(false);
	await page
		.getByRole("dialog", { name: zhCN.sidebar.characterSettings })
		.getByRole("button", {
			name: zhCN.backstage.close,
		})
		.click();

	await sendMessage(page, `检查记忆上下文 ${replacementText}`);
	await expectMemoryContext("MEMORY_CONTEXT:ABSENT");

	await setRelationshipMemory(false);
	await page.reload();
	const characterSettingsButton = page.getByRole("button", {
		name: zhCN.sidebar.characterSettings,
		exact: true,
	});
	await expect(characterSettingsButton).toBeEnabled();
	await characterSettingsButton.click();
	const backstage = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await expect(backstage).toBeVisible();
	await backstage.getByRole("tab", { name: zhCN.backstage.relationshipArchive }).click();
	await expect(
		page.getByRole("switch", { name: zhCN.settings.relationshipMemory }),
	).toHaveAttribute("aria-checked", "false");
});
