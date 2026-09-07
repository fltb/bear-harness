import { RPC } from "@bear-harness/protocol/schema";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	advancePiProjectionVersion,
	currentPiProjectionVersion,
	projectPiConversationDetail,
	projectPiConversationHistory,
	projectPiLiveSnapshot,
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
		isRetrying: true,
		retryAttempt: 2,
		isCompacting: false,
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
			version: currentPiProjectionVersion(current),
			isStreaming: true,
			isRetrying: true,
			retryAttempt: 2,
			isCompacting: false,
			pendingToolCallIds: ["tool-1"],
			steering: ["steer"],
			followUp: ["follow"],
		});
	});

	it("projects a ten-thousand-entry linear Pi branch without exhausting the call stack", () => {
		const current = session();
		for (let index = 60; index < 10_000; index += 1) {
			current.sessionManager.appendMessage({
				role: "user",
				content: `message ${index}`,
				timestamp: index,
			});
		}

		const entries = current.sessionManager.getBranch();
		const detail = projectPiConversationDetail(current);
		expect(detail.branch.entries).toHaveLength(50);
		expect(detail.branch.entries[0]).toBe(entries[9_950]);
		expect(detail.branch.entries[49]).toBe(entries[9_999]);
		expect(detail.branch.latestLeafIds).toEqual([entries[9_999]?.id]);
		expect(detail.branch.hasMoreBefore).toBe(true);
	});

	it("collects version leaves below a deeply nested sibling branch without recursion", () => {
		const current = session();
		const parentId = current.sessionManager.getLeafId();
		expect(parentId).toBeTruthy();
		const olderRootId = current.sessionManager.appendMessage({
			role: "user",
			content: "older version",
			timestamp: 60,
		});
		let olderLeafId = olderRootId;
		for (let index = 61; index < 10_000; index += 1) {
			olderLeafId = current.sessionManager.appendMessage({
				role: "user",
				content: `older branch ${index}`,
				timestamp: index,
			});
		}
		current.sessionManager.branch(parentId!);
		const activeLeafId = current.sessionManager.appendMessage({
			role: "user",
			content: "active version",
			timestamp: 10_000,
		});

		const detail = projectPiConversationDetail(current);
		expect(detail.branch.activeLeafId).toBe(activeLeafId);
		expect(detail.branch.latestLeafIds).toEqual([olderLeafId, activeLeafId]);
	});

	it("bounds projected version leaves while retaining the active Pi leaf", () => {
		const current = session();
		const parentId = current.sessionManager.getLeafId();
		expect(parentId).toBeTruthy();
		const versionLeaves: string[] = [];
		for (let index = 0; index < 120; index += 1) {
			current.sessionManager.branch(parentId!);
			versionLeaves.push(
				current.sessionManager.appendMessage({
					role: "user",
					content: `version ${index}`,
					timestamp: 100 + index,
				}),
			);
		}
		current.sessionManager.branch(versionLeaves[0]!);

		const detail = projectPiConversationDetail(current);
		expect(detail.branch.latestLeafIds).toHaveLength(100);
		expect(detail.branch.latestLeafIds).toContain(versionLeaves[0]);
		expect(detail.branch.latestLeafIds).toContain(versionLeaves[119]);
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

	it("orders snapshots against immutable event versions and replaces reopened instances", () => {
		const current = session();
		const before = projectPiLiveSnapshot(current).version!;
		const eventVersion = advancePiProjectionVersion(current);
		const after = projectPiLiveSnapshot(current).version!;
		expect(after).toEqual(eventVersion);
		expect(after.instanceId).toBe(before.instanceId);
		expect(after.sequence).toBeGreaterThan(before.sequence);
		expect(before.sequence).toBe(0);
		const reopened = { ...current } as AgentSession;
		expect(projectPiLiveSnapshot(reopened).version!.instanceId).not.toBe(after.instanceId);
		expect(projectPiLiveSnapshot(reopened).version!.sequence).toBe(0);
	});

	it("preserves more than one hundred Pi-owned queued messages across the RPC boundary", () => {
		const current = session();
		const steering = Array.from({ length: 101 }, (_, index) => `steering ${index}`);
		const followUp = Array.from({ length: 101 }, (_, index) => `follow-up ${index}`);
		current.getSteeringMessages = () => steering;
		current.getFollowUpMessages = () => followUp;

		const detail = projectPiConversationDetail(current);
		expect(RPC.conversation.open.response.parse(detail).live).toMatchObject({
			steering,
			followUp,
		});
	});
});
