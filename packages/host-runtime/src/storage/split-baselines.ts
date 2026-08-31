function syncTriggers(tables: readonly string[]): string {
	return tables
		.flatMap((table) =>
			(["insert", "update", "delete"] as const).map(
				(
					operation,
				) => `CREATE TRIGGER sync_${table}_${operation} AFTER ${operation.toUpperCase()} ON "${table}" BEGIN
INSERT INTO sync_changes(source) VALUES ('${table}'); SELECT bear_sync_changed(); END;`,
			),
		)
		.join("\n");
}

const SYSTEM_TABLES = [
	"active_character",
	"app_settings",
	"character_draft_revisions",
	"character_drafts",
	"companion_identity",
	"companion_packages",
	"configured_models",
	"executor_profiles",
	"provider_accounts",
	"runtime_assets",
	"user_decisions",
] as const;

export const SYSTEM_BASELINE_V1_SQL = `
CREATE TABLE installation_identity (
	id INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (id = 1),
	installation_id TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE companion_packages (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	origin TEXT NOT NULL DEFAULT 'official' CHECK (origin IN ('official','local','imported')),
	plugin_hash TEXT NOT NULL DEFAULT '',
	plugin_trusted_hash TEXT,
	signed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE companion_identity (
	id TEXT PRIMARY KEY,
	package_id TEXT NOT NULL REFERENCES companion_packages(id),
	name TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE active_character (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	character_id TEXT NOT NULL REFERENCES companion_identity(id),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE app_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	first_run_stage TEXT NOT NULL DEFAULT 'model',
	network_proxy TEXT NOT NULL DEFAULT '{"mode":"auto"}',
	memory_vector_service TEXT NOT NULL DEFAULT '{"enabled":false,"provider":"none"}',
	system_model_defaults TEXT NOT NULL DEFAULT '{"vision":{"mode":"auto"}}',
	model_download_mirror TEXT NOT NULL DEFAULT '{}',
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE provider_accounts (
	id TEXT PRIMARY KEY,
	provider_id TEXT NOT NULL,
	credential_blob BLOB,
	credential_status TEXT NOT NULL DEFAULT 'missing'
		CHECK (credential_status IN ('missing','session_only','stored','weak_storage','refreshing','invalid','unavailable')),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE configured_models (
	provider_id TEXT NOT NULL,
	model_id TEXT NOT NULL,
	label TEXT NOT NULL,
	supports_images INTEGER NOT NULL DEFAULT 0 CHECK (supports_images IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (provider_id, model_id)
);
CREATE TABLE executor_profiles (
	id TEXT PRIMARY KEY,
	profile_type TEXT NOT NULL CHECK (profile_type IN ('pi','codex')),
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
CREATE TABLE character_drafts (
	id TEXT PRIMARY KEY,
	base_package_id TEXT,
	status TEXT NOT NULL DEFAULT 'draft'
		CHECK (status IN ('draft','validating','ready_to_publish','published')),
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
CREATE TABLE sync_changes (revision INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL);
INSERT INTO app_settings (id) VALUES (1);
INSERT INTO executor_profiles (id, profile_type, capability_json)
	VALUES ('pi-default', 'pi', '{}');
INSERT INTO installation_identity (id, installation_id)
VALUES (1, lower(
	hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
	substr(hex(randomblob(2)), 2) || '-' ||
	substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
	hex(randomblob(6))
));
${syncTriggers(SYSTEM_TABLES)}
`;

const COMPANION_TABLES = [
	"artifact_adoptions",
	"artifacts",
	"canon_chunks",
	"canon_entities",
	"canon_package_state",
	"canon_relations",
	"canon_sources",
	"companion_state_documents",
	"conversations",
	"evidence",
	"model_route_settings",
	"onboarding_state",
	"run_manifests",
	"runs",
	"story_modules",
] as const;

