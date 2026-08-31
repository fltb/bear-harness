import { describe, expect, it } from "vitest";
import {
	projectPiConversationDetail,
	projectPiSessionLiveEvent,
} from "../src/companion/pi-live-events.js";
import type { PiSessionEvent, PiSnapshot } from "../src/companion/pi-runtime.js";

function nativeSession(
	input: {
		entries?: Array<Record<string, unknown>>;
		roots?: Array<Record<string, unknown>>;
		leafId?: string;
		name?: string;
		streamingMessage?: Record<string, unknown>;
		isStreaming?: boolean;
	} = {},
) {
	const entries = input.entries ?? [];
	const treeEntries: Array<Record<string, unknown>> = [];
	const visit = (node: Record<string, unknown>) => {
		if (node.entry && typeof node.entry === "object") {
			treeEntries.push(node.entry as Record<string, unknown>);
		}
		if (Array.isArray(node.children)) {
			node.children.forEach((child) => {
				visit(child);
			});
		}
	};
	(input.roots ?? []).forEach(visit);
	return {
		sessionId: "session-1",
		sessionName: input.name,
		sessionManager: {
			buildContextEntries: () => entries,
			getBranch: () => entries,
			getTree: () => input.roots ?? [],
			getChildren: (parentId: string) => treeEntries.filter((entry) => entry.parentId === parentId),
			getLeafId: () => input.leafId ?? null,
		},
		isStreaming: input.isStreaming ?? false,
		state: { streamingMessage: input.streamingMessage, errorMessage: undefined },
		getSteeringMessages: () => ["queued"],
		getFollowUpMessages: () => [],
	} as unknown as NonNullable<PiSnapshot>;
}

describe("Pi transient event projection", () => {
	const snapshot = nativeSession({
		isStreaming: true,
		streamingMessage: {
			role: "assistant",
			content: [
				{ type: "text", text: "partial response" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
			],
			stopReason: "stop",
		},
	});

	it("projects message updates from the owning session snapshot", () => {
		const event = projectPiSessionLiveEvent(
			{
				sessionId: "session-1",
				event: {
					type: "message_update",
					message: snapshot.state.streamingMessage,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " response" },
				},
			} as PiSessionEvent,
			snapshot,
		);
		expect(event).toMatchObject({
			sessionId: "session-1",
			type: "message_update",
			live: {
				isStreaming: true,
				streamingMessage: { text: "partial response", stopReason: "pending" },
				queuedUserMessages: ["queued"],
			},
		});
	});

	it("projects a typed timeline without exposing raw Pi or tool payloads", () => {
		const entries = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: "2026-08-31T00:00:00.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: "2026-08-31T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "working" },
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { token: "secret-argument" },
						},
					],
					provider: "private-provider",
					model: "private-model",
					stopReason: "toolUse",
					errorMessage: undefined,
				},
			},
			{
				type: "message",
				id: "tool-result",
				parentId: "assistant",
				timestamp: "2026-08-31T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "secret-result" }],
					details: { path: "secret-path" },
					isError: false,
				},
			},
			{
				type: "custom",
				id: "custom",
				parentId: "tool-result",
				timestamp: "2026-08-31T00:00:03.000Z",
				customType: "private",
				data: { token: "secret-custom" },
			},
		];
		const oldUser = {
			type: "message",
			id: "old-user",
			parentId: null,
			timestamp: "2026-08-30T23:59:58.000Z",
			message: { role: "user", content: "old", timestamp: 0 },
		};
		const oldLeaf = {
			type: "message",
			id: "old-leaf",
			parentId: "old-user",
			timestamp: "2026-08-30T23:59:59.000Z",
			message: { role: "assistant", content: [], stopReason: "stop" },
		};
		const tree = (entry: Record<string, unknown>, children: unknown[] = []) => ({
			entry,
			children,
		});
		const detail = projectPiConversationDetail(
			nativeSession({
				name: "Safe conversation",
				entries,
				leafId: "custom",
				roots: [
					tree(oldUser, [tree(oldLeaf)]),
					tree(entries[0] as Record<string, unknown>, [
						tree(entries[1] as Record<string, unknown>, [
							tree(entries[2] as Record<string, unknown>, [
								tree(entries[3] as Record<string, unknown>),
							]),
						]),
					]),
				],
			}),
		);

		expect(detail).toMatchObject({
			sessionId: "session-1",
			name: "Safe conversation",
			timeline: {
				activeLeafId: "custom",
				entries: [
					{ id: "user", kind: "message", role: "user", text: "hello" },
					{
						id: "assistant",
						kind: "message",
						role: "assistant",
						text: "working",
						toolCalls: [{ toolName: "read", toolCallId: "call-1" }],
						version: { current: 1, leafIds: ["old-leaf", "custom"] },
					},
					{
						id: "tool-result",
						kind: "message",
						role: "tool",
						toolName: "read",
						toolCallId: "call-1",
						status: "succeeded",
					},
					{ id: "custom", kind: "custom" },
				],
			},
		});
		const wire = JSON.stringify(detail);
		for (const secret of [
			"secret-argument",
			"secret-result",
			"secret-path",
			"secret-custom",
			"private-provider",
			"private-model",
		]) {
			expect(wire).not.toContain(secret);
		}
	});

	it("projects only validated host_media and host_choices details for timeline presentation", () => {
		const tool = (id: string, toolName: string, data: unknown): Record<string, unknown> => ({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-08-31T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: `${id}-call`,
				toolName,
				content: [{ type: "text", text: "done" }],
				details: { ok: true, data },
				isError: false,
			},
		});
		const detail = projectPiConversationDetail(
			nativeSession({
				entries: [
					tool("media", "host_media", { mediaId: "signal" }),
					tool("choices", "host_choices", {
						prompt: "Continue?",
						items: [
							{ label: "Continue", message: "Continue." },
							{ label: "Pause", message: "Pause." },
						],
					}),
					tool("invalid", "host_media", { mediaId: "../../secret" }),
				],
			}),
		);
		expect(detail.timeline.entries[0]).toMatchObject({
			toolName: "host_media",
			mediaId: "signal",
		});
		expect(detail.timeline.entries[1]).toMatchObject({
			toolName: "host_choices",
			choices: { prompt: "Continue?" },
		});
		expect(detail.timeline.entries[2]).not.toHaveProperty("mediaId");
	});

	it("exposes tool identity and status without arguments or results", () => {
		const event = projectPiSessionLiveEvent(
			{
				sessionId: "session-1",
				event: {
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "read",
					result: { secret: "must not cross" },
					isError: false,
				},
			} as PiSessionEvent,
			snapshot,
		);
		expect(event?.tool).toEqual({
			toolCallId: "call-1",
			toolName: "read",
			status: "succeeded",
		});
		expect(JSON.stringify(event)).not.toContain("must not cross");
	});

	it("drops an event when its session snapshot is not open", () => {
		expect(
			projectPiSessionLiveEvent(
				{ sessionId: "closed", event: { type: "agent_settled" } } as PiSessionEvent,
				snapshot,
			),
		).toBeUndefined();
	});
});
