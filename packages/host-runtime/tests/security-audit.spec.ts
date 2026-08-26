// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AuditKind,
	AuditStore,
	auditKindForEvent,
	wireAuditToEvents,
} from "../src/security/audit-store.js";

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const HASH_EMPTY = sha256("");

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "audit-"));
	dirs.push(dir);
	return dir;
}

function segmentFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => /^segment-\d+\.jsonl$/.test(name))
		.sort();
}

function readRecords(dir: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const name of segmentFiles(dir)) {
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (line.trim() !== "") out.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return out;
}

function makeStore(
	dir: string,
	overrides: ConstructorParameters<typeof AuditStore>[0] = { dir },
): AuditStore {
	return new AuditStore({ dir, ...overrides });
}

describe("AuditStore hash chain", () => {
	it("appends records with a verified hash chain and 0o600 segments", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.append("permission", "requested", '{"runId":"r1"}');
		await store.append("run", "started", '{"runId":"r1"}');
		await store.append("memory", "state_changed", '{"conversationId":"v1"}');

		const records = readRecords(dir);
		expect(records).toHaveLength(3);
		expect(records[0]!.prevHash).toBe(HASH_EMPTY);
		for (let i = 0; i < records.length; i += 1) {
			const r = records[i]!;
			if (i > 0) expect(r.prevHash).toBe(records[i - 1]!.hash);
			const expected = sha256(
				`${r.seq}|${r.kind}|${r.action}|${r.detail}|${r.createdAt}|${r.prevHash}`,
			);
			expect(r.hash).toBe(expected);
		}
		const mode = statSync(join(dir, segmentFiles(dir)[0]!)).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("list orders newest-first and honors afterSeq and limit", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		for (let i = 0; i < 5; i += 1) await store.append("run", "started", `{"runId":"r${i}"}`);

		const all = await store.list();
		expect(all.entries.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
		expect(all.oldestSeq).toBe(1);

		const after = await store.list({ afterSeq: 2 });
		expect(after.entries.map((e) => e.seq)).toEqual([5, 4, 3]);
		expect(after.oldestSeq).toBe(1);

		const limited = await store.list({ limit: 2 });
		expect(limited.entries.map((e) => e.seq)).toEqual([5, 4]);

		const none = await store.list({ afterSeq: 5 });
		expect(none.entries).toEqual([]);
		expect(none.oldestSeq).toBe(1);
	});

	it("export verifies the chain; tampering any line breaks it", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.append("run", "started", "a");
		await store.append("permission", "granted", "b");
		await store.append("run", "completed", "c");

		const clean = await store.exportLines();
		expect(clean.verified).toBe(true);
		expect(clean.lines.split("\n").filter((l) => l.trim())).toHaveLength(3);

		// Tamper with the FIRST record's detail in place.
		const firstFile = join(dir, segmentFiles(dir)[0]!);
		const lines = readFileSync(firstFile, "utf8").split("\n");
		const tampered = JSON.parse(lines[0]!) as Record<string, unknown>;
		tampered.detail = "tampered";
		lines[0] = JSON.stringify(tampered);
		writeFileSync(firstFile, lines.join("\n"), "utf8");

		const broken = await store.exportLines();
		expect(broken.verified).toBe(false);
	});

	it("rotates segments when the current segment would exceed maxBytesPerSegment", async () => {
		const dir = tempDir();
		// A 1-byte budget forces a rotation before every append: each record
		// lands in its own segment and the chain spans the rotation.
		const store = makeStore(dir, { maxBytesPerSegment: 1 });
		for (let i = 0; i < 5; i += 1) {
			await store.append("run", "started", `{"runId":"r${i}"}`);
		}
		expect(segmentFiles(dir)).toHaveLength(5);

		const all = await store.list();
		expect(all.entries.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
		expect((await store.exportLines()).verified).toBe(true);
	});

	it("truncates detail to stay within the protocol string budget", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		const record = await store.append("config", "changed", "x".repeat(10_000));
		expect(record.detail.length).toBeLessThanOrEqual(4096);
		expect(record.action.length).toBeLessThanOrEqual(128);
	});

	it("rejects invalid kinds and restores seq/hash continuity across restarts", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.append("run", "started", "a");
		await store.append("run", "completed", "b");
		expect(() => store.append("bogus" as AuditKind, "x", "y")).toThrow(TypeError);

		// A fresh instance over the same dir continues the chain.
		const restarted = makeStore(dir);
		const next = await restarted.append("run", "cancelled", "c");
		expect(next.seq).toBe(3);
		const records = readRecords(dir);
		expect(records[2]!.prevHash).toBe(records[1]!.hash);
		expect((await restarted.exportLines()).verified).toBe(true);
	});
});

