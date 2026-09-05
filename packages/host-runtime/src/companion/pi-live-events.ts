import type {
	ConversationDetail,
	ConversationHistoryResponse,
	PiAgentSessionEvent,
	PiLiveSnapshot,
} from "@bear-harness/protocol";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { PiSnapshot } from "./pi-runtime.js";

type Session = NonNullable<PiSnapshot>;
const DEFAULT_PAGE_SIZE = 50;

/** `agent_end.messages` duplicates the authoritative session transcript and has no UI projection. */
export function projectPiTransientEvent(
	event: PiAgentSessionEvent,
): Exclude<PiAgentSessionEvent, { type: "agent_end" }> | undefined {
	return event.type === "agent_end" ? undefined : event;
}

function findTreeNode(nodes: SessionTreeNode[], entryId: string): SessionTreeNode | undefined {
	for (const node of nodes) {
		if (node.entry.id === entryId) {
			return node;
		}
		const match = findTreeNode(node.children, entryId);
		if (match) {
			return match;
		}
	}
	return undefined;
}

function collectTerminalLeafIds(node: SessionTreeNode, leafIds: string[]): void {
	if (node.children.length === 0) {
		leafIds.push(node.entry.id);
		return;
	}
	for (const child of node.children) {
		collectTerminalLeafIds(child, leafIds);
	}
}

function projectLatestLeafIds(session: Session): ConversationDetail["branch"]["latestLeafIds"] {
	const branch = session.sessionManager.getBranch();
	let bottomTurnId: string | undefined;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user") {
			bottomTurnId = entry.id;
			break;
		}
	}
	if (!bottomTurnId) {
		return [];
	}

	const sessionTree = session.sessionManager.getTree();
	const bottomTurn = findTreeNode(sessionTree, bottomTurnId);
	if (!bottomTurn) {
		return [];
	}

	const siblings = bottomTurn.entry.parentId
		? findTreeNode(sessionTree, bottomTurn.entry.parentId)?.children
		: sessionTree;
	const userTurnRoots = siblings?.filter(
		(node) => node.entry.type === "message" && node.entry.message.role === "user",
	);
	const leafIds: string[] = [];
	for (const root of userTurnRoots && userTurnRoots.length > 1 ? userTurnRoots : [bottomTurn]) {
		collectTerminalLeafIds(root, leafIds);
	}
	return leafIds;
}

/** A bounded initial/reconnect view over Pi-owned session state. */
export function projectPiConversationDetail(
	session: Session,
	limit = DEFAULT_PAGE_SIZE,
): ConversationDetail {
	const branch = session.sessionManager.getBranch();
	const entries = branch.slice(-limit);
	const activeLeafId = session.sessionManager.getLeafId();
	const latestLeafIds = projectLatestLeafIds(session);
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
			latestLeafIds,
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
