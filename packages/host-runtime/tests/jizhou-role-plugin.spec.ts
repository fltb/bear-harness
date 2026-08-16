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

async function loadTools(): Promise<Map<string, RegisteredTool>> {
	const tools = new Map<string, RegisteredTool>();
	const plugin = (await import(pluginUrl)).default as (pi: {
		registerTool(tool: RegisteredTool): void;
	}) => void;
	plugin({ registerTool: (tool) => tools.set(tool.name, tool) });
	return tools;
}

describe("Jizhou role plugin", () => {
	it("registers closed semantic actions and maps them to allowlisted Host calls", async () => {
		const hostCall = vi.fn(async (tool: string) =>
			tool === "host_get_roleplay_state"
				? {
						ok: true,
						message: "state",
						data: { values: { damaged_log_stage: 1, damaged_log_snapshot_preserved: false } },
					}
				: { ok: true, message: "accepted" },
		);
		Reflect.set(globalThis, "bearHostCall", hostCall);
		const tools = await loadTools();

		expect([...tools.keys()]).toEqual(["jizhou_damaged_log", "jizhou_media_cue"]);
		expect(tools.get("jizhou_media_cue")?.parameters.properties.action.enum).toEqual([
			"first_night",
			"damaged_signal",
			"damaged_log_choice",
		]);
		expect(tools.get("jizhou_damaged_log")?.parameters.properties.action.enum).toEqual([
			"inspect",
			"advance",
			"respond",
			"preserve",
		]);

		const advance = await tools.get("jizhou_damaged_log")?.execute("call-1", {
			action: "advance",
		});
		await tools.get("jizhou_media_cue")?.execute("call-2", { action: "damaged_signal" });

		expect(advance?.details).toMatchObject({
			stage: 1,
			status: "copy_preserved",
			allowedActions: ["advance"],
			queued: "damaged_log_pulse_isolated",
		});
		expect(hostCall.mock.calls).toEqual([
			["host_get_roleplay_state", {}],
			["host_trigger_roleplay_event", { eventId: "damaged_log_pulse_isolated" }],
			["host_play_media", { mediaId: "damaged_signal_live" }],
		]);
	});

	it("returns an explicit step card and rejects actions outside that stage", async () => {
		Reflect.set(
			globalThis,
			"bearHostCall",
			vi.fn(async () => ({
				ok: true,
				data: { values: { damaged_log_stage: 0 } },
			})),
		);
		const tools = await loadTools();
		const inspected = await tools.get("jizhou_damaged_log")?.execute("call-1", {
			action: "inspect",
		});
		expect(inspected?.details).toMatchObject({
			stage: 0,
			status: "unopened",
			allowedActions: ["advance"],
			next: expect.stringContaining("advance"),
		});
		await expect(
			tools.get("jizhou_damaged_log")?.execute("call-2", { action: "respond" }),
		).rejects.toThrow("not allowed at damaged-log stage 0");
	});

	it("surfaces Host rejection instead of narrating a false state change", async () => {
		Reflect.set(
			globalThis,
			"bearHostCall",
			vi.fn(async (tool: string) => {
				if (tool === "host_get_roleplay_state")
					return { ok: true, data: { values: { damaged_log_stage: 2 } } };
				return { ok: false, message: "event condition failed" };
			}),
		);
		const tools = await loadTools();
		await expect(
			tools.get("jizhou_damaged_log")?.execute("call-1", { action: "respond" }),
		).rejects.toThrow("event condition failed");
	});
});
