import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { activeConversationId, projectPiEntries } from "./helpers";

const enabled = process.env.BEAR_E2E_LIVE_MODEL === "1";
const providerId = process.env.BEAR_E2E_PROVIDER_ID ?? "";
const modelId = process.env.BEAR_E2E_MODEL_ID ?? "";
const secondaryModelId = process.env.BEAR_E2E_SECONDARY_MODEL_ID ?? "";
const apiKey = process.env.BEAR_E2E_API_KEY ?? "";
const customBaseUrl = process.env.BEAR_E2E_CUSTOM_BASE_URL ?? "";
const usePiConfig = process.env.BEAR_E2E_USE_PI_CONFIG === "1";
const useCodexSession = process.env.BEAR_E2E_USE_CODEX_SESSION === "1";
const credentialsAvailable = apiKey.length > 0 || usePiConfig || useCodexSession;
const configuredProviderId = useCodexSession
	? "openai-codex"
	: usePiConfig
		? "e2e-live-openai"
		: providerId;
const liveReplyTimeout = 180_000;

type LiveRpc = <T>(channel: string, data: unknown) => Promise<T>;

async function setSelectedApiKey(rpc: LiveRpc, selectedApiKey: string): Promise<void> {
	if (useCodexSession || !selectedApiKey) return;
	await rpc("provider.setApiKey", {
		providerId: configuredProviderId,
		apiKey: selectedApiKey,
		sessionOnly: true,
	});
}

async function completeLiveOnboarding(rpc: LiveRpc, context: string): Promise<void> {
	await rpc("systemOnboarding.completeModel", {
		reply: { providerId: configuredProviderId, modelId },
		vision: { mode: "auto" },
		licensesAcknowledged: {
			bear: "GPL-3.0-only",
			...(process.platform === "win32" ? { gitForWindows: "GPL-2.0-only" } : {}),
		},
	});
	await rpc("systemOnboarding.completeEmbedding", { choice: "none" });
	await rpc("model.defaults.completeOnboarding", {});
	let onboarding = await rpc<{ status: string; currentStepId?: string }>("onboarding.get", {});
	const onboardingAnswers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "北辰",
	};
	while (onboarding.status === "active") {
		const stepId = onboarding.currentStepId;
		if (!stepId || !(stepId in onboardingAnswers)) {
			throw new Error(`Unhandled ${context} onboarding step: ${stepId ?? "missing"}`);
		}
		onboarding = await rpc("onboarding.submit", {
			stepId,
			answer: onboardingAnswers[stepId],
		});
	}
}

function selectedPiProviderConfig(modelIds: string[] = [modelId]): {
	apiKey: string;
	configJson: string;
} {
	const parsed = JSON.parse(
		readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"),
	) as { providers?: Record<string, unknown> };
	const provider = parsed.providers?.[providerId];
	if (!provider) throw new Error(`Pi config has no provider ${providerId}`);
	const { apiKey: configuredKey, ...metadata } = provider as Record<string, unknown>;
	if (typeof configuredKey !== "string" || configuredKey.length === 0)
		throw new Error(`Pi config provider ${providerId} has no API key`);
	if (typeof metadata.baseUrl !== "string")
		throw new Error(`Pi config provider ${providerId} has no base URL`);
	const configuredModels = Array.isArray(metadata.models) ? metadata.models : [];
	const selectedModels = modelIds.map((requestedModelId) => {
		const sourceModel = configuredModels.find(
			(value) =>
				value !== null &&
				typeof value === "object" &&
				"id" in value &&
				value.id === requestedModelId,
		) as Record<string, unknown> | undefined;
		if (!sourceModel)
			throw new Error(`Pi config provider ${providerId} has no model ${requestedModelId}`);
		return sourceModel;
	});
	return {
		apiKey: configuredKey,
		configJson: JSON.stringify({
			providers: {
				[configuredProviderId]: { ...metadata, models: selectedModels },
			},
		}),
	};
}

test("configured live model answers a WebDev smoke message", async ({ page }) => {
	test.skip(
		!enabled || !providerId || !modelId || !credentialsAvailable,
		"Set BEAR_E2E_LIVE_MODEL=1 and the provider/model/key variables in .env",
	);
	test.setTimeout(liveReplyTimeout);

	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};

	let selectedApiKey = apiKey;
	if (usePiConfig) {
		const selected = selectedPiProviderConfig();
		selectedApiKey = selected.apiKey;
		await rpc("provider.importPiConfig", { configJson: selected.configJson });
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId,
			name: "E2E custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	await setSelectedApiKey(rpc, selectedApiKey);
	await rpc("model.enable", {
		providerId: configuredProviderId,
		modelId,
		label: "E2E live model",
	});
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	const conversation = await rpc<{ conversationId: string }>("conversation.create", {});
	await rpc("model.route.set", {
		conversationId: conversation.conversationId,
		selected: { providerId: configuredProviderId, modelId },
	});
	await rpc("message.send", {
		conversationId: conversation.conversationId,
		text: "只回复 E2E_OK，不要添加其他内容。",
		clientMessageId: crypto.randomUUID(),
	});

	await expect
		.poll(
			async () => {
				const opened = await rpc<{ branch: { entries: unknown[] } }>("conversation.open", {
					conversationId: conversation.conversationId,
				});
				const failed = opened.branch.entries.findLast(
					(entry) =>
						entry !== null &&
						typeof entry === "object" &&
						"message" in entry &&
						entry.message !== null &&
						typeof entry.message === "object" &&
						"stopReason" in entry.message &&
						entry.message.stopReason === "error",
				);
				if (failed) throw new Error(`Live smoke model error: ${JSON.stringify(failed)}`);
				return projectPiEntries(opened.branch.entries)
					.filter((entry) => entry.type === "message" && entry.role === "assistant")
					.map((entry) => entry.text ?? "")
					.join("\n");
			},
			{ timeout: 60_000 },
		)
		.toContain("E2E_OK");
});

