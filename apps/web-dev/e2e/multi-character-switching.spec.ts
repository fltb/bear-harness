import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Page, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	providerHold,
	sendMessage,
} from "./helpers";

const characterRoot = fileURLToPath(new URL("../../../config/characters/jizhou", import.meta.url));
const testCharacters = [
	{ id: "e2e-role-lan", name: "岚", accent: "#d6a7ff" },
	{ id: "e2e-role-qing", name: "青", accent: "#80d8ff" },
] as const;

async function rpc<T>(page: Page, token: string, channel: string, data: unknown): Promise<T> {
	const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
		headers: { "x-bear-web-dev-token": token },
		data,
	});
	const envelope = await response.json();
	if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
	return envelope.data as T;
}

function packageFiles(
	id: string,
	name: string,
	accent: string,
	root = characterRoot,
	directory = characterRoot,
): Array<{ path: string; base64: string }> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return packageFiles(id, name, accent, root, path);
		const bytes = readFileSync(path);
		const payload =
			entry.name.endsWith(".yaml") || entry.name.endsWith(".md")
				? Buffer.from(
						bytes
							.toString("utf8")
							.replace(/^id: jizhou$/mu, `id: ${id}`)
							.replace(
								"urn:bear-harness:character:jizhou:state:v1",
								`urn:bear-harness:character:${id}:state:v1`,
							)
							.replaceAll("极昼", name)
							.replace("#8bd0bb", accent),
					)
				: bytes;
		return [
			{
				path: `package/${relative(root, path)}`,
				base64: payload.toString("base64"),
			},
		];
	});
}

async function completeCharacterSetup(page: Page, token: string): Promise<void> {
	await rpc(page, token, "model.defaults.completeOnboarding", {});
	const answers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "林",
	};
	let onboarding = await rpc<{ status: string; currentStepId?: string }>(
		page,
		token,
		"onboarding.get",
		{},
	);
	while (onboarding.status === "active") {
		const stepId = onboarding.currentStepId;
		if (!stepId || !(stepId in answers)) throw new Error(`Unhandled onboarding step: ${stepId}`);
		onboarding = await rpc(page, token, "onboarding.submit", {
			stepId,
			answer: answers[stepId],
		});
	}
}

async function openCharacterSwitch(page: Page, name: string) {
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	const dialog = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await expect(dialog).toBeVisible();
	const candidates = await dialog
		.getByRole("button", { name: zhCN.backstage.roleSwitch, exact: true })
		.all();
	const target = (
		await Promise.all(
			candidates.map(async (candidate) => ({
				candidate,
				matches: await candidate.evaluate((button) =>
					button.parentElement?.textContent?.includes(name),
				),
			})),
		)
	).find(({ matches }) => matches)?.candidate;
	expect(target, `missing character switch control for ${name}`).toBeDefined();
	if (!target) throw new Error(`missing character switch control for ${name}`);
	return { dialog, target };
}

