import { expect, type Page, test } from "playwright/test";
import { getBootstrap, projectPiEntries } from "./helpers";

interface PiEntry {
	id: string;
	kind: string;
	role?: string;
	text?: string;
}

interface ConversationProjection {
	timeline: { entries: unknown[] };
}

interface CompanionStateProjection {
	state: { display: { sceneId: string; expressionId: string } };
}

async function conversationProjection(
	page: Page,
	token: string,
	conversationId: string,
): Promise<ConversationProjection> {
	return rpc(page, token, "conversation.open:v1", { id: conversationId });
}

async function rpc<T>(page: Page, token: string, channel: string, data: unknown): Promise<T> {
	const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
		headers: { "x-bear-web-dev-token": token },
		data,
	});
	const envelope = await response.json();
	if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
	return envelope.data as T;
}

test("rule provider exercises send and edited-history regeneration deterministically", async ({
	page,
}) => {
	await page.goto("/");
	const bootstrap = await getBootstrap(page);
	await rpc(page, bootstrap.token, "provider.customUpsert:v1", {
		providerId: "e2e-rule",
		name: "E2E Rule Provider",
		baseUrl: `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`,
		models: [{ id: "rule-model" }],
	});
	await rpc(page, bootstrap.token, "provider.setApiKey:v1", {
		providerId: "e2e-rule",
		apiKey: "e2e-rule-key",
		sessionOnly: true,
	});
	await rpc(page, bootstrap.token, "model.enable:v1", {
		providerId: "e2e-rule",
		modelId: "rule-model",
		label: "E2E Rule Provider",
	});
	const conversation = await rpc<{ sessionId: string }>(
		page,
		bootstrap.token,
		"conversation.create:v1",
		{
			title: "Rule provider",
		},
	);
	await rpc(page, bootstrap.token, "model.route.set:v1", {
		conversationId: conversation.sessionId,
		selected: { providerId: "e2e-rule", modelId: "rule-model" },
	});

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversation.sessionId,
		text: "你是谁？",
	});
	await expect
		.poll(async () => {
			const projection = await conversationProjection(
				page,
				bootstrap.token,
				conversation.sessionId,
			);
			return projectPiEntries(projection.timeline.entries)
				.filter((entry) => entry.kind === "message" && entry.role === "assistant")
				.at(-1)
				?.text?.trim();
		})
		.toBe("我是 E2E Rule Provider。");

	const projection = await conversationProjection(page, bootstrap.token, conversation.sessionId);
	const userEntry = projectPiEntries(projection.timeline.entries).find(
		(entry) => entry.kind === "message" && entry.role === "user" && entry.text === "你是谁？",
	);
	if (!userEntry) throw new Error("rule provider projection has no native user entry");
	await rpc(page, bootstrap.token, "message.edit:v1", {
		conversationId: conversation.sessionId,
		entryId: userEntry.id,
		text: "规则：回复 EDITED_OK",
	});
	await expect
		.poll(async () => {
			const next = await conversationProjection(page, bootstrap.token, conversation.sessionId);
			return projectPiEntries(next.timeline.entries)
				.filter((entry) => entry.kind === "message" && entry.role === "assistant")
				.map((entry) => entry.text?.trim());
		})
		.toContain("EDITED_OK");

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversation.sessionId,
		text: "E2E_MANUAL_ROLE_VISUAL",
	});
	await expect
		.poll(async () => {
			const next = await conversationProjection(page, bootstrap.token, conversation.sessionId);
			return projectPiEntries(next.timeline.entries)
				.filter((entry) => entry.kind === "message" && entry.role === "assistant")
				.at(-1)
				?.text?.trim();
		})
		.toContain("E2E_MANUAL_ROLE_VISUAL_DONE");
	await expect
		.poll(async () => {
			const projection = await rpc<CompanionStateProjection>(
				page,
				bootstrap.token,
				"companionState.get:v1",
				{ conversationId: conversation.sessionId },
			);
			return projection.state.display.sceneId;
		})
		.toBe("quiet_terminal");

	await page.reload();
	const restored = await rpc<CompanionStateProjection>(
		page,
		bootstrap.token,
		"companionState.get:v1",
		{ conversationId: conversation.sessionId },
	);
	expect(restored.state.display.sceneId).toBe("quiet_terminal");
});

test("rule provider selects the memory matching the current query marker", async ({ page }) => {
	const providerUrl = `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`;
	const recalledMemories = [
		"E2E_DIRECT_MEMORY_A：我们约定暗号是南星",
		"E2E_DIRECT_MEMORY_B：我们约定暗号是北辰",
	].join("\n");
	const askProvider = async (queryMarker: string): Promise<string> => {
		const response = await page.request.post(`${providerUrl}/chat/completions`, {
			data: {
				messages: [
					{
						role: "user",
						content: [
							"<host_context>",
							recalledMemories,
							"</host_context>",
							"",
							"<current_user_message>",
							`检查记忆上下文 ${queryMarker}`,
							"</current_user_message>",
						].join("\n"),
					},
				],
			},
		});
		expect(response).toBeOK();
		const payload = (await response.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		const content = payload.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new Error("rule provider returned no text content");
		return content;
	};

	await expect(askProvider("E2E_DIRECT_MEMORY_A：我们约定暗号是南星")).resolves.toBe(
		"MEMORY_CONTEXT:我们约定暗号是南星\n",
	);
	await expect(askProvider("E2E_DIRECT_MEMORY_B：我们约定暗号是北辰")).resolves.toBe(
		"MEMORY_CONTEXT:我们约定暗号是北辰\n",
	);
});
