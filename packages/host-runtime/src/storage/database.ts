/**
 * Host canonical database — single `node:sqlite DatabaseSync` connection.
 *
 * Lifecycle: created at app boot, one connection, never shared across
 * worker_threads. WAL mode, foreign_keys, defensive mode, busy_timeout.
 *
 * Migrations are integer-ordered, checksummed, and recorded in an
 * append-only `schema_migrations` table. Each upgrade batch gets one verified,
 * SQLite-consistent pre-upgrade backup and a durable recovery marker.
 * Migration failure → storage unavailable (no auto-rebuild). Recovery is
 * copy-as-new only.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import * as sqliteVec from "sqlite-vec";
import { BASELINE_V1_SQL } from "./baseline-v1.js";
import { installationIdentity } from "./schema.js";

function createAppDatabase(client: DatabaseSync) {
	return drizzle({ client });
}

export type AppDatabase = ReturnType<typeof createAppDatabase>;

const INSTALLATION_IDENTITY_SINGLETON_ID = 1;

/** Load the durable identity created by the installation identity migration. */
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
	ensureCanonVectorIndex(dimensions: number): { ready: boolean; reset: boolean };
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

/** Max migrations to apply in one boot (safety gate). */
const MAX_MIGRATION_STEPS = 50;
/** Retain at least the current and preceding verified schema backups. */
const RETAIN_BACKUPS = 2;
/** Query latency threshold for logging. */
const SLOW_QUERY_MS = 16;
/**
 * The sole pre-release v1 baseline shipped before `conversations.scene_title`
 * was replaced by Host-owned `scene_state`. This is intentionally a checksum,
 * not a loose schema probe: no unknown database is ever rewritten.
 */
const PRE_RELEASE_V1_SCENE_TITLE_CHECKSUM =
	"0ac4f43cf5d1aed5e85a00bc725e57d6b9a00e3ed17386845ca76cbe4452a3ea";

// ---------------------------------------------------------------------------
// Migration type
// ---------------------------------------------------------------------------

export interface Migration {
	readonly id: number;
	readonly description: string;
	readonly up: string;
	readonly rebuildsForeignKeys?: true;
}

interface UpgradeMarker {
	readonly sourceVersion: number;
	readonly targetVersion: number;
	readonly backupPath: string;
	readonly state: "pending";
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * Instance-scoped canonical database — one `node:sqlite DatabaseSync`
 * connection per runtime. The connection is never shared across
 * worker_threads. WAL mode, foreign_keys, defensive mode, busy_timeout.
 *
 * Migrations are integer-ordered, checksummed, and recorded in an
 * append-only `schema_migrations` table. Each upgrade batch gets one verified,
 * SQLite-consistent pre-upgrade backup and a durable recovery marker.
 * Migration failure → storage unavailable (no auto-rebuild). Recovery is
 * copy-as-new only.
 *
 * Unlike the legacy desktop singleton, this class owns its connection and
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

	private readonly dbPath: string;
	private readonly backupDir: string;
	private readonly upgradeMarkerPath: string;

	constructor(databaseDir: string) {
		this.dbPath = join(databaseDir, "canon.db");
		this.backupDir = join(databaseDir, "schema-backups");
		this.upgradeMarkerPath = join(databaseDir, "schema-upgrade.json");
		mkdirSync(databaseDir, { recursive: true });
		mkdirSync(this.backupDir, { recursive: true });

		this.connection = new DatabaseSync(this.dbPath, { allowExtension: true });
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

		// Create the schema_migrations tracking table if this is a fresh DB
		this.connection.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				id INTEGER PRIMARY KEY,
				checksum TEXT NOT NULL,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
	}

