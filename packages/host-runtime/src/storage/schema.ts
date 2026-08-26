import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	blob,
	check,
	foreignKey,
	index,
	integer,
	numeric,
	primaryKey,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

export const schemaMigrations = sqliteTable("schema_migrations", {
	id: integer().primaryKey(),
	checksum: text().notNull(),
	appliedAt: text("applied_at").default(sql`datetime('now')`).notNull(),
});

export const installationIdentity = sqliteTable(
	"installation_identity",
	{
		id: integer().primaryKey().default(1),
		installationId: text("installation_id").notNull().unique(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		check("installation_identity_singleton", sql`${table.id} = 1`),
		check(
			"installation_identity_uuid",
			sql`
				length(${table.installationId}) = 36
				AND substr(${table.installationId}, 9, 1) = '-'
				AND substr(${table.installationId}, 14, 1) = '-'
				AND substr(${table.installationId}, 19, 1) = '-'
				AND substr(${table.installationId}, 24, 1) = '-'
				AND substr(${table.installationId}, 15, 1) = '4'
				AND substr(${table.installationId}, 20, 1) GLOB '[89ab]'
				AND lower(${table.installationId}) = ${table.installationId}
				AND replace(${table.installationId}, '-', '') NOT GLOB '*[^0-9a-f]*'
			`,
		),
	],
);

export const companionPackages = sqliteTable("companion_packages", {
	id: text().primaryKey(),
	name: text().notNull(),
	version: text().notNull(),
	hash: text().notNull(),
	origin: text({ enum: ["official", "local", "imported"] })
		.notNull()
		.default("official"),
	pluginHash: text("plugin_hash").notNull().default(""),
	pluginTrustedHash: text("plugin_trusted_hash"),
	signedAt: text("signed_at"),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const companionIdentity = sqliteTable("companion_identity", {
	id: text().primaryKey(),
	packageId: text("package_id")
		.notNull()
		.references(() => companionPackages.id),
	name: text().notNull(),
	selfCanon: text("self_canon").notNull(),
	nickname: text(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const selfCanonVersions = sqliteTable("self_canon_versions", {
	id: integer().primaryKey({ autoIncrement: true }),
	companionId: text("companion_id")
		.notNull()
		.references(() => companionIdentity.id),
	canon: text().notNull(),
	version: integer().notNull(),
	hash: text().notNull(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const conversations = sqliteTable(
	"conversations",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		title: text().default("").notNull(),
		sceneTitle: text("scene_title").default("").notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
		archivedAt: text("archived_at"),
	},
	(table) => [
		index("idx_conversations_active").on(table.companionId, table.archivedAt, table.updatedAt),
	],
);

export const conversationSessions = sqliteTable("conversation_sessions", {
	conversationId: text("conversation_id")
		.primaryKey()
		.references(() => conversations.id, { onDelete: "cascade" }),
	piSessionId: text("pi_session_id").notNull(),
	sessionFilePath: text("session_file_path").notNull(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});
export const activeConversations = sqliteTable("active_conversations", {
	companionId: text("companion_id")
		.primaryKey()
		.references(() => companionIdentity.id, { onDelete: "cascade" }),
	conversationId: text("conversation_id")
		.notNull()
		.references(() => conversations.id, { onDelete: "cascade" }),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});

export const sceneState = sqliteTable("scene_state", {
	id: text().primaryKey(),
	conversationId: text("conversation_id")
		.notNull()
		.references(() => conversations.id),
	scene: text().default("").notNull(),
	stateJson: text("state_json", { mode: "json" })
		.$type<Record<string, unknown>>()
		.default({})
		.notNull(),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});

export const conversationDirectives = sqliteTable(
	"conversation_directives",
	{
		id: text().primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id),
		directive: text().notNull(),
		scope: text().default("session").notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [check("conversation_directives_check_3", sql`scope IN ('once','session','always')`)],
);

export const relationshipMemoryEntries = sqliteTable(
	"relationship_memory_entries",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		kind: text({ enum: ["fact", "preference", "event", "self_canon_summary"] }).notNull(),
		scope: text({ enum: ["self", "relationship", "scene"] }).notNull(),
		text: text().notNull(),
		normalizedText: text("normalized_text").notNull(),
		/** Pi provenance is intentionally not a foreign key: SessionManager owns native entries. */
		sourcePiSessionId: text("source_pi_session_id"),
		sourceNativeEntryId: text("source_native_entry_id"),
		sourceConversationId: text("source_conversation_id").references(() => conversations.id),
		sourceKind: text("source_kind", {
			enum: ["user_button", "user_request", "companion_suggestion", "extractor"],
		})
			.default("user_button")
			.notNull(),
		status: text({ enum: ["active", "excluded", "forgotten"] })
			.default("active")
			.notNull(),
		pinnedAt: text("pinned_at"),
		sceneId: text("scene_id"),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
		forgottenAt: text("forgotten_at"),
	},
	(table) => [
		index("idx_memory_entries_companion").on(table.companionId),
		check(
			"relationship_memory_entries_check_4",
			sql`kind IN ('fact','preference','event','self_canon_summary')`,
		),
		check("relationship_memory_entries_check_5", sql`scope IN ('self','relationship','scene')`),
		check(
			"relationship_memory_entries_check_6",
			sql`source_kind IN ('user_button','user_request','companion_suggestion','extractor')`,
		),
		check("relationship_memory_entries_check_7", sql`status IN ('active','excluded','forgotten')`),
	],
);

export const memoryCandidates = sqliteTable(
	"memory_candidates",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		kind: text({ enum: ["fact", "preference", "event", "self_canon_summary"] }).notNull(),
		/** Pi provenance is intentionally not a foreign key: SessionManager owns native entries. */
		sourcePiSessionId: text("source_pi_session_id"),
		sourceNativeEntryId: text("source_native_entry_id"),
		sourceConversationId: text("source_conversation_id").references(() => conversations.id),
		sourceKind: text("source_kind", {
			enum: ["user_button", "user_request", "companion_suggestion", "extractor"],
		}).notNull(),
		normalizedText: text("normalized_text").notNull(),
		why: text().default("").notNull(),
		suggestedScope: text("suggested_scope", { enum: ["self", "relationship", "scene"] }).notNull(),
		status: text({ enum: ["pending", "approved", "rejected", "expired"] })
			.default("pending")
			.notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		decidedAt: text("decided_at"),
	},
	(table) => [
		index("idx_memory_candidates_companion").on(table.companionId),
		check(
			"memory_candidates_check_8",
			sql`kind IN ('fact','preference','event','self_canon_summary')`,
		),
		check(
			"memory_candidates_check_9",
			sql`source_kind IN ('user_button','user_request','companion_suggestion','extractor')`,
		),
		check("memory_candidates_check_10", sql`suggested_scope IN ('self','relationship','scene')`),
		check("memory_candidates_check_11", sql`status IN ('pending','approved','rejected','expired')`),
	],
);

export const memoryDecisions = sqliteTable(
	"memory_decisions",
	{
		id: text().primaryKey(),
		candidateId: text("candidate_id")
			.notNull()
			.references(() => memoryCandidates.id),
		decision: text().notNull(),
		editedText: text("edited_text"),
		decidedScope: text("decided_scope", {
			enum: ["self", "relationship", "scene"],
		}),
		decidedByUser: numeric("decided_by_user", { mode: "number" }).default(1).notNull(),
		decidedAt: text("decided_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		check("memory_decisions_check_12", sql`decision IN ('approve','approve_edited','reject')`),
		check("memory_decisions_check_13", sql`decided_scope IN ('self','relationship','scene')`),
	],
);
export const memoryPresentation = sqliteTable(
	"memory_presentation",
	{
		backendMemoryId: text("backend_memory_id").notNull(),
		installationId: text("installation_id").notNull(),
		userId: text("user_id").notNull(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		sourcePiEntryId: text("source_pi_entry_id"),
		createdBy: text("created_by", {
			enum: ["user_capture", "assistant_tool", "auto_episode", "imported"],
		}).notNull(),
		pinned: integer("pinned", { mode: "boolean" }).default(false).notNull(),
		replacementMemoryId: text("replacement_memory_id"),
		excludedAt: text("excluded_at"),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
		invalidatedAt: text("invalidated_at"),
	},
	(table) => [
		primaryKey({
			columns: [table.backendMemoryId, table.installationId, table.userId, table.companionId],
		}),
		index("idx_memory_presentation_scope").on(
			table.installationId,
			table.userId,
			table.companionId,
		),
		check(
			"memory_presentation_check_14",
			sql`created_by IN ('user_capture','assistant_tool','auto_episode','imported')`,
		),
		check("memory_presentation_check_15", sql`pinned IN (0,1)`),
	],
);

export const appSettings = sqliteTable(
	"app_settings",
	{
		id: integer("id").primaryKey(),
		networkProxyJson: text("network_proxy").notNull().default('{"mode":"auto"}'),
		memoryVectorServiceJson: text("memory_vector_service")
			.notNull()
			.default('{"enabled":false,"provider":"none"}'),
		modelDownloadMirrorJson: text("model_download_mirror").notNull().default("{}"),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [check("app_settings_check_18", sql`id = 1`)],
);

export const runs = sqliteTable(
	"runs",
	{
		id: text().primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		triggerEntryId: text("trigger_entry_id").notNull(),
		executorProfile: text("executor_profile").notNull(),
		title: text().notNull(),
		instruction: text().notNull(),
		inputAttachmentIds: text("input_attachment_ids", { mode: "json" })
			.$type<string[]>()
			.default([])
			.notNull(),
		workspaceAttachmentId: text("workspace_attachment_id").references(
			() => conversationAttachments.id,
			{
				onDelete: "set null",
			},
		),
		status: text({
			enum: [
				"enqueued",
				"running",
				"needs_user",
				"completed",
				"failed",
				"cancelled",
				"interrupted",
				"forced_termination",
			],
		})
			.default("enqueued")
			.notNull(),
		summary: text(),
		memoryCapturedAt: text("memory_captured_at"),
		resultReportedAt: text("result_reported_at"),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		index("idx_runs_conversation_trigger").on(table.conversationId, table.triggerEntryId),
		check(
			"runs_check_15",
			sql`status IN ('enqueued','running','needs_user','completed','failed','cancelled','interrupted','forced_termination')`,
		),
	],
);

export const runManifests = sqliteTable("run_manifests", {
	id: text().primaryKey(),
	runId: text("run_id")
		.notNull()
		.references(() => runs.id),
	manifestJson: text("manifest_json", { mode: "json" })
		.$type<Record<string, unknown>>()
		.default({})
		.notNull(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const events = sqliteTable(
	"events",
	{
		seq: integer().primaryKey({ autoIncrement: true }),
		kind: text().notNull(),
		payload: text({ mode: "json" }).default({}).notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [index("idx_events_seq").on(table.seq)],
);

export const evidence = sqliteTable("evidence", {
	id: text().primaryKey(),
	runId: text("run_id").references(() => runs.id),
	kind: text().notNull(),
	data: text({ mode: "json" }).$type<unknown>().default({}).notNull(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const artifacts = sqliteTable(
	"artifacts",
	{
		id: text().primaryKey(),
		logicalName: text("logical_name").notNull(),
		mime: text().notNull(),
		bytes: integer().default(0).notNull(),
		sha256: text().notNull(),
		status: text().default("created").notNull(),
		producerRunId: text("producer_run_id").references(() => runs.id),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		index("idx_artifacts_run").on(table.producerRunId),
		check(
			"artifacts_check_16",
			sql`status IN ('created','verified','verification_failed','adopted','saved')`,
		),
	],
);

export const conversationAttachments = sqliteTable(
	"conversation_attachments",
	{
		id: text().primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		originEntryId: text("origin_entry_id"),
		sendNonce: text("send_nonce"),
		kind: text({ enum: ["file", "folder", "generated"] }).notNull(),
		name: text().notNull(),
		totalBytes: integer("total_bytes").notNull(),
		fileCount: integer("file_count").notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		index("idx_attachments_conversation_created").on(table.conversationId, table.createdAt),
		index("idx_attachments_conversation_entry").on(table.conversationId, table.originEntryId),
		index("idx_attachments_conversation_nonce").on(table.conversationId, table.sendNonce),
		check("conversation_attachments_kind", sql`kind IN ('file','folder','generated')`),
	],
);

export const conversationAttachmentFiles = sqliteTable(
	"conversation_attachment_files",
	{
		id: text().primaryKey(),
		attachmentId: text("attachment_id")
			.notNull()
			.references(() => conversationAttachments.id, { onDelete: "cascade" }),
		entryKind: text("entry_kind", { enum: ["file", "directory", "symlink"] }).notNull(),
		relativePath: text("relative_path").notNull(),
		artifactId: text("artifact_id").references(() => artifacts.id),
		linkTarget: text("link_target"),
		mime: text(),
		materialKind: text("material_kind"),
		bytes: integer(),
		sha256: text(),
		extractedText: text("extracted_text"),
		extractionError: text("extraction_error"),
	},
	(table) => [
		index("idx_attachment_files_attachment").on(table.attachmentId),
		unique("conversation_attachment_files_relative").on(table.attachmentId, table.relativePath),
		check("conversation_attachment_files_kind", sql`entry_kind IN ('file','directory','symlink')`),
	],
);

export const pendingTurns = sqliteTable(
	"pending_turns",
	{
		id: text().primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		framedText: text("framed_text").notNull(),
		imagesJson: text("images_json").default("[]").notNull(),
		attachmentIdsJson: text("attachment_ids_json").default("[]").notNull(),
		attachmentSendNonce: text("attachment_send_nonce"),
		state: text({
			enum: ["accepted", "dispatched", "user_persisted", "completed"],
		})
			.default("accepted")
			.notNull(),
		piEntryId: text("pi_entry_id"),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
		completedAt: text("completed_at"),
		lastError: text("last_error"),
	},
	(table) => [
		index("idx_pending_turns_conversation_state").on(
			table.conversationId,
			table.state,
			table.createdAt,
		),
		unique("pending_turns_conversation_entry").on(table.conversationId, table.piEntryId),
		check(
			"pending_turns_id_uuid",
			sql`length(id) = 36
				AND substr(id, 9, 1) = '-'
				AND substr(id, 14, 1) = '-'
				AND substr(id, 19, 1) = '-'
				AND substr(id, 24, 1) = '-'
				AND substr(id, 15, 1) = '4'
				AND substr(id, 20, 1) GLOB '[89ab]'
				AND lower(id) = id
				AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'`,
		),
		check("pending_turns_framed_text", sql`length(framed_text) <= 262144`),
		check(
			"pending_turns_images_json",
			sql`length(images_json) <= 139811200
				AND json_valid(images_json)
				AND json_type(images_json) = 'array'
				AND json_array_length(images_json) <= 10`,
		),
		check(
			"pending_turns_attachment_ids_json",
			sql`length(attachment_ids_json) <= 681
				AND json_valid(attachment_ids_json)
				AND json_type(attachment_ids_json) = 'array'
				AND json_array_length(attachment_ids_json) <= 10`,
		),
		check(
			"pending_turns_attachment_nonce",
			sql`(json_array_length(attachment_ids_json) = 0 AND attachment_send_nonce IS NULL)
				OR (json_array_length(attachment_ids_json) > 0 AND attachment_send_nonce IS NOT NULL)`,
		),
		check(
			"pending_turns_state",
			sql`state IN ('accepted','dispatched','user_persisted','completed')`,
		),
		check(
			"pending_turns_entry_state",
			sql`(state IN ('accepted','dispatched') AND pi_entry_id IS NULL)
				OR (state IN ('user_persisted','completed') AND pi_entry_id IS NOT NULL)`,
		),
		check(
			"pending_turns_completion",
			sql`(state = 'completed' AND completed_at IS NOT NULL)
				OR (state <> 'completed' AND completed_at IS NULL)`,
		),
	],
);

export const artifactAdoptions = sqliteTable("artifact_adoptions", {
	id: text().primaryKey(),
	artifactId: text("artifact_id")
		.notNull()
		.references(() => artifacts.id),
	runId: text("run_id")
		.notNull()
		.references(() => runs.id),
	adoptedAt: text("adopted_at").default(sql`datetime('now')`).notNull(),
});

export const providerAccounts = sqliteTable(
	"provider_accounts",
	{
		id: text().primaryKey(),
		providerId: text("provider_id").notNull(),
		credentialBlob: blob("credential_blob").$type<Uint8Array>(),
		credentialStatus: text("credential_status").default("missing").notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		check(
			"provider_accounts_check_17",
			sql`credential_status IN ('missing','session_only','stored','weak_storage','refreshing','invalid','unavailable')`,
		),
	],
);

export const configuredModels = sqliteTable(
	"configured_models",
	{
		providerId: text("provider_id").notNull(),
		modelId: text("model_id").notNull(),
		label: text().notNull(),
		supportsImages: integer("supports_images").default(0).notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.providerId, table.modelId], name: "configured_models_pk" }),
		check("configured_models_check_18", sql`supports_images IN (0, 1)`),
	],
);

export const conversationModelSelections = sqliteTable(
	"conversation_model_selections",
	{
		conversationId: text("conversation_id")
			.primaryKey()
			.references(() => conversations.id, { onDelete: "cascade" }),
		providerId: text("provider_id").notNull(),
		modelId: text("model_id").notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.providerId, table.modelId],
			foreignColumns: [configuredModels.providerId, configuredModels.modelId],
			name: "fk_conversation_model_selections_provider_id_model_id_configured_models_provider_id_model_id_fk",
		})
			.onUpdate("no action")
			.onDelete("cascade"),
	],
);

export const modelRouteSettings = sqliteTable("model_route_settings", {
	companionId: text("companion_id")
		.primaryKey()
		.references(() => companionIdentity.id),
	textProviderId: text("text_provider_id"),
	textModelId: text("text_model_id"),
	visionMode: text("vision_mode").default("auto").notNull(),
	multimodalProviderId: text("multimodal_provider_id"),
	multimodalModelId: text("multimodal_model_id"),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});

export const executorProfiles = sqliteTable(
	"executor_profiles",
	{
		id: text().primaryKey(),
		profileType: text("profile_type", {
			enum: ["pi", "codex"],
		}).notNull(),
		capabilityJson: text("capability_json", { mode: "json" })
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [check("executor_profiles_check_20", sql`profile_type IN ('pi','codex')`)],
);

export const runtimeAssets = sqliteTable("runtime_assets", {
	id: text().primaryKey(),
	assetType: text("asset_type").notNull(),
	version: text().notNull(),
	path: text().notNull(),
	hash: text().notNull(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const userDecisions = sqliteTable("user_decisions", {
	id: text().primaryKey(),
	kind: text().notNull(),
	decisionData: text("decision_data", { mode: "json" }).default({}).notNull(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const onboardingState = sqliteTable("onboarding_state", {
	companionId: text("companion_id").primaryKey(),
	state: text().notNull(),
	stateJson: text("state_json", { mode: "json" }).default({}).notNull(),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});

export const canonSources = sqliteTable(
	"canon_sources",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		logicalName: text("logical_name").notNull(),
		mime: text().notNull(),
		sha256: text().notNull(),
		artifactId: text("artifact_id").references(() => artifacts.id),
		origin: text({ enum: ["user", "package"] })
			.default("user")
			.notNull(),
		stableKey: text("stable_key"),
		language: text(),
		sourceKind: text("source_kind"),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [index("idx_canon_sources_companion").on(table.companionId, table.createdAt)],
);

export const canonChunks = sqliteTable(
	"canon_chunks",
	{
		id: text().primaryKey(),
		sourceId: text("source_id")
			.notNull()
			.references(() => canonSources.id, { onDelete: "cascade" }),
		ordinal: integer().notNull(),
		content: text().notNull(),
		startOffset: integer("start_offset").notNull(),
		endOffset: integer("end_offset").notNull(),
		tokenCount: integer("token_count").default(0).notNull(),
		heading: text(),
		embedding: blob({ mode: "buffer" }),
	},
	(table) => [index("idx_canon_chunks_source").on(table.sourceId, table.ordinal)],
);

export const canonEntities = sqliteTable(
	"canon_entities",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		kind: text().notNull(),
		name: text().notNull(),
		aliasesJson: text("aliases_json", { mode: "json" }).$type<string[]>().default([]).notNull(),
		description: text().default("").notNull(),
		origin: text({ enum: ["user", "package"] })
			.default("user")
			.notNull(),
		stableKey: text("stable_key"),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [index("idx_canon_entities_companion").on(table.companionId, table.name)],
);

export const canonRelations = sqliteTable("canon_relations", {
	id: text().primaryKey(),
	fromEntityId: text("from_entity_id")
		.notNull()
		.references(() => canonEntities.id, { onDelete: "cascade" }),
	toEntityId: text("to_entity_id")
		.notNull()
		.references(() => canonEntities.id, { onDelete: "cascade" }),
	kind: text().notNull(),
	description: text().default("").notNull(),
	sourceChunkId: text("source_chunk_id").references(() => canonChunks.id),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

export const canonPackageState = sqliteTable("canon_package_state", {
	companionId: text("companion_id")
		.primaryKey()
		.references(() => companionIdentity.id, { onDelete: "cascade" }),
	manifestHash: text("manifest_hash").notNull(),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});

export const storyModules = sqliteTable(
	"story_modules",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		parentId: text("parent_id").references((): AnySQLiteColumn => storyModules.id),
		kind: text({
			enum: ["root", "arc", "event", "entity", "relationship", "location", "object", "behavior"],
		}).notNull(),
		name: text().notNull(),
		description: text().default("").notNull(),
		sourceRefsJson: text("source_refs_json", { mode: "json" })
			.$type<string[]>()
			.default([])
			.notNull(),
		dependenciesJson: text("dependencies_json", { mode: "json" })
			.$type<string[]>()
			.default([])
			.notNull(),
		origin: text({ enum: ["user", "package"] })
			.default("user")
			.notNull(),
		stableKey: text("stable_key"),
		triggersJson: text("triggers_json", { mode: "json" }).$type<string[]>().default([]).notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		index("idx_story_modules_companion").on(table.companionId, table.kind),
		check(
			"story_modules_check_25",
			sql`kind IN ('root','arc','event','entity','relationship','location','object','behavior')`,
		),
	],
);

export const activeCharacter = sqliteTable(
	"active_character",
	{
		singleton: integer().primaryKey(),
		characterId: text("character_id")
			.notNull()
			.references(() => companionIdentity.id),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [check("active_character_check_26", sql`singleton = 1`)],
);

export const characterDrafts = sqliteTable("character_drafts", {
	id: text().primaryKey(),
	basePackageId: text("base_package_id"),
	status: text({ enum: ["draft", "validating", "ready_to_publish", "published"] })
		.default("draft")
		.notNull(),
	locale: text().default("zh-CN").notNull(),
	currentRevision: integer("current_revision").default(1).notNull(),
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});

export const characterDraftRevisions = sqliteTable(
	"character_draft_revisions",
	{
		draftId: text("draft_id")
			.notNull()
			.references(() => characterDrafts.id, { onDelete: "cascade" }),
		revision: integer().notNull(),
		filesJson: text("files_json", { mode: "json" })
			.$type<Record<string, { encoding: "utf8" | "base64"; content: string }>>()
			.notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [primaryKey({ columns: [table.draftId, table.revision] })],
);

export const roleplayEvents = sqliteTable(
	"roleplay_events",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		conversationId: text("conversation_id").references(() => conversations.id, {
			onDelete: "cascade",
		}),
		/** Native Pi provenance supersedes branch/version identity after downstream cutover. */
		piSessionId: text("pi_session_id"),
		sourceNativeEntryId: text("source_native_entry_id"),
		eventId: text("event_id").notNull(),
		effectsJson: text("effects_json", { mode: "json" })
			.$type<Array<Record<string, unknown>>>()
			.notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		index("idx_roleplay_events_projection").on(
			table.companionId,
			table.conversationId,
			table.createdAt,
		),
	],
);

export const roleplayUnlocks = sqliteTable(
	"roleplay_unlocks",
	{
		companionId: text("companion_id")
			.notNull()
			.references(() => companionIdentity.id),
		unlockableId: text("unlockable_id").notNull(),
		sourceEventId: text("source_event_id")
			.notNull()
			.references(() => roleplayEvents.id, { onDelete: "cascade" }),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [primaryKey({ columns: [table.companionId, table.unlockableId] })],
);
