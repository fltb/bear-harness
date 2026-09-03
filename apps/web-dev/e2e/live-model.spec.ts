import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zhCN } from "@bear-harness/i18n/locales";
import { expect, test } from "playwright/test";
import { projectPiEntries } from "./helpers";

const enabled = process.env.BEAR_E2E_LIVE_MODEL === "1";
const providerId = process.env.BEAR_E2E_PROVIDER_ID ?? "";
const modelId = process.env.BEAR_E2E_MODEL_ID ?? "";
const secondaryModelId = process.env.BEAR_E2E_SECONDARY_MODEL_ID ?? "";
const apiKey = process.env.BEAR_E2E_API_KEY ?? "";
const customBaseUrl = process.env.BEAR_E2E_CUSTOM_BASE_URL ?? "";
const usePiConfig = process.env.BEAR_E2E_USE_PI_CONFIG === "1";
const credentialsAvailable = apiKey.length > 0 || usePiConfig;
const configuredProviderId = usePiConfig ? "e2e-live-openai" : providerId;
const liveReplyTimeout = 180_000;

function selectedPiProviderConfig(): {
	apiKey: string;
	baseUrl: string;
	model: { id: string; name?: string; supportsImages?: boolean };
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
	const sourceModel = (Array.isArray(metadata.models) ? metadata.models : []).find(
		(value) => value !== null && typeof value === "object" && "id" in value && value.id === modelId,
	) as Record<string, unknown> | undefined;
	if (!sourceModel) throw new Error(`Pi config provider ${providerId} has no model ${modelId}`);
	return {
		apiKey: configuredKey,
		baseUrl: metadata.baseUrl,
		model: {
			id: modelId,
			...(typeof sourceModel.name === "string" ? { name: sourceModel.name } : {}),
			...(Array.isArray(sourceModel.input) && sourceModel.input.includes("image")
				? { supportsImages: true }
				: {}),
		},
	};
}

function selectedPiModels(modelIds: string[]): Array<{
	id: string;
	name?: string;
	supportsImages?: boolean;
}> {
	const parsed = JSON.parse(
		readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"),
	) as { providers?: Record<string, unknown> };
	const provider = parsed.providers?.[providerId] as Record<string, unknown> | undefined;
	if (!provider) throw new Error(`Pi config has no provider ${providerId}`);
	const configuredModels = Array.isArray(provider.models) ? provider.models : [];
	return modelIds.map((requestedModelId) => {
		const sourceModel = configuredModels.find(
			(value) =>
				value !== null &&
				typeof value === "object" &&
				"id" in value &&
				value.id === requestedModelId,
		) as Record<string, unknown> | undefined;
		if (!sourceModel)
			throw new Error(`Pi config provider ${providerId} has no model ${requestedModelId}`);
		return {
			id: requestedModelId,
			...(typeof sourceModel.name === "string" ? { name: sourceModel.name } : {}),
			...(Array.isArray(sourceModel.input) && sourceModel.input.includes("image")
				? { supportsImages: true }
				: {}),
		};
	});
}

test("configured live model answers a WebDev smoke message", async ({ page }) => {
	test.skip(
		!enabled || !providerId || !modelId || !credentialsAvailable,
		"Set BEAR_E2E_LIVE_MODEL=1 and the provider/model/key variables in .env",
	);

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
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live Pi provider",
			baseUrl: selected.baseUrl,
			models: [selected.model],
		});
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId,
			name: "E2E custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	if (selectedApiKey)
		await rpc("provider.setApiKey", {
			providerId: configuredProviderId,
			apiKey: selectedApiKey,
			sessionOnly: true,
		});
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
				return projectPiEntries(opened.branch.entries)
					.filter((entry) => entry.type === "message" && entry.role === "assistant")
					.map((entry) => entry.text ?? "")
					.join("\n");
			},
			{ timeout: 60_000 },
		)
		.toContain("E2E_OK");
});

