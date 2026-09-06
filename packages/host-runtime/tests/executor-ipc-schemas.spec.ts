// @vitest-environment node

import { CHANNEL_CONTRACTS } from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";

function schema(channel: string) {
	const value = CHANNEL_CONTRACTS[channel];
	if (!value) throw new Error(`missing contract for ${channel}`);
	return value.request;
}

describe("executor control IPC schemas", () => {
	it("accepts strict external-agent setup and rejects unrecognized fields", () => {
		expect(schema("externalAgent.discoverCodex").safeParse({}).success).toBe(true);
		expect(schema("externalAgent.status").safeParse({}).success).toBe(true);
		expect(
			schema("externalAgent.connectCodex").safeParse({
				canonicalPath: "/usr/local/bin/codex",
				version: "0.147.0",
				sha256: "a".repeat(64),
			}).success,
		).toBe(true);
		expect(
			schema("externalAgent.connectCodex").safeParse({
				canonicalPath: "/usr/local/bin/codex",
				version: "0.147.0",
				sha256: "a".repeat(64),
				codexHome: "/home/user/.codex",
				bypassConsent: true,
			}).success,
		).toBe(false);
	});

	it("requires the exact pending permission request and option rather than treating resume as approval", () => {
		expect(
			schema("run.respondPermission").safeParse({
				runId: "run-1",
				requestId: "permission-1",
				optionId: "allow-once",
			}).success,
		).toBe(true);
		expect(schema("run.cancel").safeParse({ runId: "run-1" }).success).toBe(true);
		expect(
			schema("run.respondPermission").safeParse({
				runId: "run-1",
				optionId: "allow-once",
			}).success,
		).toBe(false);
		expect(
			schema("run.resume").safeParse({
				runId: "run-1",
				requestId: "permission-1",
				optionId: "allow-once",
			}).success,
		).toBe(false);
	});

	it("bounds task history and evidence pages without rejecting valid cursors", () => {
		expect(
			schema("run.list").safeParse({
				conversationId: "conversation-1",
				scope: "history",
				cursor: "page-2",
				limit: 100,
			}).success,
		).toBe(true);
		expect(
			schema("run.get").safeParse({
				runId: "run-1",
				cursor: "evidence-2",
				limit: 100,
			}).success,
		).toBe(true);
		expect(schema("run.list").safeParse({ limit: 101 }).success).toBe(false);
		expect(schema("run.get").safeParse({ runId: "run-1", limit: 0 }).success).toBe(false);
		expect(
			schema("run.get").safeParse({
				runId: "run-1",
				cursor: "x".repeat(257),
			}).success,
		).toBe(false);
		expect(
			schema("run.get").safeParse({
				runId: "run-1",
				path: "/private/worker-output",
			}).success,
		).toBe(false);
	});

	it("accepts bounded continuation instructions and reports steering without claiming completion", () => {
		expect(
			schema("run.resume").safeParse({
				runId: "run-1",
				instruction: "Continue with only the verified inputs.",
			}).success,
		).toBe(true);
		expect(
			schema("run.resume").safeParse({
				runId: "run-1",
				instruction: "x".repeat(12001),
			}).success,
		).toBe(false);
		const receipt = CHANNEL_CONTRACTS["run.steer"]!.response;
		expect(receipt.safeParse({ outcome: "injected" }).success).toBe(true);
		expect(receipt.safeParse({ outcome: "sent" }).success).toBe(true);
		expect(receipt.safeParse({ outcome: "completed" }).success).toBe(false);
	});
});
