/**
 * Host canonical database — single `node:sqlite DatabaseSync` connection.
 *
 * Lifecycle: created at app boot, one connection, never shared across
 * worker_threads. WAL mode, foreign_keys, defensive mode, busy_timeout.
 *
 * Bear 1.0 uses one checked-in schema for each database. Existing databases
 * must already satisfy that schema; there is no internal upgrade ladder.
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

const INSTALLATION_IDENTITY_SINGLETON_ID = 1;

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Query latency threshold for logging. */
const SLOW_QUERY_MS = 16;

type SchemaContract = Readonly<Record<string, readonly string[]>>;

interface DatabaseOptions {
	readonly fileName?: string;
	readonly schemaContract?: SchemaContract;
}

export const SYSTEM_SCHEMA_CONTRACT: SchemaContract = {
	installation_identity: ["id", "installation_id", "created_at"],
	app_settings: [
		"id",
		"first_run_stage",
		"network_proxy",
		"memory_vector_service",
		"system_model_defaults",
		"model_download_mirror",
		"updated_at",
	],
	companion_packages: ["id", "name", "origin", "plugin_hash"],
	companion_identity: ["id", "package_id", "name"],
	provider_accounts: ["id", "provider_id", "credential_blob", "credential_status"],
	configured_models: ["provider_id", "model_id", "label", "supports_images", "created_at"],
	executor_profiles: ["id", "profile_type", "capability_json"],
};

export const COMPANION_SCHEMA_CONTRACT: SchemaContract = {
	runtime_identity: ["id", "companion_id", "nickname", "created_at"],
	events: ["seq", "kind", "payload", "created_at"],
	conversations: ["id", "companion_id", "archived_at"],
	model_route_settings: [
		"companion_id",
		"text_provider_id",
		"text_model_id",
		"vision_mode",
		"onboarding_complete",
	],
	onboarding_state: ["companion_id", "state", "state_json"],
	runs: ["id", "conversation_id", "trigger_entry_id", "executor_profile", "status"],
	artifacts: ["id", "sha256", "producer_run_id", "status"],
	companion_state_documents: [
		"id",
		"companion_id",
		"conversation_id",
		"scope",
		"domain",
		"state_json",
		"revision",
	],
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * Instance-scoped canonical database — one `node:sqlite DatabaseSync`
 * connection per runtime. The connection is never shared across
 * worker_threads. WAL mode, foreign_keys, defensive mode, busy_timeout.
 *
 * Bear 1.0 opens one final schema. A fresh database is initialized atomically;
 * an existing database is validated instead of being interpreted as a point
 * on an upgrade timeline.
 *
 * This class owns its connection and
 * paths: each HostRuntime creates its own instance and closes it on
 * shutdown, so nothing is shared at module scope.
 */
export class Database {
	/** The underlying SQLite connection handed to domain services. */
	readonly connection: DatabaseSync;
	/** The typed application query interface. */
	readonly orm: AppDatabase;

	private readonly syncListeners = new Set<(revision: number, tables: string[]) => void>();
	private syncNotificationQueued = false;
	private syncClosed = false;
	private deliveredSyncRevision = 0;

	/** Durable watermark; SQLite rolls it back together with the business write. */
	syncRevision(): number {
		return Number(
			this.connection.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes'").get()
				?.seq ?? 0,
		);
	}

	subscribeSync(listener: (revision: number, tables: string[]) => void): () => void {
		this.syncListeners.add(listener);
		return () => this.syncListeners.delete(listener);
	}

	private scheduleSyncNotification(): void {
		if (this.syncNotificationQueued || this.syncClosed) return;
		this.syncNotificationQueued = true;
		queueMicrotask(() => {
			this.syncNotificationQueued = false;
			if (this.syncClosed) return;
			// SQL triggers run inside the caller's transaction. Delivery runs only
			// after the synchronous transaction has committed or rolled back.
			if (this.connection.isTransaction) return;
			const revision = this.syncRevision();
			if (revision <= this.deliveredSyncRevision) return;
			const tables = this.connection
				.prepare("SELECT DISTINCT source FROM sync_changes WHERE revision > ? AND revision <= ?")
				.all(this.deliveredSyncRevision, revision)
				.map((row) => String(row.source));
			this.deliveredSyncRevision = revision;
			// Retain a bounded diagnostic tail; sqlite_sequence preserves the watermark.
			this.connection.prepare("DELETE FROM sync_changes WHERE revision <= ?").run(revision - 10000);
			for (const listener of this.syncListeners) listener(revision, tables);
		});
	}

	readonly path: string;
	private readonly schemaContract: SchemaContract;

	constructor(databaseDir: string, options: DatabaseOptions = {}) {
		const fileName = options.fileName ?? "canon.db";
		this.path = join(databaseDir, fileName);
		this.schemaContract = options.schemaContract ?? {};
		mkdirSync(databaseDir, { recursive: true });

		this.connection = new DatabaseSync(this.path, { allowExtension: true });
		this.connection.function("bear_sync_changed", () => {
			this.scheduleSyncNotification();
			return 0;
		});
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
		this.syncClosed = true;
		this.syncListeners.clear();
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

	/** Initialize a fresh database from the single Bear 1.0 schema. */
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
				this.connection.exec("COMMIT");
			} catch (error) {
				this.connection.exec("ROLLBACK");
				throw new Error(
					`database initialization failed: ${(error as Error)?.message ?? String(error)}`,
				);
			}
		}
	}

	/** Refuse to start a database that does not match the current schema. */
	assertSchemaContract(): void {
		for (const [table, columns] of Object.entries(this.schemaContract)) {
			const actual = new Set(
				(
					this.connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
				).map((column) => column.name),
			);
			for (const column of columns) {
				if (!actual.has(column)) {
					throw new Error(`incompatible database schema: missing ${table}.${column}`);
				}
			}
		}
	}

	/** Record a latency observation for a query. */
	recordLatency(operation: string, elapsedMs: number): void {
		if (elapsedMs > SLOW_QUERY_MS) {
			// Logged via diagnostics; for now just a console.warn (M1 diagnostics integration later)
			console.warn(`slow query [${elapsedMs.toFixed(1)}ms]: ${operation.slice(0, 120)}`);
		}
	}
}

export { COMPANION_SCHEMA_SQL, SYSTEM_SCHEMA_SQL };

export class SystemDatabase extends Database {
	constructor(path: string) {
		super(dirname(path), {
			fileName: basename(path),
			schemaContract: SYSTEM_SCHEMA_CONTRACT,
		});
	}
}

export class CompanionDatabase extends Database {
	constructor(
		path: string,
		readonly companionId: string,
	) {
		super(dirname(path), {
			fileName: basename(path),
			schemaContract: COMPANION_SCHEMA_CONTRACT,
		});
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
