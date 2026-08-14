// @vitest-environment node

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { REQUEST_SCHEMAS } from "../src/shared/ipc-schemas.js";

function schema(channel: string) {
	const value = REQUEST_SCHEMAS[channel];
	if (!value) throw new Error(`missing schema for ${channel}`);
	return value;
}

describe("executor control IPC schemas", () => {
	it("accepts the approval-to-launch path and rejects unrecognized fields", () => {
		expect(
		Value.Check(schema("commission.draft:v1"), {
			conversationId: "conversation-1",
			title: "Inspect files",
			description: "Read the selected directory.",
			reads: ["/workspace"],
			toolNames: ["read"],
		}),
	).toBe(true);
		expect(
		Value.Check(schema("commission.approve:v1"), {
			commissionId: "commission-1",
			approvedHash: "a".repeat(64),
		}),
	).toBe(true);
		expect(
		Value.Check(schema("commission.launch:v1"), {
			commissionId: "commission-1",
			executorProfile: "pi-product-managed",
		}),
	).toBe(true);
		expect(
		Value.Check(schema("commission.launch:v1"), {
			commissionId: "commission-1",
			executorProfile: "pi-product-managed",
			bypassApproval: true,
		}),
	).toBe(false);
	});

	it("requires a concrete pending-permission request and option to resume a run", () => {
		expect(
		Value.Check(schema("run.respondPermission:v1"), {
			runId: "run-1",
			requestId: "permission-1",
			optionId: "allow-once",
		}),
	).toBe(true);
		expect(Value.Check(schema("run.cancel:v1"), { runId: "run-1" })).toBe(true);
		expect(
		Value.Check(schema("run.respondPermission:v1"), {
			runId: "run-1",
			optionId: "allow-once",
		}),
	).toBe(false);
	});
});