	/** Close the connection. Idempotent per instance. */
	close(): void {
		this.syncClosed = true;
		this.syncListeners.clear();
		this.connection.close();
	}
	ensureCanonVectorIndex(dimensions: number): { ready: boolean; reset: boolean } {
		if (!Number.isSafeInteger(dimensions) || dimensions <= 0) return { ready: false, reset: false };
		try {
			this.connection.exec(
				"CREATE TABLE IF NOT EXISTS canon_vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
			);
			const row = this.connection
				.prepare("SELECT value FROM canon_vector_meta WHERE key = 'dimensions'")
				.get() as { value: string } | undefined;
			const reset = Boolean(row && Number(row.value) !== dimensions);
			if (reset) this.connection.exec("DROP TABLE IF EXISTS canon_chunk_vectors");
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
			return { ready: true, reset };
		} catch {
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

	/** Get the current user_version (highest applied migration id). */
	currentVersion(): number {
		const row = this.connection
			.prepare("SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations")
			.get() as { v: number };
		return row.v;
	}

	/** Compute a SHA-256 checksum of a migration SQL string. */
	private checksum(sql: string): string {
		return createHash("sha256").update(sql, "utf8").digest("hex");
	}

	/** Return verified backup files in newest-first filename order. */
	private backupPaths(): string[] {
		return readdirSync(this.backupDir)
			.filter((file) => file.startsWith("canon-") && file.endsWith(".db"))
			.map((file) => join(this.backupDir, file))
			.sort()
			.reverse();
	}

	/** Create and verify a SQLite-consistent backup of all committed data. */
	private backupSchema(sourceVersion: number, targetVersion: number): string {
		const timestamp = Date.now().toString().padStart(13, "0");
		let suffix = 0;
		let backupPath: string;
		do {
			const collisionSuffix = suffix === 0 ? "" : `-${suffix}`;
			backupPath = join(
				this.backupDir,
				`canon-${timestamp}-v${sourceVersion}-to-v${targetVersion}${collisionSuffix}.db`,
			);
			suffix += 1;
		} while (existsSync(backupPath));

		const quotedPath = backupPath.replaceAll("'", "''");
		this.connection.exec(`VACUUM INTO '${quotedPath}'`);
		try {
			this.validateDatabase(new DatabaseSync(backupPath, { readOnly: true }), "pre-upgrade backup");
			this.syncDirectory(this.backupDir);
		} catch (error) {
			rmSync(backupPath, { force: true });
			throw error;
		}
		return backupPath;
	}

	/** Validate integrity and referential consistency, closing non-primary connections. */
	private validateDatabase(database: DatabaseSync, label: string): void {
		const closeAfterCheck = database !== this.connection;
		try {
			const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<
				Record<string, unknown>
			>;
			const integrityErrors = integrityRows
				.map((row) => Object.values(row)[0])
				.filter((result) => result !== "ok");
			if (integrityRows.length !== 1 || integrityErrors.length > 0) {
				throw new Error(`${label} integrity check failed: ${JSON.stringify(integrityRows)}`);
			}
			const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
			if (foreignKeyErrors.length > 0) {
				throw new Error(`${label} foreign key check failed: ${JSON.stringify(foreignKeyErrors)}`);
			}
		} finally {
			if (closeAfterCheck) database.close();
		}
	}

	/** Atomically persist the recovery marker before the first schema change. */
	private writeUpgradeMarker(marker: UpgradeMarker): void {
		const temporaryPath = `${this.upgradeMarkerPath}.tmp-${process.pid}`;
		writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
			encoding: "utf8",
			flush: true,
		});
		renameSync(temporaryPath, this.upgradeMarkerPath);
		this.syncDirectory(dirname(this.upgradeMarkerPath));
	}

	/** Remove the recovery marker durably after the upgraded database is verified. */
	private clearUpgradeMarker(): void {
		rmSync(this.upgradeMarkerPath, { force: true });
		this.syncDirectory(dirname(this.upgradeMarkerPath));
	}

	private syncDirectory(directoryPath: string): void {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(directoryPath, "r");
			fsyncSync(descriptor);
		} catch (error) {
			if (process.platform !== "win32") throw error;
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}

	/** Prune old backups without removing either recovery-relevant snapshot. */
	private pruneBackups(protectedPaths: ReadonlySet<string>): void {
		const files = this.backupPaths();
		const retained = new Set(files.slice(0, RETAIN_BACKUPS));
		for (const protectedPath of protectedPaths) retained.add(protectedPath);
		for (const old of files) {
			if (!retained.has(old)) rmSync(old);
		}
	}

