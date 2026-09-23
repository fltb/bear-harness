import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Page, test } from "playwright/test";
import {
	activeConversationId,
	ensureReadyForConversation,
	providerHold,
	selectKobalteOption,
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

async function completeCharacterSetup(
	page: Page,
	token: string,
	characterId: string,
): Promise<void> {
	await rpc(page, token, "model.defaults.completeOnboarding", { characterId });
	const answers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "林",
	};
	let onboarding = await rpc<{ status: string; currentStepId?: string }>(
		page,
		token,
		"onboarding.get",
		{ characterId },
	);
	while (onboarding.status === "active") {
		const stepId = onboarding.currentStepId;
		if (!stepId || !(stepId in answers)) throw new Error(`Unhandled onboarding step: ${stepId}`);
		onboarding = await rpc(page, token, "onboarding.submit", {
			characterId,
			stepId,
			answer: answers[stepId],
		});
	}
}

async function openCharacterSwitch(page: Page, name: string) {
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	const dialog = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await expect(dialog).toBeVisible();
	const target = dialog
		.getByRole("article", { name, exact: true })
		.getByRole("button", { name: zhCN.backstage.roleSwitch, exact: true });
	await expect(target).toBeVisible();
	return { dialog, target };
}

async function switchCharacter(page: Page, name: string): Promise<void> {
	const { dialog, target } = await openCharacterSwitch(page, name);
	await target.click();
	await dialog.getByRole("button", { name: zhCN.backstage.close, exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("complementary").getByRole("strong").getByText(name, { exact: true }),
	).toBeVisible({
		timeout: 15_000,
	});
}

test.afterEach(async ({ page }) => {
	const { token } = await (await page.request.get("/bootstrap")).json();
	for (const character of testCharacters) {
		await rpc(page, token, "character.runtimeDelete", { characterId: character.id }).catch(
			() => undefined,
		);
		await rpc(page, token, "character.packageDelete", { characterId: character.id }).catch(
			() => undefined,
		);
	}
});

test("two characters and windows retain independent selections while a background reply continues", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const token = bootstrap.token as string;
	const conversationIds = new Map<string, string>();

	for (const character of testCharacters) {
		await rpc(page, token, "character.import", {
			files: packageFiles(character.id, character.name, character.accent),
		});
		await completeCharacterSetup(page, token, character.id);
		await switchCharacter(page, character.name);
		await expect(
			page
				.getByRole("complementary")
				.getByRole("strong")
				.getByText(character.name, { exact: true }),
		).toBeVisible({
			timeout: 15_000,
		});
		await page.getByTitle(zhCN.sidebar.newConversation, { exact: true }).click();
		const conversationId = await activeConversationId(page);
		conversationIds.set(character.id, conversationId);
		await rpc(page, token, "model.route.set", {
			characterId: character.id,
			conversationId,
			selected: { providerId: "e2e-rule", modelId: "rule-model" },
		});
		await expect(page.getByRole("textbox", { name: zhCN.composer.messageInputLabel })).toBeEnabled({
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

	await switchCharacter(page, testCharacters[0].name);
	await expect(
		page
			.getByRole("complementary")
			.getByRole("strong")
			.getByText(testCharacters[0].name, { exact: true }),
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
		await switchCharacter(page, testCharacters[0].name);
		expect(await activeConversationId(page)).toBe(conversationIds.get(testCharacters[0].id));
		const background = await rpc<{ live: { isStreaming: boolean } }>(
			page,
			token,
			"conversation.open",
			{
				characterId: testCharacters[1].id,
				conversationId: conversationIds.get(testCharacters[1].id),
			},
		);
		expect(background.live.isStreaming).toBe(true);
		const otherWindow = await page.context().newPage();
		try {
			await otherWindow.goto("/");
			await expect(
				otherWindow
					.getByRole("complementary")
					.getByRole("strong")
					.getByText("极昼", { exact: true }),
			).toBeVisible();
			await switchCharacter(otherWindow, testCharacters[1].name);
			expect(await activeConversationId(otherWindow)).toBe(
				conversationIds.get(testCharacters[1].id),
			);
			expect(await activeConversationId(page)).toBe(conversationIds.get(testCharacters[0].id));
			await hold.release();
			await expect(
				otherWindow.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true }),
			).toBeVisible();
		} finally {
			await otherWindow.close();
		}
		await switchCharacter(page, testCharacters[1].name);
		await expect(page.getByText(`E2E_WAIT_DONE_${hold.id}`, { exact: true })).toBeVisible();
		await expect(page.getByTestId("conversation-activity")).toBeHidden();
	} finally {
		await hold.release();
	}
	expect(pageErrors).toEqual([]);
});

test("a fresh character can select and confirm a re-added provider model", async ({ page }) => {
	await ensureReadyForConversation(page);
	const { token } = await (await page.request.get("/bootstrap")).json();
	await rpc(page, token, "provider.remove", { providerId: "e2e-rule" });
	await rpc(page, token, "provider.customUpsert", {
		providerId: "e2e-rule",
		name: "E2E Rule Provider",
		baseUrl: `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`,
		models: [{ id: "rule-model" }],
		apiKey: "e2e-rule-key",
	});
	await rpc(page, token, "model.systemDefaults.set", {
		reply: { providerId: "e2e-rule", modelId: "rule-model" },
		vision: { mode: "auto" },
	});
	await rpc(page, token, "model.defaults.setReply", {
		characterId: "jizhou",
		reply: { providerId: "e2e-rule", modelId: "rule-model" },
	});
	const character = testCharacters[0];
	await rpc(page, token, "character.import", {
		files: packageFiles(character.id, character.name, character.accent),
	});
	await page.reload();
	await page.getByRole("button", { name: zhCN.sidebar.characterSettings, exact: true }).click();
	const dialog = page.getByRole("dialog", { name: zhCN.sidebar.characterSettings });
	await dialog
		.getByRole("article", { name: character.name, exact: true })
		.getByRole("button", { name: zhCN.backstage.roleSwitch, exact: true })
		.click();
	await dialog.getByRole("button", { name: zhCN.backstage.close, exact: true }).click();
	const setup = page.getByRole("dialog", { name: zhCN.modelSetup.dialogLabel });
	await expect(setup.getByRole("heading", { name: zhCN.modelSetup.roleTitle })).toBeVisible();
	await expect(setup.getByText(zhCN.modelSetup.noModels)).toHaveCount(0);
	await selectKobalteOption(
		page,
		setup.getByRole("button", { name: zhCN.modelSetup.modelLabel }),
		/rule-model/,
	);
	await expect(setup.getByRole("button", { name: zhCN.modelSetup.confirmRole })).toBeEnabled();
	await setup.getByRole("button", { name: zhCN.modelSetup.confirmRole }).click();
	await expect(setup).toBeHidden();
	await expect(page.getByRole("dialog", { name: "开始相处" })).toBeVisible();
});
