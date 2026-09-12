/**
 * Host canonical database — single `node:sqlite DatabaseSync` connection.
 *
 * Lifecycle: created at app boot, one connection, never shared across
 * worker_threads. WAL mode, foreign_keys, defensive mode, busy_timeout.
 * Bear 1.0 uses one final schema for each database. Existing databases must
 * already identify as schema v1; pre-release layouts are not migrated.
 */
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import * as sqliteVec from "sqlite-vec";
import { companionRuntimeIdentity, installationIdentity } from "./schema.js";
import { COMPANION_SCHEMA_SQL, SYSTEM_SCHEMA_SQL } from "./schema-sql.js";

function createAppDatabase(client: DatabaseSync) {
	return drizzle({ client });
}

export type AppDatabase = ReturnType<typeof createAppDatabase>;

export interface TraceIndexRow {
	traceId: string;
	modifiedAt: string;
	event: string;
	level: string;
	conversationId?: string;
	runId?: string;
}

export interface TraceQuery {
	incidents?: boolean;
	before?: string;
	limit?: number;
	level?: string;
	event?: string;
	conversationId?: string;
	runId?: string;
}

/** Disposable search metadata only. JSONL remains the diagnostic source;
 * no messages or Pi lifecycle are reconstructed from this database. */
export class TraceIndex {
	private readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		try {
			this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;
			CREATE TABLE IF NOT EXISTS trace_search (
			 trace_id TEXT NOT NULL, event TEXT NOT NULL, level TEXT NOT NULL,
			 conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, modified_at TEXT NOT NULL,
			 PRIMARY KEY(trace_id,event,level,conversation_id,run_id));
			CREATE INDEX IF NOT EXISTS trace_search_time ON trace_search(modified_at,trace_id);`);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	add(row: TraceIndexRow): void {
		this.db
			.prepare(`INSERT INTO trace_search VALUES(?,?,?,?,?,?)
			ON CONFLICT DO UPDATE SET modified_at=MAX(modified_at,excluded.modified_at)`)
			.run(
				row.traceId,
				row.event,
				row.level,
				row.conversationId ?? "",
				row.runId ?? "",
				row.modifiedAt,
			);
	}
	remove(traceId: string): void {
		this.db.prepare("DELETE FROM trace_search WHERE trace_id=?").run(traceId);
	}
	clear(): void {
		this.db.exec("DELETE FROM trace_search");
	}
	query(query: TraceQuery = {}): {
		traces: Array<{ traceId: string; modifiedAt: string }>;
		next?: string;
	} {
		const clauses: string[] = [];
		if (query.incidents) clauses.push("level IN ('error','fatal')");
		const values: Array<string | number> = [];
		for (const [column, value] of [
			["level", query.level],
			["event", query.event],
			["conversation_id", query.conversationId],
			["run_id", query.runId],
		]) {
			if (value !== undefined) {
				clauses.push(`${column}=?`);
				values.push(value);
			}
		}
		const limit = Math.max(1, Math.min(100, query.limit ?? 100));
		const having = query.before ? "HAVING MAX(modified_at)||'|'||trace_id < ?" : "";
		if (query.before) values.push(query.before);
		values.push(limit + 1);
		const rows = this.db
			.prepare(`SELECT trace_id AS traceId, MAX(modified_at) AS modifiedAt FROM trace_search
			${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} GROUP BY trace_id ${having}
			ORDER BY modifiedAt DESC,trace_id DESC LIMIT ?`)
			.all(...values) as unknown as Array<{ traceId: string; modifiedAt: string }>;
		const traces = rows.slice(0, limit);
		const last = traces.at(-1);
		return {
			traces,
			...(rows.length > limit && last ? { next: `${last.modifiedAt}|${last.traceId}` } : {}),
		};
	}
	close(): void {
		this.db.close();
	}
}

const INSTALLATION_IDENTITY_SINGLETON_ID = 1;
export const DATABASE_SCHEMA_VERSION = 1;

/** Load the installation's durable identity. */
export function loadInstallationId(db: AppDatabase): string {
	const row = db
		.select({ installationId: installationIdentity.installationId })
		.from(installationIdentity)
		.where(eq(installationIdentity.id, INSTALLATION_IDENTITY_SINGLETON_ID))
		.get();
	if (!row) throw new Error("installation identity is missing");
	return row.installationId;
}
export interface CanonVectorIndex {
	ensureCanonVectorIndex(configuration: { dimensions: number; fingerprint: string }): {
		ready: boolean;
		reset: boolean;
	};
	searchCanonVectors(
		embedding: Float32Array,
		limit: number,
	): Array<{
		chunkId: string;
		distance: number;
	}>;
	upsertCanonVector(chunkId: string, embedding: Float32Array): void;
}

interface DatabaseOptions {
	readonly fileName?: string;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * Instance-scoped canonical database. Each HostRuntime owns one connection,
 * and opening initializes a fresh schema or validates the existing v1 schema
 * before domain services use it.
 */
export class Database {
	/** The underlying SQLite connection handed to domain services. */
	readonly connection: DatabaseSync;
	/** The typed application query interface. */
	readonly orm: AppDatabase;

	readonly path: string;
	constructor(databaseDir: string, options: DatabaseOptions = {}) {
		const fileName = options.fileName ?? "canon.db";
		this.path = join(databaseDir, fileName);
		mkdirSync(databaseDir, { recursive: true });

		this.connection = new DatabaseSync(this.path, { allowExtension: true });
		this.orm = createAppDatabase(this.connection);
		try {
			this.connection.enableLoadExtension(true);
			sqliteVec.load(this.connection);
			this.connection.enableLoadExtension(false);
		} catch {
			// Canon's lexical index remains available when the optional native
			// extension cannot load on a platform.
		}

		// Pragmas
		this.connection.exec("PRAGMA journal_mode = WAL");
		this.connection.exec("PRAGMA foreign_keys = ON");
		this.connection.exec("PRAGMA defensive = ON");
		this.connection.exec(`PRAGMA busy_timeout = 5000`);
	}

	/** Close the connection. Idempotent per instance. */
	close(): void {
		this.connection.close();
	}
	ensureCanonVectorIndex(configuration: { dimensions: number; fingerprint: string }): {
		ready: boolean;
		reset: boolean;
	} {
		const { dimensions, fingerprint } = configuration;
		if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || !/^[0-9a-f]{64}$/.test(fingerprint))
			return { ready: false, reset: false };
		let savepointOpen = false;
		try {
			this.connection.exec("SAVEPOINT canon_vector_configuration");
			savepointOpen = true;
			this.connection.exec(
				"CREATE TABLE IF NOT EXISTS canon_vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
			);
			const metadata = new Map(
				(
					this.connection
						.prepare(
							"SELECT key, value FROM canon_vector_meta WHERE key IN ('dimensions', 'fingerprint')",
						)
						.all() as Array<{ key: string; value: string }>
				).map((row) => [row.key, row.value]),
			);
			const reset =
				metadata.get("dimensions") !== String(dimensions) ||
				metadata.get("fingerprint") !== fingerprint;
			if (reset) {
				this.connection.exec("DROP TABLE IF EXISTS canon_chunk_vectors");
				this.connection.exec("UPDATE canon_chunks SET embedding = NULL");
			}
			this.connection.exec(
				`CREATE VIRTUAL TABLE IF NOT EXISTS canon_chunk_vectors USING vec0(
					chunk_id TEXT PRIMARY KEY,
					embedding float[${dimensions}] distance_metric=cosine
				)`,
			);
			this.connection
				.prepare(
					"INSERT INTO canon_vector_meta (key, value) VALUES ('dimensions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(String(dimensions));
			this.connection
				.prepare(
					"INSERT INTO canon_vector_meta (key, value) VALUES ('fingerprint', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(fingerprint);
			this.connection.exec("RELEASE canon_vector_configuration");
			savepointOpen = false;
			return { ready: true, reset };
		} catch {
			if (savepointOpen) {
				try {
					this.connection.exec("ROLLBACK TO canon_vector_configuration");
				} catch {}
				try {
					this.connection.exec("RELEASE canon_vector_configuration");
				} catch {}
			}
			return { ready: false, reset: false };
		}
	}

	searchCanonVectors(
		embedding: Float32Array,
		limit: number,
	): Array<{ chunkId: string; distance: number }> {
		return (
			this.connection
				.prepare(
					`SELECT chunk_id, distance FROM canon_chunk_vectors
					 WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
				)
				.all(
					Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
					limit,
				) as Array<{ chunk_id: string; distance: number }>
		).map((row) => ({ chunkId: row.chunk_id, distance: row.distance }));
	}

	upsertCanonVector(chunkId: string, embedding: Float32Array): void {
		this.connection.prepare("DELETE FROM canon_chunk_vectors WHERE chunk_id = ?").run(chunkId);
		this.connection
			.prepare("INSERT INTO canon_chunk_vectors (chunk_id, embedding) VALUES (?, ?)")
			.run(chunkId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
	}

	/** Initialize a fresh v1 database or validate an existing v1 database. */
	initialize(schemaSql: string): void {
		const tables = (
			this.connection
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		if (tables.length === 0) {
			this.connection.exec("BEGIN IMMEDIATE");
			try {
				this.connection.exec(schemaSql);
				this.connection.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
				this.connection.exec("COMMIT");
			} catch (error) {
				this.connection.exec("ROLLBACK");
				throw new Error(
					`database initialization failed: ${(error as Error)?.message ?? String(error)}`,
				);
			}
			return;
		}
		const row = this.connection.prepare("PRAGMA user_version").get() as {
			user_version: number;
		};
		if (row.user_version !== DATABASE_SCHEMA_VERSION) {
			throw new Error(
				`unsupported database schema version ${row.user_version}; expected ${DATABASE_SCHEMA_VERSION}`,
			);
		}
	}
}

export { COMPANION_SCHEMA_SQL, SYSTEM_SCHEMA_SQL };

export class SystemDatabase extends Database {
	constructor(path: string) {
		super(dirname(path), { fileName: basename(path) });
	}
}

export class CompanionDatabase extends Database {
	constructor(
		path: string,
		readonly companionId: string,
	) {
		super(dirname(path), { fileName: basename(path) });
	}

	ensureRuntimeIdentity(): void {
		const existing = this.orm
			.select({ companionId: companionRuntimeIdentity.companionId })
			.from(companionRuntimeIdentity)
			.where(eq(companionRuntimeIdentity.id, 1))
			.get();
		if (existing && existing.companionId !== this.companionId) {
			throw new Error("character runtime database identity does not match its directory");
		}
		if (!existing) {
			this.orm
				.insert(companionRuntimeIdentity)
				.values({ id: 1, companionId: this.companionId })
				.run();
		}
	}
}
