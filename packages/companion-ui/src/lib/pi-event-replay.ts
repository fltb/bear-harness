import type { ConversationDetail, PiAgentSessionEvent } from "@bear-harness/protocol";

type PiVersion = NonNullable<ConversationDetail["live"]["version"]>;

/** Only the same real session instance has comparable transport sequences. */
export function isNewerPiVersion(incoming: PiVersion | undefined, current: PiVersion | undefined) {
	return (
		!current ||
		(!!incoming &&
			incoming.instanceId === current.instanceId &&
			incoming.sequence > current.sequence)
	);
}

/** Keep only a prefix proven to be ancestors of the new native branch. */
export function retainPiHistory(
	previous: ConversationDetail["branch"] | undefined,
	incoming: ConversationDetail["branch"],
): ConversationDetail["branch"] {
	const first = incoming.entries[0];
	if (!previous || !first || !incoming.hasMoreBefore) return incoming;
	let end = previous.entries.findIndex((entry) => entry.id === first.id);
	if (end < 0) {
		const parent = previous.entries.findIndex((entry) => entry.id === first.parentId);
		if (parent < 0) return incoming;
		end = parent + 1;
	}
	if (!end) return incoming;
	const prefix = previous.entries.slice(0, end);
	const joined = [...prefix, ...incoming.entries];
	if (joined.some((entry, index) => index > 0 && entry.parentId !== joined[index - 1]?.id))
		return incoming;
	return { ...incoming, entries: joined, hasMoreBefore: previous.hasMoreBefore };
}

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
		last.message.timestamp === event.message.timestamp &&
		!(
			last.message.role === "assistant" &&
			event.message.role === "assistant" &&
			last.message.responseId &&
			event.message.responseId &&
			last.message.responseId !== event.message.responseId
		) &&
		!(
			last.message.role === "toolResult" &&
			event.message.role === "toolResult" &&
			last.message.toolCallId !== event.message.toolCallId
		)
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
