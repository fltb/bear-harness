import { expect, type Page, test } from "playwright/test";
import { getBootstrap } from "./helpers";

interface SnapshotMessage {
	id: string;
	role: string;
	versions: Array<{ content: string }>;
}

interface ConversationSnapshot {
	conversation?: { messages?: SnapshotMessage[] };
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
		modelId: "rule-model",
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
	const conversation = await rpc<{ id: string }>(page, bootstrap.token, "conversation.create:v1", {
		title: "Rule provider",
	});
	await rpc(page, bootstrap.token, "model.route.set:v1", {
		conversationId: conversation.id,
		selected: { providerId: "e2e-rule", modelId: "rule-model" },
	});

	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversation.id,
		text: "你是谁？",
	});
	await expect
		.poll(async () => {
			const snapshot = await rpc<ConversationSnapshot>(
				page,
				bootstrap.token,
				"snapshot.get:v1",
				{},
			);
			return snapshot.conversation?.messages?.at(-1)?.versions?.at(-1)?.content;
		})
		.toBe("我是 E2E Rule Provider。");

	const snapshot = await rpc<ConversationSnapshot>(page, bootstrap.token, "snapshot.get:v1", {});
	const userMessage = snapshot.conversation?.messages?.find((message) => message.role === "user");
	if (!userMessage) throw new Error("rule provider snapshot has no user message");
	await rpc(page, bootstrap.token, "message.edit:v1", {
		conversationId: conversation.id,
		messageId: userMessage.id,
		text: "规则：回复 EDITED_OK",
		isUserMessage: true,
	});
	await expect
		.poll(async () => {
			const next = await rpc<ConversationSnapshot>(page, bootstrap.token, "snapshot.get:v1", {});
			return next.conversation?.messages
				?.filter((message) => message.role === "assistant")
				.flatMap((message) => message.versions)
				.map((version) => version.content);
		})
		.toContain("EDITED_OK");
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

test("an image reader observes images while the selected text model produces the reply", async ({
	page,
}) => {
	await page.goto("/");
	const bootstrap = await getBootstrap(page);
	const baseUrl = `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`;
	await rpc(page, bootstrap.token, "provider.importPiConfig:v1", {
		configJson: JSON.stringify({
			providers: {
				"e2e-rule": {
					name: "E2E Rule Provider",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "rule-text",
							name: "Rule Text",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 8192,
							maxTokens: 1024,
						},
						{
							id: "rule-vision",
							name: "Rule Vision",
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 8192,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	});
	await rpc(page, bootstrap.token, "provider.setApiKey:v1", {
		providerId: "e2e-rule",
		apiKey: "e2e-rule-key",
		sessionOnly: true,
	});
	const conversation = await rpc<{ id: string }>(page, bootstrap.token, "conversation.create:v1", {
		title: "Image reader routing",
	});
	await rpc(page, bootstrap.token, "model.route.set:v1", {
		conversationId: conversation.id,
		selected: { providerId: "e2e-rule", modelId: "rule-text" },
	});
	await rpc(page, bootstrap.token, "model.defaults.setVision:v1", {
		mode: "manual",
		route: { providerId: "e2e-rule", modelId: "rule-vision" },
	});
	await rpc(page, bootstrap.token, "message.send:v1", {
		conversationId: conversation.id,
		text: "What is in this image?",
		attachments: [{ name: "square.png", mime: "image/png", base64: "AQID" }],
	});

	await expect
		.poll(async () => {
			const snapshot = await rpc<ConversationSnapshot>(
				page,
				bootstrap.token,
				"snapshot.get:v1",
				{},
			);
			return snapshot.conversation?.messages?.at(-1)?.versions?.at(-1)?.content;
		})
		.toBe("MAIN_USED_VISUAL_OBSERVATION");
});
