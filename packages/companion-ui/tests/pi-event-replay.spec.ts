import type {
	ConversationDetail,
	PiAgentSessionEvent,
	PiSessionEntry,
} from "@bear-harness/protocol";
import { describe, expect, it } from "vitest";
import {
	appendPiProjectionEvent,
	isNewerPiVersion,
	retainPiHistory,
} from "../src/lib/pi-event-replay.js";

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		provider: "test",
		model: "test",
		timestamp: 1,
		stopReason: "stop" as const,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("Pi event replay capture", () => {
	it("retains only the latest complete state for one streamed message", () => {
		const capture: PiAgentSessionEvent[] = [];
		appendPiProjectionEvent(capture, { type: "agent_start" });
		for (let index = 0; index < 10_000; index += 1) {
			appendPiProjectionEvent(capture, {
				type: "message_update",
				message: assistantMessage(`reply ${index}`),
			});
		}

		expect(capture).toHaveLength(2);
		const last = capture.at(-1);
		expect(last?.type).toBe("message_update");
		if (last?.type === "message_update") {
			expect(last.message.content).toEqual([{ type: "text", text: "reply 9999" }]);
		}
	});

	it("drops the duplicate transcript payload from agent_end", () => {
		const capture: PiAgentSessionEvent[] = [];
		const event: PiAgentSessionEvent = {
			type: "agent_end",
			messages: [assistantMessage("large completed payload")],
			willRetry: false,
		};
		appendPiProjectionEvent(capture, event);

		expect(capture).toEqual([]);
	});

	it("replaces consecutive queue and tool progress snapshots", () => {
		const capture: PiAgentSessionEvent[] = [];
		appendPiProjectionEvent(capture, {
			type: "queue_update",
			steering: ["first"],
			followUp: [],
		});
		appendPiProjectionEvent(capture, {
			type: "queue_update",
			steering: ["latest"],
			followUp: ["next"],
		});
		appendPiProjectionEvent(capture, {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "host_state",
			args: {},
			partialResult: { content: [] },
		});
		appendPiProjectionEvent(capture, {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "host_state",
			args: {},
			partialResult: { content: [{ type: "text", text: "latest" }] },
		});

		expect(capture).toHaveLength(2);
		expect(capture[0]).toMatchObject({ steering: ["latest"], followUp: ["next"] });
		expect(capture[1]).toMatchObject({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [{ type: "text", text: "latest" }] },
		});
	});
});

describe("Native projection ancestry and transport order", () => {
	const entry = (id: string, parentId: string | null): PiSessionEntry => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: id, timestamp: 1 },
	});
	const branch = (
		entries: PiSessionEntry[],
		hasMoreBefore = false,
	): ConversationDetail["branch"] => ({
		entries,
		hasMoreBefore,
		activeLeafId: entries.at(-1)?.id,
		latestLeafIds: [],
	});

	it("retains only the shared native ancestor prefix when the leaf changes", () => {
		const root = entry("root", null);
		const shared = entry("shared", "root");
		const discarded = entry("old-leaf", "shared");
		const replacement = entry("new-leaf", "shared");
		expect(
			retainPiHistory(branch([root, shared, discarded]), branch([shared, replacement], true)),
		).toEqual(branch([root, shared, replacement]));
	});

	it("does not union disconnected or internally inconsistent branches", () => {
		const old = branch([entry("root", null), entry("old-leaf", "root")]);
		const disconnected = branch([entry("new-leaf", "unknown")], true);
		expect(retainPiHistory(old, disconnected)).toBe(disconnected);
		const inconsistent = branch([entry("old-leaf", "different-parent")], true);
		expect(retainPiHistory(old, inconsistent)).toBe(inconsistent);
	});

	it("accepts only strictly newer events from the snapshot's real native instance", () => {
		const snapshot = { instanceId: "session-instance", sequence: 12 };
		expect(isNewerPiVersion({ ...snapshot, sequence: 13 }, snapshot)).toBe(true);
		expect(isNewerPiVersion(snapshot, snapshot)).toBe(false);
		expect(isNewerPiVersion({ ...snapshot, sequence: 11 }, snapshot)).toBe(false);
		expect(isNewerPiVersion({ instanceId: "retired-instance", sequence: 100 }, snapshot)).toBe(
			false,
		);
		expect(isNewerPiVersion(undefined, snapshot)).toBe(false);
	});
});
