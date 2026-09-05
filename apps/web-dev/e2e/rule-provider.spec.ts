import { expect, type Page, test } from "playwright/test";
import { getBootstrap, projectPiEntries } from "./helpers";

interface PiEntry {
	id: string;
	type: string;
	role?: string;
	text?: string;
}

interface ConversationProjection {
	branch: { entries: unknown[] };
}

interface CompanionStateProjection {
	state: { display: { sceneId: string; expressionId: string } };
}

async function conversationProjection(
	page: Page,
	token: string,
	conversationId: string,
): Promise<ConversationProjection> {
	return rpc(page, token, "conversation.open", { conversationId });
}

async function rpc<T>(page: Page, token: string, channel: string, data: unknown): Promise<T> {
	const requestData =
		channel === "message.send" && data && typeof data === "object"
			? { ...data, clientMessageId: crypto.randomUUID() }
			: data;
	const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
		headers: { "x-bear-web-dev-token": token },
		data: requestData,
	});
	const envelope = await response.json();
	if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
	return envelope.data as T;
}

async function assistantMessages(page: Page, token: string, conversationId: string) {
	const projection = await conversationProjection(page, token, conversationId);
	return (projectPiEntries(projection.branch.entries) as PiEntry[])
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.map((entry) => entry.text?.trim() ?? "");
}

async function latestAssistant(page: Page, token: string, conversationId: string) {
	return (await assistantMessages(page, token, conversationId)).at(-1);
}

test("rule provider exercises send and historical edits deterministically", async ({ page }) => {
	await page.goto("/");
	const bootstrap = await getBootstrap(page);
	await rpc(page, bootstrap.token, "provider.customUpsert", {
		providerId: "e2e-rule",
		name: "E2E Rule Provider",
		baseUrl: `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`,
		models: [{ id: "rule-model" }],
	});
	await rpc(page, bootstrap.token, "provider.setApiKey", {
		providerId: "e2e-rule",
		apiKey: "e2e-rule-key",
		sessionOnly: true,
	});
	await rpc(page, bootstrap.token, "model.enable", {
		providerId: "e2e-rule",
		modelId: "rule-model",
		label: "E2E Rule Provider",
	});
	await rpc(page, bootstrap.token, "model.defaults.setReply", {
		reply: { providerId: "e2e-rule", modelId: "rule-model" },
	});
	const conversation = await rpc<{ conversationId: string }>(
		page,
		bootstrap.token,
		"conversation.create",
		{
			title: "Rule provider",
		},
	);
	await rpc(page, bootstrap.token, "model.route.set", {
		conversationId: conversation.conversationId,
		selected: { providerId: "e2e-rule", modelId: "rule-model" },
	});

	await rpc(page, bootstrap.token, "message.send", {
		conversationId: conversation.conversationId,
		text: "你是谁？",
	});
	await expect
		.poll(async () => {
			const projection = await conversationProjection(
				page,
				bootstrap.token,
				conversation.conversationId,
			);
			return projectPiEntries(projection.branch.entries)
				.filter((entry) => entry.type === "message" && entry.role === "assistant")
				.at(-1)
				?.text?.trim();
		})
		.toBe("我是 E2E Rule Provider。");

	const projection = await conversationProjection(
		page,
		bootstrap.token,
		conversation.conversationId,
	);
	const userEntry = projectPiEntries(projection.branch.entries).find(
		(entry) => entry.type === "message" && entry.role === "user" && entry.text === "你是谁？",
	);
	if (!userEntry) throw new Error("rule provider projection has no native user entry");
	await rpc(page, bootstrap.token, "message.edit", {
		conversationId: conversation.conversationId,
		entryId: userEntry.id,
		text: "规则：回复 EDITED_OK",
	});
	await expect
		.poll(async () => {
			const next = await conversationProjection(page, bootstrap.token, conversation.conversationId);
			return projectPiEntries(next.branch.entries)
				.filter((entry) => entry.type === "message" && entry.role === "assistant")
				.map((entry) => entry.text?.trim());
		})
		.toContain("EDITED_OK");

	await rpc(page, bootstrap.token, "message.send", {
		conversationId: conversation.conversationId,
		text: "E2E_MANUAL_ROLE_VISUAL",
	});
	await expect
		.poll(async () => {
			const next = await conversationProjection(page, bootstrap.token, conversation.conversationId);
			return projectPiEntries(next.branch.entries)
				.filter((entry) => entry.type === "message" && entry.role === "assistant")
				.at(-1)
				?.text?.trim();
		})
		.toContain("E2E_MANUAL_ROLE_VISUAL_DONE");
	await expect
		.poll(async () => {
			const projection = await rpc<CompanionStateProjection>(
				page,
				bootstrap.token,
				"companionState.get",
				{ conversationId: conversation.conversationId },
			);
			return projection.state.display.sceneId;
		})
		.toBe("quiet_terminal");

	await page.reload();
	const restored = await rpc<CompanionStateProjection>(
		page,
		bootstrap.token,
		"companionState.get",
		{ conversationId: conversation.conversationId },
	);
	expect(restored.state.display.sceneId).toBe("quiet_terminal");
});

