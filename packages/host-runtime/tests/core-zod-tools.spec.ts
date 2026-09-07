// @vitest-environment node

import { z } from "@bear-harness/schema";
import { describe, expect, it, vi } from "vitest";
import { toCoreTool } from "../src/companion/core-zod-tools.js";

describe("Zod Core tool adapter", () => {
	it("uses Zod as the execution authority while exposing JSON Schema to the model", async () => {
		const execute = vi.fn(async (_id: string, params: { sceneId: string }) => ({
			content: [{ type: "text" as const, text: params.sceneId }],
			details: params,
		}));
		const tool = toCoreTool({
			name: "host_state",
			label: "Set scene",
			description: "Set a declared scene.",
			schema: z.strictObject({ sceneId: z.string().min(1).max(64) }),
			execute,
		});
		expect(tool.parameters).toMatchObject({ type: "object", required: ["sceneId"] });
		await expect(tool.execute("call-1", { sceneId: "snow_plains" })).resolves.toMatchObject({
			details: { sceneId: "snow_plains" },
		});
		expect(execute).toHaveBeenCalledWith("call-1", { sceneId: "snow_plains" }, undefined);
		expect(() => tool.execute("call-2", { sceneId: "" })).toThrow();
	});

	it("marks object unions as object tool parameters without replacing library conversion", () => {
		const tool = toCoreTool({
			name: "role_skill",
			label: "Character skill",
			description: "List or read a skill.",
			schema: z.discriminatedUnion("action", [
				z.strictObject({ action: z.literal("list") }),
				z.strictObject({ action: z.literal("read"), skillId: z.string().min(1) }),
			]),
			execute: vi.fn(async () => ({ content: [], details: {} })),
		});
		expect(tool.parameters).toMatchObject({ type: "object", oneOf: expect.any(Array) });
	});
});
