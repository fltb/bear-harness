// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	CHANNEL_CONTRACTS,
	MemoryCaptureRequest,
	MemoryCaptureResponse,
	MemoryEntry,
	REQUEST_SCHEMAS,
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
		const response = { memoryId: "memory-1", sourceEntryId: "entry-1" };
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

	it("projects memory entries without pin or invalidation metadata", () => {
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
		expect(MemoryEntry.safeParse({ ...entry, pinned: true, status: "invalidated" }).success).toBe(
			false,
		);
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
			expect(REQUEST_SCHEMAS[channel]).toBe(contract?.request);
		}
		expect(RPC.memory.capture.channel).toBe("memory.capture:v1");
		expect(RPC.memory.edit.channel).toBe("memory.edit:v1");
	});
});
