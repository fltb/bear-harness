import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { ensureReadyForConversation, getBootstrap, projectPiEntries, sendMessage } from "./helpers";

test("direct memory capture, scoped context, and user management stay deterministic", async ({
	page,
}) => {
	await ensureReadyForConversation(page);

	const bootstrap = await getBootstrap(page);
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const sourceText = "E2E_DIRECT_MEMORY_A：我们约定暗号是北辰";

	const memoryEntries = async (): Promise<{
		ok: boolean;
		entries: Array<{ id: string; text: string; sourceEntryId?: string }>;
	}> => {
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
		return { ok: payload.ok, entries: payload.data?.entries ?? [] };
	};

	const captureMessage = async (
		expectedAssistantText: string,
	): Promise<{ content: string; memoryId: string }> => {
		await sendMessage(page, expectedAssistantText);
		await expect
			.poll(async () => {
				const response = await page.request.post("/rpc/conversation.activeGet%3Av1", {
					headers,
					data: {},
				});
				const payload = (await response.json()) as {
					data?: { session?: { entries: unknown[] } };
				};
				return projectPiEntries(payload.data?.session?.entries ?? []).some(
					(entry) =>
						entry.kind === "message" &&
						entry.role === "assistant" &&
						entry.text?.trim() === expectedAssistantText,
				);
			})
			.toBe(true);
		const article = page
			.getByRole("article", { name: "极昼" })
			.filter({ has: page.getByText(expectedAssistantText, { exact: true }) });
		const remember = article.getByRole("button", {
			name: zhCN.messages.rememberMoment,
		});
		await remember.click();
		const content = `用户：${expectedAssistantText}\n角色：${expectedAssistantText}`;
		let capture: { id: string; sourceEntryId?: string } | undefined;
		await expect
			.poll(async () => {
				const snapshot = await memoryEntries();
				if (!snapshot.ok) return false;
				capture = snapshot.entries.find((entry) => entry.text === content);
				return capture !== undefined;
			})
			.toBe(true);
		if (!capture) throw new Error("captured memory was not projected");
		return {
			content,
			memoryId: capture.id,
		};
	};
	const setRelationshipMemory = async (enabled: boolean): Promise<void> => {
		const characterSettingsButton = page.getByRole("button", {
			name: zhCN.sidebar.characterSettings,
			exact: true,
		});
		await expect(characterSettingsButton).toBeEnabled();
		await characterSettingsButton.click();
		const dialog = page.getByRole("dialog", {
			name: zhCN.sidebar.characterSettings,
		});
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
		.poll(async () => {
			const snapshot = await memoryEntries();
			return snapshot.ok
				? snapshot.entries.find((entry) => entry.id === firstCapture.memoryId)
				: undefined;
		})
		.toMatchObject({
			id: firstCapture.memoryId,
			text: capturedSourceText,
		});

	const forgetResponse = await page.request.post("/rpc/memory.forget%3Av1", {
		headers,
		data: { entryId: firstCapture.memoryId },
	});
	expect(forgetResponse.ok()).toBe(true);
	await expect
		.poll(async () => {
			const snapshot = await memoryEntries();
			return snapshot.ok
				? snapshot.entries.some((entry) => entry.id === firstCapture.memoryId)
				: undefined;
		})
		.toBe(false);
});
