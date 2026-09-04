import { describe, expect, it } from "vitest";
import {
	projectPiConversationDetail,
	projectPiConversationHistory,
	projectPiTransientEvent,
} from "../src/companion/pi-live-events.js";

function session(
	entries = Array.from({ length: 60 }, (_, index) => ({
		type: "message" as const,
		id: `entry-${index}`,
		parentId: index ? `entry-${index - 1}` : null,
		timestamp: new Date(index).toISOString(),
		message: { role: "user" as const, content: `message ${index}`, timestamp: index },
	})),
) {
	return {
		sessionId: "session-1",
		sessionName: "Native Pi session",
		isStreaming: true,
		state: {
			streamingMessage: undefined,
			errorMessage: undefined,
			pendingToolCalls: new Set(["tool-1"]),
		},
		getSteeringMessages: () => ["steer"],
		getFollowUpMessages: () => ["follow"],
		sessionManager: {
			getBranch: () => entries,
			getLeafId: () => entries.at(-1)?.id,
		},
	} as never;
}

describe("native Pi conversation projection", () => {
	it("returns a bounded tail without remodeling SessionEntry", () => {
		const detail = projectPiConversationDetail(session());
		expect(detail.conversationId).toBe("session-1");
		expect(detail.branch.entries).toHaveLength(50);
		expect(detail.branch.entries[0]?.id).toBe("entry-10");
		expect(detail.branch.hasMoreBefore).toBe(true);
		expect(detail.live).toEqual({
			isStreaming: true,
			pendingToolCallIds: ["tool-1"],
			steering: ["steer"],
			followUp: ["follow"],
		});
	});

	it("pages earlier native entries by Pi entry id", () => {
		const history = projectPiConversationHistory(session(), "entry-10", 5);
		expect(history.entries.map((entry) => entry.id)).toEqual([
			"entry-5",
			"entry-6",
			"entry-7",
			"entry-8",
			"entry-9",
		]);
		expect(history.nextCursor).toBe("entry-5");
	});

	it("does not transport the duplicate transcript carried by agent_end", () => {
		expect(
			projectPiTransientEvent({ type: "agent_end", messages: [{ role: "user" }] } as never),
		).toBeUndefined();
		const settled = { type: "agent_settled" as const };
		expect(projectPiTransientEvent(settled)).toBe(settled);
	});
});
