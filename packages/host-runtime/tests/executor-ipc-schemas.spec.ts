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
				codexHome: "/home/user/.codex",
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
		expect(CHANNEL_CONTRACTS["commission.launch"]).toBeUndefined();
	});

	it("requires a concrete pending-permission request and option to resume a run", () => {
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
	});
});
