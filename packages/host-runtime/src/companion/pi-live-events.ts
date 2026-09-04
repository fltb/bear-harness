import type {
	ConversationDetail,
	ConversationHistoryResponse,
	PiAgentSessionEvent,
	PiLiveSnapshot,
} from "@bear-harness/protocol";
import type { PiSnapshot } from "./pi-runtime.js";

type Session = NonNullable<PiSnapshot>;
const DEFAULT_PAGE_SIZE = 50;

/** `agent_end.messages` duplicates the authoritative session transcript and has no UI projection. */
export function projectPiTransientEvent(
	event: PiAgentSessionEvent,
): Exclude<PiAgentSessionEvent, { type: "agent_end" }> | undefined {
	return event.type === "agent_end" ? undefined : event;
}

/** A bounded initial/reconnect view over Pi-owned session state. */
export function projectPiConversationDetail(
	session: Session,
	limit = DEFAULT_PAGE_SIZE,
): ConversationDetail {
	const branch = session.sessionManager.getBranch();
	const entries = branch.slice(-limit);
	const activeLeafId = session.sessionManager.getLeafId();
	return {
		conversationId: session.sessionId,
		...(session.sessionName ? { name: session.sessionName } : {}),
		...(session.model
			? { selectedModel: { providerId: session.model.provider, modelId: session.model.id } }
			: {}),
		branch: {
			...(activeLeafId ? { activeLeafId } : {}),
			entries,
			hasMoreBefore: entries.length < branch.length,
		},
		live: projectPiLiveSnapshot(session),
	};
}

export function projectPiConversationHistory(
	session: Session,
	beforeEntryId?: string,
	limit = DEFAULT_PAGE_SIZE,
): ConversationHistoryResponse {
	const branch = session.sessionManager.getBranch();
	const end = beforeEntryId
		? branch.findIndex((entry) => entry.id === beforeEntryId)
		: branch.length;
	if (end < 0) throw { kind: "not_found", reason: "conversation_entry_not_found" };
	const start = Math.max(0, end - limit);
	const entries = branch.slice(start, end);
	return {
		entries,
		...(start > 0 && entries[0] ? { nextCursor: entries[0].id } : {}),
	};
}

export function projectPiLiveSnapshot(session: Session): PiLiveSnapshot {
	const streamingMessage = session.state.streamingMessage;
	return {
		isStreaming: session.isStreaming,
		...(streamingMessage ? { streamingMessage } : {}),
		pendingToolCallIds: [...session.state.pendingToolCalls],
		steering: [...session.getSteeringMessages()],
		followUp: [...session.getFollowUpMessages()],
		...(session.state.errorMessage ? { errorMessage: session.state.errorMessage } : {}),
	};
}
