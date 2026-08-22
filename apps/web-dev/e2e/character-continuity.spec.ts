import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "playwright/test";

const providerUrl = `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}`;

import { ensureReadyForConversation } from "./helpers";

const characterRoot = fileURLToPath(new URL("../../../config/characters/jizhou", import.meta.url));

async function rpc<T>(page: Page, token: string, channel: string, data: unknown): Promise<T> {
	const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
		headers: { "x-bear-web-dev-token": token },
		data,
	});
	const envelope = await response.json();
	if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
	return envelope.data as T;
}

test("committed character facts survive new conversations and edited message history", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationA = await createFreshConversation(
		page,
		bootstrap.token,
		"Character facts source",
	);

	await rpc(page, bootstrap.token, "roleplay.trigger:v1", {
		conversationId: conversationA,
		eventId: "continuity_opened",
		dedupeKey: "e2e:continuity-opened",
	});
	await rpc(page, bootstrap.token, "roleplay.trigger:v1", {
		conversationId: conversationA,
		eventId: "continuity_revealed",
		dedupeKey: "e2e:continuity-revealed",
	});
	const conversationB = await createFreshConversation(page, bootstrap.token, "Second context");
	const state = await rpc<{ state: { values: Record<string, unknown> } }>(
		page,
		bootstrap.token,
		"roleplay.get:v1",
		{ conversationId: conversationB },
	);
	expect(state.state.values).toMatchObject({ continuity_stage: 2 });

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversationA,
		text: "历史搜索锚点 7F-19",
	});
	await expect
		.poll(async () =>
			rpc<{ hits: Array<{ excerpt: string }> }>(page, bootstrap.token, "conversation.search:v1", {
				query: "7F-19",
			}),
		)
		.toMatchObject({
			hits: [expect.objectContaining({ excerpt: expect.stringContaining("7F-19") })],
		});

	await rpc(page, bootstrap.token, "settings.set:v1", {
		settings: { conversationHistoryReadEnabled: true },
	});
	await expect(rpc(page, bootstrap.token, "settings.get:v1", {})).resolves.toMatchObject({
		settings: { conversationHistoryReadEnabled: true },
	});
});

test("scripted model invokes roleplay and cross-conversation tools with exact arguments", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	await rpc(page, bootstrap.token, "settings.set:v1", {
		settings: { conversationHistoryReadEnabled: false },
	});
	const conversationA = await createFreshConversation(
		page,
		bootstrap.token,
		"Tool-call history source",
	);
	const conversationB = await createFreshConversation(
		page,
		bootstrap.token,
		"Tool-call verification",
	);

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversationA,
		text: "E2E_HISTORY_MARKER: the first conversation is searchable.",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationA))
		.toBe("RULE_OK");

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversationB,
		text: "E2E_TOOL_TRIGGER_DAMAGED_LOG",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationB))
		.toBe("E2E_TOOL_TRIGGER_DAMAGED_LOG_DONE");
	await expect
		.poll(async () =>
			rpc<{ state: { values: Record<string, unknown> } }>(
				page,
				bootstrap.token,
				"roleplay.get:v1",
				{ conversationId: conversationB },
			),
		)
		.toMatchObject({ state: { values: { continuity_stage: 1 } } });

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversationB,
		text: "E2E_TOOL_SEARCH_OTHER_CONVERSATION",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationB))
		.toBe("E2E_TOOL_SEARCH_OTHER_CONVERSATION_DENIED");

	await rpc(page, bootstrap.token, "settings.set:v1", {
		settings: { conversationHistoryReadEnabled: true },
	});
	await expect(rpc(page, bootstrap.token, "settings.get:v1", {})).resolves.toMatchObject({
		settings: { conversationHistoryReadEnabled: true },
	});
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversationB,
		text: "E2E_TOOL_SEARCH_OTHER_CONVERSATION_ALLOWED",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationB))
		.toBe("E2E_TOOL_SEARCH_OTHER_CONVERSATION_FOUND");
	const trace = (await (await page.request.get(`${providerUrl}/trace/tools`)).json()) as {
		calls: Array<{ tool: string; args: Record<string, unknown> }>;
	};
	expect(trace.calls).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				tool: "host_trigger_roleplay_event",
				args: { eventId: "continuity_opened" },
			}),
			expect.objectContaining({
				tool: "host_search_conversation_history",
				args: { query: "E2E_HISTORY_MARKER", limit: 2 },
			}),
		]),
	);
});

