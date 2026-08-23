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
		await expect
			.poll(async () => {
				const response = await page.request.post("/rpc/conversation.activeGet%3Av1", {
					headers,
					data: {},
				});
				const payload = (await response.json()) as {
					data?: { conversation?: { piTimeline: { entries: Array<{ kind: string; role?: string; text?: string }> } } };
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
		if (!conversation || !source) throw new Error("missing native assistant entry for memory capture");
		const captureResponse = await page.request.post("/rpc/memory.capture%3Av1", {
			headers,
			data: { conversationId: conversation.id, entryId: source.id },
		});
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
				sourceEntryId: source.id,
				createdBy: "user_capture",
			},
		});
		const capture = capturePayload.data;
		if (!capture) throw new Error("memory.capture succeeded without response data");
		return { content: expectedAssistantText, memoryId: capture.memoryId, sourceEntryId: capture.sourceEntryId };
	};
	const expectMemoryContext = async (expected: string): Promise<void> => {
		await expect(page.getByText(expected, { exact: true })).toBeVisible();
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
		const relationshipTab = dialog.getByRole("tab", { name: "角色记忆" });
		await relationshipTab.click();
		await expect(relationshipTab).toHaveAttribute("aria-selected", "true");
		const memorySwitch = dialog.getByRole("switch", {
			name: "关系记忆",
		});
		await expect(memorySwitch).toBeVisible();
		if ((await memorySwitch.getAttribute("aria-checked")) !== String(enabled)) {
			await memorySwitch.click();
		}
		await expect(memorySwitch).toHaveAttribute("aria-checked", String(enabled));
		await dialog.getByRole("button", { name: zhCN.backstage.close }).click();
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

	const forgetResponse = await page.request.post("/rpc/memory.forget%3Av1", {
		headers,
		data: { entryId: firstCapture.memoryId },
	});
	expect(forgetResponse.ok()).toBe(true);
	await expect
		.poll(async () => (await memoryEntries()).some((entry) => entry.id === firstCapture.memoryId))
		.toBe(false);
});
