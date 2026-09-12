import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseExtractionResult } from "../src/core/record/l1-extractor.js";
import { CheckpointManager } from "../src/utils/checkpoint.js";
import { createL1Runner } from "../src/utils/pipeline-factory.js";

describe("failed memory extraction does not consume input", () => {
	it("distinguishes an explicit empty array from an invalid response", () => {
		expect(parseExtractionResult("[]")).toEqual([]);
		expect(parseExtractionResult("```json\n[]\n```")).toEqual([]);
		expect(() => parseExtractionResult("fetch failed")).toThrow("memory_l1_response_invalid");
		expect(() => parseExtractionResult("[broken]")).toThrow("memory_l1_response_invalid");
	});
	it("rejects malformed scene and memory fields instead of silently consuming them", () => {
		for (const value of [
			[1],
			[{}],
			[{ scene_name: "test", message_ids: [], memories: [{}] }],
			[{ scene_name: "test", message_ids: [1], memories: [] }],
		])
			expect(() => parseExtractionResult(JSON.stringify(value))).toThrow(
				"memory_l1_response_invalid",
			);
		const memory = {
			content: "Float uses Debian",
			type: "persona",
			priority: 80,
			source_message_ids: ["u1"],
			metadata: {},
		};
		const scene = { scene_name: "preferences", message_ids: ["u1"], memories: [memory] };
		expect(parseExtractionResult(JSON.stringify([scene]))).toEqual([scene]);
		for (const patch of [
			{ type: "nonsense" },
			{ priority: 101 },
			{ metadata: [] },
			{ content: " " },
			{ source_message_ids: [null] },
		])
			expect(() =>
				parseExtractionResult(JSON.stringify([{ ...scene, memories: [{ ...memory, ...patch }] }])),
			).toThrow("memory_l1_response_invalid");
	});
	it("preserves the checkpoint when the extraction model fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "bear-l1-failure-"));
		const checkpoint = new CheckpointManager(root);
		const mark = vi.spyOn(CheckpointManager.prototype, "markL1ExtractionComplete");
		const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const cfg = {
			extraction: { enableDedup: false, maxMemoriesPerSession: 10 },
			embedding: { timeoutMs: 1000 },
		};
		const runner = createL1Runner({
			pluginDataDir: root,
			cfg: cfg as never,
			openclawConfig: {},
			embeddingService: undefined,
			vectorStore: {
				isDegraded: () => false,
				queryL0GroupedBySessionId: async () => [
					{
						sessionId: "conversation-a",
						messages: [
							{
								id: "u1",
								role: "user",
								content: "Please remember that I prefer to be called Float and I am a Debian user.",
								timestamp: new Date().toISOString(),
								recordedAtMs: 1000,
							},
							{
								id: "a1",
								role: "assistant",
								content: "I will call you Float and keep your Debian preference in mind.",
								timestamp: new Date().toISOString(),
								recordedAtMs: 1001,
							},
						],
					},
				],
			} as never,
			logger,
			llmRunner: {
				run: async () => {
					throw new Error("model request failed");
				},
			} as never,
		});
		try {
			await expect(runner({ sessionKey: "memory-a" })).rejects.toThrow(
				"memory_l1_extraction_incomplete",
			);
			expect(mark).not.toHaveBeenCalled();
			expect(checkpoint.getRunnerState(await checkpoint.read(), "memory-a").last_l1_cursor).toBe(0);
		} finally {
			mark.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});
});