test("adopted multi-turn history and a manual edit change the next model context", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationId = await createFreshConversation(page, bootstrap.token, "Multi-turn context");

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_CONTEXT_T1_ORIGINAL",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_CONTEXT_T2",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_CONTEXT_TWO_TURNS_OK");

	const selected = await rpc<{
		messages: Array<{
			id: string;
			role: string;
			versions: Array<{ content: string; adopted: boolean }>;
		}>;
	}>(page, bootstrap.token, "conversation.select:v1", { id: conversationId });
	const firstUser = selected.messages.find(
		(message) =>
			message.role === "user" &&
			message.versions.some(
				(version) => version.adopted && version.content === "E2E_CONTEXT_T1_ORIGINAL",
			),
	);
	if (!firstUser) throw new Error("missing original context message");
	await rpc(page, bootstrap.token, "message.edit:v1", {
		conversationId,
		messageId: firstUser.id,
		text: "E2E_CONTEXT_T1_EDITED",
		isUserMessage: true,
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_CONTEXT_T2_AFTER_EDIT",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_CONTEXT_EDITED_OK");
	const promptTrace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
		prompts: string[];
	};
	const lastPrompt = promptTrace.prompts.at(-1);
	expect(lastPrompt).toContain("你是极昼，旧极光站的守护核心。");
	expect(lastPrompt).toContain("语气克制、具体，像一个长期值守的人在说话。");
	expect(lastPrompt).not.toContain(
		"You are an expert coding assistant operating inside pi, a coding agent harness.",
	);
	expect(lastPrompt).toContain("<host_context>");
	expect(lastPrompt).toContain("【identity】");
	expect(lastPrompt).toContain("【canon】");
	expect(lastPrompt).toContain("【roleplay】");
	expect(lastPrompt).toContain("E2E_CONTEXT_T1_EDITED");
	expect(lastPrompt).toContain("E2E_CONTEXT_T2");
	expect(lastPrompt).not.toContain("E2E_CONTEXT_T1_ORIGINAL");
	expect(lastPrompt).toContain("<current_user_message>\nE2E_CONTEXT_T2_AFTER_EDIT");
});

test("archived conversations require an explicit search opt-in and deleted messages stop being searchable", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const archived = await rpc<{ id: string }>(page, bootstrap.token, "conversation.create:v1", {
		title: "Archive search boundary",
	});
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: archived.id,
		text: "E2E_ARCHIVED_SEARCH_MARKER",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, archived.id))
		.toBe("RULE_OK");
	await rpc(page, bootstrap.token, "conversation.archive:v1", { id: archived.id, archived: true });
	await expect(
		rpc<{ hits: Array<{ conversationId: string }> }>(
			page,
			bootstrap.token,
			"conversation.search:v1",
			{ query: "E2E_ARCHIVED_SEARCH_MARKER" },
		),
	).resolves.toEqual({ hits: [] });
	await expect(
		rpc<{ hits: Array<{ conversationId: string }> }>(
			page,
			bootstrap.token,
			"conversation.search:v1",
			{ query: "E2E_ARCHIVED_SEARCH_MARKER", includeArchived: true },
		),
	).resolves.toMatchObject({ hits: [{ conversationId: archived.id }] });
	await rpc(page, bootstrap.token, "conversation.delete:v1", { id: archived.id });
	await expect(
		rpc<{ hits: Array<{ conversationId: string }> }>(
			page,
			bootstrap.token,
			"conversation.search:v1",
			{ query: "E2E_ARCHIVED_SEARCH_MARKER", includeArchived: true },
		),
	).resolves.toEqual({ hits: [] });
});

