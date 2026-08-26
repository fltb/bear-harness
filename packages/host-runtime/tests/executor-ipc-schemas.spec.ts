// @vitest-environment node

import { REQUEST_SCHEMAS } from "@bear-harness/protocol/schema";
import { describe, expect, it } from "vitest";

function schema(channel: string) {
	const value = REQUEST_SCHEMAS[channel];
	if (!value) throw new Error(`missing schema for ${channel}`);
	return value;
}

describe("executor control IPC schemas", () => {
	it("accepts strict external-agent setup and rejects unrecognized fields", () => {
		expect(schema("externalAgent.discoverCodex:v1").safeParse({}).success).toBe(true);
		expect(schema("externalAgent.status:v1").safeParse({}).success).toBe(true);
		expect(
			schema("externalAgent.connectCodex:v1").safeParse({
				canonicalPath: "/usr/local/bin/codex",
				version: "0.147.0",
				sha256: "a".repeat(64),
				codexHome: "/home/user/.codex",
			}).success,
		).toBe(true);
		expect(
			schema("externalAgent.connectCodex:v1").safeParse({
				canonicalPath: "/usr/local/bin/codex",
				version: "0.147.0",
				sha256: "a".repeat(64),
				codexHome: "/home/user/.codex",
				bypassConsent: true,
			}).success,
		).toBe(false);
		expect(REQUEST_SCHEMAS["commission.launch:v1"]).toBeUndefined();
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
