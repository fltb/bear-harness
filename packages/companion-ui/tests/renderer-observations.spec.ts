import { expect, it } from "vitest";
import {
	createRendererDiagnostics,
	type RendererObservation,
} from "../src/lib/renderer-diagnostics.js";

it("bounds pending diagnostics while transport is stalled and never fails projection", async () => {
	let release: (() => void) | undefined;
	const sent: RendererObservation[][] = [];
	const recorder = createRendererDiagnostics(async (records) => {
		sent.push(records);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	const record: RendererObservation = {
		conversationId: "a",
		event: "received",
		at: new Date().toISOString(),
	};
	for (let i = 0; i < 200; i++) recorder.record(record);
	expect(sent).toHaveLength(1);
	expect(recorder.health()).toEqual({ buffered: 128, dropped: 40 });
	release?.();
	await Promise.resolve();
	await Promise.resolve();
	recorder.dispose();
	expect(recorder.health().buffered).toBe(0);
});

it("contains transport failures and clears the buffer after disposal", async () => {
	const recorder = createRendererDiagnostics(async () => {
		throw new Error("disconnected");
	});
	recorder.record({
		conversationId: "a",
		event: "scroll",
		at: new Date().toISOString(),
		distance: 0,
	});
	await recorder.flush();
	expect(recorder.health()).toEqual({ buffered: 0, dropped: 1 });
	recorder.dispose();
	recorder.record({ conversationId: "a", event: "fault", at: new Date().toISOString() });
	expect(recorder.health().buffered).toBe(0);
});

it("attaches recent observations to faults and resets history across characters", async () => {
	const sent: RendererObservation[][] = [];
	const recorder = createRendererDiagnostics(async (records) => {
		sent.push(records);
	});
	recorder.scope("role-a");
	recorder.record({
		conversationId: "a",
		event: "projected",
		at: new Date().toISOString(),
		sequence: 1,
	});
	await recorder.flush();
	recorder.record({
		conversationId: "a",
		event: "fault",
		at: new Date().toISOString(),
		error: { name: "TypeError", message: "actual error", stack: "stack" },
	});
	await recorder.flush();
	expect(sent[1]?.map((record) => record.event)).toEqual(["projected", "fault"]);
	recorder.scope("role-b");
	recorder.record({ conversationId: "b", event: "fault", at: new Date().toISOString() });
	await recorder.flush();
	expect(sent[2]?.map((record) => record.conversationId)).toEqual(["b"]);
	recorder.record({
		conversationId: "b",
		event: "fault",
		at: new Date().toISOString(),
		error: { name: "Error", message: "x".repeat(65537) },
	});
	expect(recorder.health().dropped).toBe(1);
	recorder.dispose();
});
