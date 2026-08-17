/**
 * Host canonical database — single `node:sqlite DatabaseSync` connection.
 *
 * Lifecycle: created at app boot, one connection, never shared across
 * worker_threads. WAL mode, foreign_keys, defensive mode, busy_timeout.
 *
 * Migrations are integer-ordered, checksummed, and recorded in an
 * append-only `schema_migrations` table. Before each migration the DB is
 * backed up (last 2 schema backups retained). Migration failure → storage
 * unavailable (no auto-rebuild). Recovery is copy-as-new only.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";

function createAppDatabase(client: DatabaseSync) {
	return drizzle({ client });
}

export type AppDatabase = ReturnType<typeof createAppDatabase>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max migrations to apply in one boot (safety gate). */
const MAX_MIGRATION_STEPS = 50;
/** Keep this many schema backups (the most recent 2). */
const RETAIN_BACKUPS = 2;
/** Query latency threshold for logging. */
const SLOW_QUERY_MS = 16;

// ---------------------------------------------------------------------------
// Migration type
// ---------------------------------------------------------------------------

export interface Migration {
	readonly id: number;
	readonly description: string;
	readonly up: string;
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
 * append-only `schema_migrations` table. Before each migration the DB is
 * backed up (last 2 schema backups retained). Migration failure → storage
 * unavailable (no auto-rebuild). Recovery is copy-as-new only.
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

	private readonly dbPath: string;
	private readonly backupDir: string;