test("an explicit transcript branch cannot commit roleplay facts", async ({ page }) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationId = await createFreshConversation(page, bootstrap.token, "Transcript branch");
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_BRANCH_SOURCE",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	const selected = await rpc<{
		messages: Array<{
			id: string;
			role: string;
			versions: Array<{ content: string; adopted: boolean }>;
		}>;
	}>(page, bootstrap.token, "conversation.select:v1", { id: conversationId });
	const source = selected.messages.find(
		(message) =>
			message.role === "user" &&
			message.versions.some(
				(version) => version.adopted && version.content === "E2E_BRANCH_SOURCE",
			),
	);
	if (!source) throw new Error("missing branch source message");
	await rpc(page, bootstrap.token, "message.branch:v1", {
		conversationId,
		messageId: source.id,
	});
	const response = await page.request.post("/rpc/roleplay.trigger%3Av1", {
		headers: { "x-bear-web-dev-token": bootstrap.token },
		data: {
			conversationId,
			eventId: "continuity_opened",
			dedupeKey: "branch-write-must-fail",
		},
	});
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: { kind: "conflict", reason: "roleplay_event_branch_not_canonical" },
	});
});

test("conversation operations send explicit model instructions and persist revised replies", async ({
	page,
}) => {
	await ensureReadyForConversation(page);
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const conversationId = await createFreshConversation(
		page,
		bootstrap.token,
		"Conversation operations",
	);

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_OPERATION_PARENT",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	const selected = await rpc<{
		messages: Array<{ id: string; role: string }>;
	}>(page, bootstrap.token, "conversation.select:v1", { id: conversationId });
	const assistant = selected.messages.find((message) => message.role === "assistant");
	if (!assistant) throw new Error("missing assistant message");

	await rpc(page, bootstrap.token, "message.regenerate:v1", {
		conversationId,
		messageId: assistant.id,
	});
	await expect
		.poll(async () => (await promptTrace()).at(-1))
		.toContain("请基于上面的对话重新生成对上一条用户消息的回复。");

	await rpc(page, bootstrap.token, "message.continue:v1", { conversationId });
	await expect
		.poll(async () => (await promptTrace()).at(-1))
		.toContain("请继续上一条回复。不要重复已经说过的内容，直接接着完成。");

	await rpc(page, bootstrap.token, "message.correct:v1", {
		conversationId,
		reason: "不要替用户行动",
		applyScope: "once",
	});
	await expect
		.poll(async () => (await promptTrace()).at(-1))
		.toContain("用户刚刚指出上一条回复的问题：“不要替用户行动”。");
	const afterCorrection = await rpc<{
		messages: Array<{ role: string; versions: Array<{ adopted: boolean; content: string }> }>;
	}>(page, bootstrap.token, "conversation.select:v1", { id: conversationId });
	expect(
		afterCorrection.messages
			.filter((message) => message.role === "assistant")
			.at(-1)
			?.versions.find((version) => version.adopted)?.content,
	).toBe("RULE_OK");
});

async function promptTrace(): Promise<string[]> {
	const payload: unknown = await (await fetch(`${providerUrl}/trace/prompts`)).json();
	if (
		!payload ||
		typeof payload !== "object" ||
		!("prompts" in payload) ||
		!Array.isArray(payload.prompts) ||
		!payload.prompts.every((prompt) => typeof prompt === "string")
	) {
		throw new Error("rule provider returned an invalid prompt trace");
	}
	return payload.prompts;
}

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

	await expect(rpc(page, bootstrap.token, "character.import:v1", { files })).resolves.toMatchObject(
		{
			character: { id: "e2e-plugin-trust" },
		},
	);
	await expect(
		rpc<{ trust: { origin: string; pluginsPresent: boolean; trusted: boolean } }>(
			page,
			bootstrap.token,
			"character.pluginTrustGet:v1",
			{ characterId: "e2e-plugin-trust" },
		),
	).resolves.toMatchObject({
		trust: { origin: "imported", pluginsPresent: true, trusted: false },
	});
	await expect(
		rpc<{ trust: { trusted: boolean } }>(page, bootstrap.token, "character.pluginTrustConfirm:v1", {
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
	const conversation = await rpc<{ id: string }>(page, token, "conversation.create:v1", { title });
	await rpc(page, token, "conversation.select:v1", { id: conversation.id });
	return conversation.id;
}

async function latestAssistant(
	page: Page,
	token: string,
	conversationId: string,
): Promise<string | undefined> {
	const selected = await rpc<{
		messages: Array<{ role: string; versions: Array<{ content: string; adopted: boolean }> }>;
	}>(page, token, "conversation.select:v1", { id: conversationId });
	return selected.messages
		.filter((message) => message.role === "assistant")
		.at(-1)
		?.versions.find((version) => version.adopted)?.content;
}