test("configured live model preserves authority through switch, refresh, and Stop", async ({
	page,
}) => {
	test.skip(
		!enabled || !providerId || !modelId || !credentialsAvailable,
		"Set the live-model variables for the Stop journey",
	);
	test.setTimeout(600_000);
	const pageErrors: Error[] = [];
	page.on("pageerror", (error) => pageErrors.push(error));
	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};
	let selectedApiKey = apiKey;
	if (usePiConfig) {
		const selected = selectedPiProviderConfig();
		selectedApiKey = selected.apiKey;
		await rpc("provider.importPiConfig", { configJson: selected.configJson });
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	await setSelectedApiKey(rpc, selectedApiKey);
	await rpc("model.enable", {
		providerId: configuredProviderId,
		modelId,
		label: `E2E live ${modelId}`,
	});
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	await completeLiveOnboarding(rpc, "stop-journey");
	const source = await rpc<{ conversationId: string }>("conversation.create", {
		title: "真实模型停止验收",
	});
	const parallel = await rpc<{ conversationId: string }>("conversation.create", {
		title: "真实模型后台会话",
	});
	for (const conversationId of [source.conversationId, parallel.conversationId]) {
		await rpc("model.route.set", {
			conversationId,
			selected: { providerId: configuredProviderId, modelId },
		});
	}
	await page.reload();
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const sourceButton = sidebar.locator(`[data-conversation-id="${source.conversationId}"]`);
	const parallelButton = sidebar.locator(`[data-conversation-id="${parallel.conversationId}"]`);
	await sourceButton.click();
	await activeConversationId(page, source.conversationId);
	const sourceThread = page.getByRole("region", { name: zhCN.messages.conversation });
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill(
		"极昼，今晚值守太安静了。请给我讲一个足够长、至少一万字的雪原旅店故事，从第一场风雪一直讲到第二天清晨，人物对话和环境细节都慢慢展开。",
	);
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
	const streaming = page.getByTestId("streaming-assistant-message");
	const streamedText = () =>
		streaming.getByTestId("message-content").evaluateAll((elements) =>
			elements
				.filter((element) => element.parentElement?.classList.contains("msg"))
				.map((element) => element.textContent ?? "")
				.join("\n"),
		);
	let partialBeforeSwitch = "";
	await expect
		.poll(
			async () => {
				const candidate = await streamedText();
				if (candidate.trim().length > 0) partialBeforeSwitch = candidate;
				return partialBeforeSwitch.trim().length;
			},
			{ timeout: liveReplyTimeout },
		)
		.toBeGreaterThan(0);
	expect(partialBeforeSwitch.length).toBeGreaterThan(0);
	await parallelButton.click();
	await activeConversationId(page, parallel.conversationId);
	await expect(page.getByTestId("conversation-activity")).toBeHidden();
	await sourceButton.click();
	await activeConversationId(page, source.conversationId);
	await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeVisible();
	await page.reload();
	await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeVisible({
		timeout: liveReplyTimeout,
	});
	const stopStarted = Date.now();
	await page.getByRole("button", { name: zhCN.composer.stopLabel }).click();
	await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeHidden({
		timeout: 1_000,
	});
	expect(Date.now() - stopStarted).toBeLessThanOrEqual(1_000);
	await expect
		.poll(
			async () =>
				JSON.stringify(
					(
						await rpc<{ branch: { entries: unknown[] } }>("conversation.open", {
							conversationId: source.conversationId,
						})
					).branch.entries,
				).includes('"stopReason":"aborted"'),
			{ timeout: 30_000 },
		)
		.toBe(true);
	const opened = await rpc<{ branch: { entries: unknown[] } }>("conversation.open", {
		conversationId: source.conversationId,
	});
	const serialized = JSON.stringify(opened.branch.entries);
	expect(serialized).toContain('"stopReason":"aborted"');
	const aborted = opened.branch.entries.findLast(
		(entry) =>
			entry !== null &&
			typeof entry === "object" &&
			"message" in entry &&
			entry.message !== null &&
			typeof entry.message === "object" &&
			"stopReason" in entry.message &&
			entry.message.stopReason === "aborted",
	) as { message?: { content?: unknown[] } } | undefined;
	expect(aborted).toBeDefined();
	const preservedAssistantText = projectPiEntries(opened.branch.entries)
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.map((entry) => entry.text ?? "")
		.join("\n");
	expect(preservedAssistantText.length).toBeGreaterThan(0);
	await expect
		.poll(() =>
			sourceThread
				.getByRole("article", { name: "极昼", exact: true })
				.getByTestId("message-content")
				.evaluateAll((elements) => elements.map((element) => element.textContent ?? "").join("\n")),
		)
		.toContain(partialBeforeSwitch.trim());
	await expect(page.getByText(zhCN.messages.responseStopped, { exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByText(zhCN.messages.responseStopped, { exact: true })).toBeVisible();
	expect(pageErrors).toEqual([]);
});

test("configured live model answers in character and obeys the explicit-memory boundary", async ({
	page,
}) => {
	test.skip(
		!enabled || !providerId || !modelId || !credentialsAvailable,
		"Set BEAR_E2E_LIVE_MODEL=1 and the provider/model/key variables in .env",
	);
	test.setTimeout(300_000);

	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};
	let selectedApiKey = apiKey;
	if (usePiConfig) {
		const selected = selectedPiProviderConfig();
		selectedApiKey = selected.apiKey;
		await rpc("provider.importPiConfig", { configJson: selected.configJson });
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId,
			name: "E2E custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	await setSelectedApiKey(rpc, selectedApiKey);
	await rpc("model.enable", {
		providerId: configuredProviderId,
		modelId,
		label: "E2E live model",
	});
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	const conversation = await rpc<{ conversationId: string }>("conversation.create", {
		title: "Live character and memory boundary",
	});
	await rpc("model.route.set", {
		conversationId: conversation.conversationId,
		selected: { providerId: configuredProviderId, modelId },
	});
	const open = () =>
		rpc<{ branch: { entries: unknown[] }; live: { isStreaming: boolean } }>("conversation.open", {
			conversationId: conversation.conversationId,
		});
	const assistants = async () =>
		projectPiEntries((await open()).branch.entries)
			.filter((entry) => entry.type === "message" && entry.role === "assistant")
			.map((entry) => entry.text?.trim() ?? "");
	const send = (text: string) =>
		rpc("message.send", {
			conversationId: conversation.conversationId,
			text,
			clientMessageId: crypto.randomUUID(),
		});

	await send("我今天穿蓝色外套，只是随口说，不需要记住。请自然回应。 ");
	await expect.poll(async () => (await assistants()).length, { timeout: liveReplyTimeout }).toBe(1);
	await expect.poll(async () => (await open()).live.isStreaming).toBe(false);
	expect(JSON.stringify((await open()).branch.entries)).not.toContain(
		'"toolName":"explicit_memory"',
	);

	await send("请明确记住：我长期希望你称呼我为北辰。记住后简短确认。");
	await expect
		.poll(async () => JSON.stringify((await open()).branch.entries), { timeout: liveReplyTimeout })
		.toContain('"toolName":"explicit_memory"');
	await expect
		.poll(async () => (await open()).live.isStreaming, { timeout: liveReplyTimeout })
		.toBe(false);

	await send("请用两句话直接回答：你是谁，你现在最重视什么？");
	await expect
		.poll(async () => (await assistants()).at(-1), { timeout: liveReplyTimeout })
		.toContain("极昼");
	await expect.poll(async () => (await open()).live.isStreaming).toBe(false);
});

test("configured live model answers through the native conversation journey", async ({
	context,
	request,
}) => {
	test.skip(
		!enabled || !providerId || !modelId || !secondaryModelId || !credentialsAvailable,
		"Set the live-model variables, including BEAR_E2E_SECONDARY_MODEL_ID",
	);
	test.setTimeout(900_000);

	let copiedText = "";
	await context.exposeFunction("recordLiveModelCopy", (value: string) => {
		copiedText = value;
	});
	await context.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (value: string) => {
					await (
						window as unknown as { recordLiveModelCopy(text: string): Promise<void> }
					).recordLiveModelCopy(value);
				},
			},
		});
	});

	const bootstrap = await (await request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};

	let selectedApiKey = apiKey;
	if (usePiConfig) {
		const selected = selectedPiProviderConfig([modelId, secondaryModelId]);
		selectedApiKey = selected.apiKey;
		await rpc("provider.importPiConfig", { configJson: selected.configJson });
	} else if (!useCodexSession) {
		test.skip(!customBaseUrl, "The complete journey needs a custom provider base URL");
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }, { id: secondaryModelId }],
		});
	}
	await setSelectedApiKey(rpc, selectedApiKey);
	for (const liveModelId of [modelId, secondaryModelId]) {
		await rpc("model.enable", {
			providerId: configuredProviderId,
			modelId: liveModelId,
			label: `E2E live ${liveModelId}`,
		});
	}
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	await completeLiveOnboarding(rpc, "live-model");

	const source = await rpc<{ conversationId: string }>("conversation.create", {
		title: "Live native journey source",
	});
	const parallel = await rpc<{ conversationId: string }>("conversation.create", {
		title: "Live native journey parallel",
	});
	await rpc("model.route.set", {
		conversationId: source.conversationId,
		selected: { providerId: configuredProviderId, modelId },
	});
	await rpc("model.route.set", {
		conversationId: parallel.conversationId,
		selected: { providerId: configuredProviderId, modelId: secondaryModelId },
	});

	type Opened = {
		branch: { entries: unknown[]; activeLeafId?: string };
		live: { isStreaming: boolean };
		selectedModel?: { providerId: string; modelId: string };
	};
	const open = (conversationId: string) => rpc<Opened>("conversation.open", { conversationId });
	const projected = async (conversationId: string) =>
		projectPiEntries((await open(conversationId)).branch.entries);
	const assistantTexts = async (conversationId: string) =>
		(await projected(conversationId))
			.filter((entry) => entry.type === "message" && entry.role === "assistant")
			.map((entry) => entry.text?.trim() ?? "");
	const waitSettled = async (conversationId: string, marker: string) => {
		await expect
			.poll(
				async () => {
					const snapshot = await open(conversationId);
					const failed = snapshot.branch.entries.findLast(
						(entry) =>
							entry !== null &&
							typeof entry === "object" &&
							"message" in entry &&
							entry.message !== null &&
							typeof entry.message === "object" &&
							"stopReason" in entry.message &&
							entry.message.stopReason === "error",
					);
					if (failed) throw new Error(`Live journey model error: ${JSON.stringify(failed)}`);
					return projectPiEntries(snapshot.branch.entries)
						.filter((entry) => entry.type === "message" && entry.role === "assistant")
						.map((entry) => entry.text?.trim() ?? "")
						.join("\n");
				},
				{ timeout: liveReplyTimeout },
			)
			.toContain(marker);
		await expect
			.poll(async () => (await open(conversationId)).live.isStreaming, {
				timeout: liveReplyTimeout,
			})
			.toBe(false);
	};
	const sendRpc = (conversationId: string, text: string) =>
		rpc("message.send", { conversationId, text, clientMessageId: crypto.randomUUID() });

	await Promise.all([
		sendRpc(source.conversationId, "只回复 LIVE_SOURCE，不要添加其他文字。"),
		sendRpc(parallel.conversationId, "只回复 LIVE_PARALLEL，不要添加其他文字。"),
	]);
	await Promise.all([
		waitSettled(source.conversationId, "LIVE_SOURCE"),
		waitSettled(parallel.conversationId, "LIVE_PARALLEL"),
	]);
	expect((await open(source.conversationId)).selectedModel).toEqual({
		providerId: configuredProviderId,
		modelId,
	});
	expect((await open(parallel.conversationId)).selectedModel).toEqual({
		providerId: configuredProviderId,
		modelId: secondaryModelId,
	});

	const page = await context.newPage();
	await page.goto("/");
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const sourceButton = sidebar.locator(`[data-conversation-id="${source.conversationId}"]`);
	await sourceButton.click();
	await expect(thread.getByText("LIVE_SOURCE", { exact: true })).toHaveCount(1);
	const sourceAssistant = thread
		.getByRole("article", { name: "极昼" })
		.filter({ hasText: "LIVE_SOURCE" });
	await sourceAssistant.getByRole("button", { name: zhCN.messages.copy }).click();
	await expect(sourceAssistant.getByRole("button", { name: zhCN.messages.copied })).toBeVisible();
	await expect.poll(() => copiedText).toBe("LIVE_SOURCE");

	const sourceUser = thread
		.getByRole("article", { name: zhCN.messages.you })
		.filter({ hasText: "只回复 LIVE_SOURCE，不要添加其他文字。" });
	await sourceUser.getByRole("button", { name: zhCN.messages.edit }).click();
	const editor = thread.getByRole("textbox", { name: zhCN.messages.editLabel });
	await editor.fill("只回复 LIVE_EDITED，不要添加其他文字。");
	await editor.press("Enter");
	await waitSettled(source.conversationId, "LIVE_EDITED");
	await expect(thread.getByText("LIVE_EDITED", { exact: true })).toHaveCount(1);
	await expect(thread.getByText("LIVE_SOURCE", { exact: true })).toHaveCount(0);

	const editedAssistant = thread
		.getByRole("article", { name: "极昼" })
		.filter({ hasText: "LIVE_EDITED" });
	const leafBeforeCorrection = (await open(source.conversationId)).branch.activeLeafId;
	await editedAssistant.getByRole("button", { name: "这不像极昼" }).click();
	await page.getByRole("button", { name: "语气不像他" }).click();
	await expect
		.poll(async () => (await open(source.conversationId)).branch.activeLeafId, {
			timeout: liveReplyTimeout,
		})
		.not.toBe(leafBeforeCorrection);
	await expect
		.poll(async () => (await open(source.conversationId)).live.isStreaming, {
			timeout: liveReplyTimeout,
		})
		.toBe(false);
	await expect
		.poll(async () => (await assistantTexts(source.conversationId)).join("\n"), {
			timeout: liveReplyTimeout,
		})
		.toContain("LIVE_EDITED");

	await editedAssistant.getByRole("button", { name: zhCN.messages.branch }).click();
	await expect
		.poll(async () => {
			const current = await sidebar
				.getByRole("button")
				.evaluateAll((buttons) =>
					buttons
						.find((button) => button.getAttribute("aria-current") === "page")
						?.getAttribute("data-conversation-id"),
				);
			return current && current !== source.conversationId ? current : undefined;
		})
		.toBeTruthy();
	const branchConversationId = await sidebar
		.getByRole("button")
		.evaluateAll((buttons) =>
			buttons
				.find((button) => button.getAttribute("aria-current") === "page")
				?.getAttribute("data-conversation-id"),
		);
	if (!branchConversationId) throw new Error("live-model fork did not activate a conversation");
	const branchPrompt = "这是刚才话题的新方向。请确认你收到了，并简短说说我们现在从哪里继续。";
	const branchAssistantCount = (await assistantTexts(branchConversationId)).length;
	await sendRpc(branchConversationId, branchPrompt);
	await expect
		.poll(async () => (await assistantTexts(branchConversationId)).length, {
			timeout: liveReplyTimeout,
		})
		.toBeGreaterThan(branchAssistantCount);
	await expect
		.poll(async () => (await open(branchConversationId)).live.isStreaming, {
			timeout: liveReplyTimeout,
		})
		.toBe(false);
	expect(JSON.stringify((await open(source.conversationId)).branch.entries)).not.toContain(
		branchPrompt,
	);
	await expect(thread.getByText(branchPrompt, { exact: true })).toHaveCount(1);
	await expect(thread.getByRole("article", { name: "极昼" })).toHaveCount(branchAssistantCount + 1);
	await expect(sourceButton).toBeVisible();

	await page.reload();
	await expect(thread.getByText(branchPrompt, { exact: true })).toHaveCount(1);
	await expect(thread.getByRole("article", { name: "极昼" })).toHaveCount(branchAssistantCount + 1);
	expect((await open(source.conversationId)).selectedModel).toEqual({
		providerId: configuredProviderId,
		modelId,
	});
	expect((await open(parallel.conversationId)).selectedModel).toEqual({
		providerId: configuredProviderId,
		modelId: secondaryModelId,
	});
});

