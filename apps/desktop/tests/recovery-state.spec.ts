import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type RecoveryIncidentInput,
	RecoveryStateStore,
	RecoveryStateValidationError,
} from "../src/main/recovery-state.js";

const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "bear-recovery-state-"));
	roots.push(root);
	return root;
}

function incidentInput(root: string, id: string): RecoveryIncidentInput {
	return {
		id,
		kind: "filesystem_recovery",
		operation: "replace",
		targetPath: join(root, "data", "character"),
		journalPath: join(root, "journal.json"),
		reason: "Interrupted durable replacement",
	};
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

	it("rejects a symlink that places recovery records inside product data", () => {
		const root = temporaryRoot();
		const product = join(root, "product");
		mkdirSync(product);
		symlinkSync(product, join(root, "recovery"), "dir");
		const store = new RecoveryStateStore(join(root, "recovery"), {
			productDataRoots: [product],
		});

		expect(() => store.upsert(incidentInput(root, "incident"))).toThrow(
			RecoveryStateValidationError,
		);
		expect(existsSync(join(product, "incident.json"))).toBe(false);
	});

	it("keeps incident history monotonic and resolved incidents closed across restart and replay", () => {
		const root = temporaryRoot();
		const recovery = join(root, "recovery");
		let now = new Date("2026-09-03T00:00:00.000Z");
		const store = new RecoveryStateStore(recovery, { now: () => now });
		const input = incidentInput(root, "incident");
		store.upsert(input);
		now = new Date("2026-09-04T00:00:00.000Z");
		store.upsert({ ...input, reason: "Replacement still needs verification" });
		now = new Date("2026-09-02T00:00:00.000Z");
		store.upsert({ ...input, operation: "move" });
		expect(store.resolveVerified(input.id, "retry")).toMatchObject({
			status: "ok",
			changed: true,
			record: {
				status: "resolved",
				createdAt: "2026-09-03T00:00:00.000Z",
				updatedAt: "2026-09-04T00:00:00.000Z",
				resolvedAt: "2026-09-04T00:00:00.000Z",
			},
		});
		const committed = readFileSync(join(recovery, "incident.json"), "utf8");
		const reopened = new RecoveryStateStore(recovery);
		expect(reopened.upsert({ ...input, operation: "delete" })).toMatchObject({
			status: "ok",
			changed: false,
			record: { status: "resolved", operation: "move" },
		});
		expect(reopened.resolveVerified(input.id, "safe_reset")).toMatchObject({
			status: "ok",
			changed: false,
		});
		expect(readFileSync(join(recovery, "incident.json"), "utf8")).toBe(committed);
	});

	it("lists intact incidents alongside preserved corruption and discards only abandoned regular temporary files", () => {
		const root = temporaryRoot();
		const recovery = join(root, "recovery");
		const store = new RecoveryStateStore(recovery, {
			productDataRoots: [join(root, "not-created-yet")],
			now: () => new Date("2026-09-01T00:00:00.000Z"),
		});
		store.upsert(incidentInput(root, "pending"));
		store.upsert(incidentInput(root, "resolved"));
		store.resolveVerified("resolved", "retry");
		const pendingBytes = readFileSync(join(recovery, "pending.json"), "utf8");
		writeFileSync(join(recovery, "wrong-owner.json"), pendingBytes);
		writeFileSync(join(recovery, "pending.json.tmp"), "partial next write");
		writeFileSync(join(recovery, "notes.txt"), "leave unrelated files alone");
		mkdirSync(join(recovery, "blocked.json.tmp"));
		mkdirSync(join(recovery, "directory.json"));

		const result = store.list();
		expect(result).toMatchObject({
			status: "recovery_required",
			records: [
				{ id: "pending", status: "pending" },
				{ id: "resolved", status: "resolved" },
			],
		});
		if (result.status !== "recovery_required") throw new Error("Expected preserved corruption");
		expect(result.issues.map((issue) => issue.id).sort()).toEqual([
			"blocked",
			"directory",
			"wrong-owner",
		]);
		expect(existsSync(join(recovery, "pending.json.tmp"))).toBe(false);
		expect(readFileSync(join(recovery, "pending.json"), "utf8")).toBe(pendingBytes);
		expect(readFileSync(join(recovery, "wrong-owner.json"), "utf8")).toBe(pendingBytes);
		expect(readFileSync(join(recovery, "notes.txt"), "utf8")).toBe("leave unrelated files alone");
		expect(existsSync(join(recovery, "blocked.json.tmp"))).toBe(true);
	});

	it("recovers the committed record rather than an interrupted write when reading one incident", () => {
		const root = temporaryRoot();
		const recovery = join(root, "recovery");
		const store = new RecoveryStateStore(recovery);
		store.upsert(incidentInput(root, "incident"));
		writeFileSync(join(recovery, "incident.json.tmp"), '{"status":"resolved"');

		expect(new RecoveryStateStore(recovery).get("incident")).toMatchObject({
			status: "ok",
			record: { status: "pending" },
		});
		expect(existsSync(join(recovery, "incident.json.tmp"))).toBe(false);
	});

	it("preserves a suspicious temporary symlink and refuses to overwrite or resolve its incident", () => {
		const root = temporaryRoot();
		const recovery = join(root, "recovery");
		const store = new RecoveryStateStore(recovery);
		const input = incidentInput(root, "incident");
		store.upsert(input);
		const committed = readFileSync(join(recovery, "incident.json"), "utf8");
		const outside = join(root, "outside");
		writeFileSync(outside, "valuable");
		symlinkSync(outside, join(recovery, "incident.json.tmp"));

		expect(store.get(input.id)).toMatchObject({ status: "recovery_required" });
		expect(store.upsert({ ...input, reason: "new attempt" })).toMatchObject({
			status: "recovery_required",
		});
		expect(store.resolveVerified(input.id, "retry")).toMatchObject({
			status: "recovery_required",
		});
		expect(readFileSync(outside, "utf8")).toBe("valuable");
		expect(readFileSync(join(recovery, "incident.json"), "utf8")).toBe(committed);
		expect(existsSync(join(recovery, "incident.json.tmp"))).toBe(true);
	});

	it("does not repair an impossible resolved history by overwriting the evidence", () => {
		const root = temporaryRoot();
		const recovery = join(root, "recovery");
		const store = new RecoveryStateStore(recovery, {
			now: () => new Date("2026-09-03T00:00:00.000Z"),
		});
		const input = incidentInput(root, "incident");
		store.upsert(input);
		store.resolveVerified(input.id, "retry");
		const path = join(recovery, "incident.json");
		const invalid = JSON.parse(readFileSync(path, "utf8"));
		invalid.resolvedAt = "2026-09-02T00:00:00.000Z";
		const evidence = JSON.stringify(invalid);
		writeFileSync(path, evidence);

		expect(store.upsert(input)).toMatchObject({ status: "recovery_required" });
		expect(store.resolveVerified(input.id, "safe_reset")).toMatchObject({
			status: "recovery_required",
		});
		expect(readFileSync(path, "utf8")).toBe(evidence);
	});

	it("does not invent a resolved incident when its durable record is missing", () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "recovery"));
		expect(store.resolveVerified("missing", "retry")).toEqual({
			status: "not_found",
			id: "missing",
		});
		expect(store.list()).toEqual({ status: "ok", records: [] });
	});

	it("leaves pending work untouched if the wall clock cannot produce a valid timestamp", () => {
		const root = temporaryRoot();
		let now = new Date("2026-09-03T00:00:00.000Z");
		const recovery = join(root, "recovery");
		const store = new RecoveryStateStore(recovery, { now: () => now });
		const input = incidentInput(root, "incident");
		store.upsert(input);
		const committed = readFileSync(join(recovery, "incident.json"), "utf8");
		now = new Date(Number.NaN);

		expect(() => store.resolveVerified(input.id, "retry")).toThrow(RecoveryStateValidationError);
		expect(readFileSync(join(recovery, "incident.json"), "utf8")).toBe(committed);
		expect(store.get(input.id)).toMatchObject({ status: "ok", record: { status: "pending" } });
	});
});
