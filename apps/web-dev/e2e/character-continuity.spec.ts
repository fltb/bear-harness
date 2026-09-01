import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, type Page, test } from "playwright/test";

const providerUrl = `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}`;

import { ensureReadyForConversation, projectPiEntries, sendMessage } from "./helpers";

const characterRoot = fileURLToPath(new URL("../../../config/characters/jizhou", import.meta.url));
const storyScreenshotRoot = resolve(
	import.meta.dirname,
	"../../../artifacts/story-full-coverage-2026-09-01/screenshots",
);

async function rpc<T>(page: Page, token: string, channel: string, data: unknown): Promise<T> {
	const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
		headers: { "x-bear-web-dev-token": token },
		data,
	});
	const envelope = await response.json();
	if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
	return envelope.data as T;
}

type PiEntry = {
	id: string;
	type: string;
	role?: string;
	text?: string;
};

async function projection(page: Page, token: string, conversationId: string): Promise<PiEntry[]> {
	const opened = await rpc<{ branch: { entries: unknown[] } }>(page, token, "conversation.open", {
		conversationId,
	});
	return projectPiEntries(opened.branch.entries) as PiEntry[];
}

test("committed schema state survives new conversations and edited message history", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationA = await createFreshConversation(
		page,
		bootstrap.token,
		"Character facts source",
	);

	await rpc(page, bootstrap.token, "message.send", {
		conversationId: conversationA,
		text: "E2E_TOOL_TRIGGER_DAMAGED_LOG",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationA))
		.toBe("E2E_TOOL_TRIGGER_DAMAGED_LOG_DONE");
	const conversationB = await createFreshConversation(page, bootstrap.token, "Second context");
	await rpc(page, bootstrap.token, "message.send", {
		conversationId: conversationB,
		text: "E2E_OK schema state projection check",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationB))
		.toBe("E2E_OK");
	const promptTrace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
		prompts: string[];
	};
	expect(
		promptTrace.prompts.findLast((prompt) => prompt.includes("schema state projection check")),
	).toMatch(/"continuity":\s*{\s*"stage": 1/);

	await rpc(page, bootstrap.token, "conversation.rename", {
		conversationId: conversationA,
		title: "历史搜索锚点 7F-19",
	});
	await expect
		.poll(async () =>
			rpc<{ conversations: Array<{ conversationId: string; name?: string }> }>(
				page,
				bootstrap.token,
				"conversation.list",
				{
					title: "7F-19",
				},
			),
		)
		.toMatchObject({
			conversations: [
				expect.objectContaining({
					conversationId: conversationA,
					name: expect.stringContaining("7F-19"),
				}),
			],
		});
});

test("scripted model invokes the schema state tool with exact arguments", async ({ page }) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationB = await createFreshConversation(
		page,
		bootstrap.token,
		"Tool-call verification",
	);

	await rpc(page, bootstrap.token, "message.send", {
		conversationId: conversationB,
		text: "E2E_TOOL_TRIGGER_DAMAGED_LOG",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationB))
		.toBe("E2E_TOOL_TRIGGER_DAMAGED_LOG_DONE");
	const trace = (await (await page.request.get(`${providerUrl}/trace/tools`)).json()) as {
		calls: Array<{ tool: string; args: Record<string, unknown> }>;
	};
	expect(trace.calls).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				tool: "host_state",
				args: expect.objectContaining({ action: "update" }),
			}),
		]),
	);
});

