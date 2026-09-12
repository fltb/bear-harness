import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterTrace, DEFAULT_TRACE_POLICY } from "../../src/diagnostics/character-trace.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function make() {
	const root = await mkdtemp(join(tmpdir(), "bear-trace-search-"));
	roots.push(root);
	return new CharacterTrace(root, "a");
}

it("fails shutdown within its deadline without reporting a clean flush", async () => {
	const recorder = await make();
	recorder.emit("test.shutdown", "info");
	await recorder.flush();
	let release: (() => void) | undefined;
	const flushing = vi.spyOn(recorder, "flush").mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await expect(recorder.close(10)).rejects.toThrow("diagnostic_shutdown_timeout");
	expect(
		JSON.parse(await readFile(join(recorder.root, "metrics", `${recorder.launchId}.json`), "utf8"))
			.clean,
	).toBe(false);
	release?.();
	flushing.mockRestore();
	await recorder.close();
});

it("rebuilds character-local search metadata and paginates without repeating traces", async () => {
	const recorder = await make();
	for (let i = 0; i < 5; i++)
		await recorder.operation("test.search", { conversationId: `c${i}` }, undefined, async () => i);
	const first = await recorder.query({ limit: 2 });
	expect(first.traces).toHaveLength(2);
	const second = await recorder.query({ limit: 2, before: first.next });
	expect(second.traces).toHaveLength(2);
	expect(new Set([...first.traces, ...second.traces].map((trace) => trace.traceId)).size).toBe(4);
	expect(
		(await recorder.query({ conversationId: "c3", event: "test.search.end", level: "info" }))
			.traces,
	).toHaveLength(1);
	await recorder.close();
	await rm(join(recorder.root, "search.db"));
	const reopened = new CharacterTrace(recorder.root, "a");
	expect((await reopened.query()).traces).toHaveLength(5);
	await reopened.close();
	await writeFile(join(recorder.root, "search.db"), "corrupt disposable index");
	const repaired = new CharacterTrace(recorder.root, "a");
	expect((await repaired.query()).traces).toHaveLength(5);
	await repaired.close();
});

it("reads bounded UTF-8 pages and rejects unaligned cursors", async () => {
	const recorder = await make();
	const span = recorder.span("test.pages");
	for (let i = 0; i < 210; i++)
		span.run(() => recorder.emit("test.row", "info", { i, text: "极昼" }));
	span.end("ok");
	const page = await recorder.page(span.context.traceId);
	expect(page.content.trim().split("\n")).toHaveLength(200);
	expect(page.next).toBeGreaterThan(0);
	const remaining = await recorder.page(span.context.traceId, page.next);
	expect(remaining.content.trim().split("\n")).toHaveLength(12);
	expect(remaining.next).toBeUndefined();
	await expect(recorder.page(span.context.traceId, 1)).rejects.toThrow("record boundary");
	await recorder.close();
});

it("retains pinned incidents and records duration histograms independently of level", async () => {
	const base = await make();
	const recorder = new CharacterTrace(base.root, "a", () => ({
		...DEFAULT_TRACE_POLICY,
		maxBytes: 1,
	}));
	const span = recorder.span("test.failure");
	await recorder.flush();
	await recorder.pin(span.context.traceId, true);
	span.end("error", new Error("disk unavailable"));
	await recorder.flush();
	await recorder.prune();
	expect(
		JSON.parse(
			await readFile(join(base.root, "traces", span.context.traceId, "incident.json"), "utf8"),
		).reason,
	).toBe("test.failure.end");
	expect(recorder.metrics().durations["test.failure"]?.count).toBe(1);
	await recorder.pin(span.context.traceId, false);
	await recorder.prune();
	await expect(recorder.read(span.context.traceId)).rejects.toThrow();
	await recorder.close();
});

it("exports paginated evidence with complete verified payloads", async () => {
	const recorder = await make();
	const span = recorder.span("test.export", {}, { text: "hello", password: "credential" });
	for (let i = 0; i < 205; i++) span.run(() => recorder.emit("test.export_row", "info", { i }));
	span.end("ok");
	const first = await recorder.exportPage(span.context.traceId);
	const bundle = JSON.parse(first.content);
	expect(bundle.events).toHaveLength(200);
	expect(first.content).not.toContain("credential");
	expect(Object.values(bundle.payloads)).toHaveLength(1);
	const second = await recorder.exportPage(span.context.traceId, first.next);
	expect(JSON.parse(second.content).events.at(-1).event).toBe("test.export.end");
	expect(second.next).toBeUndefined();
	await recorder.close();
});

it("associates an unclean dead launch with the system crash identity", async () => {
	const recorder = await make();
	await mkdir(join(recorder.root, "metrics"));
	const launchId = "12345678-1234-1234-1234-123456789012";
	await writeFile(
		join(recorder.root, "metrics", `${launchId}.json`),
		JSON.stringify({
			companionId: "a",
			pid: 1073741824,
			clean: false,
			launchId,
			systemLaunchId: "system-crash",
			dropped: 2,
			writeFailures: 0,
		}),
	);
	recorder.emit("test.restart", "info");
	const traces = await recorder.query({ event: "diagnostics.previous_exit" });
	expect(traces.traces).toHaveLength(1);
	const first = traces.traces[0];
	if (!first) throw new Error("missing recovery trace");
	expect(await recorder.read(first.traceId)).toContain("system-crash");
	await recorder.close();
});

it("counts disk-full failures without changing the instrumented operation result", async () => {
	const recorder = await make();
	const append = vi
		.spyOn(recorder as unknown as { append(path: string, body: string): Promise<void> }, "append")
		.mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
	expect(await recorder.operation("test.disk", {}, {}, async () => "model result")).toBe(
		"model result",
	);
	await recorder.flush();
	expect(recorder.health().writeFailures).toBe(2);
	expect(recorder.health().written).toBe(0);
	append.mockRestore();
	await recorder.close();
});

it("exports a trace larger than the old inline limit at a fixed snapshot boundary", async () => {
	const recorder = await make();
	const span = recorder.span("test.large");
	for (let i = 0; i < 180; i++)
		span.run(() => recorder.emit("test.large_row", "info", { i, text: "内容".repeat(10000) }));
	span.end("ok");
	await recorder.flush();
	expect(recorder.health().dropped).toBe(0);
	await expect(recorder.read(span.context.traceId)).rejects.toThrow("inline read limit");
	let part = await recorder.exportPage(span.context.traceId);
	const snapshotEnd = part.end;
	span.run(() => recorder.emit("test.after_snapshot", "info"));
	let count = 0;
	while (true) {
		const bundle = JSON.parse(part.content);
		count += bundle.events.length;
		expect(part.content).not.toContain("test.after_snapshot");
		expect(Buffer.byteLength(part.content)).toBeLessThan(2 * 1024 * 1024);
		if (part.next === undefined) break;
		part = await recorder.exportPage(span.context.traceId, part.next, snapshotEnd);
	}
	expect(count).toBe(182);
	await recorder.close();
});
