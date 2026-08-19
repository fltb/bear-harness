import { zhCN } from "@bear-harness/i18n/locales";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/index.js";
import { createTestClient, OFFICIAL_PRODUCT } from "./fixtures.js";

const COMPLETE_ONBOARDING = {
	status: "complete" as const,
	eventSeq: 0,
	stateData: { schema_version: 1 as const, flow_version: 1, answers: {}, decisions: {} },
};

const TEST_MODEL = {
	providerId: "relay",
	providerName: "Relay Service",
	modelId: "fast",
	label: "Fast",
	supportsImages: true,
	createdAt: "2026-01-01",
};

function activeComposerClient() {
	const { client } = createTestClient();
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				eventSeq: 0,
				onboarding: COMPLETE_ONBOARDING,
				conversation: { activeConversationId: "conversation-1" },
				model: {
					pool: { models: [TEST_MODEL] },
					defaults: {
						reply: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
						vision: { mode: "auto" as const },
					},
				},
			},
		}),
	);
	client.model.poolGet = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: { models: [TEST_MODEL] } }),
	);
	client.model.routeGet = vi.fn(({ conversationId }) =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversationId,
				selected: { providerId: TEST_MODEL.providerId, modelId: TEST_MODEL.modelId },
			},
		}),
	);
	client.onboarding.get = vi.fn(() =>
		Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
	);
	return client;
}

describe("composer abort control", () => {
	it("shows a Stop button while sending and aborts the in-flight message", async () => {
		const user = userEvent.setup();
		const client = activeComposerClient();
		// The send never settles: the optimistic pending state keeps the Stop
		// slot visible for the whole turn.
		client.message.send = vi.fn(() => new Promise<never>(() => {}));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const input = await screen.findByRole("textbox", { name: zhCN.composer.messageInputLabel });
		await waitFor(() => expect(input).toBeEnabled());
		await user.type(input, "给我讲个故事");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		const stop = await screen.findByRole("button", { name: zhCN.composer.stopLabel });
		await user.click(stop);
		await waitFor(() =>
			expect(client.message.abort).toHaveBeenCalledWith({ conversationId: "conversation-1" }),
		);
	});

	it("keeps the Stop button while a streamed draft is visible", async () => {
		const user = userEvent.setup();
		const client = activeComposerClient();
		client.message.send = vi.fn(() => new Promise<never>(() => {}));
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const input = await screen.findByRole("textbox", { name: zhCN.composer.messageInputLabel });
		await waitFor(() => expect(input).toBeEnabled());
		await user.type(input, "继续说");
		await user.click(screen.getByRole("button", { name: zhCN.composer.sendLabel }));

		expect(await screen.findByRole("button", { name: zhCN.composer.stopLabel })).toBeVisible();
		expect(screen.queryByRole("button", { name: zhCN.composer.sendLabel })).not.toBeInTheDocument();
	});
});
