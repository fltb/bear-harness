import { zhCN } from "@bear-harness/i18n/locales";
import type { CharacterDisplay, PiSessionEntry } from "@bear-harness/protocol";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/App.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

const toolEntry = (
	id: string,
	toolName: string,
	details: Record<string, unknown> = { ok: true, data: {} },
): PiSessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: {
		role: "toolResult",
		toolCallId: `call-${id}`,
		toolName,
		content: [],
		details,
		isError: false,
		timestamp: 1,
	},
});

function configure(
	client: ReturnType<typeof createTestClient>["client"],
	entries: PiSessionEntry[],
	character: CharacterDisplay = THEMED_CHARACTER,
) {
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				onboarding: { status: "complete" as const, stateData: { answers: {}, decisions: {} } },
				character,
			},
		}),
	);
	client.conversation.list = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversations: [
					{
						conversationId: "conversation-1",
						name: "Native Pi tools",
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-01T00:00:01.000Z",
						messageCount: entries.length,
						firstMessage: "",
						isStreaming: false,
					},
				],
			},
		}),
	);
	client.conversation.open = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				conversationId: "conversation-1",
				name: "Native Pi tools",
				branch: { entries, hasMoreBefore: false },
				live: { isStreaming: false, steering: [], followUp: [] },
			},
		}),
	);
}

describe("Pi native tool rendering", () => {
	it("renders choices and media directly from native tool-result entries", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const media = {
			id: "signal",
			kind: "image" as const,
			label: "损坏的信号",
			description: "一张有噪点的信号图。",
			use_when: "查看信号记录时",
			loop: false,
			url: "data:image/png;base64,aW1hZ2U=",
		};
		configure(
			client,
			[
				toolEntry("choices", "host_choices", {
					ok: true,
					data: {
						prompt: "接下来呢？",
						items: [
							{ label: "Investigate", message: "Continue investigating." },
							{ label: "暂停", message: "先暂停。" },
						],
					},
				}),
				toolEntry("media", "host_media", { ok: true, data: { mediaId: media.id } }),
			],
			{ ...THEMED_CHARACTER, media: [media] },
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await user.click(await screen.findByRole("button", { name: "Investigate" }));
		expect(client.message.send).toHaveBeenCalledWith(expect.objectContaining({
			conversationId: "conversation-1",
			text: "Continue investigating.",
		}));
		await user.click(screen.getByRole("button", { name: zhCN.messages.openMedia }));
		expect(screen.getByRole("complementary", { name: "损坏的信号" })).toBeVisible();
	});

	it("maps memory authorities from the native Pi tool name", async () => {
		const { client } = createTestClient();
		const tools = [
			["host_canon", zhCN.messages.toolActivity.canon],
			["tdai_memory_search", zhCN.messages.toolActivity.memorySearch],
			["tdai_conversation_search", zhCN.messages.toolActivity.conversationSearch],
			["explicit_memory", zhCN.messages.toolActivity.explicitMemory],
		] as const;
		configure(
			client,
			tools.map(([name], index) => toolEntry(`tool-${index}`, name)),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		for (const [, label] of tools) {
			expect(
				await screen.findByRole("article", { name: `${label} succeeded` }),
			).toBeInTheDocument();
		}
	});
});
