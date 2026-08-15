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

function activeConversationSnapshot() {
	return {
		eventSeq: 0,
		onboarding: COMPLETE_ONBOARDING,
		conversation: {
			activeConversationId: "conversation-1",
			conversations: [
				{
					id: "conversation-1",
					title: "测试对话",
					sceneTitle: "测试场景",
					unread: false,
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			messages: [
				{
					id: "assistant-1",
					role: "assistant",
					adoptedVersionId: "version-2",
					createdAt: "2026-01-01T00:00:00.000Z",
					versions: [
						{
							id: "version-1",
							role: "assistant",
							content: "旧回答",
							editedByUser: false,
							createdAt: "2026-01-01T00:00:00.000Z",
							adopted: false,
						},
						{
							id: "version-2",
							role: "assistant",
							content: "当前回答",
							editedByUser: false,
							createdAt: "2026-01-01T00:00:01.000Z",
							adopted: true,
						},
					],
				},
			],
		},
	};
}

describe("conversation message controls", () => {
	it("routes version, regenerate, edit, continue and branch controls through the active conversation", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const switchVersion = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const regenerate = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const edit = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const continueMessage = vi.fn(() => Promise.resolve({ ok: true as const, data: null }));
		const branch = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: { branchId: "branch-2" } }),
		);
		client.message.switchVersion = switchVersion;
		client.message.regenerate = regenerate;
		client.message.edit = edit;
		client.message.continue = continueMessage;
		client.message.branch = branch;
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: activeConversationSnapshot() }),
		);
		client.onboarding.get = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: COMPLETE_ONBOARDING }),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await screen.findByText("当前回答");
		await user.click(screen.getByRole("button", { name: "上一个版本" }));
		await user.click(screen.getByRole("button", { name: "重新生成" }));
		await user.click(screen.getByRole("button", { name: "编辑" }));
		const editor = screen.getByRole("textbox", { name: "编辑消息" });
		await user.clear(editor);
		await user.type(editor, "修订后的回答");
		await user.click(screen.getByRole("button", { name: "保存" }));
		await user.click(screen.getByRole("button", { name: "继续" }));
		await user.click(screen.getByRole("button", { name: "从这里另开一段" }));

		await waitFor(() => {
			expect(switchVersion).toHaveBeenCalledWith("conversation-1", "assistant-1", "version-1");
			expect(regenerate).toHaveBeenCalledWith("conversation-1", "assistant-1");
			expect(edit).toHaveBeenCalledWith("conversation-1", "assistant-1", "修订后的回答", false);
			expect(continueMessage).toHaveBeenCalledWith("conversation-1");
			expect(branch).toHaveBeenCalledWith("conversation-1", "assistant-1");
		});
	});
});