export const COMPANION_BASELINE_V1_SQL = `
CREATE TABLE runtime_identity (
	id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	companion_id TEXT NOT NULL UNIQUE,
	nickname TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_seq ON events(seq);
CREATE TABLE conversations (
	id TEXT PRIMARY KEY,
	companion_id TEXT NOT NULL REFERENCES runtime_identity(companion_id),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	archived_at TEXT
);
CREATE INDEX idx_conversations_active ON conversations(companion_id, archived_at, updated_at);
CREATE TABLE model_route_settings (
	companion_id TEXT PRIMARY KEY REFERENCES runtime_identity(companion_id),
	text_provider_id TEXT,
	text_model_id TEXT,
	vision_mode TEXT NOT NULL DEFAULT 'auto' CHECK (vision_mode IN ('auto','manual')),
	multimodal_provider_id TEXT,
	multimodal_model_id TEXT,
	onboarding_complete INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_complete IN (0,1)),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE onboarding_state (
	companion_id TEXT PRIMARY KEY REFERENCES runtime_identity(companion_id),
	state TEXT NOT NULL,
	state_json TEXT NOT NULL DEFAULT '{}',
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	trigger_entry_id TEXT NOT NULL,
	executor_profile TEXT NOT NULL,
	title TEXT NOT NULL,
	instruction TEXT NOT NULL,
	input_paths TEXT NOT NULL DEFAULT '[]',
	status TEXT NOT NULL DEFAULT 'enqueued'
		CHECK (status IN ('enqueued','running','needs_user','completed','failed','cancelled','interrupted','forced_termination')),
	summary TEXT,
	result_reported_at TEXT,
	started_at TEXT,
	completed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_runs_conversation_trigger ON runs(conversation_id, trigger_entry_id);
CREATE TABLE run_manifests (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	manifest_json TEXT NOT NULL DEFAULT '{}',
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
	status TEXT NOT NULL DEFAULT 'created'
		CHECK (status IN ('created','verified','verification_failed','adopted','saved')),
	producer_run_id TEXT REFERENCES runs(id),
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_artifacts_run ON artifacts(producer_run_id);
CREATE TABLE artifact_adoptions (
	id TEXT PRIMARY KEY,
	artifact_id TEXT NOT NULL REFERENCES artifacts(id),
	run_id TEXT NOT NULL REFERENCES runs(id),
	adopted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE canon_sources (
	id TEXT PRIMARY KEY,
	companion_id TEXT NOT NULL REFERENCES runtime_identity(companion_id),
	logical_name TEXT NOT NULL,
	mime TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	artifact_id TEXT REFERENCES artifacts(id),
	origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','package')),
	stable_key TEXT,
	language TEXT,
	source_kind TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_canon_sources_companion ON canon_sources(companion_id, created_at);
CREATE UNIQUE INDEX idx_canon_sources_package_key
	ON canon_sources(companion_id, stable_key) WHERE stable_key IS NOT NULL;
CREATE TABLE canon_chunks (
	id TEXT PRIMARY KEY,
	source_id TEXT NOT NULL REFERENCES canon_sources(id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL,
	content TEXT NOT NULL,
	start_offset INTEGER NOT NULL,
	end_offset INTEGER NOT NULL,
	token_count INTEGER NOT NULL DEFAULT 0,
	heading TEXT,
	embedding BLOB,
	UNIQUE(source_id, ordinal)
);
CREATE INDEX idx_canon_chunks_source ON canon_chunks(source_id, ordinal);
CREATE VIRTUAL TABLE canon_chunks_fts USING fts5(
	content, content='canon_chunks', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER canon_chunks_fts_insert AFTER INSERT ON canon_chunks BEGIN
	INSERT INTO canon_chunks_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TRIGGER canon_chunks_fts_delete AFTER DELETE ON canon_chunks BEGIN
	INSERT INTO canon_chunks_fts(canon_chunks_fts, rowid, content)
	VALUES ('delete', old.rowid, old.content); END;
CREATE TRIGGER canon_chunks_fts_update AFTER UPDATE ON canon_chunks BEGIN
	INSERT INTO canon_chunks_fts(canon_chunks_fts, rowid, content)
	VALUES ('delete', old.rowid, old.content);
	INSERT INTO canon_chunks_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TABLE canon_entities (
	id TEXT PRIMARY KEY,
	companion_id TEXT NOT NULL REFERENCES runtime_identity(companion_id),
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	aliases_json TEXT NOT NULL DEFAULT '[]',
	description TEXT NOT NULL DEFAULT '',
	origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','package')),
	stable_key TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_canon_entities_companion ON canon_entities(companion_id, name);
CREATE UNIQUE INDEX idx_canon_entities_package_key
	ON canon_entities(companion_id, stable_key) WHERE stable_key IS NOT NULL;
CREATE TABLE canon_relations (
	id TEXT PRIMARY KEY,
	from_entity_id TEXT NOT NULL REFERENCES canon_entities(id) ON DELETE CASCADE,
	to_entity_id TEXT NOT NULL REFERENCES canon_entities(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	source_chunk_id TEXT REFERENCES canon_chunks(id),
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE canon_package_state (
	companion_id TEXT PRIMARY KEY REFERENCES runtime_identity(companion_id) ON DELETE CASCADE,
	manifest_hash TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE story_modules (
	id TEXT PRIMARY KEY,
	companion_id TEXT NOT NULL REFERENCES runtime_identity(companion_id),
	parent_id TEXT REFERENCES story_modules(id),
	kind TEXT NOT NULL CHECK (kind IN ('root','arc','event','entity','relationship','location','object','behavior')),
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	source_refs_json TEXT NOT NULL DEFAULT '[]',
	dependencies_json TEXT NOT NULL DEFAULT '[]',
	origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','package')),
	stable_key TEXT,
	triggers_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_story_modules_companion ON story_modules(companion_id, kind);
CREATE UNIQUE INDEX idx_story_modules_package_key
	ON story_modules(companion_id, stable_key) WHERE stable_key IS NOT NULL;
CREATE TABLE companion_state_documents (
	id TEXT PRIMARY KEY,
	companion_id TEXT NOT NULL REFERENCES runtime_identity(companion_id) ON DELETE CASCADE,
	conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
	scope TEXT NOT NULL CHECK (scope IN ('conversation','global')),
	domain TEXT NOT NULL CHECK (domain IN ('character','display')),
	state_json TEXT NOT NULL DEFAULT '{}',
	revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	UNIQUE(companion_id, conversation_id, scope, domain),
	CHECK ((scope = 'conversation' AND conversation_id IS NOT NULL)
		OR (scope = 'global' AND conversation_id IS NULL))
);
CREATE TABLE canon_vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sync_changes (revision INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL);
CREATE TRIGGER sync_events_insert AFTER INSERT ON events WHEN NEW.kind != 'sync.invalidated' BEGIN
	INSERT INTO sync_changes(source) VALUES ('event:' || NEW.kind); SELECT bear_sync_changed(); END;
${syncTriggers(COMPANION_TABLES)}
`;
