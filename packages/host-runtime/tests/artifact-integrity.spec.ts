import { createHash, randomUUID } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ArtifactCorruptedError,
	ArtifactStore,
	type ArtifactStoreHooks,
} from "../src/artifacts/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function openFixture(hooks: ArtifactStoreHooks = {}): {
	database: DatabaseSync;
	store: ArtifactStore;
	casDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "bear-artifact-integrity-"));
	const casDir = join(root, "cas");
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE artifacts (
			id TEXT PRIMARY KEY,
			logical_name TEXT NOT NULL,
			mime TEXT NOT NULL,
			bytes INTEGER NOT NULL DEFAULT 0,
			sha256 TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'created'
				CHECK (status IN ('created','verified','verification_failed','adopted','saved')),
			producer_run_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	roots.push(root);
	databases.push(database);
	return {
		database,
		store: new ArtifactStore(drizzle({ client: database }), casDir, hooks),
		casDir,
	};
}

function status(database: DatabaseSync, id: string): string | undefined {
	return (
		database.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as
			| { status: string }
			| undefined
	)?.status;
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ArtifactStore CAS integrity", () => {
	it("reuses and reads a valid CAS object", () => {
		const { store, casDir } = openFixture();
		const buffer = Buffer.from("content-addressed bytes");
		const first = store.create({ logicalName: "first.txt", buffer, mime: "text/plain" });
		const second = store.create({ logicalName: "second.txt", buffer, mime: "text/plain" });

		expect(first.sha256).toBe(second.sha256);
		expect(readdirSync(casDir)).toEqual([first.sha256]);
		expect(store.readBlob(first.id)).toEqual(buffer);
		expect(store.readBlob(second.id)).toEqual(buffer);
		expect(store.readBlobRange(first.id, 8, 9)).toEqual({
			buffer: Buffer.from("addressed"),
			nextOffset: 17,
			eof: false,
		});
		expect(store.readBlob(randomUUID())).toBeNull();
		expect(store.readBlobRange(randomUUID(), 0, 1)).toBeNull();
	});

	it("rejects a corrupt object already occupying the expected hash path", () => {
		const { store, database, casDir } = openFixture();
		const expected = Buffer.from("expected bytes");
		const corrupt = Buffer.from("corrupt! bytes");
		const sha256 = createHash("sha256").update(expected).digest("hex");
		writeFileSync(join(casDir, sha256), corrupt);

		expect(() =>
			store.create({ logicalName: "expected.txt", buffer: expected, mime: "text/plain" }),
		).toThrowError(ArtifactCorruptedError);
		expect(database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
		expect(readFileSync(join(casDir, sha256))).toEqual(corrupt);
	});

	it("detects truncation and a same-size bit flip without deleting either object", () => {
		const { store, database, casDir } = openFixture();
		const truncated = store.create({
			logicalName: "truncated.bin",
			buffer: Buffer.from("truncate this object"),
			mime: "application/octet-stream",
		});
		store.markVerified(truncated.id);
		const truncatedPath = join(casDir, truncated.sha256);
		truncateSync(truncatedPath, truncated.bytes - 1);

		expect(() => store.readBlobRange(truncated.id, 0, 4)).toThrowError(ArtifactCorruptedError);
		expect(status(database, truncated.id)).toBe("verification_failed");
		expect(readFileSync(truncatedPath)).toHaveLength(truncated.bytes - 1);

		const original = Buffer.from("bit flip target");
		const flipped = Buffer.from(original);
		flipped[4] ^= 0x01;
		const bitFlipped = store.create({
			logicalName: "bit-flip.bin",
			buffer: original,
			mime: "application/octet-stream",
		});
		store.markVerified(bitFlipped.id);
		const bitFlippedPath = join(casDir, bitFlipped.sha256);
		writeFileSync(bitFlippedPath, flipped);

		expect(() => store.readBlob(bitFlipped.id)).toThrowError(ArtifactCorruptedError);
		expect(status(database, bitFlipped.id)).toBe("verification_failed");
		expect(readFileSync(bitFlippedPath)).toEqual(flipped);
	});

	it("projects a missing CAS blob as corruption and preserves truthful status", () => {
		const { store, database, casDir } = openFixture();
		const artifact = store.create({
			logicalName: "missing.txt",
			buffer: Buffer.from("will disappear"),
			mime: "text/plain",
		});
		rmSync(join(casDir, artifact.sha256));

		expect(() => store.readBlob(artifact.id)).toThrowError(ArtifactCorruptedError);
		expect(() => store.readBlobRange(artifact.id, 0, 4)).toThrowError(ArtifactCorruptedError);
		expect(status(database, artifact.id)).toBe("verification_failed");
	});

	it("sets verified only after real validation and records validation failure", () => {
		const { store, database, casDir } = openFixture();
		const valid = store.create({
			logicalName: "valid.txt",
			buffer: Buffer.from("valid"),
			mime: "text/plain",
		});
		store.markVerified(valid.id);
		expect(status(database, valid.id)).toBe("verified");

		const corrupt = store.create({
			logicalName: "corrupt.txt",
			buffer: Buffer.from("original"),
			mime: "text/plain",
		});
		writeFileSync(join(casDir, corrupt.sha256), Buffer.from("tampered"));
		expect(() => store.markVerified(corrupt.id)).toThrowError(ArtifactCorruptedError);
		expect(status(database, corrupt.id)).toBe("verification_failed");
	});

	it("rejects a symlink at a CAS hash path even when its target has valid bytes", () => {
		const { store, database, casDir } = openFixture();
		const expected = Buffer.from("valid target bytes");
		const sha256 = createHash("sha256").update(expected).digest("hex");
		const outside = join(casDir, "outside-object");
		writeFileSync(outside, expected);
		symlinkSync(outside, join(casDir, sha256));

		expect(() =>
			store.create({ logicalName: "linked.txt", buffer: expected, mime: "text/plain" }),
		).toThrowError(ArtifactCorruptedError);
		expect(database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
		expect(readFileSync(join(casDir, sha256))).toEqual(expected);
	});

	it("syncs the CAS parent after rename and not when reusing a durable object", () => {
		const observations: string[][] = [];
		const syncDirectory = vi.fn((directory: string) => {
			observations.push(readdirSync(directory));
		});
		const { store, casDir } = openFixture({ syncDirectory });
		const buffer = Buffer.from("durable bytes");
		const first = store.create({
			logicalName: "first.bin",
			buffer,
			mime: "application/octet-stream",
		});

		expect(syncDirectory).toHaveBeenCalledOnce();
		expect(syncDirectory).toHaveBeenCalledWith(casDir);
		expect(observations).toEqual([[first.sha256]]);

		store.create({ logicalName: "second.bin", buffer, mime: "application/octet-stream" });
		expect(syncDirectory).toHaveBeenCalledOnce();
	});
});