	constructor(databaseDir: string) {
		this.dbPath = join(databaseDir, "canon.db");
		this.backupDir = join(databaseDir, "schema-backups");
		mkdirSync(databaseDir, { recursive: true });
		mkdirSync(this.backupDir, { recursive: true });

		this.connection = new DatabaseSync(this.dbPath);
		this.orm = createAppDatabase(this.connection);

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
		this.connection.close();
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

	/** Create a backup of the current database (schema + data) before migration. */
	private backupSchema(): string {
		const timestamp = Date.now().toString(36);
		const backupPath = join(this.backupDir, `canon-${timestamp}.db`);
		copyFileSync(this.dbPath, backupPath);
		return backupPath;
	}

	/** Prune old backups, keeping only the most recent RETAIN_BACKUPS. */
	private pruneBackups(): void {
		const files = readdirSync(this.backupDir)
			.filter((f) => f.startsWith("canon-") && f.endsWith(".db"))
			.map((f) => join(this.backupDir, f))
			.sort()
			.reverse();
		for (const old of files.slice(RETAIN_BACKUPS)) {
			rmSync(old);
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

		// Backup before applying
		const backupPath = this.backupSchema();

		// Apply in a transaction
		this.connection.exec("BEGIN IMMEDIATE");
		try {
			this.connection.exec(migration.up);
			this.connection
				.prepare("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)")
				.run(migration.id, chk);
			this.connection.exec("COMMIT");
		} catch (e) {
			this.connection.exec("ROLLBACK");
			throw new Error(
				`migration ${migration.id} failed: ${(e as Error)?.message ?? String(e)}; backup at ${backupPath}`,
			);
		}

		this.pruneBackups();
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

		for (const migration of pending) {
			this.applyMigration(migration);
		}
	}

	/** Refuse to start a partially compatible database. */
	assertSchemaContract(): void {
		const required: Readonly<Record<string, readonly string[]>> = {
			runs: ["id", "commission_id", "executor_profile", "status", "created_at"],
			configured_models: ["provider_id", "model_id", "label", "supports_images", "created_at"],
			conversation_model_selections: ["conversation_id", "provider_id", "model_id", "updated_at"],
			conversation_sessions: [
				"conversation_id",
				"pi_session_id",
				"session_file_path",
				"active_leaf_id",
				"created_at",
				"updated_at",
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

/** All project migrations, ordered by `id` — append-only. */
export const MIGRATIONS: Migration[] = [
	{
		id: 1,
		description: "Initial schema — conversations, messages, branches, events, artifacts",
		up: `
			CREATE TABLE companion_packages (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				version TEXT NOT NULL,
				hash TEXT NOT NULL,
				signed_at TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE companion_identity (
				id TEXT PRIMARY KEY,
				package_id TEXT NOT NULL REFERENCES companion_packages(id),
				name TEXT NOT NULL,
				self_canon TEXT NOT NULL,
				nickname TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE self_canon_versions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				canon TEXT NOT NULL,
				version INTEGER NOT NULL,
				hash TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE conversations (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				title TEXT NOT NULL DEFAULT '',
				scene_title TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE branches (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				parent_branch_id TEXT REFERENCES branches(id),
				fork_message_id TEXT,
				label TEXT NOT NULL DEFAULT '',
				adopted BOOLEAN NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				branch_id TEXT NOT NULL REFERENCES branches(id),
				role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE message_versions (
				id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL REFERENCES messages(id),
				content TEXT NOT NULL,
				edited_by_user BOOLEAN NOT NULL DEFAULT 0,
				adopted BOOLEAN NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE turns (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				user_message_id TEXT NOT NULL REFERENCES messages(id),
				assistant_message_id TEXT NOT NULL REFERENCES messages(id),
				status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','streaming','completed','failed','aborted')),
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE scene_state (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				scene TEXT NOT NULL DEFAULT '',
				state_json TEXT NOT NULL DEFAULT '{}',
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE conversation_directives (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				directive TEXT NOT NULL,
				scope TEXT NOT NULL DEFAULT 'session' CHECK (scope IN ('once','session','always')),
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE relationship_memory_entries (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				kind TEXT NOT NULL CHECK (kind IN ('fact','preference','event','self_canon_summary')),
				scope TEXT NOT NULL CHECK (scope IN ('self','relationship','scene')),
				text TEXT NOT NULL,
				normalized_text TEXT NOT NULL,
				source_message_version_id TEXT REFERENCES message_versions(id),
				source_branch_id TEXT REFERENCES branches(id),
				source_conversation_id TEXT REFERENCES conversations(id),
				source_kind TEXT NOT NULL DEFAULT 'user_button' CHECK (source_kind IN ('user_button','user_request','companion_suggestion','extractor')),
				status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','excluded','forgotten')),
				pinned_at TEXT,
				scene_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				forgotten_at TEXT
			);

			CREATE TABLE memory_candidates (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				kind TEXT NOT NULL CHECK (kind IN ('fact','preference','event','self_canon_summary')),
				source_message_version_id TEXT REFERENCES message_versions(id),
				source_branch_id TEXT REFERENCES branches(id),
				source_conversation_id TEXT REFERENCES conversations(id),
				source_kind TEXT NOT NULL CHECK (source_kind IN ('user_button','user_request','companion_suggestion','extractor')),
				normalized_text TEXT NOT NULL,
				why TEXT NOT NULL DEFAULT '',
				suggested_scope TEXT NOT NULL CHECK (suggested_scope IN ('self','relationship','scene')),
				status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				decided_at TEXT
			);

			CREATE TABLE memory_decisions (
				id TEXT PRIMARY KEY,
				candidate_id TEXT NOT NULL REFERENCES memory_candidates(id),
				decision TEXT NOT NULL CHECK (decision IN ('approve','approve_edited','reject')),
				edited_text TEXT,
				decided_scope TEXT CHECK (decided_scope IN ('self','relationship','scene')),
				decided_by_user BOOLEAN NOT NULL DEFAULT 1,
				decided_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE commissions (
				id TEXT PRIMARY KEY,
				conversation_id TEXT REFERENCES conversations(id),
				status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','awaiting_approval','approved','queued','running','needs_user','completed','failed','cancelled')),
				draft_json TEXT NOT NULL DEFAULT '{}',
				approval_hash TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE approvals (
				id TEXT PRIMARY KEY,
				commission_id TEXT NOT NULL REFERENCES commissions(id),
				draft_hash TEXT NOT NULL,
				approved_by TEXT NOT NULL DEFAULT 'user',
				expires_at TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				commission_id TEXT NOT NULL REFERENCES commissions(id),
				executor_profile TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'enqueued' CHECK (status IN ('enqueued','running','needs_user','completed','failed','cancelled','interrupted','forced_termination')),
				started_at TEXT,
				completed_at TEXT
			);

			CREATE TABLE run_manifests (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id),
				manifest_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				kind TEXT NOT NULL,
				payload TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE evidence (
				id TEXT PRIMARY KEY,
				run_id TEXT REFERENCES runs(id),
				kind TEXT NOT NULL,
				data TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE artifacts (
				id TEXT PRIMARY KEY,
				logical_name TEXT NOT NULL,
				mime TEXT NOT NULL,
				bytes INTEGER NOT NULL DEFAULT 0,
				sha256 TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','verified','verification_failed','adopted','saved')),
				producer_run_id TEXT REFERENCES runs(id),
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE artifact_adoptions (
				id TEXT PRIMARY KEY,
				artifact_id TEXT NOT NULL REFERENCES artifacts(id),
				run_id TEXT NOT NULL REFERENCES runs(id),
				adopted_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE provider_accounts (
				id TEXT PRIMARY KEY,
				provider_id TEXT NOT NULL,
				credential_blob BLOB,
				credential_status TEXT NOT NULL DEFAULT 'missing' CHECK (credential_status IN ('missing','session_only','stored','weak_storage','refreshing','invalid','unavailable')),
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE voice_stack_versions (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				provider_id TEXT NOT NULL,
				model_id TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 0,
				label TEXT NOT NULL DEFAULT '',
				active BOOLEAN NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE executor_profiles (
				id TEXT PRIMARY KEY,
				profile_type TEXT NOT NULL CHECK (profile_type IN ('product-managed','native-full','codex')),
				capability_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE runtime_assets (
				id TEXT PRIMARY KEY,
				asset_type TEXT NOT NULL,
				version TEXT NOT NULL,
				path TEXT NOT NULL,
				hash TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE user_decisions (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				decision_data TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE INDEX idx_messages_branch ON messages(branch_id);
			CREATE INDEX idx_message_versions_message ON message_versions(message_id);
			CREATE INDEX idx_turns_conversation ON turns(conversation_id);
			CREATE INDEX idx_memory_entries_companion ON relationship_memory_entries(companion_id);
			CREATE INDEX idx_memory_candidates_companion ON memory_candidates(companion_id);
			CREATE INDEX idx_events_seq ON events(seq);
			CREATE INDEX idx_artifacts_run ON artifacts(producer_run_id);
			CREATE INDEX idx_runs_commission ON runs(commission_id);
		`,
	},
	{
		id: 2,
		description: "FTS5 index for memory entries",
		up: `
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
				normalized_text,
				content='relationship_memory_entries',
				content_rowid='rowid',
				tokenize='unicode61'
			);

			CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON relationship_memory_entries
			BEGIN
				INSERT INTO memory_fts(rowid, normalized_text) VALUES (new.rowid, new.normalized_text);
			END;

			CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON relationship_memory_entries
			BEGIN
				INSERT INTO memory_fts(memory_fts, rowid, normalized_text) VALUES ('delete', old.rowid, old.normalized_text);
			END;

			CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON relationship_memory_entries
			BEGIN
				INSERT INTO memory_fts(memory_fts, rowid, normalized_text) VALUES ('delete', old.rowid, old.normalized_text);
				INSERT INTO memory_fts(rowid, normalized_text) VALUES (new.rowid, new.normalized_text);
			END;
		`,
	},
	{
		id: 3,
		description: "onboarding state table",
		up: `
			CREATE TABLE onboarding_state (
				companion_id TEXT PRIMARY KEY,
				state TEXT NOT NULL,
				state_json TEXT NOT NULL DEFAULT '{}',
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`,
	},
	{
		id: 4,
		description: "Canon Hub, story changes, and creator source graph",
		up: `
			CREATE TABLE story_changes (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				conversation_id TEXT REFERENCES conversations(id),
				branch_id TEXT REFERENCES branches(id),
				text TEXT NOT NULL,
				normalized_text TEXT NOT NULL,
				scope TEXT NOT NULL CHECK (scope IN ('global','branch')),
				source TEXT NOT NULL CHECK (source IN ('user_explicit','story_event','user_confirmed')),
				status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reverted')),
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				reverted_at TEXT
			);

			CREATE TABLE story_change_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				change_id TEXT REFERENCES story_changes(id),
				action TEXT NOT NULL CHECK (action IN ('applied','reverted','reset')),
				conversation_id TEXT REFERENCES conversations(id),
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE canon_sources (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				logical_name TEXT NOT NULL,
				mime TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				artifact_id TEXT REFERENCES artifacts(id),
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE canon_chunks (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL REFERENCES canon_sources(id) ON DELETE CASCADE,
				ordinal INTEGER NOT NULL,
				content TEXT NOT NULL,
				start_offset INTEGER NOT NULL,
				end_offset INTEGER NOT NULL,
				token_count INTEGER NOT NULL DEFAULT 0,
				embedding BLOB,
				UNIQUE(source_id, ordinal)
			);

			CREATE VIRTUAL TABLE canon_chunks_fts USING fts5(
				content,
				content='canon_chunks',
				content_rowid='rowid',
				tokenize='unicode61'
			);

			CREATE TRIGGER canon_chunks_fts_insert AFTER INSERT ON canon_chunks BEGIN
				INSERT INTO canon_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER canon_chunks_fts_delete AFTER DELETE ON canon_chunks BEGIN
				INSERT INTO canon_chunks_fts(canon_chunks_fts, rowid, content)
				VALUES ('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER canon_chunks_fts_update AFTER UPDATE ON canon_chunks BEGIN
				INSERT INTO canon_chunks_fts(canon_chunks_fts, rowid, content)
				VALUES ('delete', old.rowid, old.content);
				INSERT INTO canon_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
			END;

			CREATE TABLE canon_entities (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				kind TEXT NOT NULL,
				name TEXT NOT NULL,
				aliases_json TEXT NOT NULL DEFAULT '[]',
				description TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE canon_relations (
				id TEXT PRIMARY KEY,
				from_entity_id TEXT NOT NULL REFERENCES canon_entities(id) ON DELETE CASCADE,
				to_entity_id TEXT NOT NULL REFERENCES canon_entities(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				source_chunk_id TEXT REFERENCES canon_chunks(id),
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE TABLE story_modules (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				parent_id TEXT REFERENCES story_modules(id),
				kind TEXT NOT NULL CHECK (kind IN ('root','arc','event','entity','relationship','location','object','behavior')),
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				source_refs_json TEXT NOT NULL DEFAULT '[]',
				dependencies_json TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE INDEX idx_story_changes_companion ON story_changes(companion_id, status, created_at);
			CREATE INDEX idx_story_changes_branch ON story_changes(branch_id, status, created_at);
			CREATE INDEX idx_canon_sources_companion ON canon_sources(companion_id, created_at);
			CREATE INDEX idx_canon_chunks_source ON canon_chunks(source_id, ordinal);
			CREATE INDEX idx_canon_entities_companion ON canon_entities(companion_id, name);
			CREATE INDEX idx_story_modules_companion ON story_modules(companion_id, kind);
		`,
	},
	{
		id: 5,
		description: "Persist the active installed character",
		up: `
			CREATE TABLE active_character (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				character_id TEXT NOT NULL REFERENCES companion_identity(id),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`,
	},
	{
		id: 6,
		description: "Conversation archive state",
		up: `
			ALTER TABLE conversations ADD COLUMN archived_at TEXT;
			CREATE INDEX idx_conversations_active
				ON conversations(companion_id, archived_at, updated_at);
		`,
	},
	{
		id: 7,
		description: "Persistent story change confirmations",
		up: `
			CREATE TABLE story_change_proposals (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
				branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
				text TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				decided_at TEXT
			);
			CREATE INDEX idx_story_proposals_pending
				ON story_change_proposals(companion_id, conversation_id, status, created_at);
		`,
	},
	{
		id: 8,
		description: "Persistent text and multimodal model fallback routes",
		up: `
			CREATE TABLE model_route_settings (
				companion_id TEXT PRIMARY KEY REFERENCES companion_identity(id),
				text_provider_id TEXT,
				text_model_id TEXT,
				multimodal_provider_id TEXT,
				multimodal_model_id TEXT,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`,
	},
	{
		id: 9,
		description: "Reusable model pool and per-conversation selection",
		up: `
			ALTER TABLE runs ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00';
			UPDATE runs SET created_at = COALESCE(started_at, completed_at, datetime('now'));

			CREATE TABLE configured_models (
				provider_id TEXT NOT NULL,
				model_id TEXT NOT NULL,
				label TEXT NOT NULL,
				supports_images INTEGER NOT NULL DEFAULT 0 CHECK (supports_images IN (0, 1)),
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (provider_id, model_id)
			);
			INSERT OR IGNORE INTO configured_models (provider_id, model_id, label, created_at)
				SELECT provider_id, model_id, MAX(label), MIN(created_at)
				FROM voice_stack_versions
				GROUP BY provider_id, model_id;

			CREATE TABLE conversation_model_selections (
				conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
				provider_id TEXT NOT NULL,
				model_id TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				FOREIGN KEY (provider_id, model_id)
					REFERENCES configured_models(provider_id, model_id) ON DELETE CASCADE
			);
		`,
	},
	{
		id: 10,
		description: "Explicit automatic or manual vision model default",
		up: `
			ALTER TABLE model_route_settings
				ADD COLUMN vision_mode TEXT NOT NULL DEFAULT 'auto'
				CHECK (vision_mode IN ('auto', 'manual'));
			UPDATE model_route_settings
				SET vision_mode = CASE
					WHEN multimodal_provider_id IS NULL OR multimodal_model_id IS NULL THEN 'auto'
					ELSE 'manual'
				END;
		`,
	},
	{
		id: 11,
		description: "Append-only roleplay event ledger and monotonic unlocks",
		up: `
			CREATE TABLE roleplay_events (
				id TEXT PRIMARY KEY,
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
				branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,
				source_message_version_id TEXT REFERENCES message_versions(id) ON DELETE CASCADE,
				event_id TEXT NOT NULL,
				effects_json TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX idx_roleplay_events_projection
				ON roleplay_events(companion_id, conversation_id, created_at);
			CREATE TABLE roleplay_unlocks (
				companion_id TEXT NOT NULL REFERENCES companion_identity(id),
				unlockable_id TEXT NOT NULL,
				source_event_id TEXT NOT NULL REFERENCES roleplay_events(id) ON DELETE CASCADE,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (companion_id, unlockable_id)
			);
		`,
	},
	{
		id: 12,
		description: "Package-owned canon metadata and Chinese trigram retrieval",
		up: `
			ALTER TABLE canon_sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','package'));
			ALTER TABLE canon_sources ADD COLUMN stable_key TEXT;
			ALTER TABLE canon_sources ADD COLUMN language TEXT;
			ALTER TABLE canon_sources ADD COLUMN source_kind TEXT;
			ALTER TABLE canon_chunks ADD COLUMN heading TEXT;
			ALTER TABLE canon_entities ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','package'));
			ALTER TABLE canon_entities ADD COLUMN stable_key TEXT;
			ALTER TABLE story_modules ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','package'));
			ALTER TABLE story_modules ADD COLUMN stable_key TEXT;
			ALTER TABLE story_modules ADD COLUMN triggers_json TEXT NOT NULL DEFAULT '[]';
			CREATE UNIQUE INDEX idx_canon_sources_package_key ON canon_sources(companion_id, stable_key) WHERE stable_key IS NOT NULL;
			CREATE UNIQUE INDEX idx_canon_entities_package_key ON canon_entities(companion_id, stable_key) WHERE stable_key IS NOT NULL;
			CREATE UNIQUE INDEX idx_story_modules_package_key ON story_modules(companion_id, stable_key) WHERE stable_key IS NOT NULL;
			CREATE TABLE canon_package_state (
				companion_id TEXT PRIMARY KEY REFERENCES companion_identity(id) ON DELETE CASCADE,
				manifest_hash TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			DROP TRIGGER canon_chunks_fts_insert;
			DROP TRIGGER canon_chunks_fts_delete;
			DROP TRIGGER canon_chunks_fts_update;
			DROP TABLE canon_chunks_fts;
			CREATE VIRTUAL TABLE canon_chunks_fts USING fts5(
				content, content='canon_chunks', content_rowid='rowid', tokenize='trigram'
			);
			CREATE TRIGGER canon_chunks_fts_insert AFTER INSERT ON canon_chunks BEGIN
				INSERT INTO canon_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			CREATE TRIGGER canon_chunks_fts_delete AFTER DELETE ON canon_chunks BEGIN
				INSERT INTO canon_chunks_fts(canon_chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			END;
			CREATE TRIGGER canon_chunks_fts_update AFTER UPDATE ON canon_chunks BEGIN
				INSERT INTO canon_chunks_fts(canon_chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
				INSERT INTO canon_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
			END;
			INSERT INTO canon_chunks_fts(canon_chunks_fts) VALUES ('rebuild');
		`,
	},
	{
		id: 13,
		description: "Versioned character package workshop drafts",
		up: `
			CREATE TABLE character_drafts (
				id TEXT PRIMARY KEY,
				base_package_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('draft','validating','ready_to_publish','published')),
				locale TEXT NOT NULL DEFAULT 'zh-CN',
				current_revision INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE TABLE character_draft_revisions (
				draft_id TEXT NOT NULL REFERENCES character_drafts(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				files_json TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (draft_id, revision)
			);
		`,
	},
	{
		id: 14,
		description: "Character package plugin provenance and explicit trust",
		up: `
			ALTER TABLE companion_packages ADD COLUMN origin TEXT NOT NULL DEFAULT 'official'
				CHECK (origin IN ('official','local','imported'));
			ALTER TABLE companion_packages ADD COLUMN plugin_hash TEXT NOT NULL DEFAULT '';
			ALTER TABLE companion_packages ADD COLUMN plugin_trusted_hash TEXT;
		`,
	},
	{
		id: 15,
		description: "Persist Pi-managed conversation session metadata",
		up: `
			CREATE TABLE conversation_sessions (
				conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
				pi_session_id TEXT NOT NULL,
				session_file_path TEXT NOT NULL,
				active_leaf_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`,
	},
];
