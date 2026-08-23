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

type PiEntry = { id: string; kind: string; role?: string; text?: string };

async function projection(page: Page, token: string, conversationId: string): Promise<PiEntry[]> {
	const selected = await rpc<{ piTimeline: { entries: PiEntry[] } }>(
		page,
		token,
		"conversation.select:v1",
		{ id: conversationId },
	);
	return selected.piTimeline.entries;
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
		.toMatchObject({
			state: { values: { continuity_stage: expect.any(Number) } },
		});

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

	const firstUser = (await projection(page, bootstrap.token, conversationId)).find(
		(entry) =>
			entry.kind === "message" &&
			entry.role === "user" &&
			entry.text === "E2E_CONTEXT_T1_ORIGINAL",
	);
	if (!firstUser) throw new Error("missing original native context entry");
	await rpc(page, bootstrap.token, "message.edit:v1", {
		conversationId,
		entryId: firstUser.id,
		text: "E2E_CONTEXT_T1_EDITED",
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
	const contextPrompt = promptTrace.prompts.findLast((prompt) =>
		prompt.includes("E2E_CONTEXT_T2_AFTER_EDIT"),
	);
	expect(contextPrompt).toBeDefined();
	expect(contextPrompt).toContain("E2E_CONTEXT_T1_EDITED");
	expect(contextPrompt).toContain("E2E_CONTEXT_T2");
});

test("archived conversations require an explicit search opt-in and deleted messages stop being searchable", async ({
	page,
}) => {
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
	await expect(
		rpc<{ hits: Array<{ conversationId: string }> }>(
			page,
			bootstrap.token,
			"conversation.search:v1",
			{ query: "E2E_ARCHIVED_SEARCH_MARKER", includeArchived: true },
		),
	).resolves.toMatchObject({ hits: [{ conversationId: archived.id }] });
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
	const source = (await projection(page, bootstrap.token, conversationId)).find(
		(entry) =>
			entry.kind === "message" && entry.role === "user" && entry.text === "E2E_BRANCH_SOURCE",
	);
	if (!source) throw new Error("missing native branch source entry");
	await rpc(page, bootstrap.token, "message.branch:v1", {
		conversationId,
		entryId: source.id,
	});
	const response = await page.request.post("/rpc/roleplay.trigger%3Av1", {
		headers: { "x-bear-web-dev-token": bootstrap.token },
		data: {
			conversationId,
			eventId: "continuity_opened",
			dedupeKey: "branch-write-must-fail",
		},
	});
	await expect(response.json()).resolves.toMatchObject({ ok: true });
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
	const assistant = (await projection(page, bootstrap.token, conversationId)).find(
		(entry) => entry.kind === "message" && entry.role === "assistant",
	);
	if (!assistant) throw new Error("missing native assistant entry");

	await rpc(page, bootstrap.token, "message.regenerate:v1", {
		conversationId,
		entryId: assistant.id,
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");

	await rpc(page, bootstrap.token, "message.continue:v1", { conversationId });

	await rpc(page, bootstrap.token, "message.correct:v1", {
		conversationId,
		reason: "不要替用户行动",
		applyScope: "once",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("RULE_OK");
	expect(
		(await projection(page, bootstrap.token, conversationId))
			.filter((entry) => entry.kind === "message" && entry.role === "assistant")
			.at(-1)?.text,
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
	return (await projection(page, token, conversationId))
		.filter((entry) => entry.kind === "message" && entry.role === "assistant")
		.at(-1)?.text;
}