test("two sessions keep different native models through renderer restart", async ({ page }) => {
	await page.goto("/");
	const bootstrap = await getBootstrap(page);
	await rpc(page, bootstrap.token, "provider.customUpsert", {
		providerId: "e2e-rule",
		name: "E2E Rule Provider",
		baseUrl: `http://127.0.0.1:${process.env.BEAR_E2E_PROVIDER_PORT ?? "3211"}/v1`,
		models: [{ id: "rule-model" }, { id: "alternate-model" }],
	});
	await rpc(page, bootstrap.token, "provider.setApiKey", {
		providerId: "e2e-rule",
		apiKey: "e2e-rule-key",
		sessionOnly: true,
	});
	for (const modelId of ["rule-model", "alternate-model"]) {
		await rpc(page, bootstrap.token, "model.enable", {
			providerId: "e2e-rule",
			modelId,
			label: modelId,
		});
	}
	await rpc(page, bootstrap.token, "model.defaults.setReply", {
		reply: { providerId: "e2e-rule", modelId: "rule-model" },
	});
	const alpha = await rpc<{ conversationId: string }>(
		page,
		bootstrap.token,
		"conversation.create",
		{ title: "Model alpha" },
	);
	const beta = await rpc<{ conversationId: string }>(page, bootstrap.token, "conversation.create", {
		title: "Model beta",
	});
	await Promise.all([
		rpc(page, bootstrap.token, "model.route.set", {
			conversationId: alpha.conversationId,
			selected: { providerId: "e2e-rule", modelId: "rule-model" },
		}),
		rpc(page, bootstrap.token, "model.route.set", {
			conversationId: beta.conversationId,
			selected: { providerId: "e2e-rule", modelId: "alternate-model" },
		}),
	]);

	const sendModelMarker = (conversationId: string) =>
		rpc(page, bootstrap.token, "message.send", {
			conversationId,
			text: "E2E_MODEL_ID",
		});
	await Promise.all([sendModelMarker(alpha.conversationId), sendModelMarker(beta.conversationId)]);
	await expect
		.poll(() => latestAssistant(page, bootstrap.token, alpha.conversationId))
		.toBe("E2E_MODEL_ID:rule-model");
	await expect
		.poll(() => latestAssistant(page, bootstrap.token, beta.conversationId))
		.toBe("E2E_MODEL_ID:alternate-model");

	await page.reload();
	const [openedAlpha, openedBeta] = await Promise.all([
		rpc<{ selectedModel?: { providerId: string; modelId: string } }>(
			page,
			bootstrap.token,
			"conversation.open",
			{ conversationId: alpha.conversationId },
		),
		rpc<{ selectedModel?: { providerId: string; modelId: string } }>(
			page,
			bootstrap.token,
			"conversation.open",
			{ conversationId: beta.conversationId },
		),
	]);
	expect(openedAlpha.selectedModel).toEqual({ providerId: "e2e-rule", modelId: "rule-model" });
	expect(openedBeta.selectedModel).toEqual({
		providerId: "e2e-rule",
		modelId: "alternate-model",
	});

	await Promise.all([sendModelMarker(alpha.conversationId), sendModelMarker(beta.conversationId)]);
	await expect
		.poll(
			async () =>
				(await assistantMessages(page, bootstrap.token, alpha.conversationId)).filter(
					(text) => text === "E2E_MODEL_ID:rule-model",
				).length,
		)
		.toBe(2);
	await expect
		.poll(
			async () =>
				(await assistantMessages(page, bootstrap.token, beta.conversationId)).filter(
					(text) => text === "E2E_MODEL_ID:alternate-model",
				).length,
		)
		.toBe(2);
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