	/** Apply a single migration inside a transaction, with checksum validation. */
	private applyMigration(migration: Migration): void {
		const chk = this.checksum(migration.up);

		// Verify the migration hasn't been applied with a different checksum
		const existing = this.connection
			.prepare("SELECT checksum FROM schema_migrations WHERE id = ?")
			.get(migration.id) as { checksum: string } | undefined;
		if (existing) {
			if (existing.checksum !== chk) {
				throw new Error(
					`migration ${migration.id} checksum mismatch: was ${existing.checksum}, current ${chk}`,
				);
			}
			return; // already applied, same checksum — idempotent
		}

		// Table-rebuild migrations temporarily suspend enforcement before the
		// transaction, rebuild every referenced identity in-place, then run
		// SQLite's full FK check before commit and restore enforcement.
		const rebuildsForeignKeys = migration.rebuildsForeignKeys === true;
		if (rebuildsForeignKeys) this.connection.exec("PRAGMA foreign_keys = OFF");
		this.connection.exec("BEGIN IMMEDIATE");
		try {
			this.connection.exec(migration.up);
			if (
				rebuildsForeignKeys &&
				this.connection.prepare("PRAGMA foreign_key_check").all().length > 0
			) {
				throw new Error("foreign key check failed after table rebuild");
			}
			this.connection
				.prepare("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)")
				.run(migration.id, chk);
			this.connection.exec("COMMIT");
		} catch (e) {
			this.connection.exec("ROLLBACK");
			if (rebuildsForeignKeys) this.connection.exec("PRAGMA foreign_keys = ON");
			throw new Error(`migration ${migration.id} failed: ${(e as Error)?.message ?? String(e)}`);
		}
		if (rebuildsForeignKeys) this.connection.exec("PRAGMA foreign_keys = ON");
	}

	/**
	 * Fold the one known pre-release v1 database into the final v1 baseline.
	 *
	 * This is deliberately not a numbered migration: release 1.0 still has one
	 * canonical baseline. The exact old checksum and obsolete column must both
	 * match before any write occurs. The normal verified-backup/recovery-marker
	 * contract applies, and an interrupted or failed rewrite stays recoverable.
	 */
	private reconcilePreReleaseV1(migrations: readonly Migration[]): void {
		if (migrations.length !== 1 || migrations[0]?.id !== 1) return;
		const record = this.connection
			.prepare("SELECT checksum FROM schema_migrations WHERE id = 1")
			.get() as { checksum: string } | undefined;
		if (record?.checksum !== PRE_RELEASE_V1_SCENE_TITLE_CHECKSUM) return;

		const columns = new Set(
			(
				this.connection.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
			).map((column) => column.name),
		);
		if (!columns.has("scene_title")) {
			throw new Error(
				"known pre-release v1 checksum has an unexpected conversations schema; refusing rewrite",
			);
		}

		const lastKnownGoodBackup = this.backupPaths()[0];
		const backupPath = this.backupSchema(1, 1);
		this.writeUpgradeMarker({ sourceVersion: 1, targetVersion: 1, backupPath, state: "pending" });
		try {
			this.connection.exec("BEGIN IMMEDIATE");
			try {
				this.connection.exec("ALTER TABLE conversations DROP COLUMN scene_title");
				this.connection
					.prepare("UPDATE schema_migrations SET checksum = ? WHERE id = 1 AND checksum = ?")
					.run(this.checksum(migrations[0].up), PRE_RELEASE_V1_SCENE_TITLE_CHECKSUM);
				this.connection.exec("COMMIT");
			} catch (error) {
				this.connection.exec("ROLLBACK");
				throw error;
			}
			this.validateDatabase(this.connection, "reconciled pre-release v1 database");
		} catch (error) {
			throw new Error(
				`pre-release v1 reconciliation failed: ${(error as Error)?.message ?? String(error)}; ` +
					`verified backup at ${backupPath}; recovery marker at ${this.upgradeMarkerPath}`,
			);
		}

		this.clearUpgradeMarker();
		this.pruneBackups(
			new Set(lastKnownGoodBackup ? [backupPath, lastKnownGoodBackup] : [backupPath]),
		);
	}

