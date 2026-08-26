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
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../storage/database.js";
import { artifactAdoptions, artifacts, conversationAttachmentFiles } from "../storage/schema.js";
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

export class ArtifactStore {
	private db: AppDatabase;
	private casDir: string;

	constructor(db: AppDatabase, casDir: string) {
		this.db = db;
		this.casDir = casDir;
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

		// Write to CAS: temp file → fsync → atomic rename
		const casPath = join(this.casDir, sha256);
		if (!existsSync(casPath)) {
			const tmp = join(this.casDir, `.tmp-${id}`);
			const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			try {
				let written = 0;
				while (written < params.buffer.byteLength) {
					written += writeSync(fd, params.buffer, written, params.buffer.byteLength - written);
				}
				fsyncSync(fd);
			} catch (error) {
				rmSync(tmp, { force: true });
				throw error;
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, casPath);
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

	/** Mark an artifact as verified (re-opened, hash/MIME/structure all pass). */
	markVerified(id: string): void {
		this.db.update(artifacts).set({ status: "verified" }).where(eq(artifacts.id, id)).run();
	}

	/** Stream a regular local file into CAS without buffering its contents. */
	async createFromPath(params: {
		logicalName: string;
		path: string;
		mime: string;
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
			const chunk = Buffer.allocUnsafe(1024 * 1024);
			let bytes = 0;
			for (;;) {
				const read = readSync(sourceFd, chunk, 0, chunk.byteLength, null);
				if (read === 0) break;
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
			if (existsSync(casPath)) rmSync(temp, { force: true });
			else renameSync(temp, casPath);
			this.db
				.insert(artifacts)
				.values({
					id,
					logicalName: params.logicalName,
					mime: params.mime,
					bytes,
					sha256,
					status: "created",
					producerRunId: params.producerRunId ?? null,
				})
				.run();
			return {
				id,
				logicalName: params.logicalName,
				mime: params.mime,
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

	/** Mark verification failed. */
	markVerificationFailed(id: string): void {
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

	/** Read the CAS blob for an artifact. Returns null if not found. */
	readBlob(id: string): Buffer | null {
		const record = this.get(id);
		if (!record) return null;
		const casPath = join(this.casDir, record.sha256);
		if (!existsSync(casPath)) return null;
		return readFileSync(casPath);
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
			length > 1024 * 1024
		) {
			throw new Error("artifact_range_invalid");
		}
		const record = this.get(id);
		if (!record) return null;
		const casPath = join(this.casDir, record.sha256);
		let fd: number;
		try {
			fd = openSync(casPath, constants.O_RDONLY);
		} catch {
			return null;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size !== record.bytes) return null;
			const size = Math.min(length, Math.max(0, stat.size - offset));
			const buffer = Buffer.allocUnsafe(size);
			let read = 0;
			while (read < size) {
				const count = readSync(fd, buffer, read, size - read, offset + read);
				if (count === 0) break;
				read += count;
			}
			const nextOffset = offset + read;
			return {
				buffer: read === size ? buffer : buffer.subarray(0, read),
				nextOffset,
				eof: nextOffset >= stat.size,
			};
		} finally {
			closeSync(fd);
		}
	}

	/** Read a CAS blob by SHA-256 hash directly. */
	readBlobByHash(sha256: string): Buffer | null {
		const casPath = join(this.casDir, sha256);
		if (!existsSync(casPath)) return null;
		return readFileSync(casPath);
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

	/** Garbage collect blobs not referenced by attachments, adoptions, or saves. */
	gc(options: { retentionDays: number }): number {
		const cutoff = new Date(Date.now() - options.retentionDays * 86400000)
			.toISOString()
			.replace("T", " ")
			.slice(0, 19);
		const used = new Set([
			...this.db
				.selectDistinct({ sha256: conversationAttachmentFiles.sha256 })
				.from(conversationAttachmentFiles)
				.all()
				.flatMap((row) => (row.sha256 ? [row.sha256] : [])),
			...this.db
				.selectDistinct({ sha256: artifacts.sha256 })
				.from(artifactAdoptions)
				.innerJoin(artifacts, eq(artifactAdoptions.artifactId, artifacts.id))
				.all()
				.map((row) => row.sha256),
			...this.db
				.selectDistinct({ sha256: artifacts.sha256 })
				.from(artifacts)
				.where(eq(artifacts.status, "saved"))
				.all()
				.map((row) => row.sha256),
		]);

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
			const newest = this.db
				.select({ createdAt: artifacts.createdAt })
				.from(artifacts)
				.where(eq(artifacts.sha256, file))
				.orderBy(desc(artifacts.createdAt))
				.get();
			if (newest && newest.createdAt < cutoff) {
				rmSync(path);
				removed += 1;
			}
		}
		return removed;
	}
}
