import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	projectPiConversationDetail,
	projectPiConversationHistory,
	projectPiTransientEvent,
} from "../src/companion/pi-live-events.js";

function session() {
	const sessionManager = SessionManager.inMemory();
	for (let index = 0; index < 60; index += 1) {
		sessionManager.appendMessage({
			role: "user",
			content: `message ${index}`,
			timestamp: index,
		});
	}
	return {
		sessionId: sessionManager.getSessionId(),
		sessionName: "Native Pi session",
		isStreaming: true,
		state: {
			streamingMessage: undefined,
			errorMessage: undefined,
			pendingToolCalls: new Set(["tool-1"]),
		},
		getSteeringMessages: () => ["steer"],
		getFollowUpMessages: () => ["follow"],
		sessionManager,
	} as unknown as AgentSession;
}

describe("native Pi conversation projection", () => {
	it("returns a bounded tail without remodeling SessionEntry", () => {
		const current = session();
		const entries = current.sessionManager.getBranch();
		const detail = projectPiConversationDetail(current);
		expect(detail.conversationId).toBe(current.sessionId);
		expect(detail.branch.entries).toHaveLength(50);
		expect(detail.branch.entries[0]).toBe(entries[10]);
		expect(detail.branch.entries[49]).toBe(entries[59]);
		expect(detail.branch.activeLeafId).toBe(entries[59]?.id);
		expect(detail.branch.latestLeafIds).toEqual([entries[59]?.id]);
		expect(detail.branch.hasMoreBefore).toBe(true);
		expect(detail.live).toEqual({
			isStreaming: true,
			pendingToolCallIds: ["tool-1"],
			steering: ["steer"],
			followUp: ["follow"],
		});
	});

	it("pages earlier native entries by Pi entry id", () => {
		const current = session();
		const entries = current.sessionManager.getBranch();
		const history = projectPiConversationHistory(current, entries[10]?.id, 5);
		expect(history.entries).toEqual(entries.slice(5, 10));
		expect(history.entries[0]).toBe(entries[5]);
		expect(history.nextCursor).toBe(entries[5]?.id);
	});

	it("does not transport the duplicate transcript carried by agent_end", () => {
		expect(
			projectPiTransientEvent({ type: "agent_end", messages: [{ role: "user" }] } as never),
		).toBeUndefined();
		const settled = { type: "agent_settled" as const };
		expect(projectPiTransientEvent(settled)).toBe(settled);
	});
});
