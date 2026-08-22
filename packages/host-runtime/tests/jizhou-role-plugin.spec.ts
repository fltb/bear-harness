// @vitest-environment node

import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

interface RegisteredTool {
	name: string;
	parameters: { properties: { action: { enum: string[] } } };
	execute(toolCallId: string, parameters: { action: string }): Promise<{ details: unknown }>;
}

const pluginUrl = pathToFileURL(
	new URL("../../../config/characters/jizhou/plugins/jizhou-roleplay.mjs", import.meta.url)
		.pathname,
).href;

afterEach(() => Reflect.deleteProperty(globalThis, "bearHostCall"));

async function loadTool(): Promise<RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const plugin = (await import(pluginUrl)).default as (pi: {
		registerTool(tool: RegisteredTool): void;
	}) => void;
	plugin({ registerTool: (tool) => tools.set(tool.name, tool) });
	const tool = tools.get("jizhou_continuity_reveal");
	if (!tool) throw new Error("missing continuity tool");
	expect([...tools.keys()]).toEqual(["jizhou_continuity_reveal"]);
	return tool;
}

describe("Jizhou role plugin", () => {
	it("registers closed semantic actions and maps advance to the allowlisted Host event", async () => {
		const hostCall = vi.fn(async (name: string) =>
			name === "host_get_roleplay_state"
				? { ok: true, data: { values: { continuity_stage: 1 } } }
				: { ok: true, message: "accepted" },
		);
		Reflect.set(globalThis, "bearHostCall", hostCall);
		const tool = await loadTool();

		expect(tool.parameters.properties.action.enum).toEqual([
			"inspect",
			"advance",
			"receive",
			"set_down",
		]);
		const advance = await tool.execute("call-1", { action: "advance" });
		expect(advance.details).toMatchObject({
			stage: 1,
			status: "read",
			queued: "continuity_revealed",
		});
		expect(hostCall.mock.calls).toEqual([
			["host_get_roleplay_state", {}],
			["host_trigger_roleplay_event", { eventId: "continuity_revealed" }],
		]);
	});

	it("keeps the reveal sealed until the state reaches its disclosure stage", async () => {
		Reflect.set(
			globalThis,
			"bearHostCall",
			vi.fn(async () => ({ ok: true, data: { values: { continuity_stage: 0 } } })),
		);
		const tool = await loadTool();
		const inspected = await tool.execute("call-1", { action: "inspect" });
		expect(inspected.details).toMatchObject({
			stage: 0,
			status: "sealed",
			allowedActions: ["advance"],
			fact: expect.not.stringContaining("我不是旧极昼"),
		});
		await expect(tool.execute("call-2", { action: "receive" })).rejects.toThrow(
			"not allowed at continuity stage 0",
		);
	});

	it("surfaces Host rejection instead of narrating a false state change", async () => {
		Reflect.set(
			globalThis,
			"bearHostCall",
			vi.fn(async (name: string) => {
				if (name === "host_get_roleplay_state")
					return { ok: true, data: { values: { continuity_stage: 2 } } };
				return { ok: false, message: "event condition failed" };
			}),
		);
		const tool = await loadTool();
		await expect(tool.execute("call-1", { action: "receive" })).rejects.toThrow(
			"event condition failed",
		);
	});
});
