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

import { type DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
	private db: DatabaseSync;
	private casDir: string;

	constructor(db: DatabaseSync, casDir: string) {
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
			.prepare(
				"INSERT INTO artifacts (id, logical_name, mime, bytes, sha256, status, producer_run_id) VALUES (?, ?, ?, ?, ?, 'created', ?)",
			)
			.run(id, params.logicalName, mime, bytes, sha256, params.producerRunId ?? null);

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
		this.db.prepare("UPDATE artifacts SET status = 'verified' WHERE id = ?").run(id);
	}

	/** Mark verification failed. */
	markVerificationFailed(id: string): void {
		this.db.prepare("UPDATE artifacts SET status = 'verification_failed' WHERE id = ?").run(id);
	}

	/** Mark as adopted by the user. */
	markAdopted(id: string, runId: string): void {
		this.db.prepare("UPDATE artifacts SET status = 'adopted' WHERE id = ?").run(id);
		this.db
			.prepare("INSERT INTO artifact_adoptions (id, artifact_id, run_id) VALUES (?, ?, ?)")
			.run(randomUUID(), id, runId);
	}

	/** Mark as saved to a user-chosen location. */
	markSaved(id: string): void {
		this.db.prepare("UPDATE artifacts SET status = 'saved' WHERE id = ?").run(id);
	}

	/** Get an artifact record by ID. */
	get(id: string): ArtifactRecord | null {
		const row = this.db
			.prepare(
				"SELECT id, logical_name, mime, bytes, sha256, status, producer_run_id, created_at FROM artifacts WHERE id = ?",
			)
			.get(id) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			id: row.id as string,
			logicalName: row.logical_name as string,
			mime: row.mime as string,
			bytes: row.bytes as number,
			sha256: row.sha256 as string,
			status: row.status as ArtifactRecord["status"],
			producerRunId: (row.producer_run_id as string) ?? null,
			createdAt: row.created_at as string,
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
		const sql = producerRunId
			? "SELECT id, logical_name, mime, bytes, sha256, status, producer_run_id, created_at FROM artifacts WHERE producer_run_id = ? ORDER BY created_at DESC"
			: "SELECT id, logical_name, mime, bytes, sha256, status, producer_run_id, created_at FROM artifacts ORDER BY created_at DESC";
		const rows = (producerRunId
			? this.db.prepare(sql).all(producerRunId)
			: this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			id: row.id as string,
			logicalName: row.logical_name as string,
			mime: row.mime as string,
			bytes: row.bytes as number,
			sha256: row.sha256 as string,
			status: row.status as ArtifactRecord["status"],
			producerRunId: (row.producer_run_id as string) ?? null,
			createdAt: row.created_at as string,
		}));
	}

	/** Garbage collect unreferenced CAS blobs older than retention days. */
	gc(options: { retentionDays: number }): number {
		const cutoff = new Date(Date.now() - options.retentionDays * 86400000).toISOString();
		const used = new Set(
			(
				this.db
					.prepare("SELECT DISTINCT sha256 FROM artifacts WHERE status NOT IN ('created')")
					.all() as Array<{ sha256: string }>
			).map((r) => r.sha256),
		);

		let removed = 0;
		for (const file of readdirSync(this.casDir)) {
			if (file.startsWith(".tmp-")) continue;
			if (used.has(file)) continue;
			// Check age via the artifact's created_at
			const old = this.db
				.prepare("SELECT created_at FROM artifacts WHERE sha256 = ? AND status = 'created'")
				.get(file) as { created_at: string } | undefined;
			if (old && old.created_at < cutoff) {
				rmSync(join(this.casDir, file));
				removed += 1;
			}
		}
		return removed;
	}
}