test("configured live model answers in character and obeys the explicit-memory boundary", async ({
	page,
}) => {
	test.skip(
		!enabled || !providerId || !modelId || !credentialsAvailable,
		"Set BEAR_E2E_LIVE_MODEL=1 and the provider/model/key variables in .env",
	);
	test.setTimeout(120_000);

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
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live Pi provider",
			baseUrl: selected.baseUrl,
			models: [selected.model],
		});
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId,
			name: "E2E custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	if (selectedApiKey)
		await rpc("provider.setApiKey", {
			providerId: configuredProviderId,
			apiKey: selectedApiKey,
			sessionOnly: true,
		});
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
	await expect.poll(async () => (await assistants()).length, { timeout: 60_000 }).toBe(1);
	await expect.poll(async () => (await open()).live.isStreaming).toBe(false);
	expect(JSON.stringify((await open()).branch.entries)).not.toContain(
		'"toolName":"explicit_memory"',
	);

	await send("请明确记住：我长期希望你称呼我为北辰。记住后简短确认。");
	await expect
		.poll(async () => JSON.stringify((await open()).branch.entries), { timeout: 60_000 })
		.toContain('"toolName":"explicit_memory"');
	await expect.poll(async () => (await open()).live.isStreaming, { timeout: 60_000 }).toBe(false);

	await send("请用两句话直接回答：你是谁，你现在最重视什么？");
	await expect.poll(async () => (await assistants()).at(-1), { timeout: 60_000 }).toContain("极昼");
	await expect.poll(async () => (await open()).live.isStreaming).toBe(false);
});

