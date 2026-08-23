// @vitest-environment node

import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";

function schema(channel: string) {
	const value = REQUEST_SCHEMAS[channel];
	if (!value) throw new Error(`missing schema for ${channel}`);
	return value;
}

describe("executor control IPC schemas", () => {
	it("accepts the approval-to-launch path and rejects unrecognized fields", () => {
		expect(
			schema("commission.draft:v1").safeParse({
				conversationId: "conversation-1",
				triggerEntryId: "message-1",
				title: "Inspect files",
				description: "Read the selected directory.",
				reads: ["/workspace"],
				toolNames: ["read"],
			}).success,
		).toBe(true);
		expect(
			schema("commission.approve:v1").safeParse({
				commissionId: "commission-1",
				approvedHash: "a".repeat(64),
			}).success,
		).toBe(true);
		expect(
			schema("commission.launch:v1").safeParse({
				commissionId: "commission-1",
				executorProfile: "pi-product-managed",
			}).success,
		).toBe(true);
		expect(
			schema("commission.launch:v1").safeParse({
				commissionId: "commission-1",
				executorProfile: "pi-product-managed",
				bypassApproval: true,
			}).success,
		).toBe(false);
	});

	it("requires a concrete pending-permission request and option to resume a run", () => {
		expect(
			schema("run.respondPermission:v1").safeParse({
				runId: "run-1",
				requestId: "permission-1",
				optionId: "allow-once",
			}).success,
		).toBe(true);
		expect(schema("run.cancel:v1").safeParse({ runId: "run-1" }).success).toBe(true);
		expect(
			schema("run.respondPermission:v1").safeParse({
				runId: "run-1",
				optionId: "allow-once",
			}).success,
		).toBe(false);
	});
});
