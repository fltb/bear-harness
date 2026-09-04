import type { PiAgentSessionEvent } from "@bear-harness/protocol";
import { describe, expect, it } from "vitest";
import { appendPiProjectionEvent } from "../src/lib/pi-event-replay.js";

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
