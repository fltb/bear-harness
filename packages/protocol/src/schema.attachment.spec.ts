// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ConversationAttachmentReadRequest, ConversationAttachmentReadResponse } from "./schema.js";

describe("conversation attachment read schemas", () => {
	it("keeps semantic search and exact-file reads distinct", () => {
		expect(
			ConversationAttachmentReadRequest.safeParse({
				mode: "semantic",
				conversationId: "conversation-a",
				attachmentId: "attachment-a",
				query: "needle",
			}).success,
		).toBe(true);
		expect(
			ConversationAttachmentReadRequest.safeParse({
				mode: "semantic",
				conversationId: "conversation-a",
				attachmentId: "attachment-a",
				query: "needle",
				relativePath: "notes.txt",
			}).success,
		).toBe(false);
	});

	it("requires bounded byte ranges", () => {
		const request = {
			mode: "bytes",
			conversationId: "conversation-a",
			attachmentId: "attachment-a",
			offset: 0,
		};
		expect(
			ConversationAttachmentReadRequest.safeParse({ ...request, length: 1024 * 1024 }).success,
		).toBe(true);
		expect(
			ConversationAttachmentReadRequest.safeParse({ ...request, length: 1024 * 1024 + 1 }).success,
		).toBe(false);
		expect(ConversationAttachmentReadRequest.safeParse({ ...request, length: 0 }).success).toBe(
			false,
		);
	});

	it("rejects oversized semantic pages and byte payloads", () => {
		expect(
			ConversationAttachmentReadResponse.safeParse({
				mode: "semantic",
				content: "x".repeat(65_537),
			}).success,
		).toBe(false);
		expect(
			ConversationAttachmentReadResponse.safeParse({
				mode: "bytes",
				relativePath: "image.png",
				mime: "image/png",
				base64: "x".repeat(1_398_105),
				nextOffset: 0,
				eof: true,
			}).success,
		).toBe(false);
	});
});
