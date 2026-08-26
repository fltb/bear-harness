// @vitest-environment node

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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

function clock(...timestamps: string[]): () => Date {
	let index = 0;
	return () => {
		const timestamp = timestamps[Math.min(index, timestamps.length - 1)];
		index += 1;
		if (!timestamp) throw new Error("Test clock has no timestamp");
		return new Date(timestamp);
	};
}

const databaseIncident = (root: string): RecoveryIncidentInput => ({
	id: "database-upgrade",
	kind: "database_upgrade",
	databasePath: join(root, "database.sqlite"),
	backupPath: join(root, "database.sqlite.pre-upgrade"),
	fromVersion: 4,
	toVersion: 7,
	reason: "Upgrade stopped before all pending migrations completed",
});

const rootMigrationIncident = (root: string): RecoveryIncidentInput => ({
	id: "root-migration",
	kind: "root_migration",
	sourceRoot: join(root, "legacy"),
	destinationRoot: join(root, "current"),
	reason: "Root cutover requires recovery",
});

const filesystemIncident = (root: string): RecoveryIncidentInput => ({
	id: "filesystem-replace",
	kind: "filesystem_recovery",
	operation: "replace",
	targetPath: join(root, "settings.json"),
	journalPath: join(root, "settings.json.journal"),
	reason: "Durable replacement needs manual recovery",
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RecoveryStateStore", () => {
	it("round-trips each strict incident kind through upsert, get, and list", () => {
		const root = temporaryRoot();
		const store = new RecoveryStateStore(join(root, "bootstrap-recovery"), {
			now: clock(
				"2026-08-26T10:00:00.000Z",
				"2026-08-26T10:01:00.000Z",
				"2026-08-26T10:02:00.000Z",
			),
		});
		const inputs = [databaseIncident(root), rootMigrationIncident(root), filesystemIncident(root)];

		for (const input of inputs) {
			const written = store.upsert(input);
			expect(written.status).toBe("ok");
			expect(store.get(input.id)).toMatchObject({
				status: "ok",
				record: { ...input, schemaVersion: 1, status: "pending" },
			});
		}

		const listed = store.list();
		expect(listed.status).toBe("ok");
		expect(listed.records.map((record) => record.id)).toEqual([
			"database-upgrade",
			"root-migration",
			"filesystem-replace",
		]);
	});

	it("discards an uncommitted crash-leftover temp file without replacing the committed record", () => {
		const parent = temporaryRoot();
		const root = join(parent, "bootstrap-recovery");
		const store = new RecoveryStateStore(root, {
			now: clock("2026-08-26T11:00:00.000Z"),
		});
		store.upsert(databaseIncident(parent));
		const committed = readFileSync(join(root, "database-upgrade.json"), "utf8");
		const temporary = join(root, "database-upgrade.json.tmp");
		writeFileSync(temporary, "partially-written-json");

		expect(store.get("database-upgrade")).toMatchObject({ status: "ok" });
		expect(existsSync(temporary)).toBe(false);
		expect(readFileSync(join(root, "database-upgrade.json"), "utf8")).toBe(committed);
	});

	it("preserves malformed records and refuses to overwrite them", () => {
		const parent = temporaryRoot();
		const root = join(parent, "bootstrap-recovery");
		mkdirSync(root, { recursive: true });
		const recordPath = join(root, "database-upgrade.json");
		const malformed = '{"schemaVersion":1,"id":"database-upgrade","unexpected":true}\n';
		writeFileSync(recordPath, malformed);
		const store = new RecoveryStateStore(root);

		expect(store.get("database-upgrade")).toMatchObject({
			status: "recovery_required",
			reason: "malformed_record",
			id: "database-upgrade",
		});
		expect(store.upsert(databaseIncident(parent))).toMatchObject({
			status: "recovery_required",
			reason: "malformed_record",
		});
		expect(readFileSync(recordPath, "utf8")).toBe(malformed);
	});

	it("reports and preserves records from an unsupported schema version", () => {
		const parent = temporaryRoot();
		const root = join(parent, "bootstrap-recovery");
		mkdirSync(root, { recursive: true });
		const recordPath = join(root, "future.json");
		const future = '{"schemaVersion":99,"id":"future"}\n';
		writeFileSync(recordPath, future);
		const store = new RecoveryStateStore(root);

		expect(store.get("future")).toEqual({
			status: "recovery_required",
			reason: "unsupported_version",
			id: "future",
			path: recordPath,
			message: "Recovery state record uses an unsupported schema version",
			foundVersion: 99,
		});
		expect(store.list()).toMatchObject({
			status: "recovery_required",
			issues: [{ reason: "unsupported_version", foundVersion: 99 }],
		});
		expect(readFileSync(recordPath, "utf8")).toBe(future);
	});

	it("retains resolved incidents as immutable history", () => {
		const parent = temporaryRoot();
		const store = new RecoveryStateStore(join(parent, "bootstrap-recovery"), {
			now: clock("2026-08-26T12:00:00.000Z", "2026-08-26T12:30:00.000Z"),
		});
		store.upsert(rootMigrationIncident(parent));

		const resolved = store.resolve("root-migration", "Destination was verified and activated");
		expect(resolved).toMatchObject({
			status: "ok",
			changed: true,
			record: {
				status: "resolved",
				resolvedAt: "2026-08-26T12:30:00.000Z",
				resolution: "Destination was verified and activated",
			},
		});
		expect(store.list()).toMatchObject({
			status: "ok",
			records: [{ id: "root-migration", status: "resolved" }],
		});
		expect(store.upsert(rootMigrationIncident(parent))).toMatchObject({
			status: "ok",
			changed: false,
			record: { status: "resolved" },
		});
	});

	it("rejects relative, nested product, traversal, and incident data paths", () => {
		const parent = temporaryRoot();
		const productRoot = join(parent, "product-data");

		expect(() => new RecoveryStateStore("relative/recovery")).toThrow(RecoveryStateValidationError);
		expect(
			() =>
				new RecoveryStateStore(join(productRoot, "recovery"), {
					productDataRoots: [productRoot],
				}),
		).toThrow(/outside product data roots/);

		const store = new RecoveryStateStore(join(parent, "bootstrap-recovery"), {
			productDataRoots: [productRoot],
		});
		expect(() => store.get("../escape")).toThrow(RecoveryStateValidationError);
		expect(() =>
			store.upsert({
				...databaseIncident(parent),
				databasePath: "relative.sqlite",
			}),
		).toThrow(RecoveryStateValidationError);
	});

	it.skipIf(process.platform === "win32")("writes committed records with mode 0600", () => {
		const parent = temporaryRoot();
		const root = join(parent, "bootstrap-recovery");
		const store = new RecoveryStateStore(root, {
			now: clock("2026-08-26T13:00:00.000Z"),
		});
		store.upsert(filesystemIncident(parent));

		expect(statSync(join(root, "filesystem-replace.json")).mode & 0o777).toBe(0o600);
	});
});
