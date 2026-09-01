import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	blob,
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

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
	createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
});

/** Immutable owner embedded in one character's physically isolated runtime database. */
export const companionRuntimeIdentity = sqliteTable(
	"runtime_identity",
	{
		id: integer().primaryKey().default(1),
		companionId: text("companion_id").notNull().unique(),
		nickname: text(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [check("runtime_identity_singleton", sql`${table.id} = 1`)],
);

export const conversations = sqliteTable(
	"conversations",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionRuntimeIdentity.companionId),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
		archivedAt: text("archived_at"),
	},
	(table) => [
		index("idx_conversations_active").on(table.companionId, table.archivedAt, table.updatedAt),
	],
);

export const appSettings = sqliteTable(
	"app_settings",
	{
		id: integer("id").primaryKey(),
		firstRunStage: text("first_run_stage").notNull().default("model"),
		networkProxyJson: text("network_proxy").notNull().default('{"mode":"auto"}'),
		memoryVectorServiceJson: text("memory_vector_service")
			.notNull()
			.default('{"enabled":false,"provider":"none"}'),
		systemModelDefaultsJson: text("system_model_defaults")
			.notNull()
			.default('{"vision":{"mode":"auto"}}'),
		modelDownloadMirrorJson: text("model_download_mirror").notNull().default('{"type":"official"}'),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
	},
	() => [check("app_settings_singleton", sql`id = 1`)],
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
		inputPaths: text("input_paths", { mode: "json" }).$type<string[]>().default([]).notNull(),
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
		permissionJson: text("permission_json", { mode: "json" }).$type<{
			runId: string;
			prompt: string;
			requestId: string;
			options: Array<{ optionId: string; kind: string; name: string }>;
		}>(),
		summary: text(),
		resultReportedAt: text("result_reported_at"),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		index("idx_runs_conversation_trigger").on(table.conversationId, table.triggerEntryId),
		check(
			"runs_status",
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
			"artifacts_status",
			sql`status IN ('created','verified','verification_failed','adopted','saved')`,
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
		credentialBlob: blob("credential_blob", { mode: "buffer" }).$type<Uint8Array>(),
		credentialStatus: text("credential_status").default("missing").notNull(),
		createdAt: text("created_at").default(sql`datetime('now')`).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
	},
	() => [
		check(
			"provider_accounts_credential_status",
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
		check("configured_models_supports_images_boolean", sql`supports_images IN (0, 1)`),
	],
);

export const modelRouteSettings = sqliteTable("model_route_settings", {
	companionId: text("companion_id")
		.primaryKey()
		.references(() => companionRuntimeIdentity.companionId),
	textProviderId: text("text_provider_id"),
	textModelId: text("text_model_id"),
	visionMode: text("vision_mode").default("auto").notNull(),
	multimodalProviderId: text("multimodal_provider_id"),
	multimodalModelId: text("multimodal_model_id"),
	onboardingComplete: integer("onboarding_complete").default(0).notNull(),
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
	() => [check("executor_profiles_type", sql`profile_type IN ('pi','codex')`)],
);

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
			.references(() => companionRuntimeIdentity.companionId),
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
			.references(() => companionRuntimeIdentity.companionId),
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

export const canonPackageState = sqliteTable("canon_package_state", {
	companionId: text("companion_id")
		.primaryKey()
		.references(() => companionRuntimeIdentity.companionId, { onDelete: "cascade" }),
	manifestHash: text("manifest_hash").notNull(),
	updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
});

export const storyModules = sqliteTable(
	"story_modules",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionRuntimeIdentity.companionId),
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
			"story_modules_kind",
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
	() => [check("active_character_singleton", sql`singleton = 1`)],
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

export const companionStateDocuments = sqliteTable(
	"companion_state_documents",
	{
		id: text().primaryKey(),
		companionId: text("companion_id")
			.notNull()
			.references(() => companionRuntimeIdentity.companionId, { onDelete: "cascade" }),
		conversationId: text("conversation_id").references(() => conversations.id, {
			onDelete: "cascade",
		}),
		scope: text({ enum: ["conversation", "global"] }).notNull(),
		domain: text({ enum: ["character", "display"] }).notNull(),
		stateJson: text("state_json", { mode: "json" })
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		revision: integer().default(0).notNull(),
		updatedAt: text("updated_at").default(sql`datetime('now')`).notNull(),
	},
	(table) => [
		unique("companion_state_documents_scope").on(
			table.companionId,
			table.conversationId,
			table.scope,
			table.domain,
		),
		check(
			"companion_state_documents_scope_owner",
			sql`(${table.scope} = 'conversation' AND ${table.conversationId} IS NOT NULL)
				OR (${table.scope} = 'global' AND ${table.conversationId} IS NULL)`,
		),
		check("companion_state_documents_revision", sql`${table.revision} >= 0`),
	],
);
