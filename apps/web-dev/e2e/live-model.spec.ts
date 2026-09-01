import { expect, test } from "playwright/test";
import { projectPiEntries } from "./helpers";

const enabled = process.env.BEAR_E2E_LIVE_MODEL === "1";
const providerId = process.env.BEAR_E2E_PROVIDER_ID ?? "";
const modelId = process.env.BEAR_E2E_MODEL_ID ?? "";
const apiKey = process.env.BEAR_E2E_API_KEY ?? "";
const customBaseUrl = process.env.BEAR_E2E_CUSTOM_BASE_URL ?? "";

test("configured live model answers a WebDev smoke message", async ({ page }) => {
	test.skip(
		!enabled || !providerId || !modelId || !apiKey,
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

	if (customBaseUrl) {
		await rpc("provider.customUpsert", {
			providerId,
			name: "E2E custom provider",
			baseUrl: customBaseUrl,
			models: [{ id: modelId }],
		});
	}
	await rpc("provider.setApiKey", { providerId, apiKey, sessionOnly: true });
	await rpc("model.enable", {
		providerId,
		modelId,
		label: "E2E live model",
	});
	const conversation = await rpc<{ conversationId: string }>("conversation.create", {});
	await rpc("model.route.set", {
		conversationId: conversation.conversationId,
		selected: { providerId, modelId },
	});
	await rpc("message.send", {
		conversationId: conversation.conversationId,
		text: "只回复 E2E_OK，不要添加其他内容。",
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
