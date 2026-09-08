import { zhCN } from "@bear-harness/i18n/locales";
import type {
	CharacterDisplay,
	ConversationDetail,
	PiAgentMessage,
	PiLiveSnapshot,
	PiSessionEntry,
} from "@bear-harness/protocol";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompanionApp } from "../src/App.js";
import { createTestClient, OFFICIAL_PRODUCT, pushPiEvent, THEMED_CHARACTER } from "./fixtures.js";

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

function assistantEntry(
	id: string,
	content: Extract<PiAgentMessage, { role: "assistant" }>["content"],
	fields: Partial<Extract<PiAgentMessage, { role: "assistant" }>> = {},
): PiSessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "openai-completions",
			provider: "test",
			model: "test",
			content,
			timestamp: 1,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			...fields,
		},
	};
}

function configure(
	client: ReturnType<typeof createTestClient>["client"],
	entries: PiSessionEntry[],
	character: CharacterDisplay = THEMED_CHARACTER,
	live: Partial<PiLiveSnapshot> = {},
) {
	client.snapshot.get = vi.fn(() =>
		Promise.resolve({
			ok: true as const,
			data: {
				onboarding: { status: "complete" as const, stateData: { answers: {} } },
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
	const detail: ConversationDetail = {
		conversationId: "conversation-1",
		name: "Native Pi tools",
		branch: {
			entries,
			activeLeafId: entries.at(-1)?.id,
			latestLeafIds: entries.slice(-1).map((entry) => entry.id),
			hasMoreBefore: false,
		},
		live: {
			isStreaming: false,
			isCompacting: false,
			isRetrying: false,
			retryAttempt: 0,
			pendingToolCallIds: [],
			steering: [],
			followUp: [],
			...live,
		},
	};
	client.conversation.activeGet = vi.fn(async () => ({
		ok: true as const,
		data: { activeConversation: detail },
	}));
	client.conversation.select = vi.fn(() => client.conversation.activeGet({}));
	client.conversation.open = vi.fn(async () => ({ ok: true as const, data: detail }));
}

describe("Pi native tool rendering", () => {
	it("renders running, completed, and failed native tool events", async () => {
		const { client } = createTestClient();
		const user = userEvent.setup();
		configure(client, []);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await screen.findByRole("region", { name: zhCN.messages.conversation });

		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			event: {
				type: "tool_execution_start",
				toolCallId: "state-call",
				toolName: "host_state",
				args: { path: "/workspace/readme.txt", limit: 42 },
			},
		});
		expect(
			await screen.findByRole("article", {
				name: `host_state ${zhCN.messages.toolActivity.running}`,
			}),
		).toHaveAttribute("data-status", "running");
		const disclosure = screen.getByText("host_state").closest("details")!;
		expect(disclosure).not.toHaveAttribute("open");
		await user.click(screen.getByText("host_state"));
		expect(disclosure).toHaveAttribute("open");
		expect(within(disclosure).getByText(/"limit": 42/)).toBeVisible();

		const progressText = `Reading <script>privateMarkup()</script><button aria-label="Injected progress action">Run</button>\n${"visible progress ".repeat(80)}`;
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			event: {
				type: "tool_execution_update",
				toolCallId: "state-call",
				toolName: "host_state",
				args: { path: "/workspace/readme.txt", limit: 42 },
				partialResult: {
					content: [{ type: "text", text: progressText }],
					details: { lineCount: 42, thinkingSignature: "opaque-provider-signature" },
				},
			},
		});
		const progress = await screen.findByText(/Reading <script>/);
		expect(progress.textContent).toBe(progressText);
		expect(screen.queryByRole("button", { name: "Injected progress action" })).toBeNull();
		expect(within(disclosure).getByText(/"lineCount": 42/)).toBeVisible();
		expect(screen.queryByText(/opaque-provider-signature/)).toBeNull();

		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			event: {
				type: "tool_execution_end",
				toolCallId: "state-call",
				toolName: "host_state",
				result: { content: [] },
				isError: false,
			},
		});
		expect(
			await screen.findByRole("article", {
				name: `host_state ${zhCN.messages.toolActivity.completed}`,
			}),
		).toHaveAttribute("data-status", "completed");

		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			event: {
				type: "tool_execution_end",
				toolCallId: "failed-call",
				toolName: "host_media",
				result: {
					content: [{ type: "text", text: "Image unavailable: missing file" }],
					details: { ok: false, code: "media_missing", message: "Image unavailable: missing file" },
				},
				isError: true,
			},
		});
		expect(
			await screen.findByRole("article", {
				name: `host_media ${zhCN.messages.toolActivity.failed}`,
			}),
		).toHaveAttribute("data-status", "failed");
		await user.click(screen.getByText("host_media"));
		expect(screen.getByText("Image unavailable: missing file")).toBeVisible();
		expect(screen.getByText(/"code": "media_missing"/)).toBeVisible();
	});

	it("keeps an opened disclosure through streamed arguments, execution, and persisted query results", async () => {
		const { client } = createTestClient();
		const user = userEvent.setup();
		const instanceId = "native-disclosure-boundary";
		const partialArgs = { path: "/workspace/sour" };
		const fullArgs = { path: "/workspace/source.txt", offset: 12, limit: 42 };
		const partial = assistantEntry("streamed-call", [
			{ type: "text", text: "Reading the requested source." },
			{ type: "toolCall", id: "call-boundary-result", name: "read", arguments: partialArgs },
		]);
		const saved = assistantEntry(
			"persisted-assistant-call",
			[
				{ type: "text", text: "Reading the requested source." },
				{ type: "toolCall", id: "call-boundary-result", name: "read", arguments: fullArgs },
			],
			{ stopReason: "toolUse" },
		);
		const persisted = toolEntry("boundary-result", "read", { bytes: 42 });
		if (
			partial.type !== "message" ||
			saved.type !== "message" ||
			persisted.type !== "message" ||
			persisted.message.role !== "toolResult"
		)
			throw new Error("fixture");
		persisted.parentId = saved.id;
		persisted.message.content = [{ type: "text", text: "Exact source result: final byte." }];
		configure(client, [], THEMED_CHARACTER, {
			version: { instanceId, sequence: 0 },
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await screen.findByRole("region", { name: zhCN.messages.conversation });

		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId, sequence: 1 },
			event: { type: "message_start", message: { ...partial.message, content: [] } },
		});
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId, sequence: 2 },
			event: { type: "message_update", message: partial.message },
		});
		const article = await screen.findByRole("article", {
			name: `read ${zhCN.messages.toolActivity.pending}`,
		});
		const disclosure = within(article).getByText("read").closest("details")!;
		const expectArguments = (args: Record<string, unknown>) => {
			const source = within(disclosure).getByText(/"path":/);
			expect(source).toBeVisible();
			expect(source.textContent).toBe(JSON.stringify(args, null, 2));
		};
		expect(disclosure).not.toHaveAttribute("open");
		await user.click(within(disclosure).getByText("read"));
		expect(disclosure).toHaveAttribute("open");
		expectArguments(partialArgs);

		// The native run is still streaming, but execution has not started.
		// Its latest persisted leaf is the assistant call, not a tool result.
		configure(client, [saved], THEMED_CHARACTER, {
			version: { instanceId, sequence: 3 },
			isStreaming: true,
		});
		const openPersistedAssistant = client.conversation.open;
		let releaseAssistantSnapshot!: () => void;
		const assistantSnapshotReady = new Promise<void>((resolve) => {
			releaseAssistantSnapshot = resolve;
		});
		client.conversation.open = vi.fn(async (request) => {
			await assistantSnapshotReady;
			return openPersistedAssistant(request);
		});
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId, sequence: 3 },
			event: { type: "message_end", message: saved.message },
		});

		// The event channel is asynchronous; hold the authoritative read until
		// the completed arguments are visible without an execution event.
		await waitFor(() => expectArguments(fullArgs));
		expect(disclosure.isConnected).toBe(true);
		expect(disclosure).toHaveAttribute("open");
		expect(article).toHaveAttribute("data-status", "pending");
		expectArguments(fullArgs);
		releaseAssistantSnapshot();
		await waitFor(() =>
			expect(screen.getByTestId("timeline-message")).toHaveAttribute("data-pi-entry-id", saved.id),
		);
		expect(disclosure.isConnected).toBe(true);
		expect(disclosure).toHaveAttribute("open");
		expect(article).toHaveAttribute("data-status", "pending");
		expectArguments(fullArgs);

		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId, sequence: 4 },
			event: {
				type: "tool_execution_start",
				toolCallId: "call-boundary-result",
				toolName: "read",
				args: fullArgs,
			},
		});
		await waitFor(() => expect(article).toHaveAttribute("data-status", "running"));
		expect(disclosure.isConnected).toBe(true);
		expect(disclosure).toHaveAttribute("open");
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId, sequence: 5 },
			event: {
				type: "tool_execution_update",
				toolCallId: "call-boundary-result",
				toolName: "read",
				args: fullArgs,
				partialResult: { content: [{ type: "text", text: "Exact source result: partial" }] },
			},
		});
		expect(await within(disclosure).findByText("Exact source result: partial")).toBeVisible();
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId, sequence: 6 },
			event: {
				type: "tool_execution_end",
				toolCallId: "call-boundary-result",
				toolName: "read",
				result: {
					content: persisted.message.content,
					details: persisted.message.details,
				},
				isError: false,
			},
		});
		await waitFor(() => expect(article).toHaveAttribute("data-status", "completed"));
		expect(disclosure.isConnected).toBe(true);
		expect(disclosure).toHaveAttribute("open");
		expect(within(disclosure).getByText("Exact source result: final byte.")).toBeVisible();
		expect(within(disclosure).queryByText("Exact source result: partial")).toBeNull();

		configure(client, [saved, persisted], THEMED_CHARACTER, {
			version: { instanceId, sequence: 7 },
			isStreaming: true,
		});
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId, sequence: 7 },
			event: { type: "message_end", message: persisted.message },
		});
		await waitFor(() => expect(article).toHaveAttribute("data-pi-entry-id", persisted.id));
		expect(disclosure.isConnected).toBe(true);
		expect(within(article).getByText("read").closest("details")).toBe(disclosure);
		expect(disclosure).toHaveAttribute("open");
		expect(article).toHaveAttribute("data-status", "completed");
		expectArguments(fullArgs);
		expect(within(disclosure).getByText("Exact source result: final byte.")).toBeVisible();
		const resultDetails = within(disclosure).getByText(/"bytes": 42/);
		expect(resultDetails).toBeVisible();
		expect(resultDetails.textContent).toBe(JSON.stringify({ bytes: 42 }, null, 2));
	});

	it("shows real preparation and post-response memory failure without inventing assistant messages", async () => {
		const { client } = createTestClient();
		configure(client, []);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await screen.findByRole("region", { name: zhCN.messages.conversation });
		const live = {
			isStreaming: false,
			isCompacting: false,
			isRetrying: false,
			retryAttempt: 0,
			pendingToolCallIds: [],
			steering: [],
			followUp: [],
		};
		pushPiEvent(client, {
			type: "conversationActivity",
			conversationId: "conversation-1",
			operationId: "recall-stage",
			activity: "memory_recall",
			status: "started",
			live,
		});
		const activity = await screen.findByTestId("conversation-activity");
		expect(activity).toHaveAttribute("data-activity", "memory_recall");
		expect(activity).toBeVisible();
		expect(screen.queryByTestId("streaming-assistant-message")).toBeNull();
		expect(screen.getByRole("button", { name: `${zhCN.threadHead.runningWork}0` })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		pushPiEvent(client, {
			type: "conversationActivity",
			conversationId: "conversation-1",
			operationId: "recall-stage",
			activity: "memory_recall",
			status: "completed",
			live,
		});
		await waitFor(() => expect(screen.queryByTestId("conversation-activity")).toBeNull());
		pushPiEvent(client, {
			type: "conversationActivity",
			conversationId: "conversation-1",
			operationId: "capture-stage",
			activity: "memory_capture",
			status: "started",
			live,
		});
		expect(await screen.findByTestId("conversation-activity")).toHaveAttribute(
			"data-activity",
			"memory_capture",
		);
		pushPiEvent(client, {
			type: "conversationActivity",
			conversationId: "conversation-1",
			operationId: "capture-stage",
			activity: "memory_capture",
			status: "failed",
			live,
			errorMessage: "Memory service unavailable",
		});
		await waitFor(() =>
			expect(screen.getByTestId("conversation-activity")).toHaveAttribute("data-failed", "true"),
		);
		expect(screen.getByTestId("conversation-activity")).toHaveTextContent(
			"Memory service unavailable",
		);
		expect(screen.queryByTestId("streaming-assistant-message")).toBeNull();
		expect(screen.queryByTestId("conversation-submission")).toBeNull();
	});

	it("shows preflight compaction without offering unsupported response cancellation", async () => {
		const { client } = createTestClient();
		configure(client, [], THEMED_CHARACTER, { isCompacting: true });
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		expect(await screen.findByTestId("conversation-activity")).toHaveAttribute(
			"data-activity",
			"compaction",
		);
		expect(screen.queryByRole("button", { name: zhCN.composer.stopLabel })).toBeNull();
		expect(screen.queryByTestId("streaming-assistant-message")).toBeNull();
		expect(screen.getByRole("button", { name: zhCN.composer.sendLabel })).toBeInTheDocument();
	});

	it("keeps compaction inside an active response stoppable", async () => {
		const { client } = createTestClient();
		configure(client, [], THEMED_CHARACTER, { isStreaming: true, isCompacting: true });
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		expect(await screen.findByRole("button", { name: zhCN.composer.stopLabel })).toBeEnabled();
		expect(screen.getByTestId("conversation-activity")).toHaveAttribute(
			"data-activity",
			"compaction",
		);
		expect(screen.queryByRole("button", { name: zhCN.composer.sendLabel })).toBeNull();
	});

	it("keeps native retry stoppable and distinguishes guidance from follow-up queues", async () => {
		const { client } = createTestClient();
		configure(client, [], THEMED_CHARACTER, {
			isStreaming: true,
			isRetrying: true,
			retryAttempt: 2,
			steering: ["Use the updated requirement"],
			followUp: ["Then describe the result"],
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		expect(await screen.findByRole("button", { name: zhCN.composer.stopLabel })).toBeEnabled();
		expect(screen.getByTestId("conversation-activity")).toHaveAttribute("data-activity", "retry");
		const steering = (await screen.findByText("Use the updated requirement")).closest("article");
		const followUp = screen.getByText("Then describe the result").closest("article");
		expect(steering).toHaveTextContent(zhCN.messages.submission.queue.steering);
		expect(steering).not.toHaveTextContent(zhCN.messages.submission.queue.followUp);
		expect(followUp).toHaveTextContent(zhCN.messages.submission.queue.followUp);
		expect(screen.queryByTestId("streaming-assistant-message")).toBeNull();
	});

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
		await user.click(await screen.findByText("host_choices"));
		expect(screen.getByText(/"message": "Continue investigating\."/)).toBeVisible();
		await user.click(screen.getByText("host_media"));
		expect(screen.getByText(/"mediaId": "signal"/)).toBeVisible();
		await user.click(await screen.findByRole("button", { name: "Investigate" }));
		expect(client.message.send).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-1",
				text: "Continue investigating.",
			}),
		);
		await user.click(screen.getByRole("button", { name: zhCN.messages.openMedia }));
		expect(screen.getByRole("dialog", { name: "损坏的信号" })).toBeVisible();
	});

	it("keeps actual known and unknown native tool identities inspectable", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const tools = [
			"host_canon",
			"tdai_memory_search",
			"tdai_conversation_search",
			"explicit_memory",
			"third_party_lookup",
		];
		configure(
			client,
			tools.map((name, index) => toolEntry(`tool-${index}`, name, { matches: ["found"] })),
		);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		for (const name of tools) {
			const article = await screen.findByRole("article", {
				name: `${name} ${zhCN.messages.toolActivity.completed}`,
			});
			expect(within(article).getByText(/"found"/)).not.toBeVisible();
			await user.click(within(article).getByText(name));
			expect(within(article).getByText(/"found"/)).toBeVisible();
		}
	});

	it("preserves a successful unchanged explicit-memory result for inspection", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		configure(client, [
			toolEntry("memory", "explicit_memory", {
				ok: true,
				data: { content: "用户明确要求记住北辰。", changed: false },
			}),
		]);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await user.click(await screen.findByText("explicit_memory"));
		expect(screen.getByText(/"changed": false/)).toBeVisible();
		expect(screen.getByText(/用户明确要求记住北辰。/)).toBeVisible();
	});

	it("renders visible custom results and context notices, but not hidden extension state", async () => {
		const { client } = createTestClient();
		const base = { parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
		configure(client, [
			{
				...base,
				id: "hidden-state",
				type: "custom",
				customType: "extension_state",
				data: { secret: "opaque internal state" },
			},
			{
				...base,
				id: "hidden-message",
				type: "custom_message",
				customType: "internal",
				content: "hidden native message",
				display: false,
			},
			{
				...base,
				id: "delivered-result",
				type: "custom_message",
				customType: "host_external_agent_result",
				content: "Run run-42 (pi) failed: compiler rejected input",
				display: true,
				details: { runId: "run-42" },
			},
			{
				...base,
				id: "model",
				type: "model_change",
				provider: "native-provider",
				modelId: "native-model",
			},
			{ ...base, id: "level", type: "thinking_level_change", thinkingLevel: "high" },
			{
				...base,
				id: "summary",
				type: "compaction",
				summary: "Earlier verified context",
				firstKeptEntryId: "model",
				tokensBefore: 1200,
			},
			{
				...base,
				id: "shell",
				type: "message",
				message: {
					role: "bashExecution",
					command: "printf observed-output",
					output: "observed-output",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
			},
		]);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		expect(
			await screen.findByText("Run run-42 (pi) failed: compiler rejected input"),
		).toBeVisible();
		expect(screen.getByText("native-provider / native-model")).toBeVisible();
		expect(screen.getByText("high")).toBeVisible();
		expect(screen.getByText("Earlier verified context")).toBeVisible();
		expect(screen.getByText("printf observed-output")).toBeVisible();
		expect(screen.getByText("observed-output")).toBeVisible();
		expect(screen.queryByText("hidden native message")).toBeNull();
		expect(screen.queryByText(/opaque internal state/)).toBeNull();
	});

	it("keeps full settled tool arguments and output, with safe native image and unsupported fallbacks", async () => {
		const user = userEvent.setup();
		const { client } = createTestClient();
		const longOutput = `${"native result ".repeat(100)}last-observed-byte`;
		const result = toolEntry("read-result", "read", { signature: "provider-opaque", bytes: 2048 });
		if (result.type !== "message" || result.message.role !== "toolResult")
			throw new Error("fixture");
		result.message.content = [
			{ type: "text", text: longOutput },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
			{ type: "video", url: "https://tracker.invalid/pixel", label: "unsupported clip" } as never,
		];
		configure(client, [
			assistantEntry("read-call", [
				{
					type: "toolCall",
					id: "call-read-result",
					name: "read",
					arguments: { path: "/workspace/source.txt", offset: 900, limit: 2048 },
				},
			]),
			result,
		]);
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		await user.click(await screen.findByText("read"));
		expect(screen.getByText(/"offset": 900/)).toBeVisible();
		expect(screen.getByText(longOutput)).toBeVisible();
		expect(screen.getByAltText(zhCN.messages.native.image)).toHaveAttribute(
			"src",
			"data:image/png;base64,aW1hZ2U=",
		);
		expect(screen.getByText(zhCN.messages.native.blockedImage)).toBeVisible();
		expect(screen.getByText(zhCN.messages.native.unsupported)).toBeVisible();
		for (const image of screen.queryAllByRole("img", { hidden: true })) {
			expect(image.getAttribute("src") ?? "").not.toMatch(/^https:\/\/tracker\.invalid/);
		}
		expect(screen.queryByText(/provider-opaque/)).toBeNull();
	});

	it("preserves native failed assistant partial text and the actual error in live and settled rendering", async () => {
		const { client } = createTestClient();
		const saved = assistantEntry(
			"failed-assistant",
			[{ type: "text", text: "Partial verified reply" }],
			{
				stopReason: "error",
				errorMessage: '400: {"message":"provider quota exhausted","type":"invalid_request_error"}',
			},
		);
		configure(client, [], THEMED_CHARACTER, {
			version: { instanceId: "native-failed-assistant", sequence: 0 },
			isStreaming: true,
			streamingMessage: saved.type === "message" ? saved.message : undefined,
		});
		render(() => <CompanionApp product={OFFICIAL_PRODUCT} client={client} />);
		expect(await screen.findByText("Partial verified reply")).toBeVisible();
		expect(screen.getByRole("alert")).toHaveTextContent("provider quota exhausted");
		expect(screen.getByRole("alert")).not.toHaveTextContent("invalid_request_error");
		expect(screen.getByRole("alert")).not.toHaveTextContent("400:");
		configure(client, [saved], THEMED_CHARACTER, {
			version: { instanceId: "native-failed-assistant", sequence: 1 },
		});
		pushPiEvent(client, {
			type: "pi",
			conversationId: "conversation-1",
			version: { instanceId: "native-failed-assistant", sequence: 1 },
			event: { type: "agent_settled" },
		});
		expect(await screen.findByTestId("timeline-message")).toHaveTextContent(
			"Partial verified reply",
		);
		expect(screen.getByRole("alert")).toHaveTextContent("provider quota exhausted");
	});
});
