/**
 * Host canonical database — single `node:sqlite DatabaseSync` connection.
 *
 * Lifecycle: created at app boot, one connection, never shared across
 * worker_threads. WAL mode, foreign_keys, defensive mode, busy_timeout.
 * Bear uses one final schema for each database. Database opening performs only
 * deterministic in-place upgrades from the immediately preceding schema.
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

interface DatabaseOptions {
	readonly fileName?: string;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Upgrade only the immediately preceding, explicitly recognized schema. */
function tableExists(connection: DatabaseSync, table: string): boolean {
	return Boolean(
		connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
	);
}

function columnNames(connection: DatabaseSync, table: string): Set<string> {
	return new Set(
		(
			connection.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
}

function upgradeSystemSchema(connection: DatabaseSync): void {
	if (!tableExists(connection, "app_settings") || !tableExists(connection, "configured_models"))
		return;
	const appColumns = columnNames(connection, "app_settings");
	const hasLegacyStage = appColumns.has("first_run_stage");
	const completionColumns = [
		"system_model_onboarding_complete",
		"embedding_onboarding_complete",
		"relationship_memory_enabled",
	] as const;
	const hasAllCompletionColumns = completionColumns.every((column) => appColumns.has(column));
	const hasAnyCompletionColumn = completionColumns.some((column) => appColumns.has(column));
	const legacyOnboardingSchema = hasLegacyStage && !hasAnyCompletionColumn;
	const currentOnboardingSchema = !hasLegacyStage && hasAllCompletionColumns;
	if (!legacyOnboardingSchema && !currentOnboardingSchema)
		throw new Error("unsupported app_settings onboarding schema");
	if (legacyOnboardingSchema) {
		const invalid = connection
			.prepare(
				"SELECT 1 FROM app_settings WHERE first_run_stage NOT IN ('model', 'embedding', 'role') LIMIT 1",
			)
			.get();
		if (invalid) throw new Error("unsupported app_settings first_run_stage");
	}

	connection.exec("BEGIN IMMEDIATE");
	try {
		if (hasLegacyStage) {
			connection.exec(`
				ALTER TABLE app_settings RENAME TO app_settings_legacy_onboarding;
				CREATE TABLE app_settings (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					system_model_onboarding_complete INTEGER NOT NULL DEFAULT 0
						CHECK (system_model_onboarding_complete IN (0, 1)),
					embedding_onboarding_complete INTEGER NOT NULL DEFAULT 0
						CHECK (embedding_onboarding_complete IN (0, 1)),
					relationship_memory_enabled INTEGER NOT NULL DEFAULT 0
						CHECK (relationship_memory_enabled IN (0, 1)),
					network_proxy TEXT NOT NULL DEFAULT '{"mode":"auto"}',
					memory_vector_service TEXT NOT NULL DEFAULT '{"enabled":false,"provider":"none"}',
					system_model_defaults TEXT NOT NULL DEFAULT '{"vision":{"mode":"auto"}}',
					model_download_mirror TEXT NOT NULL DEFAULT '{"type":"official"}',
					updated_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				INSERT INTO app_settings (
					id,
					system_model_onboarding_complete,
					embedding_onboarding_complete,
					relationship_memory_enabled,
					network_proxy,
					memory_vector_service,
					system_model_defaults,
					model_download_mirror,
					updated_at
				)
				SELECT
					id,
					CASE first_run_stage WHEN 'model' THEN 0 ELSE 1 END,
					CASE first_run_stage WHEN 'role' THEN 1 ELSE 0 END,
					0,
					network_proxy,
					memory_vector_service,
					system_model_defaults,
					model_download_mirror,
					updated_at
				FROM app_settings_legacy_onboarding;
				DROP TABLE app_settings_legacy_onboarding;
			`);
		}
		if (!columnNames(connection, "configured_models").has("enabled")) {
			connection.exec(
				"ALTER TABLE configured_models ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))",
			);
		}
		connection.exec(`
			CREATE TABLE IF NOT EXISTS provider_removal_journal (
				provider_id TEXT PRIMARY KEY,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		connection.exec("COMMIT");
	} catch (error) {
		connection.exec("ROLLBACK");
		throw new Error(
			`system database upgrade failed: ${(error as Error)?.message ?? String(error)}`,
		);
	}
}

function upgradeCompanionSchema(connection: DatabaseSync): void {
	if (
		!tableExists(connection, "runtime_identity") ||
		!tableExists(connection, "conversations") ||
		tableExists(connection, "active_conversations")
	)
		return;
	connection.exec("BEGIN IMMEDIATE");
	try {
		connection.exec(`
			CREATE TABLE active_conversations (
				companion_id TEXT PRIMARY KEY REFERENCES runtime_identity(companion_id) ON DELETE CASCADE,
				conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		connection.exec("COMMIT");
	} catch (error) {
		connection.exec("ROLLBACK");
		throw new Error(
			`companion database upgrade failed: ${(error as Error)?.message ?? String(error)}`,
		);
	}
}

/**
 * Instance-scoped canonical database. Each HostRuntime owns one connection,
 * and opening initializes or upgrades its schema before domain services use it.
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

	/** Initialize a fresh database or upgrade the immediately preceding schema. */
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
			return;
		}
		if (schemaSql === SYSTEM_SCHEMA_SQL) {
			upgradeSystemSchema(this.connection);
		} else if (schemaSql === COMPANION_SCHEMA_SQL) {
			upgradeCompanionSchema(this.connection);
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