describe("AuditStore retention", () => {
	it("prunes segments older than maxAgeDays but never the active segment", async () => {
		const dir = tempDir();
		let now = new Date();
		const store = makeStore(dir, {
			maxBytesPerSegment: 1, // 3 appends → 3 segments
			maxAgeDays: 90,
			now: () => now,
		});
		await store.append("run", "started", "a");
		await store.append("run", "started", "b");
		await store.append("run", "started", "c");
		expect(segmentFiles(dir)).toHaveLength(3);

		now = new Date(now.getTime() + 91 * 86_400_000);
		const result = await store.prune();
		expect(result.prunedFiles).toHaveLength(2);
		expect(segmentFiles(dir)).toHaveLength(1);
		const all = await store.list();
		expect(all.entries.map((e) => e.seq)).toEqual([3]);
		expect(all.oldestSeq).toBe(3);
	});

	it("prunes oldest segments while total bytes exceed maxTotalBytes", async () => {
		const dir = tempDir();
		const now = new Date();
		const store = makeStore(dir, {
			maxBytesPerSegment: 1,
			maxTotalBytes: 700,
			now: () => now,
		});
		for (let i = 0; i < 3; i += 1) await store.append("run", "started", "x".repeat(80));
		expect(segmentFiles(dir)).toHaveLength(3);

		const result = await store.prune();
		expect(result.prunedFiles.length).toBeGreaterThanOrEqual(1);
		expect(result.remainingBytes).toBeLessThanOrEqual(700);
		expect(segmentFiles(dir).length).toBeGreaterThanOrEqual(1);
		const all = await store.list();
		expect(all.entries.length).toBeGreaterThanOrEqual(1);
		expect(all.oldestSeq).toBeGreaterThan(0);
	});

	it("keeps the active segment even when a single segment exceeds the budget", async () => {
		const dir = tempDir();
		const store = makeStore(dir, { maxBytesPerSegment: 1, maxTotalBytes: 1 });
		await store.append("run", "started", "x".repeat(200));
		const result = await store.prune();
		expect(result.prunedFiles).toEqual([]);
		expect(segmentFiles(dir)).toHaveLength(1);
		expect((await store.list()).entries).toHaveLength(1);
	});
});

describe("wireAuditToEvents", () => {
	it("maps event kinds to audit entries and ignores unrelated events", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		let listener: ((event: { kind: string; payload: unknown }) => void) | undefined;
		const eventBus = {
			subscribe: (fn: (event: { kind: string; payload: unknown }) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		};
		const unsubscribe = wireAuditToEvents(store, eventBus);
		expect(typeof unsubscribe).toBe("function");

		listener!({ kind: "run.started", payload: { runId: "r1" } });
		listener!({ kind: "run.interrupted", payload: { runId: "r1" } });
		listener!({
			kind: "evidence.collected",
			payload: { runId: "r1", evidenceId: "e1", kind: "file" },
		});
		listener!({ kind: "roleplay.state_changed", payload: { conversationId: "v1" } });
		listener!({ kind: "message.user_sent", payload: { text: "hi" } }); // not audited

		// Appends are serialized in-process; awaiting a marker append guarantees
		// every earlier event append has been written.
		await store.append("config", "marker", "x");
		const { entries } = await store.list();
		expect(entries.filter((e) => e.action !== "marker").map((e) => [e.kind, e.action])).toEqual([
			["memory", "state_changed"],
			["run", "collected"],
			["run", "interrupted"],
			["run", "started"],
		]);
	});

	it("auditKindForEvent covers the documented mapping", () => {
		expect(auditKindForEvent("commission.approved")).toBeNull();
		expect(auditKindForEvent("run.completed")).toBe("run");
		expect(auditKindForEvent("evidence.collected")).toBe("run");
		expect(auditKindForEvent("roleplay.unlocks_reset")).toBe("memory");
		expect(auditKindForEvent("message.user_sent")).toBeNull();
	});
});
