import { zhCN } from "@bear-harness/i18n/locales";
import type { ConversationDetail } from "@bear-harness/protocol";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/App.js";
import { createCompanionStore } from "../src/stores/companion.js";
import { createTestClient, OFFICIAL_PRODUCT, THEMED_CHARACTER } from "./fixtures.js";

describe("Pi tool activity labels", () => {
	it("renders transient choices in the timeline and opens media in the shared preview column", async () => {
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
		const entries = [
			{
				id: "choices",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				kind: "message" as const,
				role: "tool" as const,
				toolName: "host_choices",
				toolCallId: "choice-call",
				status: "succeeded" as const,
				choices: {
					prompt: "接下来呢？",
					items: [
						{ label: "Investigate", message: "Continue investigating." },
						{ label: "暂停", message: "先暂停。" },
					],
				},
			},
			{
				id: "media",
				parentId: "choices",
				timestamp: "2026-01-01T00:00:01.000Z",
				kind: "message" as const,
				role: "tool" as const,
				toolName: "host_media",
				toolCallId: "media-call",
				status: "succeeded" as const,
				mediaId: media.id,
			},
		];
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					character: { ...THEMED_CHARACTER, media: [media] },
					model: {
						pool: { models: [] },
						defaults: { vision: { mode: "auto" as const }, onboardingComplete: true },
					},
				} as never,
			}),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessions: [
						{
							id: "conversation-1",
							title: "Presentation",
							created: "2026-01-01T00:00:00.000Z",
							modified: "2026-01-01T00:00:01.000Z",
							messageCount: entries.length,
							firstMessage: "",
						},
					],
				},
			}),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessionId: "conversation-1",
					name: "Presentation",
					timeline: { entries },
					live: { isStreaming: false, queuedUserMessages: [] },
				} as never,
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		await user.click(await screen.findByRole("button", { name: "Investigate" }));
		expect(client.message.send).toHaveBeenCalledWith({
			conversationId: "conversation-1",
			text: "Continue investigating.",
		});
		await user.click(screen.getByRole("button", { name: zhCN.messages.openMedia }));
		expect(screen.getByRole("complementary", { name: "损坏的信号" })).toBeVisible();
		expect(screen.getByAltText("损坏的信号")).toBeVisible();
	});

	it("mounts a Run result at its Pi-native tool-call entry even when that assistant entry has no text", async () => {
		const { client } = createTestClient();
		const entries = [
			{
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				kind: "message" as const,
				role: "user" as const,
				text: "prepare a report",
			},
			{
				id: "delegate-entry",
				parentId: "user-1",
				timestamp: "2026-01-01T00:00:01.000Z",
				kind: "message" as const,
				role: "assistant" as const,
				text: "",
				stopReason: "toolUse" as const,
			},
		];
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					character: THEMED_CHARACTER,
					model: {
						pool: { models: [] },
						defaults: { vision: { mode: "auto" as const }, onboardingComplete: true },
					},
				} as never,
			}),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessions: [
						{
							id: "conversation-1",
							title: "Run result",
							created: "2026-01-01T00:00:00.000Z",
							modified: "2026-01-01T00:00:01.000Z",
							messageCount: entries.length,
							firstMessage: "prepare a report",
						},
					],
				},
			}),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessionId: "conversation-1",
					name: "Run result",
					timeline: { entries },
					live: { isStreaming: false, queuedUserMessages: [] },
				} as never,
			}),
		);
		client.run.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					runs: [
						{
							id: "run-1",
							conversationId: "conversation-1",
							triggerEntryId: "delegate-entry",
							executorProfile: "pi-default",
							title: "Report",
							status: "completed" as const,
							artifacts: [
								{
									id: "artifact-1",
									name: "report.txt",
									mime: "text/plain",
									bytes: 12,
									sha256: "a".repeat(64),
									status: "verified" as const,
									createdAt: "2026-01-01T00:00:01.000Z",
								},
							],
							evidence: [],
						},
					],
				},
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		expect(
			await screen.findByRole("button", {
				name: `${zhCN.work.timeline.viewArtifacts}: report.txt`,
			}),
		).toBeVisible();
	});

	it("maps each memory authority directly from the native Pi tool name", async () => {
		const { client } = createTestClient();
		const tools = [
			["host_canon", zhCN.messages.toolActivity.canon],
			["tdai_memory_search", zhCN.messages.toolActivity.memorySearch],
			["tdai_conversation_search", zhCN.messages.toolActivity.conversationSearch],
			["explicit_memory", zhCN.messages.toolActivity.explicitMemory],
		] as const;
		const entries = tools.flatMap(([toolName], index) => [
			{
				id: `user-${index}`,
				parentId: index === 0 ? null : `tool-${index - 1}`,
				timestamp: `2026-01-01T00:00:${String(index * 2).padStart(2, "0")}.000Z`,
				kind: "message" as const,
				role: "user" as const,
				text: `step ${index}`,
			},
			{
				id: `tool-${index}`,
				parentId: `user-${index}`,
				timestamp: `2026-01-01T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
				kind: "message" as const,
				role: "tool" as const,
				toolName,
				toolCallId: `call-${index}`,
				status: "succeeded" as const,
			},
		]);
		const session = {
			sessionId: "conversation-1",
			name: "Tool labels",
			timeline: { entries },
			live: { isStreaming: false, queuedUserMessages: [] },
		};
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					character: THEMED_CHARACTER,
					model: {
						pool: { models: [] },
						defaults: { vision: { mode: "auto" as const }, onboardingComplete: true },
					},
				} as never,
			}),
		);
		client.conversation.open = vi.fn(() =>
			Promise.resolve({ ok: true as const, data: session as never }),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessions: [
						{
							id: "conversation-1",
							title: "Tool labels",
							created: "2026-01-01T00:00:00.000Z",
							modified: "2026-01-01T00:00:10.000Z",
							messageCount: entries.length,
							firstMessage: "step 0",
						},
					],
				},
			}),
		);

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);

		for (const [, label] of tools) {
			expect(await screen.findByRole("article", { name: `${label} succeeded` })).toBeVisible();
		}
		expect(screen.queryByText("继任规程")).not.toBeInTheDocument();
	});

	it("projects transient Pi events by session and falls back to a fresh snapshot on disconnect", async () => {
		const { client } = createTestClient();
		const disconnected = Promise.withResolvers<void>();
		let session: ConversationDetail = {
			sessionId: "conversation-1",
			name: "Streaming",
			timeline: { entries: [] },
			live: { isStreaming: false, queuedUserMessages: [] },
		};
		client.snapshot.get = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					eventSeq: 0,
					character: THEMED_CHARACTER,
					model: {
						pool: { models: [] },
						defaults: { vision: { mode: "auto" as const }, onboardingComplete: true },
					},
				} as never,
			}),
		);
		client.conversation.list = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				data: {
					sessions: [
						{
							id: session.sessionId,
							title: session.name,
							created: "2026-01-01T00:00:00.000Z",
							modified: "2026-01-01T00:00:00.000Z",
							messageCount: 0,
							firstMessage: "",
						},
					],
				},
			}),
		);
		client.conversation.open = vi.fn(() => Promise.resolve({ ok: true as const, data: session }));
		let subscriptions = 0;
		client.pi.stream = async function* (signal) {
			if (++subscriptions > 1) {
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return;
			}
			yield {
				sessionId: "conversation-2",
				type: "message_update" as const,
				live: {
					isStreaming: true,
					streamingMessage: { text: "wrong session", stopReason: "pending" as const },
					queuedUserMessages: [],
				},
			};
			yield {
				sessionId: "conversation-1",
				type: "message_update" as const,
				live: {
					isStreaming: true,
					streamingMessage: { text: "native Pi stream", stopReason: "pending" as const },
					queuedUserMessages: ["queued natively"],
				},
			};
			await disconnected.promise;
			throw new Error("transport disconnected");
		};

		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		const store = createCompanionStore(client);
		expect(await screen.findByText("native Pi stream")).toBeVisible();
		expect(screen.getByText("queued natively")).toBeVisible();
		expect(screen.queryByText("wrong session")).not.toBeInTheDocument();

		session = {
			...session,
			live: {
				isStreaming: true,
				streamingMessage: { text: "snapshot replacement", stopReason: "pending" },
				queuedUserMessages: [],
			},
		};
		disconnected.resolve();
		await waitFor(() =>
			expect(store.activePiLiveState?.streamingMessage?.text).toBe("snapshot replacement"),
		);
		expect(await screen.findByText("snapshot replacement")).toBeVisible();
		await waitFor(() => expect(screen.queryByText("native Pi stream")).not.toBeInTheDocument());
		await waitFor(() => expect(subscriptions).toBe(2));
	});
});
