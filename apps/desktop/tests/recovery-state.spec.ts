import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecoveryStateStore } from "../src/main/recovery-state.js";

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-recovery-state-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RecoveryStateStore", () => {
	it("persists and resolves the current filesystem incident shape", () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "recovery"), {
			now: () => new Date("2026-09-01T00:00:00.000Z"),
		});
		const created = store.upsert({
			id: "replace-character",
			kind: "filesystem_recovery",
			operation: "replace",
			targetPath: join(root, "characters", "jizhou"),
			journalPath: join(root, "journal.json"),
			reason: "Interrupted durable replacement",
		});
		expect(created).toMatchObject({
			status: "ok",
			record: { kind: "filesystem_recovery", status: "pending" },
		});
		const resolved = store.resolveVerified("replace-character", "retry");
		expect(resolved).toMatchObject({ status: "ok", record: { status: "resolved" } });
	});

	it("preserves malformed records and reports recovery required", () => {
		const root = temporaryRoot();
		const recovery = join(root, "recovery");
		mkdirSync(recovery);
		writeFileSync(join(recovery, "broken.json"), "{not-json}\n");
		const store = new RecoveryStateStore(recovery);
		expect(store.get("broken")).toMatchObject({
			status: "recovery_required",
			reason: "malformed_record",
		});
	});

	it("rejects a store nested inside product data", () => {
		const root = temporaryRoot();
		expect(
			() =>
				new RecoveryStateStore(join(root, "product", "recovery"), {
					productDataRoots: [join(root, "product")],
				}),
		).toThrow(/outside product data roots/);
	});
});
