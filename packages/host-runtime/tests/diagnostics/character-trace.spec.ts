import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CharacterTrace,
	DEFAULT_TRACE_POLICY,
	diagnosticValue,
} from "../../src/diagnostics/character-trace.js";

const roots: string[] = [];
async function make(id = "role-a") {
	const root = await mkdtemp(join(tmpdir(), "bear-character-trace-"));
	roots.push(root);
	return new CharacterTrace(root, id);
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("character-local diagnostic evidence", () => {
	it("lists healthy traces even when a failed write left an empty trace directory", async () => {
		const recorder = await make();
		const incomplete = "a".repeat(32);
		recorder.emit("test.healthy", "info");
		await recorder.flush();
		await mkdir(join(recorder.root, "traces", incomplete, "payloads"), { recursive: true });
		expect(await recorder.list()).toHaveLength(2);
		await expect(recorder.read(incomplete)).rejects.toThrow();
		await recorder.close();
	});
	it("preserves long payloads, IDs and nested credentials without truncation", async () => {
		const recorder = await make();
		const input = "正文".repeat(10_000);
		await recorder.operation(
			"memory.search",
			{ conversationId: "session-a" },
			{ input, apiKey: "hidden", nested: { password: "hidden2" } },
			async () => ({ count: 0 }),
		);
		const traces = await recorder.list();
		expect(traces).toHaveLength(1);
		const records = (await recorder.read(traces[0]!.traceId))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.event)).toEqual([
			"memory.search.start",
			"memory.search.end",
		]);
		expect(records[0].spanId).toBe(records[1].spanId);
		expect(records[1].attributes).toMatchObject({ outcome: "ok" });
		const payload = await recorder.payload(traces[0]!.traceId, records[0].payload.sha256);
		expect(JSON.parse(payload).input).toBe(input);
		expect(payload).not.toContain("hidden");
		expect(recorder.health()).toMatchObject({ written: 2, dropped: 0, writeFailures: 0 });
		await recorder.close();
	});
	it("keeps concurrent native sessions isolated without reading them as runtime state", async () => {
		const recorder = await make();
		recorder.native("a", { type: "agent_start" });
		recorder.native("b", { type: "agent_start" });
		recorder.native("b", { type: "agent_end" });
		recorder.native("a", { type: "agent_end" });
		const traces = await recorder.list();
		expect(traces).toHaveLength(2);
		for (const trace of traces) {
			const events = (await recorder.read(trace.traceId))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(new Set(events.map((event) => event.conversationId)).size).toBe(1);
			expect(events.at(-1).attributes.outcome).toBe("settled");
		}
		await recorder.close();
	});
	it("records failure cause and preserves operation rejection", async () => {
		const recorder = await make();
		await expect(
			recorder.operation("memory.capture", {}, undefined, async () => {
				throw new Error("capture failed", { cause: new Error("disk full") });
			}),
		).rejects.toThrow("capture failed");
		const [trace] = await recorder.list();
		const content = await recorder.read(trace!.traceId);
		expect(content).toContain("disk full");
		expect(content).toContain('"outcome":"error"');
		await recorder.close();
	});
	it("applies level, metadata policy and temporary TRACE expiry independently", async () => {
		const base = await make();
		let policy = {
			...DEFAULT_TRACE_POLICY,
			level: "info" as const,
			payload: "metadata" as const,
			traceUntil: Date.now() + 10000,
		};
		const recorder = new CharacterTrace(base.root, "role-a", () => policy);
		recorder.emit("pi.message_update", "trace", {}, {}, { secretConversation: "private" });
		policy = { ...policy, traceUntil: 0 };
		recorder.emit("pi.message_update", "trace");
		await recorder.flush();
		const [trace] = await recorder.list();
		const content = await recorder.read(trace!.traceId);
		expect(content.trim().split("\n")).toHaveLength(1);
		expect(content).not.toContain('"payload":');
		expect(content).toContain('"payloadPolicy":"metadata"');
		await recorder.close();
	});
	it("reports overflow instead of silently truncating", async () => {
		const recorder = await make();
		recorder.emit("test.large", "info", {}, {}, "x".repeat(17 * 1024 * 1024));
		expect(recorder.health().dropped).toBe(1);
		expect(await recorder.list()).toEqual([]);
		await recorder.close();
	});
	it("rejects foreign IDs, traversal and corrupted payloads", async () => {
		const recorder = await make();
		const other = await make("role-b");
		await recorder.operation("test.payload", {}, "private-a", async () => undefined);
		const [trace] = await recorder.list();
		await expect(other.read(trace!.traceId)).rejects.toThrow();
		await expect(recorder.read("../outside")).rejects.toThrow("invalid trace id");
		const event = JSON.parse((await recorder.read(trace!.traceId)).split("\n")[0]!);
		await writeFile(
			join(recorder.root, "traces", trace!.traceId, "payloads", `${event.payload.sha256}.json`),
			"corrupted",
		);
		await expect(recorder.payload(trace!.traceId, event.payload.sha256)).rejects.toThrow();
		await recorder.close();
		await other.close();
	});
	it("protects active traces and prunes whole completed traces", async () => {
		const base = await make();
		const recorder = new CharacterTrace(base.root, "role-a", () => ({
			...DEFAULT_TRACE_POLICY,
			maxBytes: 1,
		}));
		const span = recorder.span("test.active");
		await recorder.flush();
		await recorder.prune();
		expect(await recorder.list()).toHaveLength(1);
		span.end("ok");
		await recorder.flush();
		await recorder.prune();
		expect(await recorder.list()).toEqual([]);
		await recorder.close();
	});
	it("refuses symlink destinations and exposes write failure health", async () => {
		const recorder = await make();
		const other = await make();
		await symlink(other.root, join(recorder.root, "traces"));
		recorder.emit("test.failure", "info");
		await recorder.flush();
		expect(recorder.health().writeFailures).toBeGreaterThan(0);
		expect(await other.list()).toEqual([]);
		await recorder.close();
	});
	it("sanitizes error objects and circular data without losing ordinary paths", () => {
		const object: Record<string, unknown> = {
			path: "/home/float/Documents",
			authorization: "Bearer abc",
			error: new Error("password=hidden"),
		};
		object.self = object;
		const text = JSON.stringify(diagnosticValue(object));
		expect(text).toContain("/home/float/Documents");
		expect(text).toContain("[Circular]");
		expect(text).not.toContain("hidden");
		expect(text).not.toContain("Bearer abc");
	});
	it("writes owner-only files", async () => {
		const recorder = await make();
		recorder.emit("test.owner", "info");
		await recorder.close();
		const [trace] = await recorder.list();
		expect(
			await readFile(join(recorder.root, "traces", trace!.traceId, "events.jsonl"), "utf8"),
		).toContain('"companionId":"role-a"');
	});
});
