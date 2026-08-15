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

describe("composer", () => {
	it("submits trimmed text to the active conversation and clears only after dispatch", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const messageSend = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { messageId: "m1" } }),
		);
		client.message.send = messageSend;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: { activeConversationId: "conversation-1" },
				},
			}),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const composer = await screen.findByRole("textbox", { name: "发送消息" });
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "  测试消息  ");
		await user.click(screen.getByRole("button", { name: "发送" }));

		await waitFor(() => expect(messageSend).toHaveBeenCalledWith("conversation-1", "测试消息"));
		expect(composer).toHaveValue("");
	});

	it("keeps Shift+Enter as a newline instead of dispatching", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const messageSend = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { messageId: "m1" } }),
		);
		client.message.send = messageSend;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					onboarding: COMPLETE_ONBOARDING,
					conversation: { activeConversationId: "conversation-1" },
				},
			}),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		const composer = await screen.findByRole("textbox", { name: "发送消息" });
		await waitFor(() => expect(composer).toBeEnabled());
		await user.type(composer, "第一行");
		await user.keyboard("{Shift>}{Enter}{/Shift}第二行");

		expect(messageSend).not.toHaveBeenCalled();
		expect(composer).toHaveValue("第一行\n第二行");
	});
});
