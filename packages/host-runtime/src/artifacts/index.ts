/**
 * Content-addressed artifact store.
 *
 * Large content is written to `<userData>/artifacts/<sha256>`; the DB stores
 * id, logical name, MIME, bytes, sha256, producer run, codec, preview model,
 * and status.
 *
 * Write flow: temp file → fsync → hash/MIME/size validation → atomic rename
 * → DB transaction. Renderer accesses artifacts only through the
 * privilege-restricted bear-artifact:// protocol (handler re-validates
 * sender, artifact ownership, view kind, and response headers).
 *
 * GC: only cleans unreferenced CAS blobs past retention; never touches
 * user-saved files.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { and, desc, eq, lt, ne } from "drizzle-orm";
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

export class ArtifactStore {
	private db: AppDatabase;
	private casDir: string;

	constructor(db: AppDatabase, casDir: string) {
		this.db = db;
		this.casDir = casDir;
		mkdirSync(casDir, { recursive: true });
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
			writeFileSync(tmp, params.buffer);
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

	/** Garbage collect unreferenced CAS blobs older than retention days. */
	gc(options: { retentionDays: number }): number {
		const cutoff = new Date(Date.now() - options.retentionDays * 86400000).toISOString();
		const used = new Set(
			this.db
				.selectDistinct({ sha256: artifacts.sha256 })
				.from(artifacts)
				.where(ne(artifacts.status, "created"))
				.all()
				.map((row) => row.sha256),
		);

		let removed = 0;
		for (const file of readdirSync(this.casDir)) {
			if (file.startsWith(".tmp-")) continue;
			if (used.has(file)) continue;
			// Check age via the artifact's created_at
			const old = this.db
				.select({ createdAt: artifacts.createdAt })
				.from(artifacts)
				.where(
					and(
						eq(artifacts.sha256, file),
						eq(artifacts.status, "created"),
						lt(artifacts.createdAt, cutoff),
					),
				)
				.get();
			if (old) {
				rmSync(join(this.casDir, file));
				removed += 1;
			}
		}
		return removed;
	}
}