test("configured live model answers a natural story with scene expression media and choices", async ({
	page,
}) => {
	test.skip(
		!enabled || !providerId || !modelId || !credentialsAvailable,
		"Set the live-model variables for the natural story journey",
	);
	test.setTimeout(600_000);

	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};

	let selectedApiKey = apiKey;
	if (usePiConfig) {
		const selected = selectedPiProviderConfig();
		selectedApiKey = selected.apiKey;
		await rpc("provider.importPiConfig", { configJson: selected.configJson });
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	await setSelectedApiKey(rpc, selectedApiKey);
	await rpc("model.enable", {
		providerId: configuredProviderId,
		modelId,
		label: `E2E live ${modelId}`,
	});
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	await completeLiveOnboarding(rpc, "natural-story");

	const conversation = await rpc<{ conversationId: string }>("conversation.create", {
		title: "自然剧情真实模型验收",
	});
	await rpc("model.route.set", {
		conversationId: conversation.conversationId,
		selected: { providerId: configuredProviderId, modelId },
	});
	type StoryOpen = {
		branch: { entries: unknown[] };
		live: { isStreaming: boolean };
	};
	type StoryState = {
		state: {
			character: { document: { story: { active: boolean; chapter: number } } };
			display: { sceneId: string; expressionId: string };
		};
	};
	const open = () =>
		rpc<StoryOpen>("conversation.open", { conversationId: conversation.conversationId });
	const state = () =>
		rpc<StoryState>("companionState.get", { conversationId: conversation.conversationId });
	const send = async (text: string) => {
		const startIndex = (await open()).branch.entries.length;
		await rpc("message.send", {
			conversationId: conversation.conversationId,
			text,
			clientMessageId: crypto.randomUUID(),
		});
		return startIndex;
	};
	const waitForTool = async (startIndex: number, toolName: string, payloadMarker: string) => {
		await expect
			.poll(
				async () => {
					const snapshot = await open();
					const turnEntries = snapshot.branch.entries.slice(startIndex);
					const entries = JSON.stringify(turnEntries);
					const hasExpectedTool =
						entries.includes(`"toolName":"${toolName}"`) && entries.includes(payloadMarker);
					if (hasExpectedTool) return true;
					const lastEntry = JSON.stringify(turnEntries.at(-1));
					if (!snapshot.live.isStreaming && lastEntry.includes('"stopReason":"error"')) {
						throw new Error(`Live model settled with an error before ${toolName}: ${lastEntry}`);
					}
					return false;
				},
				{
					timeout: liveReplyTimeout,
				},
			)
			.toBe(true);
		await expect
			.poll(async () => (await open()).live.isStreaming, { timeout: liveReplyTimeout })
			.toBe(false);
	};

	const firstTurnStart = await send("我想看看那条没归档的回报。别先给摘要，我想从原件开始查。");
	await waitForTool(firstTurnStart, "host_media", "damaged_signal");
	const firstChapterText = projectPiEntries((await open()).branch.entries)
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.map((entry) => entry.text ?? "")
		.join("\n");
	expect(firstChapterText).toContain("人找到了");
	expect(firstChapterText).toContain("不用再");
	expect(firstChapterText).not.toContain("06:40");
	expect(firstChapterText).not.toContain("风向");
	await expect.poll(async () => (await state()).state.character.document.story.active).toBe(true);
	await expect
		.poll(async () => {
			const chapter = (await state()).state.character.document.story.chapter;
			return chapter === 1 || chapter === 2;
		})
		.toBe(true);
	await expect.poll(async () => (await state()).state.display.sceneId).toBe("archive_gallery");
	await expect.poll(async () => (await state()).state.display.expressionId).toBe("reflective");

	await page.goto("/");
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await page
		.getByRole("navigation", { name: zhCN.sidebar.conversations })
		.locator(`[data-conversation-id="${conversation.conversationId}"]`)
		.click();
	await expect(page.getByRole("img", { name: "交接档案室" })).toBeVisible();
	await expect(page.getByRole("img", { name: "极昼在核对" })).toBeVisible();
	const damagedSignal = thread.getByRole("region", { name: "残缺报码" });
	await expect(damagedSignal).toBeVisible();
	await damagedSignal.getByRole("button", { name: zhCN.messages.openMedia }).click();
	const damagedSignalPreview = page.getByRole("dialog", { name: "残缺报码" });
	await expect(damagedSignalPreview).toBeVisible();
	await damagedSignalPreview.getByRole("button", { name: zhCN.messages.closeMedia }).click();

	const findRelayChoice = async () => {
		const jumpToLatest = page.getByRole("button", { name: zhCN.messages.returnToLatest });
		if (await jumpToLatest.isVisible()) await jumpToLatest.click();
		const entries = (await open()).branch.entries;
		for (let index = entries.length - 1; index >= firstTurnStart; index -= 1) {
			const entry = entries[index];
			if (!entry || typeof entry !== "object" || !("message" in entry)) continue;
			const message = entry.message;
			if (!message || typeof message !== "object") continue;
			if (!("role" in message) || message.role !== "toolResult") continue;
			if (!("toolName" in message) || message.toolName !== "host_choices") continue;
			if (!("details" in message) || !message.details || typeof message.details !== "object")
				continue;
			if (!("data" in message.details) || !message.details.data) continue;
			const data = message.details.data;
			if (typeof data !== "object" || !("items" in data) || !Array.isArray(data.items)) continue;
			const matching = data.items.filter((item): item is { label: string; message: string } =>
				Boolean(
					item &&
						typeof item === "object" &&
						"label" in item &&
						typeof item.label === "string" &&
						"message" in item &&
						typeof item.message === "string" &&
						item.message.includes("转发台"),
				),
			);
			const choice = matching.find((item) => !item.message.includes("两条")) ?? matching[0];
			if (!choice) continue;
			const candidate = thread.getByRole("button", { name: choice.label, exact: true });
			const count = await candidate.count();
			if (count > 1) throw new Error(`The live model rendered ${count} copies of ${choice.label}`);
			if (count === 1) return candidate;
		}
		return undefined;
	};
	let relayChoice = await findRelayChoice();
	if (!relayChoice) {
		const choiceTurnStart = await send("这两条路我一时拿不准。把现在能走的方向摆出来，我自己选。");
		await waitForTool(choiceTurnStart, "host_choices", "转发台");
	} else {
		await waitForTool(firstTurnStart, "host_choices", "转发台");
	}
	relayChoice = await findRelayChoice();
	if (!relayChoice) throw new Error("The live model did not offer the relay-register choice");
	const relayTurnStart = (await open()).branch.entries.length;
	await relayChoice.click();

	await waitForTool(relayTurnStart, "host_media", "storm_relay_map");
	const relayText = projectPiEntries((await open()).branch.entries)
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.map((entry) => entry.text ?? "")
		.join("\n");
	expect(relayText).toContain("K-4");
	expect(relayText).toContain("未获复述");
	await expect.poll(async () => (await state()).state.display.sceneId).toBe("relay_room");
	await expect.poll(async () => (await state()).state.display.expressionId).toBe("reflective");
	await expect(page.getByRole("img", { name: "转发台资料室" })).toBeVisible();
	await expect(page.getByRole("img", { name: "极昼在核对" })).toBeVisible();
	await expect
		.poll(() => thread.getByRole("region", { name: "转发台灯下", exact: true }).count())
		.toBeGreaterThan(0);
});