	/** Run all pending migrations in order. */
	migrate(migrations: Migration[]): void {
		if (migrations.length > MAX_MIGRATION_STEPS) {
			throw new Error(`too many migrations (${migrations.length} > ${MAX_MIGRATION_STEPS})`);
		}
		const ordered = [...migrations].sort((left, right) => left.id - right.id);
		for (const [index, migration] of ordered.entries()) {
			if (index > 0 && ordered[index - 1]?.id === migration.id) {
				throw new Error(`duplicate migration id ${migration.id}`);
			}
			const expectedId = index + 1;
			if (migration.id !== expectedId) {
				throw new Error(
					`non-contiguous migration definitions: expected ${expectedId}, received ${migration.id}`,
				);
			}
		}
		this.reconcilePreReleaseV1(ordered);

		const current = this.currentVersion();
		const knownIds = new Set(ordered.map((migration) => migration.id));
		const applied = this.connection
			.prepare("SELECT id, checksum FROM schema_migrations")
			.all() as Array<{
			id: number;
			checksum: string;
		}>;
		for (const record of applied) {
			const migration = ordered.find((candidate) => candidate.id === record.id);
			if (!migration || !knownIds.has(record.id)) {
				throw new Error(`unknown applied migration ${record.id}`);
			}
			const expected = this.checksum(migration.up);
			if (record.checksum !== expected) {
				throw new Error(
					`migration ${record.id} checksum mismatch: was ${record.checksum}, current ${expected}`,
				);
			}
		}
		const appliedIds = new Set(applied.map((migration) => migration.id));
		for (let id = 1; id <= current; id += 1) {
			if (!appliedIds.has(id)) {
				throw new Error(`migration history gap: missing applied migration ${id}`);
			}
		}
		const pending = ordered.filter((migration) => migration.id > current);
		if (pending.length === 0) return;

		const targetVersion = pending.at(-1)?.id;
		if (targetVersion === undefined) return;
		const lastKnownGoodBackup = this.backupPaths()[0];
		const backupPath = this.backupSchema(current, targetVersion);
		this.writeUpgradeMarker({
			sourceVersion: current,
			targetVersion,
			backupPath,
			state: "pending",
		});

		try {
			for (const migration of pending) {
				this.applyMigration(migration);
			}
			this.validateDatabase(this.connection, "upgraded database");
		} catch (error) {
			throw new Error(
				`database upgrade from ${current} to ${targetVersion} failed: ${
					(error as Error)?.message ?? String(error)
				}; verified backup at ${backupPath}; recovery marker at ${this.upgradeMarkerPath}`,
			);
		}

		this.clearUpgradeMarker();
		this.pruneBackups(
			new Set(lastKnownGoodBackup ? [backupPath, lastKnownGoodBackup] : [backupPath]),
		);
	}

	/** Refuse to start a partially compatible database. */
	assertSchemaContract(): void {
		const required: Readonly<Record<string, readonly string[]>> = {
			installation_identity: ["id", "installation_id", "created_at"],
			app_settings: [
				"id",
				"first_run_stage",
				"network_proxy",
				"memory_vector_service",
				"model_download_mirror",
				"updated_at",
			],
			runs: [
				"id",
				"conversation_id",
				"trigger_entry_id",
				"executor_profile",
				"title",
				"instruction",
				"input_attachment_ids",
				"workspace_attachment_id",
				"status",
				"created_at",
			],
			conversation_attachments: [
				"id",
				"conversation_id",
				"origin_entry_id",
				"send_nonce",
				"kind",
				"name",
				"total_bytes",
				"file_count",
				"created_at",
			],
			conversation_attachment_files: [
				"id",
				"attachment_id",
				"entry_kind",
				"relative_path",
				"artifact_id",
				"sha256",
			],
			configured_models: ["provider_id", "model_id", "label", "supports_images", "created_at"],
			conversation_model_selections: ["conversation_id", "provider_id", "model_id", "updated_at"],
			conversation_sessions: [
				"conversation_id",
				"pi_session_id",
				"session_file_path",
				"created_at",
				"updated_at",
			],
			relationship_memory_entries: ["source_pi_session_id", "source_native_entry_id"],
			memory_candidates: ["source_pi_session_id", "source_native_entry_id"],
			character_state_documents: [
				"id",
				"companion_id",
				"conversation_id",
				"scope",
				"state_json",
				"revision",
				"schema_hash",
			],
			pending_state_mutations: [
				"id",
				"companion_id",
				"conversation_id",
				"pi_session_id",
				"source_user_entry_id",
				"assistant_entry_id",
				"operations_json",
				"expected_revisions_json",
				"status",
			],
			state_mutation_log: ["id", "source_user_entry_id", "assistant_entry_id"],
			roleplay_events: ["pi_session_id", "source_native_entry_id"],
			memory_presentation: [
				"backend_memory_id",
				"installation_id",
				"user_id",
				"companion_id",
				"source_pi_entry_id",
				"created_by",
				"pinned",
				"replacement_memory_id",
				"created_at",
				"updated_at",
				"invalidated_at",
			],
		};
		for (const [table, columns] of Object.entries(required)) {
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

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

/** Bear 1.0 release baseline. Add upgrade migrations only after the 1.0 artifact is published. */
export const MIGRATIONS: Migration[] = [
	{ id: 1, description: "Bear 1.0 canonical schema", up: BASELINE_V1_SQL },
];
