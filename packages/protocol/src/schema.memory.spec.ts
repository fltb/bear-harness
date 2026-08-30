// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { KnownDomainEvent } from "./index.js";
import {
	CHANNEL_CONTRACTS,
	DomainEvent,
	EmptyResponse,
	MemoryCaptureRequest,
	MemoryCaptureResponse,
	MemoryEntry,
	parseKnownDomainEvent,
	RPC,
} from "./schema.js";

describe("direct memory capture and invalidation schemas", () => {
	it("bounds conversation and Pi session entry IDs on capture requests", () => {
		expect(
			MemoryCaptureRequest.safeParse({
				conversationId: "c".repeat(64),
				entryId: "e".repeat(128),
			}).success,
		).toBe(true);
		expect(
			MemoryCaptureRequest.safeParse({
				conversationId: "c".repeat(65),
				entryId: "e".repeat(128),
			}).success,
		).toBe(false);
		expect(
			MemoryCaptureRequest.safeParse({
				conversationId: "conversation-1",
				entryId: "e".repeat(129),
			}).success,
		).toBe(false);
		expect(MemoryCaptureRequest.safeParse({ conversationId: "", entryId: "entry-1" }).success).toBe(
			false,
		);
		expect(
			MemoryCaptureRequest.safeParse({ conversationId: "conversation-1", entryId: "" }).success,
		).toBe(false);
	});

	it("accepts both supported source creators and rejects other values", () => {
		const response = {
			status: "stored" as const,
			reason: "memory_stored" as const,
			memoryIds: ["memory-1"],
			sourceEntryId: "entry-1",
		};
		for (const createdBy of ["user_capture", "assistant_tool"] as const) {
			expect(MemoryCaptureResponse.safeParse({ ...response, createdBy }).success).toBe(true);
		}
		expect(MemoryCaptureResponse.safeParse({ ...response, createdBy: "system" }).success).toBe(
			false,
		);
		expect(
			MemoryCaptureResponse.safeParse({
				...response,
				createdBy: "user_capture",
				sourceEntryId: "e".repeat(129),
			}).success,
		).toBe(false);
	});

	it("projects optional source provenance and rejects unknown metadata", () => {
		const entry = {
			id: "memory-1",
			kind: "persona",
			scope: "relationship",
			text: "用户喜欢清晨工作",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			importance: 0.7,
		};
		expect(MemoryEntry.safeParse(entry).success).toBe(true);
		expect(MemoryEntry.safeParse({ ...entry, sourceEntryId: "entry-1" }).success).toBe(true);
		expect(MemoryEntry.safeParse({ ...entry, sourceEntryId: "" }).success).toBe(false);
		expect(MemoryEntry.safeParse({ ...entry, sourceEntryId: 42 }).success).toBe(false);
		expect(MemoryEntry.safeParse({ ...entry, sourceEntryId: "e".repeat(129) }).success).toBe(false);
		expect(MemoryEntry.safeParse({ ...entry, pinned: true, status: "invalidated" }).success).toBe(
			false,
		);
	});

	it("rejects incoherent memory timestamps and keeps safe maxima", () => {
		const entry = {
			id: "memory-1",
			kind: "persona",
			scope: "relationship",
			text: "用户喜欢清晨工作",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			importance: 0.7,
		};
		expect(MemoryEntry.safeParse(entry).success).toBe(true);
		expect(MemoryEntry.safeParse({ ...entry, updatedAt: "2025-12-31T23:59:59.000Z" }).success).toBe(
			false,
		);
		expect(MemoryEntry.safeParse({ ...entry, createdAt: "not-a-date" }).success).toBe(false);
		expect(MemoryEntry.safeParse({ ...entry, text: "t".repeat(4096) }).success).toBe(true);
		expect(MemoryEntry.safeParse({ ...entry, text: "t".repeat(4097) }).success).toBe(false);
		expect(MemoryEntry.safeParse({ ...entry, importance: Number.NaN }).success).toBe(false);
	});

	it("rejects unusable empty response identifiers", () => {
		expect(
			MemoryCaptureResponse.safeParse({
				status: "stored",
				reason: "memory_stored",
				memoryIds: [""],
				sourceEntryId: "entry-1",
				createdBy: "user_capture",
			}).success,
		).toBe(false);
		expect(
			MemoryCaptureResponse.safeParse({
				status: "stored",
				reason: "memory_stored",
				memoryIds: ["memory-1"],
				sourceEntryId: "",
				createdBy: "user_capture",
			}).success,
		).toBe(false);
		expect(
			MemoryCaptureResponse.safeParse({
				status: "stored",
				reason: "memory_stored",
				memoryIds: ["memory-1"],
				sourceEntryId: "entry-1",
				createdBy: "user_capture",
			}).success,
		).toBe(true);
	});

	it("uses the strict empty response for provider credentials", () => {
		expect(RPC.provider.setApiKey.response).toBe(EmptyResponse);
		expect(RPC.provider.setApiKey.response.safeParse({}).success).toBe(true);
		expect(RPC.provider.setApiKey.response.safeParse({ status: "stored" }).success).toBe(false);
	});

	it("preserves concrete fields when parsing known event payloads", () => {
		const event: KnownDomainEvent = {
			seq: 1,
			kind: "run.needs_user",
			payload: {
				runId: "run-1",
				prompt: "Allow the planned operation?",
				requestId: "request-1",
				options: [{ optionId: "allow", kind: "permission", name: "Allow once" }],
			},
		};
		const parsed = parseKnownDomainEvent(event);
		expect(parsed?.kind).toBe("run.needs_user");
		if (parsed?.kind === "run.needs_user") {
			const runId: string = parsed.payload.runId;
			const optionName: string | undefined = parsed.payload.options[0]?.name;
			expect(runId).toBe("run-1");
			expect(optionName).toBe("Allow once");
		}
	});

	it("rejects undeclared event kinds", () => {
		const event = { seq: 1, kind: "toString", payload: { value: true } };
		expect(DomainEvent.safeParse(event).success).toBe(false);
		expect(parseKnownDomainEvent(event)).toBeUndefined();
	});

	it("registers the direct memory endpoints", () => {
		const channels = [
			"memory.capture:v1",
			"memory.search:v1",
			"memory.list:v1",
			"memory.forget:v1",
			"memory.edit:v1",
		] as const;

		for (const channel of channels) {
			const contract = CHANNEL_CONTRACTS[channel];
			expect(contract).toBeDefined();
			expect(contract?.channel).toBe(channel);
			expect(contract?.request).toBeDefined();
		}
		expect(RPC.memory.capture.channel).toBe("memory.capture:v1");
		expect(RPC.memory.edit.channel).toBe("memory.edit:v1");
	});
});
