import { describe, expect, it } from "vitest";
import {
	CanonAddSourceRequest,
	CanonUpsertModuleRequest,
	CharacterImportRequest,
	CharacterMedia,
	CompanionStateUpdateRequest,
	MemoryInspectResponse,
	MessageSendRequest,
	PiLiveSnapshot,
	PiSessionEntry,
} from "../src/schema.js";

describe("content capacity follows its owner", () => {
	it("passes long messages and serializable Pi data intact", () => {
		const text = "x".repeat(8 * 1024 * 1024 + 1);
		expect(
			MessageSendRequest.parse({
				conversationId: "session",
				clientMessageId: "10000000-0000-4000-8000-000000000001",
				text,
			}).text,
		).toBe(text);
		expect(PiSessionEntry.parse({ text })).toEqual({ text });
	});
	it("passes Pi queues beyond the former message and character quotas", () => {
		const steering = Array(10001).fill("x".repeat(201));
		const parsed = PiLiveSnapshot.parse({
			isStreaming: true,
			isRetrying: false,
			retryAttempt: 0,
			isCompacting: false,
			pendingToolCallIds: [],
			steering,
			followUp: [],
		});
		expect(parsed.steering).toEqual(steering);
	});
	it("accepts more files and larger media than the former transfer quotas", () => {
		const base64 = "A".repeat(8_000_004);
		const files = Array.from({ length: 501 }, (_, i) => ({
			path: `role/file-${i}`,
			base64: i === 0 ? base64 : "AA==",
		}));
		expect(CharacterImportRequest.parse({ files }).files).toEqual(files);
		const media = {
			id: "clip",
			kind: "video",
			label: "Clip",
			description: "Clip",
			use_when: "When asked",
			loop: false,
			url: "data:video/mp4;base64," + "A".repeat(20_000_000),
			captionsUrl: "data:text/vtt;base64,AA==",
		};
		expect(CharacterMedia.parse(media)).toEqual(media);
	});
	it("retains Bear-owned memory and state constraints", () => {
		expect(
			MemoryInspectResponse.safeParse({
				characterId: "role",
				relationshipMemoryEnabled: false,
				explicit: "x".repeat(4001),
				items: [],
			}).success,
		).toBe(false);
		expect(
			CompanionStateUpdateRequest.safeParse({
				conversationId: "session",
				changes: [{ path: "/character/summary", value: "x".repeat(4097) }],
			}).success,
		).toBe(false);
	});
	it("allows book-sized manual Canon sources and larger curated modules", () => {
		const content = "x".repeat(1_048_577);
		expect(CanonAddSourceRequest.parse({ logicalName: "Book", content }).content).toBe(content);
		const sourceChunkIds = Array.from({ length: 101 }, (_, i) => `chunk-${i}`);
		expect(
			CanonUpsertModuleRequest.parse({
				kind: "root",
				title: "Book",
				instructions: "",
				sourceChunkIds,
			}).sourceChunkIds,
		).toEqual(sourceChunkIds);
		expect(
			CanonAddSourceRequest.safeParse({
				logicalName: "Book",
				content: "x".repeat(16 * 1024 * 1024 + 1),
			}).success,
		).toBe(false);
	});
});