test("presented role choices send ordinary messages and advance generic schema state", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationId = await createFreshConversation(
		page,
		bootstrap.token,
		"Generic choice state flow",
	);
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	await sidebar.getByRole("button").filter({ hasText: "Generic choice state flow" }).click();

	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_MANUAL_ROLE_START",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_START_DONE");
	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_MANUAL_ROLE_CONTINUE",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_CONTINUE_DONE");
	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_MANUAL_ROLE_PRESENT",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_PRESENT_DONE");
	const choice = page.getByRole("button", { name: /我听见了/ });
	await expect(choice).toBeVisible();
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await expect
		.poll(async () => {
			const [threadBox, choiceBox] = await Promise.all([
				thread.boundingBox(),
				choice.boundingBox(),
			]);
			if (!threadBox || !choiceBox) return false;
			return (
				choiceBox.y >= threadBox.y &&
				choiceBox.y + choiceBox.height <= threadBox.y + threadBox.height
			);
		})
		.toBe(true);
	await choice.click();
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_RECEIVED_DONE");
	const mediaCard = page.getByRole("region", { name: "继任规程" });
	await expect(mediaCard).toBeVisible();
	await mediaCard.getByRole("button", { name: zhCN.messages.openMedia }).click();
	await expect(page.getByRole("complementary", { name: "继任规程" })).toBeVisible();
	const choiceTrace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
		prompts: string[];
	};
	const choicePrompt = choiceTrace.prompts.findLast(
		(prompt) =>
			prompt.includes("我听见了，也愿意接住这份交接。") && prompt.includes("<host_context>"),
	);
	expect(choicePrompt).toMatch(/"continuity":\s*{\s*"stage": 2,\s*"response": "用户尚未回应。"/);
	const entries = await projection(page, bootstrap.token, conversationId);
	expect(
		entries.filter((entry) => entry.type === "message" && entry.role === "user").at(-1)?.text,
	).toBe("我听见了，也愿意接住这份交接。");

	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_OK final generic state projection",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_OK");
	const trace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
		prompts: string[];
	};
	const finalPrompt = trace.prompts.findLast(
		(prompt) =>
			prompt.includes("final generic state projection") && prompt.includes("<host_context>"),
	);
	expect(finalPrompt).toMatch(
		/"continuity":\s*{\s*"stage": 3,\s*"response": "用户愿意接住这份交接。"/,
	);
});

test("undelivered report enters, pauses, resumes, advances every chapter, and ends", async ({
	page,
}) => {
	test.setTimeout(60_000);
	mkdirSync(storyScreenshotRoot, { recursive: true });
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationId = await createFreshConversation(
		page,
		bootstrap.token,
		"Undelivered report full flow",
	);
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const conversationButton = sidebar
		.getByRole("button")
		.filter({ hasText: "Undelivered report full flow" });
	await conversationButton.click();
	await expect(conversationButton).toHaveAttribute("aria-current", "page");

	const send = async (text: string, expected: string) => {
		await sendMessage(page, text);
		await expect
			.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
			.toBe(expected);
	};
	const screenshot = async (name: string) => {
		await page.screenshot({
			path: join(storyScreenshotRoot, name),
			fullPage: true,
		});
	};
	const storyState = async () => {
		const result = await rpc<{
			state: { character: { document: { story: { active: boolean; chapter: number } } } };
		}>(page, bootstrap.token, "companionState.get", { conversationId });
		return result.state.character.document.story;
	};
	const latestStoryResource = async () => {
		const trace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
			prompts: string[];
		};
		const storyPrompt = trace.prompts.findLast((prompt) =>
			prompt.includes('<role_skill id="undelivered-report"'),
		);
		const matches = [
			...(storyPrompt ?? "").matchAll(
				/<role_skill id="undelivered-report"[\s\S]*?<resource id="([^"]+)">/gu,
			),
		];
		return matches.at(-1)?.[1];
	};

	await send("E2E_STORY_ENTRY", "E2E_STORY_ENTRY_DONE");
	expect(await latestStoryResource()).toBe("entry");
	const enter = page.getByRole("button", { name: "进入调查" });
	await expect(enter).toBeVisible();
	await screenshot("01-entry-choice.png");
	await enter.click();
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_STORY_STARTED_DONE");
	await expect.poll(storyState).toMatchObject({ active: true, chapter: 1 });
	await screenshot("02-entered-signal.png");

	await send("先暂停《未送达的回报》。", "E2E_STORY_PAUSED_DONE");
	expect(await latestStoryResource()).toBe("damaged-signal");
	await expect.poll(storyState).toMatchObject({ active: false, chapter: 1 });
	await screenshot("03-paused.png");
	await send("继续《未送达的回报》。", "E2E_STORY_RESUMED_DONE");
	expect(await latestStoryResource()).toBe("damaged-signal");
	await expect.poll(storyState).toMatchObject({ active: true, chapter: 1 });
	await screenshot("04-resumed.png");

	const resources = ["damaged-signal", "routes", "testimonies", "last-shift", "future", "ending"];
	for (const [index, resource] of resources.entries()) {
		const chapter = index + 2;
		await send("E2E_STORY_ADVANCE", `E2E_STORY_ADVANCE_DONE_${chapter}`);
		expect(await latestStoryResource()).toBe(resource);
		await expect.poll(storyState).toMatchObject({ active: chapter < 7, chapter });
		await screenshot(`${String(chapter + 3).padStart(2, "0")}-chapter-${chapter}.png`);
	}

	await send("E2E_STORY_CHECK_END", "E2E_STORY_END_CHECK_DONE");
	expect(await latestStoryResource()).toBe("ending");
	await expect.poll(storyState).toMatchObject({ active: false, chapter: 7 });
	await screenshot("11-ending-check.png");
});