test("configured live model answers naturally with rendered structured content", async ({
	page,
}) => {
	test.skip(
		!enabled || !providerId || !modelId || !credentialsAvailable,
		"Set the live-model variables for the natural rich-content journey",
	);
	test.setTimeout(300_000);

	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};

	let selectedApiKey = apiKey;
	if (usePiConfig) {
		const selected = selectedPiProviderConfig();
		selectedApiKey = selected.apiKey;
		await rpc("provider.importPiConfig", { configJson: selected.configJson });
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	await setSelectedApiKey(rpc, selectedApiKey);
	await rpc("model.enable", {
		providerId: configuredProviderId,
		modelId,
		label: `E2E live ${modelId}`,
	});
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	await completeLiveOnboarding(rpc, "rich-content");
	const conversation = await rpc<{ conversationId: string }>("conversation.create", {
		title: "自然富内容真实模型验收",
	});
	await rpc("model.route.set", {
		conversationId: conversation.conversationId,
		selected: { providerId: configuredProviderId, modelId },
	});

	await page.reload();
	await page
		.getByRole("navigation", { name: zhCN.sidebar.conversations })
		.locator(`[data-conversation-id="${conversation.conversationId}"]`)
		.click();
	const prompt =
		"极昼，我在给客栈写一个夜间取暖费用小工具。电暖器功率 1.5kW，每晚 8 小时，电价 0.6 元/kWh，住 7 晚。算出总费用，把计算公式清楚地排版出来，再给一个最小的 TypeScript 计算函数；顺手把它和 0.9kW 热泵的每晚耗电并排摆清楚，让我决定用哪个。";
	const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
	await composer.fill(prompt);
	await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();

	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const response = thread
		.getByRole("article", { name: "极昼" })
		.filter({ has: page.getByRole("table") });
	await expect(response.getByRole("table")).toBeVisible({ timeout: liveReplyTimeout });
	await expect
		.poll(
			async () =>
				(
					await rpc<{ live: { isStreaming: boolean } }>("conversation.open", {
						conversationId: conversation.conversationId,
					})
				).live.isStreaming,
			{ timeout: liveReplyTimeout },
		)
		.toBe(false);
	await expect(response.getByRole("button", { name: zhCN.messages.copyCode })).toBeVisible();
	await expect.poll(() => response.getByRole("code").count()).toBeGreaterThan(0);
	if ((await response.getByRole("math").count()) === 0) {
		await composer.fill("这段公式在界面里还是普通文字，不方便读。请把计算公式重新清楚地排版给我。");
		await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
		await expect
			.poll(() => thread.getByRole("math").count(), { timeout: liveReplyTimeout })
			.toBeGreaterThan(0);
		await expect
			.poll(
				async () =>
					(
						await rpc<{ live: { isStreaming: boolean } }>("conversation.open", {
							conversationId: conversation.conversationId,
						})
					).live.isStreaming,
				{ timeout: liveReplyTimeout },
			)
			.toBe(false);
	}
	await expect.poll(() => thread.getByRole("math").count()).toBeGreaterThan(0);
	await expect
		.poll(
			() =>
				response
					.getByTestId("message-content")
					.evaluateAll((nodes) => nodes.every((node) => node.getAttribute("aria-busy") !== "true")),
			{ timeout: liveReplyTimeout },
		)
		.toBe(true);

	const opened = await rpc<{ branch: { entries: unknown[] }; live: { isStreaming: boolean } }>(
		"conversation.open",
		{ conversationId: conversation.conversationId },
	);
	const assistant = projectPiEntries(opened.branch.entries)
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.map((entry) => entry.text ?? "")
		.join("\n");
	expect(opened.live.isStreaming).toBe(false);
	expect(assistant).toContain("```");
	expect(assistant).toContain("$");
	expect(assistant).toContain("number");

	await page.reload();
	const reloadedResponse = thread
		.getByRole("article", { name: "极昼" })
		.filter({ has: page.getByRole("table") });
	await expect(reloadedResponse.getByRole("table")).toBeVisible();
	await expect(
		reloadedResponse.getByRole("button", { name: zhCN.messages.copyCode }),
	).toBeVisible();
	await expect.poll(() => reloadedResponse.getByRole("code").count()).toBeGreaterThan(0);
	await expect.poll(() => thread.getByRole("math").count()).toBeGreaterThan(0);
});

