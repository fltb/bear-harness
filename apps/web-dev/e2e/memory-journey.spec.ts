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

	const memoryEntries = async (): Promise<
		Array<{ id: string; text: string; sourceEntryId?: string }>
	> => {
		const response = await page.request.post("/rpc/memory.list%3Av1", {
			headers,
			data: {},
		});
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
		await expect
			.poll(async () => {
				const response = await page.request.post("/rpc/conversation.activeGet%3Av1", {
					headers,
					data: {},
				});
				const payload = (await response.json()) as {
					data?: {
						conversation?: {
							piTimeline: { entries: Array<{ kind: string; role?: string; text?: string }> };
						};
					};
				};
				return payload.data?.conversation?.piTimeline.entries.some(
					(entry) =>
						entry.kind === "message" &&
						entry.role === "assistant" &&
						entry.text === expectedAssistantText,
				);
			})
			.toBe(true);
		const activeResponse = await page.request.post("/rpc/conversation.activeGet%3Av1", {
			headers,
			data: {},
		});
		const activePayload = (await activeResponse.json()) as {
			ok: boolean;
			data?: {
				conversation?: {
					id: string;
					piTimeline: {
						entries: Array<{ id: string; kind: string; role?: string; text?: string }>;
					};
				};
			};
		};
		expect(activePayload).toMatchObject({ ok: true });
		const conversation = activePayload.data?.conversation;
		const source = conversation?.piTimeline.entries
			.filter((entry) => entry.kind === "message" && entry.role === "assistant")
			.findLast((entry) => entry.text === expectedAssistantText);
		if (!conversation || !source)
			throw new Error("missing native assistant entry for memory capture");
		const article = page
			.getByRole("article", { name: "极昼" })
			.filter({ has: page.getByText(expectedAssistantText, { exact: true }) });
		const remember = article.getByRole("button", { name: zhCN.messages.rememberMoment });
		await remember.click();
		await expect(
			article.getByRole("button", { name: zhCN.messages.rememberedMoment }),
		).toBeDisabled();
		const content = `用户：${expectedAssistantText}\n角色：${expectedAssistantText}`;
		let capture: { id: string; sourceEntryId?: string } | undefined;
		await expect
			.poll(async () => {
				capture = (await memoryEntries()).find(
					(entry) => entry.sourceEntryId === source.id && entry.text === content,
				);
				return capture !== undefined;
			})
			.toBe(true);
		if (!capture?.sourceEntryId) throw new Error("captured memory was not projected");
		return {
			content,
			memoryId: capture.id,
			sourceEntryId: capture.sourceEntryId,
		};
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
		await dialog.getByRole("tab", { name: zhCN.backstage.roleManagement }).click();
		const relationshipTab = dialog.getByRole("tab", {
			name: zhCN.currentRolePackage.memoryTab,
		});
		await relationshipTab.click();
		await expect(relationshipTab).toHaveAttribute("aria-selected", "true");
		const memorySwitch = dialog.getByRole("switch", {
			name: zhCN.currentRolePackage.relationshipMemory,
		});
		await expect(memorySwitch).toBeVisible();
		await expect(dialog.getByText(zhCN.memory.emptyEntries, { exact: true })).toBeVisible();
		if ((await memorySwitch.getAttribute("aria-checked")) !== String(enabled)) {
			await memorySwitch.click();
		}
		await expect(memorySwitch).toHaveAttribute("aria-checked", String(enabled));
		await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
	};

	await setRelationshipMemory(true);

	const firstCapture = await captureMessage(sourceText);
	const capturedSourceText = firstCapture.content;
	const characterSettingsButton = page.getByRole("button", {
		name: zhCN.sidebar.characterSettings,
		exact: true,
	});
	await characterSettingsButton.click();
	const relationshipDialog = page.getByRole("dialog", {
		name: zhCN.sidebar.characterSettings,
	});
	await relationshipDialog.getByRole("tab", { name: zhCN.currentRolePackage.memoryTab }).click();
	await expect(relationshipDialog.getByText(capturedSourceText, { exact: true })).toBeVisible();
	await relationshipDialog.getByRole("button", { name: zhCN.backstage.close }).click();
	await expect
		.poll(async () => (await memoryEntries()).find((entry) => entry.id === firstCapture.memoryId))
		.toMatchObject({
			id: firstCapture.memoryId,
			text: capturedSourceText,
			sourceEntryId: firstCapture.sourceEntryId,
		});

	const forgetResponse = await page.request.post("/rpc/memory.forget%3Av1", {
		headers,
		data: { entryId: firstCapture.memoryId },
	});
	expect(forgetResponse.ok()).toBe(true);
	await expect
		.poll(async () => (await memoryEntries()).some((entry) => entry.id === firstCapture.memoryId))
		.toBe(false);
});