test("configured live model answers through the native conversation journey", async ({ page }) => {
	test.skip(
		!enabled || !providerId || !modelId || !secondaryModelId || !credentialsAvailable,
		"Set the live-model variables, including BEAR_E2E_SECONDARY_MODEL_ID",
	);
	test.setTimeout(900_000);

	let copiedText = "";
	await page.exposeFunction("recordLiveModelCopy", (value: string) => {
		copiedText = value;
	});
	await page.addInitScript(() => {
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
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live Pi provider",
			baseUrl: selected.baseUrl,
			models: selectedPiModels([modelId, secondaryModelId]),
		});
	} else {
		test.skip(!customBaseUrl, "The complete journey needs a custom provider base URL");
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }, { id: secondaryModelId }],
		});
	}
	await rpc("provider.setApiKey", {
		providerId: configuredProviderId,
		apiKey: selectedApiKey,
		sessionOnly: true,
	});
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
	await rpc("model.systemDefaults.set", {
		reply: { providerId: configuredProviderId, modelId },
		vision: { mode: "auto" },
	});
	await rpc("model.defaults.completeOnboarding", {});
	await rpc("settings.set", { settings: { firstRunStage: "role" } });
	let onboarding = await rpc<{ status: string; currentStepId?: string }>("onboarding.get", {});
	const onboardingAnswers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "北辰",
	};
	while (onboarding.status === "active") {
		const stepId = onboarding.currentStepId;
		if (!stepId || !(stepId in onboardingAnswers)) {
			throw new Error(`Unhandled live-model onboarding step: ${stepId ?? "missing"}`);
		}
		onboarding = await rpc("onboarding.submit", {
			stepId,
			answer: onboardingAnswers[stepId],
		});
	}

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
			.poll(async () => (await assistantTexts(conversationId)).join("\n"), {
				timeout: liveReplyTimeout,
			})
			.toContain(marker);
		await expect
			.poll(async () => (await open(conversationId)).live.isStreaming, {
				timeout: liveReplyTimeout,
			})
			.toBe(false);
	};
	const sendRpc = (conversationId: string, text: string) =>
		rpc("message.send", { conversationId, text, clientMessageId: crypto.randomUUID() });

	await sendRpc(source.conversationId, "只回复 LIVE_SOURCE，不要添加其他文字。");
	await waitSettled(source.conversationId, "LIVE_SOURCE");
	await sendRpc(parallel.conversationId, "只回复 LIVE_PARALLEL，不要添加其他文字。");
	await waitSettled(parallel.conversationId, "LIVE_PARALLEL");
	expect((await open(source.conversationId)).selectedModel).toEqual({
		providerId: configuredProviderId,
		modelId,
	});
	expect((await open(parallel.conversationId)).selectedModel).toEqual({
		providerId: configuredProviderId,
		modelId: secondaryModelId,
	});

	await page.goto("/");
	const sidebar = page.getByRole("navigation", { name: zhCN.sidebar.conversations });
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	const sourceButton = page.locator(`[data-conversation-id="${source.conversationId}"]`);
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
	const leafBeforeRegenerate = (await open(source.conversationId)).branch.activeLeafId;
	await editedAssistant.getByRole("button", { name: zhCN.messages.regenerate }).click();
	await expect(sourceButton.getByRole("status", { name: zhCN.messages.responding })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: zhCN.composer.stopLabel })).toBeVisible();
	await expect
		.poll(async () => (await open(source.conversationId)).branch.activeLeafId, {
			timeout: liveReplyTimeout,
		})
		.not.toBe(leafBeforeRegenerate);
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

	await thread.getByRole("button", { name: zhCN.messages.branch }).click();
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
	await sendRpc(branchConversationId, "只回复 LIVE_BRANCH，不要添加其他文字。");
	await waitSettled(branchConversationId, "LIVE_BRANCH");
	await expect(thread.getByText("LIVE_BRANCH", { exact: true })).toHaveCount(1);
	await expect(sourceButton).toBeVisible();

	await page.reload();
	await expect(thread.getByText("LIVE_BRANCH", { exact: true })).toHaveCount(1);
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
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live Pi provider",
			baseUrl: selected.baseUrl,
			models: [selected.model],
		});
	} else if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId: configuredProviderId,
			name: "E2E live custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	await rpc("provider.setApiKey", {
		providerId: configuredProviderId,
		apiKey: selectedApiKey,
		sessionOnly: true,
	});
	await rpc("model.enable", {
		providerId: configuredProviderId,
		modelId,
		label: `E2E live ${modelId}`,
	});
	await rpc("model.defaults.setReply", {
		reply: { providerId: configuredProviderId, modelId },
	});
	await rpc("model.systemDefaults.set", {
		reply: { providerId: configuredProviderId, modelId },
		vision: { mode: "auto" },
	});
	await rpc("model.defaults.completeOnboarding", {});
	await rpc("settings.set", { settings: { firstRunStage: "role" } });
	let onboarding = await rpc<{ status: string; currentStepId?: string }>("onboarding.get", {});
	const onboardingAnswers: Record<string, string | undefined> = {
		welcome: undefined,
		nickname: "北辰",
	};
	while (onboarding.status === "active") {
		const stepId = onboarding.currentStepId;
		if (!stepId || !(stepId in onboardingAnswers)) {
			throw new Error(`Unhandled natural-story onboarding step: ${stepId ?? "missing"}`);
		}
		onboarding = await rpc("onboarding.submit", {
			stepId,
			answer: onboardingAnswers[stepId],
		});
	}

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
	await waitForTool(firstTurnStart, "host_choices", "转发台");
	const firstChapterText = projectPiEntries((await open()).branch.entries)
		.filter((entry) => entry.type === "message" && entry.role === "assistant")
		.map((entry) => entry.text ?? "")
		.join("\n");
	expect(firstChapterText).toContain("人找到了");
	expect(firstChapterText).toContain("不用再");
	expect(firstChapterText).not.toContain("06:40");
	expect(firstChapterText).not.toContain("风向");
	await expect.poll(async () => (await state()).state.character.document.story.active).toBe(true);
	await expect.poll(async () => (await state()).state.character.document.story.chapter).toBe(1);
	await expect.poll(async () => (await state()).state.display.sceneId).toBe("archive_gallery");
	await expect.poll(async () => (await state()).state.display.expressionId).toBe("reflective");

	await page.goto("/");
	const thread = page.getByRole("region", { name: zhCN.messages.conversation });
	await page.locator(`[data-conversation-id="${conversation.conversationId}"]`).click();
	await expect(page.getByRole("img", { name: "交接档案室" })).toBeVisible();
	await expect(page.getByRole("img", { name: "极昼在核对" })).toBeVisible();
	const damagedSignal = thread.getByRole("region", { name: "残缺报码" });
	await expect(damagedSignal).toBeVisible();
	await damagedSignal.getByRole("button", { name: zhCN.messages.openMedia }).click();
	await expect(page.getByRole("complementary", { name: "残缺报码" })).toBeVisible();
	await page.getByRole("button", { name: zhCN.messages.closeMedia }).last().click();

	const relayChoice = thread.getByRole("button", {
		name: /^(?:A：)?(?:查|查看)转发台登记页$/,
	});
	await expect(relayChoice).toHaveCount(1);
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
	await expect(thread.getByRole("region", { name: "转发台登记", exact: true })).toBeVisible();
});