test("both configured release models survive ten natural mixed-content turns", async ({ page }) => {
	test.skip(
		!enabled || !providerId || !modelId || !secondaryModelId || !credentialsAvailable,
		"Set both release models for the natural mixed-content corpus",
	);
	test.setTimeout(1_800_000);
	const pageErrors: Error[] = [];
	page.on("pageerror", (error) => pageErrors.push(error));
	await page.goto("/");
	const bootstrap = await (await page.request.get("/bootstrap")).json();
	const headers = { "x-bear-web-dev-token": bootstrap.token };
	const rpc = async <T>(channel: string, data: unknown): Promise<T> => {
		const response = await page.request.post(`/rpc/${encodeURIComponent(channel)}`, {
			headers,
			data,
		});
		const envelope = await response.json();
		if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.reason ?? "failed"}`);
		return envelope.data as T;
	};
	let selectedApiKey = apiKey;
	if (usePiConfig) {
		const selected = selectedPiProviderConfig([modelId, secondaryModelId]);
		selectedApiKey = selected.apiKey;
		await rpc("provider.importPiConfig", { configJson: selected.configJson });
	} else if (!useCodexSession) {
		test.skip(!customBaseUrl, "The two-model corpus needs a custom provider base URL");
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }, { id: secondaryModelId }],
		});
	}
	await setSelectedApiKey(rpc, selectedApiKey);
	for (const currentModelId of [modelId, secondaryModelId]) {
		await rpc("model.enable", {
			providerId: configuredProviderId,
			modelId: currentModelId,
			label: `E2E live ${currentModelId}`,
		});
	}
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	await completeLiveOnboarding(rpc, "mixed-content-corpus");
	const prompts = [
		"今晚三间客房的壁炉分别烧了 4、6、5 捆木柴。帮我整理成一眼能比较的记录，再算出合计。",
		"一壶水从 18 摄氏度加热到 92 摄氏度，用日常语言说明温差怎么算，也把式子排清楚。",
		"我明早要去雪原巡路，帮我列一份简短行装清单，分成必带和可选。",
		"写一个很小的 TypeScript 函数，输入住店晚数和每晚价格，返回总价，并解释一个例子。",
		"把客栈今日交接分成已完成、待确认、风险三部分，每部分给两条简短记录。",
		"比较油灯和电灯：油灯每晚 3.2 元，电灯每晚 1.8 元，连续七晚各花多少，差多少？",
		"我总弄混摄氏和华氏。用一个例子讲清换算关系，再给我一段可以复用的小公式。",
		"给新来的夜班同伴写一份三步交接办法，顺便给出一个容易漏掉的反例。",
		"把一周七晚的入住数 4、6、5、7、8、6、3 整理清楚，指出最高和最低的那天。",
		"总结我们刚才这些计算和清单里最值得保留的三条做法，最后留一句自然的晚安。",
	];
	type Opened = { branch: { entries: unknown[] }; live: { isStreaming: boolean } };
	for (const currentModelId of [modelId, secondaryModelId]) {
		const conversation = await rpc<{ conversationId: string }>("conversation.create", {
			title: `自然富内容十轮 ${currentModelId}`,
		});
		await rpc("model.route.set", {
			conversationId: conversation.conversationId,
			selected: { providerId: configuredProviderId, modelId: currentModelId },
		});
		await page.reload();
		await page
			.getByRole("navigation", { name: zhCN.sidebar.conversations })
			.locator(`[data-conversation-id="${conversation.conversationId}"]`)
			.click();
		await activeConversationId(page, conversation.conversationId);
		const composer = page.getByRole("textbox", { name: zhCN.composer.messageInputLabel });
		for (const prompt of prompts) {
			const beforeSnapshot = await rpc<Opened>("conversation.open", {
				conversationId: conversation.conversationId,
			});
			const before = projectPiEntries(beforeSnapshot.branch.entries).filter(
				(entry) => entry.type === "message" && entry.role === "assistant",
			).length;
			await composer.fill(prompt);
			await page.getByRole("button", { name: zhCN.composer.sendLabel, exact: true }).click();
			await expect
				.poll(
					async () => {
						const opened = await rpc<Opened>("conversation.open", {
							conversationId: conversation.conversationId,
						});
						if (opened.live.isStreaming) return before;
						const failed = opened.branch.entries.findLast(
							(entry) =>
								entry !== null &&
								typeof entry === "object" &&
								"message" in entry &&
								entry.message !== null &&
								typeof entry.message === "object" &&
								"stopReason" in entry.message &&
								entry.message.stopReason === "error",
						);
						if (failed) throw new Error(`Live corpus model error: ${JSON.stringify(failed)}`);
						return projectPiEntries(opened.branch.entries).filter(
							(entry) => entry.type === "message" && entry.role === "assistant",
						).length;
					},
					{ timeout: liveReplyTimeout },
				)
				.toBeGreaterThan(before);
			expect(pageErrors).toEqual([]);
			const settled = await rpc<Opened>("conversation.open", {
				conversationId: conversation.conversationId,
			});
			const latestAssistant = projectPiEntries(settled.branch.entries).findLast(
				(entry) => entry.type === "message" && entry.role === "assistant",
			);
			if (!latestAssistant) throw new Error("The live model turn has no authoritative reply");
			if (!latestAssistant.text?.trim())
				throw new Error("The live model turn has an empty authoritative reply");
			await expect(
				page
					.getByRole("region", { name: zhCN.messages.conversation })
					.locator(`[data-pi-entry-id="${latestAssistant.id}"]`),
			).toBeVisible();
		}
	}
	expect(pageErrors).toEqual([]);
});