test("adopted multi-turn history and a manual edit change the next model context", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationId = await createFreshConversation(page, bootstrap.token, "Multi-turn context");

	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_CONTEXT_T1_ORIGINAL",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_CONTEXT_T2",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_CONTEXT_TWO_TURNS_OK");

	const firstUser = (await projection(page, bootstrap.token, conversationId)).find(
		(entry) =>
			entry.type === "message" && entry.role === "user" && entry.text === "E2E_CONTEXT_T1_ORIGINAL",
	);
	if (!firstUser) throw new Error("missing original native context entry");
	await rpc(page, bootstrap.token, "message.edit", {
		conversationId,
		entryId: firstUser.id,
		text: "E2E_CONTEXT_T1_EDITED",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_CONTEXT_T2_AFTER_EDIT",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_CONTEXT_EDITED_OK");
	const promptTrace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
		prompts: string[];
	};
	const contextPrompt = promptTrace.prompts.findLast((prompt) =>
		prompt.includes("E2E_CONTEXT_T2_AFTER_EDIT"),
	);
	expect(contextPrompt).toBeDefined();
	expect(contextPrompt).toContain("E2E_CONTEXT_T1_EDITED");
	expect(contextPrompt).toContain("E2E_CONTEXT_T2");
});

test("title query respects active, archived, and deleted session management", async ({ page }) => {
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const archived = await rpc<{ conversationId: string }>(
		page,
		bootstrap.token,
		"conversation.create",
		{
			title: "Archive search boundary",
		},
	);
	await rpc(page, bootstrap.token, "message.send", {
		conversationId: archived.conversationId,
		text: "E2E_ARCHIVED_SEARCH_MARKER",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, archived.conversationId))
		.toBe("RULE_OK");
	await rpc(page, bootstrap.token, "conversation.archive", {
		conversationId: archived.conversationId,
		archived: true,
	});
	await expect(
		rpc<{ conversations: Array<{ conversationId: string }> }>(
			page,
			bootstrap.token,
			"conversation.list",
			{
				title: "Archive search",
			},
		),
	).resolves.toEqual({ conversations: [] });
	await expect(
		rpc<{ conversations: Array<{ conversationId: string }> }>(
			page,
			bootstrap.token,
			"conversation.list",
			{
				title: "Archive search",
				archived: true,
			},
		),
	).resolves.toMatchObject({ conversations: [{ conversationId: archived.conversationId }] });
	await rpc(page, bootstrap.token, "conversation.delete", {
		conversationId: archived.conversationId,
	});
	await expect(
		rpc<{ conversations: Array<{ conversationId: string }> }>(
			page,
			bootstrap.token,
			"conversation.list",
			{
				title: "Archive search",
				archived: true,
			},
		),
	).resolves.toEqual({ conversations: [] });
});

