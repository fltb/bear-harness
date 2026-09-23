/**
 * Content-addressed artifact store.
 *
 * Large content is written to `<userData>/artifacts/<sha256>`; the DB stores
 * id, logical name, MIME, bytes, sha256, producer run, codec, preview model,
 * and status.
 *
 * Write flow: temp file → fsync → hash/MIME/size validation → atomic rename
 * → DB transaction. Artifacts are internal CAS/provenance primitives; renderer
 * access is mediated only through conversation attachment ownership.
 *
 * GC: only cleans unreferenced CAS blobs past retention; never touches
 * user-saved files.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	type Stats,
	writeSync,
} from "node:fs";
import { type FileHandle, lstat, open, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { artifactAdoptions, artifacts } from "../storage/schema.js";
export interface ArtifactRecord {
	id: string;
	logicalName: string;
	mime: string;
	bytes: number;
	sha256: string;
	verification: "pending" | "verified" | "failed";
	saved: boolean;
	adopted: boolean;
	producerRunId: string | null;
	createdAt: string;
}

export class ArtifactCorruptedError extends Error {
	readonly kind = "internal" as const;
	readonly reason = "artifact_corrupted" as const;

	constructor() {
		super("artifact_corrupted");
		this.name = "ArtifactCorruptedError";
	}
}

export interface ArtifactStoreHooks {
	syncDirectory?(directory: string): void;
}

interface OpenCasFile {
	fd: number;
	version: string;
	size: number;
}

interface AsyncCasFile {
	file: FileHandle;
	version: string;
	size: number;
}

interface VerificationTask {
	promise: Promise<void>;
	controller: AbortController;
	waiters: number;
}

const HASH_CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TEMP_PATTERN = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const artifactColumns = {
	id: artifacts.id,
	logicalName: artifacts.logicalName,
	mime: artifacts.mime,
	bytes: artifacts.bytes,
	sha256: artifacts.sha256,
	verification: artifacts.verification,
	saved: artifacts.saved,
	producerRunId: artifacts.producerRunId,
	createdAt: artifacts.createdAt,
	adopted: sql<number>`EXISTS (SELECT 1 FROM artifact_adoptions AS adoption WHERE adoption.artifact_id = artifacts.id)`,
};

async function waitForOperation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

function sameSourceFile(left: Stats, right: Stats): boolean {
	return (
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function syncDirectory(directory: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(directory, "r");
		fsyncSync(fd);
	} catch (error) {
		if (process.platform !== "win32") throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(code ?? "")) throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

async function syncDirectoryAsync(directory: string): Promise<void> {
	let directoryHandle: FileHandle | undefined;
	try {
		directoryHandle = await open(directory, "r");
		await directoryHandle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(code ?? "")) throw error;
	} finally {
		await directoryHandle?.close();
	}
}

export class ArtifactStore {
	private readonly verifiedVersions = new Map<string, string>();
	private readonly verifications = new Map<string, VerificationTask>();
	private readonly publications = new Map<string, Promise<ArtifactRecord>>();
	private readonly operations = new Set<Promise<unknown>>();
	private readonly runAccess = new Map<string, Set<Promise<unknown>>>();
	private readonly deletingRuns = new Set<string>();
	private readonly shutdown = new AbortController();
	private maintenance?: Promise<number>;
	private closing?: Promise<void>;
	private readonly hashChunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
	private readonly syncDirectoryHook: (directory: string) => void;
	private readonly syncDirectoryAsyncHook: (directory: string) => Promise<void>;

	constructor(
		private readonly db: AppDatabase,
		private readonly casDir: string,
		hooks: ArtifactStoreHooks = {},
	) {
		this.syncDirectoryHook = hooks.syncDirectory ?? syncDirectory;
		this.syncDirectoryAsyncHook = hooks.syncDirectory
			? async (directory) => this.syncDirectoryHook(directory)
			: syncDirectoryAsync;
		mkdirSync(casDir, { recursive: true });
	}

	get directory(): string {
		return this.casDir;
	}

	private assertSynchronousAccess(): void {
		if (this.shutdown.signal.aborted) throw new Error("artifact_store_closed");
		if (this.maintenance && this.operations.has(this.maintenance))
			throw new Error("artifact_maintenance_pending");
	}

	private track<T>(task: Promise<T>): Promise<T> {
		this.operations.add(task);
		void task.then(
			() => this.operations.delete(task),
			() => this.operations.delete(task),
		);
		return task;
	}

	/** Own one CAS publication through its metadata commit; same-hash captures never replace each other. */
	private publish(sha256: string, commit: () => Promise<ArtifactRecord>): Promise<ArtifactRecord> {
		const previous = this.publications.get(sha256);
		const task = previous ? previous.then(commit, commit) : Promise.resolve().then(commit);
		this.publications.set(sha256, task);
		const release = () => {
			if (this.publications.get(sha256) === task) this.publications.delete(sha256);
		};
		void task.then(release, release);
		return task;
	}

	private operate<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.shutdown.signal.aborted) return Promise.reject(new Error("artifact_store_closed"));
		const combined = signal
			? AbortSignal.any([this.shutdown.signal, signal])
			: this.shutdown.signal;
		return this.track(
			(async () => {
				await this.maintenance;
				combined.throwIfAborted();
				return work(combined);
			})(),
		);
	}

	/** Pins a complete presenter/RPC operation while its Run can still be deleted. */
	withRunAccess<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		if (this.shutdown.signal.aborted) return Promise.reject(new Error("artifact_store_closed"));
		if (this.deletingRuns.has(runId))
			return Promise.reject({ kind: "conflict", reason: "run_deleting" });
		const leases = this.runAccess.get(runId) ?? new Set<Promise<unknown>>();
		this.runAccess.set(runId, leases);
		const task = Promise.resolve().then(operation);
		leases.add(task);
		const release = () => {
			leases.delete(task);
			if (leases.size === 0) this.runAccess.delete(runId);
		};
		void task.then(release, release);
		return this.track(task);
	}

	/** Excludes only the specified resources until their admitted users and removal finish. */
	withRunDeletion<T>(runIds: readonly string[], remove: () => Promise<T>): Promise<T> {
		if (this.shutdown.signal.aborted) return Promise.reject(new Error("artifact_store_closed"));
		const ids = [...new Set(runIds)];
		if (ids.some((id) => this.deletingRuns.has(id)))
			return Promise.reject({ kind: "conflict", reason: "run_deleting" });
		for (const id of ids) this.deletingRuns.add(id);
		return this.track(
			(async () => {
				try {
					await Promise.allSettled(ids.flatMap((id) => [...(this.runAccess.get(id) ?? [])]));
					return await remove();
				} finally {
					for (const id of ids) this.deletingRuns.delete(id);
				}
			})(),
		);
	}

	/** Abort owned IO and wait for every admitted capability, verification, and deletion to release. */
	close(): Promise<void> {
		this.shutdown.abort();
		this.closing ??= (async () => {
			while (this.operations.size > 0) await Promise.allSettled([...this.operations]);
			this.verifiedVersions.clear();
		})();
		return this.closing;
	}

	/** Register a new artifact from a buffer. Returns the artifact record. */
	create(params: {
		logicalName: string;
		buffer: Buffer;
		mime: string;
		producerRunId?: string;
	}): ArtifactRecord {
		this.assertSynchronousAccess();
		const id = randomUUID();
		const sha256 = createHash("sha256").update(params.buffer).digest("hex");
		const bytes = params.buffer.byteLength;

		// Write to CAS: temp file → fsync → atomic rename → parent fsync.
		const casPath = join(this.casDir, sha256);
		if (!this.verifyExistingCas(casPath, bytes, sha256)) {
			const tmp = join(this.casDir, `.tmp-${id}`);
			const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			let closed = false;
			try {
				let written = 0;
				while (written < params.buffer.byteLength) {
					written += writeSync(fd, params.buffer, written, params.buffer.byteLength - written);
				}
				fsyncSync(fd);
				closeSync(fd);
				closed = true;
				renameSync(tmp, casPath);
				this.syncDirectoryHook(this.casDir);
			} catch (error) {
				if (!closed) closeSync(fd);
				rmSync(tmp, { force: true });
				throw error;
			}
		}

		const mime = params.mime;
		this.db
			.insert(artifacts)
			.values({
				id,
				logicalName: params.logicalName,
				mime,
				bytes,
				sha256,
				verification: "pending",
				saved: false,
				producerRunId: params.producerRunId ?? null,
			})
			.run();

		return {
			id,
			logicalName: params.logicalName,
			mime,
			bytes,
			sha256,
			verification: "pending",
			saved: false,
			adopted: false,
			producerRunId: params.producerRunId ?? null,
			createdAt: new Date().toISOString(),
		};
	}

	/** Mark an artifact verified only after reopening and hashing its CAS bytes. */
	markVerified(id: string): void {
		this.assertSynchronousAccess();
		const record = this.get(id);
		if (!record) throw new Error("artifact_not_found");
		try {
			const opened = this.openArtifact(record);
			try {
				const version = this.verifyOpenCas(opened, record.bytes, record.sha256);
				this.verifiedVersions.set(record.sha256, version);
			} finally {
				closeSync(opened.fd);
			}
		} catch (error) {
			if (error instanceof ArtifactCorruptedError) this.markVerificationFailed(id);
			throw error;
		}
		this.db.update(artifacts).set({ verification: "verified" }).where(eq(artifacts.id, id)).run();
	}

	/** Stream a regular local file into CAS without buffering its contents. */
	createFromPath(params: {
		logicalName: string;
		path: string;
		mime: string;
		sniffMime?: (header: Uint8Array) => string;
		producerRunId?: string;
		maxBytes?: number;
		signal?: AbortSignal;
		/** Host's already-validated output identity; prevents replacement before asynchronous open. */
		expectedSource?: Stats;
	}): Promise<ArtifactRecord> {
		return this.operate((signal) => this.copyFromPath({ ...params, signal }), params.signal);
	}

	private async copyFromPath(
		params: Parameters<ArtifactStore["createFromPath"]>[0],
	): Promise<ArtifactRecord> {
		const { signal } = params;
		signal?.throwIfAborted();
		const initial = await lstat(params.path);
		if (initial.isSymbolicLink() || !initial.isFile())
			throw new Error("artifact_source_not_regular_file");
		if (params.expectedSource && !sameSourceFile(params.expectedSource, initial))
			throw new Error("artifact_source_changed_before_open");
		const source = await open(params.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const id = randomUUID();
		const temp = join(this.casDir, `.tmp-${id}`);
		let destination: FileHandle | undefined;
		try {
			const sourceStat = await source.stat();
			if (!sameSourceFile(initial, sourceStat))
				throw new Error("artifact_source_changed_before_open");
			if (params.maxBytes !== undefined && sourceStat.size > params.maxBytes)
				throw new Error("artifact_source_too_large");
			signal?.throwIfAborted();
			destination = await open(temp, "wx", 0o600);
			const hash = createHash("sha256");
			// Each concurrent capture owns its buffer; no asynchronous operation
			// shares the synchronous read/verification scratch buffer.
			const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
			let bytes = 0;
			let mime: string | undefined;
			for (;;) {
				signal?.throwIfAborted();
				const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
				if (bytesRead === 0) break;
				bytes += bytesRead;
				if (params.maxBytes !== undefined && bytes > params.maxBytes)
					throw new Error("artifact_source_too_large");
				mime ??= params.sniffMime?.(chunk.subarray(0, bytesRead));
				hash.update(chunk.subarray(0, bytesRead));
				for (let written = 0; written < bytesRead; ) {
					const result = await destination.write(chunk, written, bytesRead - written, null);
					if (!result.bytesWritten) throw new Error("artifact_copy_stalled");
					written += result.bytesWritten;
				}
			}
			if (!sameSourceFile(sourceStat, await source.stat()) || bytes !== sourceStat.size)
				throw new Error("artifact_source_changed_during_read");
			await destination.sync();
			await destination.close();
			destination = undefined;
			const sha256 = hash.digest("hex");
			const casPath = join(this.casDir, sha256);
			return await this.publish(sha256, async () => {
				const existing = await this.verifyCasAsync(casPath, bytes, sha256, signal);
				signal?.throwIfAborted();
				if (existing === null) {
					await rename(temp, casPath);
					await this.syncDirectoryAsyncHook(this.casDir);
				} else {
					await rm(temp, { force: true });
				}
				signal?.throwIfAborted();
				const record: ArtifactRecord = {
					id,
					logicalName: params.logicalName,
					mime: mime ?? params.sniffMime?.(new Uint8Array()) ?? params.mime,
					bytes,
					sha256,
					verification: "pending",
					saved: false,
					adopted: false,
					producerRunId: params.producerRunId ?? null,
					createdAt: new Date().toISOString(),
				};
				this.db.insert(artifacts).values(record).run();
				return record;
			});
		} finally {
			try {
				await destination?.close();
			} finally {
				try {
					await source.close();
				} finally {
					await rm(temp, { force: true });
				}
			}
		}
	}

	/** Verify large captured outputs without blocking other Sessions or Run controls. */
	markVerifiedAsync(id: string, signal?: AbortSignal): Promise<void> {
		return this.operate(async (signal) => {
			const record = this.get(id);
			if (!record) throw new Error("artifact_not_found");
			try {
				const opened = await this.openArtifactAsync(record);
				try {
					await this.ensureVerified(record, opened, signal);
					signal.throwIfAborted();
					if (this.fileVersion(opened.file.fd) !== opened.version)
						throw new ArtifactCorruptedError();
					this.recordVerified(record);
				} finally {
					await opened.file.close();
				}
			} catch (error) {
				this.projectCorruption(record, error);
			}
		}, signal);
	}

	private async verifyCasAsync(
		path: string,
		bytes: number,
		sha256: string,
		signal?: AbortSignal,
	): Promise<string | null> {
		signal?.throwIfAborted();
		if (!Number.isSafeInteger(bytes) || bytes < 0 || !SHA256_PATTERN.test(sha256))
			throw new ArtifactCorruptedError();
		let initial: Stats;
		try {
			initial = await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		if (!initial.isFile() || initial.isSymbolicLink()) throw new ArtifactCorruptedError();
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			if (!sameSourceFile(initial, await file.stat()) || initial.size !== bytes)
				throw new ArtifactCorruptedError();
			const version = this.fileVersion(file.fd);
			const hash = createHash("sha256");
			const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
			let read = 0;
			while (read < bytes) {
				signal?.throwIfAborted();
				const result = await file.read(chunk, 0, Math.min(chunk.length, bytes - read), null);
				if (!result.bytesRead) throw new ArtifactCorruptedError();
				read += result.bytesRead;
				hash.update(chunk.subarray(0, result.bytesRead));
			}
			if (this.fileVersion(file.fd) !== version || hash.digest("hex") !== sha256)
				throw new ArtifactCorruptedError();
			return version;
		} finally {
			await file.close();
		}
	}

	/**
	 * Synchronous path ingestion for callers whose public contract is synchronous.
	 * Validation and reads use one no-follow file descriptor, closing the
	 * stat/open race and rejecting sources that mutate while being copied.
	 */
	createFromPathSync(params: {
		logicalName: string;
		path: string;
		mime: string;
		sniffMime?: (header: Uint8Array) => string;
		producerRunId?: string;
		maxBytes?: number;
	}): ArtifactRecord {
		this.assertSynchronousAccess();
		const initial = lstatSync(params.path);
		if (initial.isSymbolicLink() || !initial.isFile()) {
			throw new Error("artifact_source_not_regular_file");
		}
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const sourceFd = openSync(params.path, constants.O_RDONLY | noFollow);
		const id = randomUUID();
		const temp = join(this.casDir, `.tmp-${id}`);
		let tempFd: number | undefined;
		try {
			const sourceStat = fstatSync(sourceFd);
			if (!sourceStat.isFile()) throw new Error("artifact_source_not_regular_file");
			if (
				sourceStat.dev !== initial.dev ||
				sourceStat.ino !== initial.ino ||
				sourceStat.size !== initial.size ||
				sourceStat.mtimeMs !== initial.mtimeMs
			) {
				throw new Error("artifact_source_changed_before_open");
			}
			if (params.maxBytes !== undefined && sourceStat.size > params.maxBytes) {
				throw new Error("artifact_source_too_large");
			}

			tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			const hash = createHash("sha256");
			const chunk = this.hashChunk;
			let bytes = 0;
			let mime: string | undefined;
			for (;;) {
				const read = readSync(sourceFd, chunk, 0, chunk.byteLength, null);
				if (read === 0) break;
				mime ??= params.sniffMime?.(chunk.subarray(0, read));
				bytes += read;
				if (params.maxBytes !== undefined && bytes > params.maxBytes) {
					throw new Error("artifact_source_too_large");
				}
				hash.update(chunk.subarray(0, read));
				let written = 0;
				while (written < read) {
					written += writeSync(tempFd, chunk, written, read - written);
				}
			}
			mime ??= params.sniffMime?.(new Uint8Array()) ?? params.mime;
			const finalSourceStat = fstatSync(sourceFd);
			if (
				finalSourceStat.dev !== sourceStat.dev ||
				finalSourceStat.ino !== sourceStat.ino ||
				finalSourceStat.size !== sourceStat.size ||
				finalSourceStat.mtimeMs !== sourceStat.mtimeMs ||
				bytes !== sourceStat.size
			) {
				throw new Error("artifact_source_changed_during_read");
			}
			fsyncSync(tempFd);
			closeSync(tempFd);
			tempFd = undefined;

			const sha256 = hash.digest("hex");
			const casPath = join(this.casDir, sha256);
			if (this.verifyExistingCas(casPath, bytes, sha256)) {
				rmSync(temp, { force: true });
			} else {
				renameSync(temp, casPath);
				this.syncDirectoryHook(this.casDir);
			}
			this.db
				.insert(artifacts)
				.values({
					id,
					logicalName: params.logicalName,
					mime,
					bytes,
					sha256,
					verification: "pending",
					saved: false,
					producerRunId: params.producerRunId ?? null,
				})
				.run();
			return {
				id,
				logicalName: params.logicalName,
				mime,
				bytes,
				sha256,
				verification: "pending",
				saved: false,
				adopted: false,
				producerRunId: params.producerRunId ?? null,
				createdAt: new Date().toISOString(),
			};
		} catch (error) {
			if (tempFd !== undefined) closeSync(tempFd);
			rmSync(temp, { force: true });
			throw error;
		} finally {
			closeSync(sourceFd);
		}
	}

	/** Mark verification failed without deleting the only CAS copy. */
	markVerificationFailed(id: string): void {
		const record = this.get(id);
		if (record) this.verifiedVersions.delete(record.sha256);
		this.db.update(artifacts).set({ verification: "failed" }).where(eq(artifacts.id, id)).run();
	}

	/** Mark as adopted by the user. */
	markAdopted(id: string, runId: string): void {
		this.db.transaction((transaction) => {
			const record = transaction.select().from(artifacts).where(eq(artifacts.id, id)).get();
			if (!record || record.producerRunId !== runId)
				throw { kind: "not_found", reason: "artifact_not_found" };
			if (record.verification !== "verified")
				throw { kind: "conflict", reason: "artifact_not_verified" };
			if (
				transaction
					.select({ id: artifactAdoptions.id })
					.from(artifactAdoptions)
					.where(and(eq(artifactAdoptions.artifactId, id), eq(artifactAdoptions.runId, runId)))
					.get()
			)
				return;
			transaction
				.insert(artifactAdoptions)
				.values({ id: randomUUID(), artifactId: id, runId })
				.run();
		});
	}

	/** Mark as saved to a user-chosen location. */
	markSaved(id: string): void {
		this.db.update(artifacts).set({ saved: true }).where(eq(artifacts.id, id)).run();
	}

	/** Get an artifact record by ID. */
	get(id: string): ArtifactRecord | null {
		const row = this.db.select(artifactColumns).from(artifacts).where(eq(artifacts.id, id)).get();
		if (!row) return null;
		return {
			id: row.id,
			logicalName: row.logicalName,
			mime: row.mime,
			bytes: row.bytes,
			sha256: row.sha256,
			verification: row.verification,
			saved: row.saved,
			adopted: Boolean(row.adopted),
			producerRunId: row.producerRunId,
			createdAt: row.createdAt,
		};
	}

	/** Read the CAS blob for an artifact. A missing DB row returns null; bad CAS bytes throw. */
	readBlob(id: string): Buffer | null {
		this.assertSynchronousAccess();
		const record = this.get(id);
		if (!record) return null;
		try {
			const opened = this.openArtifact(record);
			try {
				if (opened.size !== record.bytes) throw new ArtifactCorruptedError();
				const buffer = Buffer.allocUnsafe(record.bytes);
				let read = 0;
				while (read < buffer.byteLength) {
					const count = readSync(opened.fd, buffer, read, buffer.byteLength - read, read);
					if (count === 0) throw new ArtifactCorruptedError();
					read += count;
				}
				const finalVersion = this.fileVersion(opened.fd);
				if (
					finalVersion !== opened.version ||
					createHash("sha256").update(buffer).digest("hex") !== record.sha256
				) {
					throw new ArtifactCorruptedError();
				}
				this.verifiedVersions.set(record.sha256, finalVersion);
				return buffer;
			} finally {
				closeSync(opened.fd);
			}
		} catch (error) {
			this.projectCorruption(record, error);
		}
	}

	/** Read a bounded range only after asynchronously validating this exact file version. */
	readBlobRange(
		id: string,
		offset: number,
		length: number,
		signal?: AbortSignal,
	): Promise<{ buffer: Buffer; nextOffset: number; eof: boolean } | null> {
		return this.operate(async (signal) => {
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(length) ||
				length < 1 ||
				length > HASH_CHUNK_BYTES
			)
				throw new Error("artifact_range_invalid");
			const record = this.get(id);
			if (!record) return null;
			try {
				const opened = await this.openArtifactAsync(record);
				try {
					await this.ensureVerified(record, opened, signal);
					const size = Math.min(length, Math.max(0, record.bytes - offset));
					const buffer = Buffer.allocUnsafe(size);
					let read = 0;
					while (read < size) {
						signal.throwIfAborted();
						const { bytesRead } = await opened.file.read(buffer, read, size - read, offset + read);
						if (bytesRead === 0) throw new ArtifactCorruptedError();
						read += bytesRead;
					}
					signal.throwIfAborted();
					if (this.fileVersion(opened.file.fd) !== opened.version)
						throw new ArtifactCorruptedError();
					this.recordVerified(record);
					const nextOffset = offset + read;
					return { buffer, nextOffset, eof: nextOffset >= record.bytes };
				} finally {
					await opened.file.close();
				}
			} catch (error) {
				this.projectCorruption(record, error);
			}
		}, signal);
	}

	private recordVerified(record: ArtifactRecord): void {
		this.db
			.update(artifacts)
			.set({ verification: "verified" })
			.where(and(eq(artifacts.id, record.id), sql`${artifacts.verification} != 'verified'`))
			.run();
	}

	private async openArtifactAsync(
		record: Pick<ArtifactRecord, "sha256" | "bytes">,
	): Promise<AsyncCasFile> {
		if (
			!SHA256_PATTERN.test(record.sha256) ||
			!Number.isSafeInteger(record.bytes) ||
			record.bytes < 0
		)
			throw new ArtifactCorruptedError();
		const path = join(this.casDir, record.sha256);
		let file: FileHandle | undefined;
		try {
			const initial = await lstat(path);
			if (!initial.isFile() || initial.isSymbolicLink()) throw new ArtifactCorruptedError();
			file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const current = await file.stat();
			if (!sameSourceFile(initial, current) || current.size !== record.bytes)
				throw new ArtifactCorruptedError();
			return { file, version: this.fileVersion(file.fd), size: current.size };
		} catch (error) {
			await file?.close();
			if (
				error instanceof ArtifactCorruptedError ||
				["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
			)
				throw new ArtifactCorruptedError();
			throw error;
		}
	}

	private async ensureVerified(
		record: ArtifactRecord,
		opened: AsyncCasFile,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		if (this.verifiedVersions.get(record.sha256) === opened.version) return;
		const key = `${record.sha256}:${opened.version}`;
		let task = this.verifications.get(key);
		if (!task) {
			const controller = new AbortController();
			const verificationSignal = AbortSignal.any([controller.signal, this.shutdown.signal]);
			const promise = this.track(
				(async () => {
					// Verification owns its own handle, so one cancelled reader cannot close a peer's file.
					const source = await this.openArtifactAsync(record);
					try {
						if (source.version !== opened.version) throw new ArtifactCorruptedError();
						const hash = createHash("sha256");
						const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
						let offset = 0;
						while (offset < source.size) {
							verificationSignal.throwIfAborted();
							const { bytesRead } = await source.file.read(
								buffer,
								0,
								Math.min(buffer.length, source.size - offset),
								offset,
							);
							if (!bytesRead) throw new ArtifactCorruptedError();
							hash.update(buffer.subarray(0, bytesRead));
							offset += bytesRead;
						}
						verificationSignal.throwIfAborted();
						if (
							this.fileVersion(source.file.fd) !== source.version ||
							hash.digest("hex") !== record.sha256
						)
							throw new ArtifactCorruptedError();
						this.verifiedVersions.set(record.sha256, source.version);
					} finally {
						await source.file.close();
					}
				})(),
			);
			task = { promise, controller, waiters: 0 };
			this.verifications.set(key, task);
			const release = () => {
				if (this.verifications.get(key)?.promise === promise) this.verifications.delete(key);
			};
			void promise.then(release, release);
		}
		task.waiters++;
		try {
			await waitForOperation(task.promise, signal);
		} finally {
			if (--task.waiters === 0) {
				task.controller.abort();
				if (this.verifications.get(key) === task) this.verifications.delete(key);
				// The last lease still owns the verifier's exact handle until its IO and close finish.
				await task.promise.catch(() => undefined);
			}
		}
	}

	/** Read a CAS blob by SHA-256 hash directly. */
	readBlobByHash(sha256: string): Buffer | null {
		this.assertSynchronousAccess();
		if (!SHA256_PATTERN.test(sha256)) return null;
		const opened = this.openCasFileIfPresent(join(this.casDir, sha256));
		if (!opened) return null;
		try {
			const buffer = Buffer.allocUnsafe(opened.size);
			let read = 0;
			while (read < buffer.byteLength) {
				const count = readSync(opened.fd, buffer, read, buffer.byteLength - read, read);
				if (count === 0) throw new ArtifactCorruptedError();
				read += count;
			}
			if (
				this.fileVersion(opened.fd) !== opened.version ||
				createHash("sha256").update(buffer).digest("hex") !== sha256
			) {
				throw new ArtifactCorruptedError();
			}
			return buffer;
		} finally {
			closeSync(opened.fd);
		}
	}

	private openArtifact(record: ArtifactRecord): OpenCasFile {
		if (
			!SHA256_PATTERN.test(record.sha256) ||
			!Number.isSafeInteger(record.bytes) ||
			record.bytes < 0
		) {
			throw new ArtifactCorruptedError();
		}
		return this.openCasFile(join(this.casDir, record.sha256));
	}

	private verifyExistingCas(path: string, bytes: number, sha256: string): boolean {
		const opened = this.openCasFileIfPresent(path);
		if (!opened) return false;
		try {
			this.verifyOpenCas(opened, bytes, sha256);
			return true;
		} finally {
			closeSync(opened.fd);
		}
	}

	private openCasFile(path: string): OpenCasFile {
		const opened = this.openCasFileIfPresent(path);
		if (!opened) throw new ArtifactCorruptedError();
		return opened;
	}

	private openCasFileIfPresent(path: string): OpenCasFile | null {
		let initial: Stats;
		try {
			initial = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		if (initial.isSymbolicLink() || !initial.isFile()) throw new ArtifactCorruptedError();
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		let fd: number;
		try {
			fd = openSync(path, constants.O_RDONLY | noFollow);
		} catch {
			throw new ArtifactCorruptedError();
		}
		try {
			const current = fstatSync(fd);
			if (!current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino) {
				throw new ArtifactCorruptedError();
			}
			return {
				fd,
				size: current.size,
				version: this.fileVersion(fd),
			};
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}

	private verifyOpenCas(opened: OpenCasFile, bytes: number, sha256: string): string {
		if (opened.size !== bytes) throw new ArtifactCorruptedError();
		const hash = createHash("sha256");
		let offset = 0;
		while (offset < bytes) {
			const read = readSync(
				opened.fd,
				this.hashChunk,
				0,
				Math.min(this.hashChunk.byteLength, bytes - offset),
				offset,
			);
			if (read === 0) throw new ArtifactCorruptedError();
			hash.update(this.hashChunk.subarray(0, read));
			offset += read;
		}
		const finalVersion = this.fileVersion(opened.fd);
		if (offset !== bytes || finalVersion !== opened.version || hash.digest("hex") !== sha256) {
			throw new ArtifactCorruptedError();
		}
		return finalVersion;
	}

	private fileVersion(fd: number): string {
		const stat = fstatSync(fd, { bigint: true });
		if (!stat.isFile()) throw new ArtifactCorruptedError();
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	}

	private projectCorruption(record: ArtifactRecord, error: unknown): never {
		if (error instanceof ArtifactCorruptedError) this.markVerificationFailed(record.id);
		throw error;
	}

	/** List all artifacts (optionally filtered by run). */
	list(producerRunId?: string): ArtifactRecord[] {
		const rows = this.db
			.select(artifactColumns)
			.from(artifacts)
			.where(producerRunId ? eq(artifacts.producerRunId, producerRunId) : undefined)
			.orderBy(desc(artifacts.createdAt))
			.all();
		return rows.map((row) => ({
			id: row.id,
			logicalName: row.logicalName,
			mime: row.mime,
			bytes: row.bytes,
			sha256: row.sha256,
			verification: row.verification,
			saved: row.saved,
			adopted: Boolean(row.adopted),
			producerRunId: row.producerRunId,
			createdAt: row.createdAt,
		}));
	}

	/** Remove CAS bytes only after every metadata reference to each hash is gone. */
	purgeUnreferenced(hashes: Iterable<string>): number {
		let removed = 0;
		for (const sha256 of new Set(hashes)) {
			if (!SHA256_PATTERN.test(sha256)) continue;
			if (this.publications.has(sha256)) continue;
			if (
				this.db
					.select({ id: artifacts.id })
					.from(artifacts)
					.where(eq(artifacts.sha256, sha256))
					.get()
			) {
				continue;
			}
			const path = join(this.casDir, sha256);
			let stat: Stats;
			try {
				stat = lstatSync(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactCorruptedError();
			rmSync(path);
			removed += 1;
		}
		if (removed > 0) this.syncDirectoryHook(this.casDir);
		return removed;
	}

	/** Startup-only maintenance; later asynchronous IO waits until the orphan scan finishes. */
	initMaintenance(options: { retentionDays?: number } = {}): Promise<number> {
		if (this.maintenance) return this.maintenance;
		if (this.shutdown.signal.aborted) return Promise.reject(new Error("artifact_store_closed"));
		if (this.operations.size > 0)
			return Promise.reject(new Error("artifact_maintenance_must_precede_admission"));
		const retentionDays = options.retentionDays ?? 7;
		if (!Number.isFinite(retentionDays) || retentionDays < 0)
			return Promise.reject(new Error("artifact_retention_invalid"));
		this.maintenance = this.track(this.collectOrphans(retentionDays));
		return this.maintenance;
	}

	private async collectOrphans(retentionDays: number): Promise<number> {
		const now = Date.now();
		let removed = 0;
		for await (const entry of await opendir(this.casDir)) {
			this.shutdown.signal.throwIfAborted();
			const isCas = SHA256_PATTERN.test(entry.name);
			if (!isCas && !TEMP_PATTERN.test(entry.name)) continue;
			const path = join(this.casDir, entry.name);
			let stat: Stats;
			try {
				stat = await lstat(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			const graceMs = isCas ? retentionDays * 86_400_000 : 86_400_000;
			if (stat.mtimeMs >= now - graceMs) continue;
			if (
				isCas &&
				this.db
					.select({ id: artifacts.id })
					.from(artifacts)
					.where(eq(artifacts.sha256, entry.name))
					.get()
			)
				continue;
			this.shutdown.signal.throwIfAborted();
			await rm(path, { force: true });
			this.verifiedVersions.delete(entry.name);
			removed++;
		}
		if (removed) await this.syncDirectoryAsyncHook(this.casDir);
		return removed;
	}
}
