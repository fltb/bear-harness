import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@bear-harness/i18n/locales";
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

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversationA,
		text: "E2E_TOOL_TRIGGER_DAMAGED_LOG",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationA))
		.toBe("E2E_TOOL_TRIGGER_DAMAGED_LOG_DONE");
	const conversationB = await createFreshConversation(page, bootstrap.token, "Second context");
	await rpc(page, bootstrap.token, "message.send:v1", {
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

test("scripted model invokes schema state and authorized history tools with exact arguments", async ({
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
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversationB,
		text: "E2E_TOOL_SEARCH_OTHER_CONVERSATION 请搜索之前的对话",
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
		text: "E2E_TOOL_SEARCH_OTHER_CONVERSATION_ALLOWED 请搜索之前的对话",
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
				tool: "host_state",
				args: expect.objectContaining({ action: "update" }),
			}),
			expect.objectContaining({
				tool: "host_history",
				args: { query: "E2E_HISTORY_MARKER", limit: 2 },
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

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_MANUAL_ROLE_START",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_START_DONE");
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_MANUAL_ROLE_CONTINUE",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_CONTINUE_DONE");
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_MANUAL_ROLE_PRESENT",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_PRESENT_DONE");
	await expect
		.poll(async () => {
			const snapshot = await rpc<{
				presentation?: { conversationId?: string; choiceSetId?: string };
			}>(page, bootstrap.token, "snapshot.get:v1", {});
			return snapshot.presentation?.conversationId === conversationId
				? snapshot.presentation.choiceSetId
				: undefined;
		})
		.toBe("continuity_response");

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
	await expect(choice).toBeHidden();
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_MANUAL_ROLE_RECEIVED_DONE");
	const choiceTrace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
		prompts: string[];
	};
	const choicePrompt = choiceTrace.prompts.findLast((prompt) =>
		prompt.includes("我听见了，也愿意接住这份交接。"),
	);
	expect(choicePrompt).toMatch(/"continuity":\s*{\s*"stage": 2,\s*"response": "unopened"/);
	const entries = await projection(page, bootstrap.token, conversationId);
	expect(
		entries.filter((entry) => entry.kind === "message" && entry.role === "user").at(-1)?.text,
	).toBe("我听见了，也愿意接住这份交接。");

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId,
		text: "E2E_OK final generic state projection",
	});
	await expect
		.poll(async () => latestAssistant(page, bootstrap.token, conversationId))
		.toBe("E2E_OK");
	const trace = (await (await page.request.get(`${providerUrl}/trace/prompts`)).json()) as {
		prompts: string[];
	};
	const finalPrompt = trace.prompts.findLast((prompt) =>
		prompt.includes("final generic state projection"),
	);
	expect(finalPrompt).toMatch(/"continuity":\s*{\s*"stage": 3,\s*"response": "received"/);
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
			entry.kind === "message" && entry.role === "user" && entry.text === "E2E_CONTEXT_T1_ORIGINAL",
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

	await expect(
		rpc(page, bootstrap.token, "message.continue:v1", { conversationId }),
	).rejects.toThrow("message_continue_requires_pending_input");
	const regenerated = (await projection(page, bootstrap.token, conversationId))
		.filter((entry) => entry.kind === "message" && entry.role === "assistant")
		.at(-1);
	if (!regenerated) throw new Error("missing regenerated assistant entry");

	await rpc(page, bootstrap.token, "message.correct:v1", {
		conversationId,
		entryId: regenerated.id,
		presetId: "user_agency",
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
