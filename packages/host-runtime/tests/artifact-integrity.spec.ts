import crypto, { createHash, randomUUID } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import fileSystem, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
			verification TEXT NOT NULL DEFAULT 'pending'
				CHECK (verification IN ('pending','verified','failed')),
			saved INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0,1)),
			producer_run_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE artifact_adoptions (
			id TEXT PRIMARY KEY,
			artifact_id TEXT NOT NULL REFERENCES artifacts(id),
			run_id TEXT NOT NULL,
			adopted_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
	roots.push(root);
	databases.push(database);
	return {
		database,
		store: new ArtifactStore(drizzle({ client: database }), casDir, hooks),
		casDir,
	};
}

function verification(database: DatabaseSync, id: string): string | undefined {
	return (
		database.prepare("SELECT verification FROM artifacts WHERE id = ?").get(id) as
			| { verification: string }
			| undefined
	)?.verification;
}

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const database of databases.splice(0)) database.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ArtifactStore CAS integrity", () => {
	it("keeps the last cancelled verification lease until its exact file handle closes before deletion", async () => {
		const { store, database } = openFixture();
		const record = store.create({
			logicalName: "result.txt",
			buffer: Buffer.from("result"),
			mime: "text/plain",
			producerRunId: "run-a",
		});
		const reading = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const handles: FileHandle[] = [];
		const open = fileSystem.open;
		vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
			const file = await open(...args);
			handles.push(file);
			const read = file.read.bind(file);
			vi.spyOn(file, "read").mockImplementation(async (...readArgs) => {
				if (Buffer.isBuffer(readArgs[0]) && readArgs[0].byteLength === 1024 * 1024) {
					reading.resolve();
					await release.promise;
				}
				return read(...readArgs);
			});
			return file;
		});
		syncBuiltinESMExports();
		const controller = new AbortController();
		const lease = store.withRunAccess("run-a", () =>
			store.readBlobRange(record.id, 0, 1, controller.signal),
		);
		const rejected = expect(lease).rejects.toMatchObject({ name: "AbortError" });
		let deleted = false;
		try {
			await reading.promise;
			controller.abort();
			const deleting = store.withRunDeletion(["run-a"], async () => {
				expect(handles.every((file) => file.fd === -1)).toBe(true);
				database.prepare("DELETE FROM artifacts WHERE id=?").run(record.id);
				expect(store.purgeUnreferenced([record.sha256])).toBe(1);
				deleted = true;
			});
			// Give cancellation and file-close callbacks a chance to run while the verifier is held.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(deleted).toBe(false);
			release.resolve();
			await Promise.all([rejected, deleting]);
			expect(deleted).toBe(true);
		} finally {
			release.resolve();
			await store.close();
		}
	});

	it("pins a CAS publication while another Run deletes its final metadata reference", async () => {
		const { store, database, casDir } = openFixture();
		const previous = store.create({
			logicalName: "old.txt",
			buffer: Buffer.from("shared output"),
			mime: "text/plain",
			producerRunId: "run-a",
		});
		const path = join(casDir, "../new.txt");
		writeFileSync(path, "shared output");
		const remove = fileSystem.rm;
		let removedOld = false;
		vi.spyOn(fileSystem, "rm").mockImplementation(async (...args) => {
			if (!removedOld && String(args[0]).includes(".tmp-")) {
				removedOld = true;
				await store.withRunDeletion(["run-a"], async () => {
					database.prepare("DELETE FROM artifacts WHERE id=?").run(previous.id);
					expect(store.purgeUnreferenced([previous.sha256])).toBe(0);
				});
			}
			return remove(...args);
		});
		syncBuiltinESMExports();
		try {
			const current = await store.createFromPath({
				logicalName: "new.txt",
				path,
				mime: "text/plain",
				producerRunId: "run-b",
			});
			expect(removedOld).toBe(true);
			expect((await store.readBlobRange(current.id, 0, 100))?.buffer.toString()).toBe(
				"shared output",
			);
			expect(readdirSync(casDir)).toEqual([current.sha256]);
		} finally {
			await store.close();
		}
	});

	it("publishes concurrent identical captures once without replacing a committed CAS inode", async () => {
		const { store, casDir } = openFixture();
		const path = join(casDir, "../shared.bin");
		writeFileSync(path, Buffer.alloc(1024 * 1024, 0x52));
		const rename = vi.spyOn(fileSystem, "rename");
		syncBuiltinESMExports();
		try {
			const records = await Promise.all(
				Array.from({ length: 4 }, (_, index) =>
					store.createFromPath({
						path,
						logicalName: `result-${index}`,
						mime: "application/octet-stream",
					}),
				),
			);
			expect(rename).toHaveBeenCalledOnce();
			await Promise.all(records.map((record) => store.markVerifiedAsync(record.id)));
			expect(store.list().map((record) => record.verification)).toEqual([
				"verified",
				"verified",
				"verified",
				"verified",
			]);
			expect(new Set(records.map((record) => record.sha256)).size).toBe(1);
		} finally {
			await store.close();
		}
	});

	it("shares one asynchronous cold verification while allowing timers and independent range readers", async () => {
		const { store } = openFixture();
		const record = store.create({
			logicalName: "large.bin",
			buffer: Buffer.alloc(8 * 1024 * 1024, 0x51),
			mime: "application/octet-stream",
		});
		const hashes = vi.spyOn(crypto, "createHash");
		syncBuiltinESMExports();
		let timerRan = false;
		const timer = setTimeout(() => {
			timerRan = true;
		}, 0);
		try {
			const ranges = await Promise.all([
				store.readBlobRange(record.id, 0, 1),
				store.readBlobRange(record.id, record.bytes - 1, 1),
			]);
			expect(ranges.map((range) => range?.buffer[0])).toEqual([0x51, 0x51]);
			expect(timerRan).toBe(true);
			expect(hashes).toHaveBeenCalledTimes(1);
			expect(store.get(record.id)?.verification).toBe("verified");
			await store.readBlobRange(record.id, 0, 1);
			expect(hashes).toHaveBeenCalledTimes(1);
		} finally {
			clearTimeout(timer);
			await store.close();
		}
	});

	it("cancels one verifier waiter without cancelling a peer and closes all exact handles on shutdown", async () => {
		const { store } = openFixture();
		const record = store.create({
			logicalName: "large.bin",
			buffer: Buffer.alloc(8 * 1024 * 1024, 0x51),
			mime: "application/octet-stream",
		});
		const handles: FileHandle[] = [];
		const open = fileSystem.open;
		vi.spyOn(fileSystem, "open").mockImplementation(async (...args) => {
			const file = await open(...args);
			handles.push(file);
			return file;
		});
		syncBuiltinESMExports();
		const controller = new AbortController();
		const first = store.readBlobRange(record.id, 0, 1, controller.signal);
		const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
		const second = store.readBlobRange(record.id, 1, 1);
		controller.abort();
		await rejected;
		expect((await second)?.buffer[0]).toBe(0x51);
		await store.close();
		expect(handles.length).toBeGreaterThan(0);
		expect(handles.every((file) => file.fd === -1)).toBe(true);
		await expect(store.readBlobRange(record.id, 0, 1)).rejects.toThrow("artifact_store_closed");
	});

	it("drains a cancelled capture before close and rejects new operations", async () => {
		const { store, database, casDir } = openFixture();
		const path = join(casDir, "../source.bin");
		writeFileSync(path, Buffer.alloc(3 * 1024 * 1024, 0x41));
		let closing: Promise<void> | undefined;
		const capture = store.createFromPath({
			path,
			logicalName: "source",
			mime: "text/plain",
			sniffMime: () => {
				closing = store.close();
				return "text/plain";
			},
		});
		await expect(capture).rejects.toMatchObject({ name: "AbortError" });
		await closing;
		expect(readdirSync(casDir)).toEqual([]);
		expect(database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
		await expect(
			store.createFromPath({ path, logicalName: "source", mime: "text/plain" }),
		).rejects.toThrow("artifact_store_closed");
	});

	it("keeps saved and adoption facts through later corruption and derives adoption idempotently", async () => {
		const { store, database, casDir } = openFixture();
		const record = store.create({
			logicalName: "result.txt",
			buffer: Buffer.from("original"),
			mime: "text/plain",
			producerRunId: "run-a",
		});
		expect(() => store.markAdopted(record.id, "run-b")).toThrow();
		expect(() => store.markAdopted(record.id, "run-a")).toThrow();
		await store.markVerifiedAsync(record.id);
		store.markAdopted(record.id, "run-a");
		store.markAdopted(record.id, "run-a");
		store.markSaved(record.id);
		expect(store.get(record.id)).toMatchObject({
			verification: "verified",
			saved: true,
			adopted: true,
		});
		expect(store.list()).toMatchObject([{ verification: "verified", saved: true, adopted: true }]);
		expect(database.prepare("SELECT COUNT(*) AS count FROM artifact_adoptions").get()).toEqual({
			count: 1,
		});
		writeFileSync(join(casDir, record.sha256), "tampered");
		await expect(store.readBlobRange(record.id, 0, 1)).rejects.toThrow(ArtifactCorruptedError);
		expect(store.get(record.id)).toMatchObject({
			verification: "failed",
			saved: true,
			adopted: true,
		});
		await store.close();
	});

	it("waits only for target Run leases, excludes new target reads, and releases failed deletion exclusion", async () => {
		const { store } = openFixture();
		const a = Promise.withResolvers<void>();
		const b = Promise.withResolvers<void>();
		const first = store.withRunAccess("run-a", () => a.promise);
		const second = store.withRunAccess("run-b", () => b.promise);
		const remove = vi.fn(async () => undefined);
		const deleting = store.withRunDeletion(["run-a"], remove);
		await expect(store.withRunAccess("run-a", async () => undefined)).rejects.toMatchObject({
			reason: "run_deleting",
		});
		await store.withRunAccess("run-b", async () => undefined);
		expect(remove).not.toHaveBeenCalled();
		a.resolve();
		await deleting;
		expect(remove).toHaveBeenCalledOnce();
		await expect(
			store.withRunDeletion(["run-a"], async () => {
				throw new Error("remove failed");
			}),
		).rejects.toThrow("remove failed");
		await store.withRunAccess("run-a", async () => undefined);
		const closed = vi.fn();
		const closing = store.close().then(closed);
		await Promise.resolve();
		expect(closed).not.toHaveBeenCalled();
		b.resolve();
		await Promise.all([first, second, closing]);
		expect(closed).toHaveBeenCalledOnce();
	});

	it("collects only expired legal orphan names and keeps references, fresh files, directories and symlinks", async () => {
		const { store, casDir } = openFixture();
		const owned = store.create({
			logicalName: "owned",
			buffer: Buffer.from("owned"),
			mime: "text/plain",
		});
		const expired = new Date(Date.now() - 8 * 86_400_000);
		const names = [
			"a".repeat(64),
			`.tmp-${randomUUID()}`,
			"notes.txt",
			".tmp-invalid",
			"b".repeat(64),
		];
		for (const name of names) {
			writeFileSync(join(casDir, name), "keep or collect");
			if (name !== "b".repeat(64)) utimesSync(join(casDir, name), expired, expired);
		}
		utimesSync(join(casDir, owned.sha256), expired, expired);
		await fileSystem.mkdir(join(casDir, "c".repeat(64)));
		symlinkSync(join(casDir, owned.sha256), join(casDir, "d".repeat(64)));
		const maintenance = store.initMaintenance();
		const read = store.readBlobRange(owned.id, 0, 1);
		expect(await maintenance).toBe(2);
		expect((await read)?.buffer.toString()).toBe("o");
		expect(readdirSync(casDir).sort()).toEqual(
			[
				owned.sha256,
				"notes.txt",
				".tmp-invalid",
				"b".repeat(64),
				"c".repeat(64),
				"d".repeat(64),
			].sort(),
		);
		await store.close();
	});

	it("copies concurrent asynchronous sources with independent buffers and verifies their bytes", async () => {
		const { store, casDir } = openFixture();
		const inputs = [Buffer.alloc(3 * 1024 * 1024, 0x41), Buffer.alloc(3 * 1024 * 1024, 0x42)];
		const sources = inputs.map((buffer, index) => {
			const path = join(casDir, `../source-${index}`);
			writeFileSync(path, buffer);
			return path;
		});
		const records = await Promise.all(
			sources.map((path, index) =>
				store.createFromPath({
					path,
					logicalName: `source-${index}`,
					mime: "application/octet-stream",
				}),
			),
		);
		await Promise.all(records.map((record) => store.markVerifiedAsync(record.id)));
		for (const [index, record] of records.entries()) {
			const input = inputs[index];
			if (!input) throw new Error("Missing source fixture");
			expect(store.get(record.id)?.verification).toBe("verified");
			expect(store.readBlob(record.id)?.equals(input)).toBe(true);
		}
	});

	it("aborts asynchronous capture without publishing metadata or retaining a partial temporary file", async () => {
		const { store, database, casDir } = openFixture();
		const path = join(casDir, "../source.bin");
		writeFileSync(path, Buffer.alloc(3 * 1024 * 1024, 0x41));
		const controller = new AbortController();
		await expect(
			store.createFromPath({
				path,
				logicalName: "source.bin",
				mime: "application/octet-stream",
				signal: controller.signal,
				sniffMime: () => {
					controller.abort();
					return "application/octet-stream";
				},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 0 });
		expect(readdirSync(casDir)).toEqual([]);
	});

	it("rejects oversized and symlinked asynchronous sources before committing CAS metadata", async () => {
		const { store, casDir } = openFixture();
		const path = join(casDir, "../source.bin");
		const link = join(casDir, "../source-link");
		writeFileSync(path, "too large");
		symlinkSync(path, link);
		await expect(
			store.createFromPath({ path, logicalName: "large", mime: "text/plain", maxBytes: 2 }),
		).rejects.toThrow("artifact_source_too_large");
		await expect(
			store.createFromPath({ path: link, logicalName: "link", mime: "text/plain" }),
		).rejects.toThrow("artifact_source_not_regular_file");
		expect(store.list()).toEqual([]);
		expect(readdirSync(casDir)).toEqual([]);
	});

	it("asynchronous verification rejects a replaced CAS object and marks it unavailable", async () => {
		const { store, casDir } = openFixture();
		const path = join(casDir, "../source.txt");
		writeFileSync(path, "original");
		const record = await store.createFromPath({
			path,
			logicalName: "source.txt",
			mime: "text/plain",
		});
		writeFileSync(join(casDir, record.sha256), "modified");
		await expect(store.markVerifiedAsync(record.id)).rejects.toThrow(ArtifactCorruptedError);
		expect(store.get(record.id)?.verification).toBe("failed");
	});

	it("reuses and reads a valid CAS object", async () => {
		const { store, casDir } = openFixture();
		const buffer = Buffer.from("content-addressed bytes");
		const first = store.create({ logicalName: "first.txt", buffer, mime: "text/plain" });
		const second = store.create({ logicalName: "second.txt", buffer, mime: "text/plain" });

		expect(first.sha256).toBe(second.sha256);
		expect(readdirSync(casDir)).toEqual([first.sha256]);
		expect(store.readBlob(first.id)).toEqual(buffer);
		expect(store.readBlob(second.id)).toEqual(buffer);
		expect(await store.readBlobRange(first.id, 8, 9)).toEqual({
			buffer: Buffer.from("addressed"),
			nextOffset: 17,
			eof: false,
		});
		expect(store.readBlob(randomUUID())).toBeNull();
		expect(await store.readBlobRange(randomUUID(), 0, 1)).toBeNull();
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

	it("detects truncation and a same-size bit flip without deleting either object", async () => {
		const { store, database, casDir } = openFixture();
		const truncated = store.create({
			logicalName: "truncated.bin",
			buffer: Buffer.from("truncate this object"),
			mime: "application/octet-stream",
		});
		store.markVerified(truncated.id);
		const truncatedPath = join(casDir, truncated.sha256);
		truncateSync(truncatedPath, truncated.bytes - 1);

		await expect(store.readBlobRange(truncated.id, 0, 4)).rejects.toThrowError(
			ArtifactCorruptedError,
		);
		expect(verification(database, truncated.id)).toBe("failed");
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
		expect(verification(database, bitFlipped.id)).toBe("failed");
		expect(readFileSync(bitFlippedPath)).toEqual(flipped);
	});

	it("projects a missing CAS blob as corruption and preserves truthful status", async () => {
		const { store, database, casDir } = openFixture();
		const artifact = store.create({
			logicalName: "missing.txt",
			buffer: Buffer.from("will disappear"),
			mime: "text/plain",
		});
		rmSync(join(casDir, artifact.sha256));

		expect(() => store.readBlob(artifact.id)).toThrowError(ArtifactCorruptedError);
		await expect(store.readBlobRange(artifact.id, 0, 4)).rejects.toThrowError(
			ArtifactCorruptedError,
		);
		expect(verification(database, artifact.id)).toBe("failed");
	});

	it("sets verified only after real validation and records validation failure", () => {
		const { store, database, casDir } = openFixture();
		const valid = store.create({
			logicalName: "valid.txt",
			buffer: Buffer.from("valid"),
			mime: "text/plain",
		});
		store.markVerified(valid.id);
		expect(verification(database, valid.id)).toBe("verified");

		const corrupt = store.create({
			logicalName: "corrupt.txt",
			buffer: Buffer.from("original"),
			mime: "text/plain",
		});
		writeFileSync(join(casDir, corrupt.sha256), Buffer.from("tampered"));
		expect(() => store.markVerified(corrupt.id)).toThrowError(ArtifactCorruptedError);
		expect(verification(database, corrupt.id)).toBe("failed");
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

	it("collects an expired CAS blob after its final metadata row is deleted", async () => {
		const { store, database, casDir } = openFixture();
		const artifact = store.create({
			logicalName: "deleted-run.txt",
			buffer: Buffer.from("orphan after conversation deletion"),
			mime: "text/plain",
		});
		database.prepare("DELETE FROM artifacts WHERE id = ?").run(artifact.id);
		const path = join(casDir, artifact.sha256);
		const expired = new Date(Date.now() - 8 * 86_400_000);
		utimesSync(path, expired, expired);

		expect(await store.initMaintenance({ retentionDays: 7 })).toBe(1);
		expect(readdirSync(casDir)).toEqual([]);
	});

	it("retains an expired CAS blob while any artifact metadata survives", async () => {
		const { store, casDir } = openFixture();
		const artifact = store.create({
			logicalName: "still-owned.txt",
			buffer: Buffer.from("owned by an ordinary run artifact"),
			mime: "text/plain",
		});
		const path = join(casDir, artifact.sha256);
		const expired = new Date(Date.now() - 8 * 86_400_000);
		utimesSync(path, expired, expired);

		expect(await store.initMaintenance({ retentionDays: 7 })).toBe(0);
		expect(readFileSync(path)).toEqual(Buffer.from("owned by an ordinary run artifact"));
	});
});
