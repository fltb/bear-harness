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
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	type Stats,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { artifactAdoptions, artifacts } from "../storage/schema.js";
export interface ArtifactRecord {
	id: string;
	logicalName: string;
	mime: string;
	bytes: number;
	sha256: string;
	status: "created" | "verified" | "verification_failed" | "adopted" | "saved";
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

const HASH_CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

export class ArtifactStore {
	private readonly verifiedVersions = new Map<string, string>();
	private readonly hashChunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
	private readonly syncDirectoryHook: (directory: string) => void;

	constructor(
		private readonly db: AppDatabase,
		private readonly casDir: string,
		hooks: ArtifactStoreHooks = {},
	) {
		this.syncDirectoryHook = hooks.syncDirectory ?? syncDirectory;
		mkdirSync(casDir, { recursive: true });
	}

	get directory(): string {
		return this.casDir;
	}

	/** Register a new artifact from a buffer. Returns the artifact record. */
	create(params: {
		logicalName: string;
		buffer: Buffer;
		mime: string;
		producerRunId?: string;
	}): ArtifactRecord {
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
				status: "created",
				producerRunId: params.producerRunId ?? null,
			})
			.run();

		return {
			id,
			logicalName: params.logicalName,
			mime,
			bytes,
			sha256,
			status: "created",
			producerRunId: params.producerRunId ?? null,
			createdAt: new Date().toISOString(),
		};
	}

	/** Mark an artifact verified only after reopening and hashing its CAS bytes. */
	markVerified(id: string): void {
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
		this.db.update(artifacts).set({ status: "verified" }).where(eq(artifacts.id, id)).run();
	}

	/** Stream a regular local file into CAS without buffering its contents. */
	async createFromPath(params: {
		logicalName: string;
		path: string;
		mime: string;
		sniffMime?: (header: Uint8Array) => string;
		producerRunId?: string;
		maxBytes?: number;
	}): Promise<ArtifactRecord> {
		return this.createFromPathSync(params);
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
					status: "created",
					producerRunId: params.producerRunId ?? null,
				})
				.run();
			return {
				id,
				logicalName: params.logicalName,
				mime,
				bytes,
				sha256,
				status: "created",
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
		this.db
			.update(artifacts)
			.set({ status: "verification_failed" })
			.where(eq(artifacts.id, id))
			.run();
	}

	/** Mark as adopted by the user. */
	markAdopted(id: string, runId: string): void {
		this.db.transaction((transaction) => {
			transaction.update(artifacts).set({ status: "adopted" }).where(eq(artifacts.id, id)).run();
			transaction
				.insert(artifactAdoptions)
				.values({ id: randomUUID(), artifactId: id, runId })
				.run();
		});
	}

	/** Mark as saved to a user-chosen location. */
	markSaved(id: string): void {
		this.db.update(artifacts).set({ status: "saved" }).where(eq(artifacts.id, id)).run();
	}

	/** Get an artifact record by ID. */
	get(id: string): ArtifactRecord | null {
		const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
		if (!row) return null;
		return {
			id: row.id,
			logicalName: row.logicalName,
			mime: row.mime,
			bytes: row.bytes,
			sha256: row.sha256,
			status: row.status as ArtifactRecord["status"],
			producerRunId: row.producerRunId,
			createdAt: row.createdAt,
		};
	}

	/** Read the CAS blob for an artifact. A missing DB row returns null; bad CAS bytes throw. */
	readBlob(id: string): Buffer | null {
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

	/** Read a bounded range without loading the complete blob into memory. */
	readBlobRange(
		id: string,
		offset: number,
		length: number,
	): { buffer: Buffer; nextOffset: number; eof: boolean } | null {
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length > HASH_CHUNK_BYTES
		) {
			throw new Error("artifact_range_invalid");
		}
		const record = this.get(id);
		if (!record) return null;
		try {
			const opened = this.openArtifact(record);
			try {
				if (opened.size !== record.bytes) throw new ArtifactCorruptedError();
				if (this.verifiedVersions.get(record.sha256) !== opened.version) {
					const version = this.verifyOpenCas(opened, record.bytes, record.sha256);
					this.verifiedVersions.set(record.sha256, version);
				}
				const size = Math.min(length, Math.max(0, record.bytes - offset));
				const buffer = Buffer.allocUnsafe(size);
				let read = 0;
				while (read < size) {
					const count = readSync(opened.fd, buffer, read, size - read, offset + read);
					if (count === 0) throw new ArtifactCorruptedError();
					read += count;
				}
				if (this.fileVersion(opened.fd) !== opened.version) throw new ArtifactCorruptedError();
				const nextOffset = offset + read;
				return { buffer, nextOffset, eof: nextOffset >= record.bytes };
			} finally {
				closeSync(opened.fd);
			}
		} catch (error) {
			this.projectCorruption(record, error);
		}
	}

	/** Read a CAS blob by SHA-256 hash directly. */
	readBlobByHash(sha256: string): Buffer | null {
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
			.select()
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
			status: row.status as ArtifactRecord["status"],
			producerRunId: row.producerRunId,
			createdAt: row.createdAt,
		}));
	}

	/** Remove CAS bytes only after every metadata reference to each hash is gone. */
	purgeUnreferenced(hashes: Iterable<string>): number {
		let removed = 0;
		for (const sha256 of new Set(hashes)) {
			if (!SHA256_PATTERN.test(sha256)) continue;
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

	/** Garbage collect only CAS blobs with no surviving artifact metadata. */
	gc(options: { retentionDays: number }): number {
		const cutoffTime = Date.now() - options.retentionDays * 86400000;
		const used = new Set(
			this.db
				.selectDistinct({ sha256: artifacts.sha256 })
				.from(artifacts)
				.all()
				.map((row) => row.sha256),
		);

		let removed = 0;
		const staleTempBefore = Date.now() - 24 * 60 * 60 * 1000;
		for (const file of readdirSync(this.casDir)) {
			const path = join(this.casDir, file);
			if (file.startsWith(".tmp-")) {
				if (lstatSync(path).mtimeMs < staleTempBefore) {
					rmSync(path, { force: true });
				}
				continue;
			}
			if (used.has(file)) continue;
			if (lstatSync(path).mtimeMs < cutoffTime) {
				rmSync(path);
				removed += 1;
			}
		}
		return removed;
	}
}
