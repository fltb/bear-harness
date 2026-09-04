import type { PiAgentSessionEvent } from "@bear-harness/protocol";

export function appendPiProjectionEvent(
	capture: PiAgentSessionEvent[],
	event: PiAgentSessionEvent,
): void {
	if (event.type === "agent_end") return;
	const lastIndex = capture.length - 1;
	const last = capture[lastIndex];
	const isMessageEvent =
		event.type === "message_start" ||
		event.type === "message_update" ||
		event.type === "message_end";
	const lastIsMessageEvent =
		last?.type === "message_start" ||
		last?.type === "message_update" ||
		last?.type === "message_end";
	if (
		isMessageEvent &&
		lastIsMessageEvent &&
		last.message.role === event.message.role &&
		last.message.timestamp === event.message.timestamp
	) {
		capture[lastIndex] = event;
		return;
	}
	if (event.type === "queue_update" && last?.type === "queue_update") {
		capture[lastIndex] = event;
		return;
	}
	if (
		event.type === "tool_execution_update" &&
		last?.type === "tool_execution_update" &&
		last.toolCallId === event.toolCallId
	) {
		capture[lastIndex] = event;
		return;
	}
	capture.push(event);
}