test("regeneration switches native leaves and correction is visible user feedback", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationId = await createFreshConversation(
		page,
		bootstrap.token,
		"Conversation operations",
	);

	await rpc(page, bootstrap.token, "message.send", {
		conversationId,
		text: "E2E_OPERATION_PARENT",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	const assistant = (await projection(page, bootstrap.token, conversationId)).find(
		(entry) => entry.type === "message" && entry.role === "assistant",
	);
	if (!assistant) throw new Error("missing native assistant entry");

	await rpc(page, bootstrap.token, "message.regenerate", {
		conversationId,
		entryId: assistant.id,
	});
	await expect
		.poll(
			async () =>
				(await projection(page, bootstrap.token, conversationId))
					.filter((entry) => entry.type === "message" && entry.role === "assistant")
					.at(-1)?.id,
		)
		.not.toBe(assistant.id);
	const regeneratedId = (await projection(page, bootstrap.token, conversationId))
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.at(-1)?.id;
	if (!regeneratedId) throw new Error("missing regenerated native assistant entry");
	await rpc(page, bootstrap.token, "message.switchVersion", {
		conversationId,
		leafId: assistant.id,
	});
	expect(
		(await projection(page, bootstrap.token, conversationId))
			.filter((entry) => entry.type === "message" && entry.role === "assistant")
			.at(-1)?.id,
	).toBe(assistant.id);
	await rpc(page, bootstrap.token, "message.switchVersion", {
		conversationId,
		leafId: regeneratedId,
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");

	const regenerated = (await projection(page, bootstrap.token, conversationId))
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.at(-1);
	if (!regenerated) throw new Error("missing regenerated assistant entry");

	await rpc(page, bootstrap.token, "message.regenerate", {
		conversationId,
		entryId: regenerated.id,
		feedback: "他替我做了决定",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	expect(
		(await projection(page, bootstrap.token, conversationId))
			.filter((entry) => entry.type === "message" && entry.role === "assistant")
			.at(-1)
			?.text?.trim(),
	).toBe("RULE_OK");
	const revisedProjection = await projection(page, bootstrap.token, conversationId);
	expect(
		revisedProjection.filter((entry) => entry.type === "message" && entry.role === "user").at(-1)
			?.text,
	).toContain("重新生成反馈：他替我做了决定");
});

test("imported package plugins require explicit trust before they can be enabled", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const files = packageFiles(characterRoot);
	const manifest = files.find((file) => file.path.endsWith("/character.yaml"));
	if (!manifest) throw new Error("missing character manifest");
	manifest.base64 = Buffer.from(
		Buffer.from(manifest.base64, "base64")
			.toString("utf8")
			.replace("id: jizhou", "id: e2e-plugin-trust"),
	).toString("base64");
	files.push({
		path: "package/plugins/trust-fixture.mjs",
		base64: Buffer.from("export default function register() {}\n").toString("base64"),
	});

	await expect(rpc(page, bootstrap.token, "character.import", { files })).resolves.toMatchObject({
		character: { id: "e2e-plugin-trust" },
	});
	await expect(
		rpc<{
			trust: { origin: string; pluginsPresent: boolean; trusted: boolean };
		}>(page, bootstrap.token, "character.pluginTrustGet", {
			characterId: "e2e-plugin-trust",
		}),
	).resolves.toMatchObject({
		trust: { origin: "imported", pluginsPresent: true, trusted: false },
	});
	await expect(
		rpc<{ trust: { trusted: boolean } }>(page, bootstrap.token, "character.pluginTrustConfirm", {
			characterId: "e2e-plugin-trust",
		}),
	).resolves.toMatchObject({ trust: { trusted: true } });
});

function packageFiles(root: string, directory = root): Array<{ path: string; base64: string }> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? packageFiles(root, path)
			: [
					{
						path: `package/${relative(root, path)}`,
						base64: readFileSync(path).toString("base64"),
					},
				];
	});
}

async function createFreshConversation(page: Page, token: string, title: string): Promise<string> {
	const conversation = await rpc<{ conversationId: string }>(page, token, "conversation.create", {
		title,
	});
	// Invalidations are deliberately transient and have no replay. Reconcile this
	// test-only out-of-band RPC mutation through the authoritative list read.
	await page.reload();
	return conversation.conversationId;
}

async function latestAssistant(
	page: Page,
	token: string,
	conversationId: string,
): Promise<string | undefined> {
	return (await projection(page, token, conversationId))
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.at(-1)
		?.text?.trim();
}