async function switchCharacter(page: Page, name: string): Promise<void> {
	const { dialog, target } = await openCharacterSwitch(page, name);
	const activated = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" && response.url().includes("/rpc/character.activate"),
	);
	await target.click();
	expect((await activated).ok()).toBe(true);
	await expect(page.getByRole("complementary").getByText(name, { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await dialog.getByRole("button", { name: zhCN.backstage.close, exact: true }).click();
	await expect(dialog).toBeHidden();
}

test("two characters isolate conversations and warn before an active-reply switch", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const token = bootstrap.token as string;
	const conversationIds = new Map<string, string>();

	try {
		for (const character of testCharacters) {
			await rpc(page, token, "character.import", {
				files: packageFiles(character.id, character.name, character.accent),
			});
			await rpc(page, token, "character.activate", { characterId: character.id });
			await completeCharacterSetup(page, token);
			await page.reload();
			await expect(
				page.getByRole("complementary").getByText(character.name, { exact: true }),
			).toBeVisible({
				timeout: 15_000,
			});
			await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
			const conversationId = await activeConversationId(page);
			conversationIds.set(character.id, conversationId);
			await rpc(page, token, "model.route.set", {
				conversationId,
				selected: { providerId: "e2e-rule", modelId: "rule-model" },
			});
			await page.reload();
			await expect(
				page.getByRole("textbox", { name: zhCN.composer.messageInputLabel }),
			).toBeEnabled({
				timeout: 15_000,
			});
			await sendMessage(page, `角色${character.name}初始化`);
			await expect(
				page
					.getByRole("region", { name: zhCN.messages.conversation })
					.getByRole("article", { name: character.name, exact: true })
					.getByText("RULE_OK", { exact: true }),
			).toBeVisible();
		}

		await rpc(page, token, "character.activate", { characterId: testCharacters[0].id });
		await page.reload();
		await expect(
			page.getByRole("complementary").getByText(testCharacters[0].name, { exact: true }),
		).toBeVisible({ timeout: 15_000 });
		await expect
			.poll(() => activeConversationId(page))
			.toBe(conversationIds.get(testCharacters[0].id));
		await expect(page.getByText("角色岚初始化", { exact: true })).toBeVisible();
		await expect(page.getByText("角色青初始化", { exact: true })).toHaveCount(0);
		await sendMessage(page, "E2E_OK 岚仍可独立回复");
		await expect(
			page
				.getByRole("region", { name: zhCN.messages.conversation })
				.getByRole("article", { name: testCharacters[0].name, exact: true })
				.getByText("E2E_OK", { exact: true }),
		).toBeVisible();

		await switchCharacter(page, testCharacters[1].name);
		await expect
			.poll(() => activeConversationId(page))
			.toBe(conversationIds.get(testCharacters[1].id));
		await expect(page.getByTestId("conversation-activity")).toBeHidden();
		await expect(page.getByText("角色青初始化", { exact: true })).toBeVisible();
		await expect(page.getByText("角色岚初始化", { exact: true })).toHaveCount(0);
		await expect(page.getByText("E2E_OK 岚仍可独立回复", { exact: true })).toHaveCount(0);

		await sendMessage(page, "E2E_OK 青仍可独立回复");
		const qingThread = page.getByRole("region", { name: zhCN.messages.conversation });
		await expect(
			qingThread
				.getByRole("article", { name: testCharacters[1].name, exact: true })
				.getByText("E2E_OK", { exact: true }),
		).toBeVisible();

		await switchCharacter(page, testCharacters[0].name);
		await expect
			.poll(() => activeConversationId(page))
			.toBe(conversationIds.get(testCharacters[0].id));
		await expect(page.getByText("角色岚初始化", { exact: true })).toBeVisible();
		await expect(page.getByText("E2E_OK 岚仍可独立回复", { exact: true })).toBeVisible();
		await expect(page.getByText("E2E_OK 青仍可独立回复", { exact: true })).toHaveCount(0);

		await switchCharacter(page, testCharacters[1].name);
		await expect(qingThread.getByText("E2E_OK", { exact: true })).toBeVisible();
		await expect(qingThread.getByText("E2E_OK 青仍可独立回复", { exact: true })).toBeVisible();
		await expect(qingThread.getByText("E2E_OK 岚仍可独立回复", { exact: true })).toHaveCount(0);

		const hold = providerHold(page);
		try {
			await sendMessage(page, `E2E_WAIT_TEXT_${hold.id}`);
			await hold.entered();
			await expect(page.getByTestId("conversation-activity")).toBeVisible();
			const { dialog, target } = await openCharacterSwitch(page, testCharacters[0].name);
			await target.click();
			const warning = page.getByRole("dialog", {
				name: zhCN.backstage.roleSwitchBusyTitle,
			});
			await expect(warning).toBeVisible();
			await expect(warning).toContainText(testCharacters[0].name);
			await expect(
				page.getByRole("complementary").getByText(testCharacters[1].name, { exact: true }),
			).toBeVisible();

			await warning
				.getByRole("button", { name: zhCN.backstage.roleSwitchBusyCancel, exact: true })
				.click();
			await expect(warning).toBeHidden();
			await expect(page.getByTestId("conversation-activity")).toBeVisible();

			await target.click();
			await expect(warning).toBeVisible();
			const activated = page.waitForResponse(
				(response) =>
					response.request().method() === "POST" &&
					response.url().includes("/rpc/character.activate"),
			);
			await warning
				.getByRole("button", { name: zhCN.backstage.roleSwitchBusyConfirm, exact: true })
				.click();
			expect((await activated).ok()).toBe(true);
			await expect(
				page.getByRole("complementary").getByText(testCharacters[0].name, { exact: true }),
			).toBeVisible({ timeout: 15_000 });
			await dialog.getByRole("button", { name: zhCN.backstage.close, exact: true }).click();
			await hold.cancelled();

			await switchCharacter(page, testCharacters[1].name);
			await expect(page.getByText(`E2E_WAIT_TEXT_${hold.id}`, { exact: true })).toBeVisible();
			await expect(
				page.getByRole("alert").filter({ hasText: zhCN.messages.responseStopped }),
			).toBeVisible();
		} finally {
			await hold.release();
		}
		expect(pageErrors).toEqual([]);
	} finally {
		await rpc(page, token, "character.activate", { characterId: "jizhou" }).catch(() => undefined);
		for (const character of testCharacters) {
			await rpc(page, token, "character.runtimeDelete", { characterId: character.id }).catch(
				() => undefined,
			);
			await rpc(page, token, "character.packageDelete", { characterId: character.id }).catch(
				() => undefined,
			);
		}
	}
});
