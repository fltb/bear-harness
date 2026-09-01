import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SettingsData, SystemModelDefaultsGetResponse } from "@bear-harness/protocol/schema";
import { CharacterLoader } from "../companion/character-loader.js";
import { SystemDatabase } from "./database.js";
import { RuntimeLayout, requireCompanionId } from "./layout.js";
import { COMPANION_SCHEMA_SQL, SYSTEM_SCHEMA_SQL } from "./schema-sql.js";

const SYSTEM_TABLES = [
	"installation_identity",
	"companion_packages",
	"companion_identity",
	"active_character",
	"app_settings",
	"provider_accounts",
	"configured_models",
	"executor_profiles",
	"character_drafts",
	"character_draft_revisions",
] as const;

const COMPANION_TABLES = [
	"runtime_identity",
	"conversations",
	"model_route_settings",
	"onboarding_state",
	"runs",
	"run_manifests",
	"evidence",
	"artifacts",
	"artifact_adoptions",
	"canon_sources",
	"canon_chunks",
	"canon_entities",
	"canon_package_state",
	"story_modules",
	"companion_state_documents",
	"canon_vector_meta",
] as const;

const JSON_COLUMNS = new Set([
	"network_proxy",
	"memory_vector_service",
	"system_model_defaults",
	"model_download_mirror",
	"capability_json",
	"files_json",
	"state_json",
	"input_paths",
	"permission_json",
	"manifest_json",
	"data",
	"aliases_json",
	"source_refs_json",
	"dependencies_json",
	"triggers_json",
]);

const SYSTEM_JSON_STORAGE: Readonly<Record<string, readonly string[]>> = {
	app_settings: [
		"network_proxy",
		"memory_vector_service",
		"system_model_defaults",
		"model_download_mirror",
	],
	executor_profiles: ["capability_json"],
	character_draft_revisions: ["files_json"],
};

const COMPANION_JSON_STORAGE: Readonly<Record<string, readonly string[]>> = {
	onboarding_state: ["state_json"],
	runs: ["input_paths", "permission_json"],
	run_manifests: ["manifest_json"],
	evidence: ["data"],
	canon_entities: ["aliases_json"],
	story_modules: ["source_refs_json", "dependencies_json", "triggers_json"],
	companion_state_documents: ["state_json"],
};

export type BootstrapFatalIssue =
	| { kind: "filesystem"; message: string }
	| { kind: "settings_database"; path: string; message: string }
	| {
			kind: "character_package";
			characterId: string;
			defaultCharacter: boolean;
			message: string;
	  }
	| {
			kind: "companion_database";
			characterId: string;
			path: string;
			message: string;
	  };

export type BootstrapHealth =
	| { status: "ok"; activeCharacterId: string }
	| { status: "fatal"; issue: BootstrapFatalIssue };

export interface BootstrapInspectionOptions {
	dataDir: string;
	characterSeedRoot: string;
	defaultCharacterId: string;
}

const PRODUCT_DIRECTORIES = ["system", "characters", "companions"] as const;

function message(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string")
		return error.reason;
	return String(error);
}

function syncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		fsyncSync(descriptor);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function syncFile(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function databaseIntegrity(path: string, requiredTables: readonly string[]): boolean {
	if (!existsSync(path)) return true;
	let database: DatabaseSync | undefined;
	try {
		if (!lstatSync(path).isFile()) return false;
		database = new DatabaseSync(path, { readOnly: true });
		const integrity = database.prepare("PRAGMA integrity_check").all() as Array<
			Record<string, unknown>
		>;
		if (
			integrity.length !== 1 ||
			!Object.values(integrity[0] ?? {}).some((value) => value === "ok")
		)
			return false;
		if (database.prepare("PRAGMA foreign_key_check").all().length > 0) return false;
		const tables = new Set(
			(
				database
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
					.all() as Array<{ name: string }>
			).map(({ name }) => name),
		);
		if (tables.size === 0) return true;
		return requiredTables.every((table) => tables.has(table));
	} catch {
		return false;
	} finally {
		database?.close();
	}
}

function readActiveCharacter(path: string, fallback: string): string {
	if (!existsSync(path)) return fallback;
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const row = database
			.prepare("SELECT character_id FROM active_character WHERE singleton = 1")
			.get() as { character_id?: unknown } | undefined;
		return typeof row?.character_id === "string" && row.character_id
			? requireCompanionId(row.character_id)
			: fallback;
	} finally {
		database.close();
	}
}

function validateSystemSingletons(path: string): boolean {
	if (!existsSync(path)) return true;
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(path, { readOnly: true });
		const identity = database
			.prepare("SELECT installation_id FROM installation_identity WHERE id = 1")
			.get() as { installation_id?: unknown } | undefined;
		const settings = database
			.prepare(
				"SELECT first_run_stage, network_proxy, memory_vector_service, system_model_defaults, model_download_mirror FROM app_settings WHERE id = 1",
			)
			.get() as Record<string, unknown> | undefined;
		if (typeof identity?.installation_id !== "string" || !settings) return false;
		if (!SettingsData.shape.firstRunStage.safeParse(settings.first_run_stage).success) return false;
		const network = JSON.parse(String(settings.network_proxy)) as unknown;
		const memory = JSON.parse(String(settings.memory_vector_service)) as unknown;
		const defaults = JSON.parse(String(settings.system_model_defaults)) as unknown;
		const download = JSON.parse(String(settings.model_download_mirror)) as unknown;
		return (
			SettingsData.shape.networkProxy.safeParse(network).success &&
			SettingsData.shape.memoryVectorService.safeParse(memory).success &&
			SystemModelDefaultsGetResponse.safeParse(defaults).success &&
			SettingsData.shape.modelDownloadSource.safeParse(download).success &&
			validateJsonStorage(database, SYSTEM_JSON_STORAGE)
		);
	} catch {
		return false;
	} finally {
		database?.close();
	}
}

function validateJsonStorage(
	database: DatabaseSync,
	tables: Readonly<Record<string, readonly string[]>>,
): boolean {
	try {
		for (const [table, jsonColumns] of Object.entries(tables)) {
			const rows = database
				.prepare(`SELECT ${jsonColumns.map(quoted).join(", ")} FROM ${quoted(table)}`)
				.all() as Array<Record<string, unknown>>;
			for (const row of rows) {
				for (const column of jsonColumns) {
					const value = row[column];
					if (value === null) continue;
					if (typeof value !== "string") return false;
					JSON.parse(value);
				}
			}
		}
		return true;
	} catch {
		return false;
	}
}

function validateCompanionIdentity(path: string, companionId: string): boolean {
	if (!existsSync(path)) return true;
	let database: DatabaseSync | undefined;
	try {
		database = new DatabaseSync(path, { readOnly: true });
		const row = database.prepare("SELECT companion_id FROM runtime_identity WHERE id = 1").get() as
			| { companion_id?: unknown }
			| undefined;
		return (
			row?.companion_id === companionId && validateJsonStorage(database, COMPANION_JSON_STORAGE)
		);
	} catch {
		return false;
	} finally {
		database?.close();
	}
}

/** Inspect only state that can prevent the Host from opening at all. */
export function inspectBootstrapHealth(options: BootstrapInspectionOptions): BootstrapHealth {
	let layout: RuntimeLayout;
	try {
		layout = new RuntimeLayout(options.dataDir);
		layout.ensureSystemDirectories();
		recoverPendingDatabaseRepairs(layout.systemRoot, "settings.db", SYSTEM_TABLES);
	} catch (error) {
		return { status: "fatal", issue: { kind: "filesystem", message: message(error) } };
	}
	if (
		!databaseIntegrity(layout.systemDatabase, SYSTEM_TABLES) ||
		!validateSystemSingletons(layout.systemDatabase)
	) {
		return {
			status: "fatal",
			issue: {
				kind: "settings_database",
				path: layout.systemDatabase,
				message: "System settings database is damaged or incomplete",
			},
		};
	}
	let activeCharacterId: string;
	try {
		activeCharacterId = readActiveCharacter(layout.systemDatabase, options.defaultCharacterId);
	} catch (error) {
		return {
			status: "fatal",
			issue: { kind: "settings_database", path: layout.systemDatabase, message: message(error) },
		};
	}
	let loader: CharacterLoader;
	try {
		loader = new CharacterLoader(options.characterSeedRoot, layout.charactersRoot);
		loader.bootstrapLibrary(options.defaultCharacterId);
	} catch (error) {
		return {
			status: "fatal",
			issue: {
				kind: "character_package",
				characterId: options.defaultCharacterId,
				defaultCharacter: true,
				message: message(error),
			},
		};
	}
	try {
		if (!loader.load(activeCharacterId)) throw new Error("character package is missing");
	} catch (error) {
		return {
			status: "fatal",
			issue: {
				kind: "character_package",
				characterId: activeCharacterId,
				defaultCharacter: activeCharacterId === options.defaultCharacterId,
				message: message(error),
			},
		};
	}
	const companion = layout.companion(activeCharacterId);
	try {
		recoverPendingDatabaseRepairs(companion.root, "runtime.db", COMPANION_TABLES);
	} catch (error) {
		return { status: "fatal", issue: { kind: "filesystem", message: message(error) } };
	}
	if (
		!databaseIntegrity(companion.database, COMPANION_TABLES) ||
		!validateCompanionIdentity(companion.database, activeCharacterId)
	) {
		return {
			status: "fatal",
			issue: {
				kind: "companion_database",
				characterId: activeCharacterId,
				path: companion.database,
				message: "Character runtime database is damaged or belongs to another character",
			},
		};
	}
	return { status: "ok", activeCharacterId };
}

/** Finish any user-authorized product reset before Host-owned directories are opened. */
export function completePendingProductResets(dataDir: string, recoveryRoot: string): string[] {
	mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
	const completed: string[] = [];
	for (const entry of readdirSync(recoveryRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(".resetting-")) continue;
		const transaction = join(recoveryRoot, entry.name);
		for (const name of PRODUCT_DIRECTORIES) {
			const source = join(dataDir, name);
			const destination = join(transaction, name);
			if (!existsSync(source)) continue;
			if (existsSync(destination)) {
				const failed = join(transaction, `failed-attempt-${randomUUID()}`);
				mkdirSync(failed, { mode: 0o700 });
				renameSync(source, join(failed, name));
			} else {
				renameSync(source, destination);
			}
			syncDirectory(dataDir);
			syncDirectory(transaction);
		}
		const finalName = `reset-backup-${entry.name.slice(".resetting-".length)}`;
		const finalPath = join(recoveryRoot, finalName);
		renameSync(transaction, finalPath);
		syncDirectory(recoveryRoot);
		completed.push(finalPath);
	}
	return completed;
}

/** Begin and immediately execute an idempotent reset of Bear-owned data only. */
export function resetProductData(dataDir: string, recoveryRoot: string): string {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
	const transaction = join(recoveryRoot, `.resetting-${randomUUID()}`);
	mkdirSync(transaction, { mode: 0o700 });
	syncDirectory(recoveryRoot);
	const [backup] = completePendingProductResets(dataDir, recoveryRoot);
	if (!backup) throw new Error("product reset did not create a recovery backup");
	return backup;
}

type SqlValue = bigint | number | string | null | Uint8Array;

function validJsonColumns(row: Record<string, unknown>): boolean {
	for (const [column, value] of Object.entries(row)) {
		if (!JSON_COLUMNS.has(column) || value === null) continue;
		if (typeof value !== "string") return false;
		try {
			JSON.parse(value);
		} catch {
			return false;
		}
	}
	return true;
}

function validAppSettingsRow(row: Record<string, unknown>): boolean {
	try {
		return (
			SettingsData.shape.firstRunStage.safeParse(row.first_run_stage).success &&
			SettingsData.shape.networkProxy.safeParse(JSON.parse(String(row.network_proxy))).success &&
			SettingsData.shape.memoryVectorService.safeParse(
				JSON.parse(String(row.memory_vector_service)),
			).success &&
			SystemModelDefaultsGetResponse.safeParse(JSON.parse(String(row.system_model_defaults)))
				.success &&
			SettingsData.shape.modelDownloadSource.safeParse(
				JSON.parse(String(row.model_download_mirror)),
			).success
		);
	} catch {
		return false;
	}
}

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function columns(database: DatabaseSync, table: string): string[] {
	return (
		database.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string }>
	).map(({ name }) => name);
}

function copyTable(source: DatabaseSync, target: DatabaseSync, table: string): number {
	let sourceColumns: string[];
	let targetColumns: string[];
	try {
		sourceColumns = columns(source, table);
		targetColumns = columns(target, table);
	} catch {
		return 0;
	}
	const selected = targetColumns.filter((column) => sourceColumns.includes(column));
	if (selected.length === 0) return 0;
	let rows: Array<Record<string, unknown>>;
	try {
		rows = source
			.prepare(`SELECT ${selected.map(quoted).join(", ")} FROM ${quoted(table)}`)
			.all() as Array<Record<string, unknown>>;
	} catch {
		return 0;
	}
	const placeholders = selected.map(() => "?").join(", ");
	const insert = target.prepare(
		`INSERT OR REPLACE INTO ${quoted(table)} (${selected.map(quoted).join(", ")}) VALUES (${placeholders})`,
	);
	let copied = 0;
	for (const row of rows) {
		if (!validJsonColumns(row)) continue;
		if (table === "app_settings" && !validAppSettingsRow(row)) continue;
		try {
			insert.run(...selected.map((column) => row[column] as SqlValue));
			copied += 1;
		} catch {
			// A corrupt row or broken relationship falls back to the fresh-schema default.
		}
	}
	return copied;
}

function createRecoveredDatabase(options: {
	path: string;
	schema: string;
	tables: readonly string[];
	companionId?: string;
}): { migratedRows: number; backupDirectory?: string } {
	const parent = dirname(options.path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const id = randomUUID();
	const repairDirectory = join(parent, `.${basename(options.path)}.repair-${id}`);
	mkdirSync(repairDirectory, { mode: 0o700 });
	syncDirectory(parent);
	const nextPath = join(repairDirectory, "new.db");
	const target = new DatabaseSync(nextPath);
	let source: DatabaseSync | undefined;
	let migratedRows = 0;
	try {
		target.exec("PRAGMA foreign_keys = ON");
		target.exec("BEGIN IMMEDIATE");
		target.exec(options.schema);
		target.exec("COMMIT");
		if (options.companionId) {
			target
				.prepare("INSERT INTO runtime_identity(id, companion_id) VALUES(1, ?)")
				.run(options.companionId);
		}
		if (existsSync(options.path)) {
			try {
				source = new DatabaseSync(options.path, { readOnly: true });
				target.exec("BEGIN IMMEDIATE");
				if (options.companionId) {
					try {
						const identity = source
							.prepare("SELECT nickname FROM runtime_identity WHERE id = 1")
							.get() as { nickname?: unknown } | undefined;
						if (typeof identity?.nickname === "string") {
							target
								.prepare("UPDATE runtime_identity SET nickname = ? WHERE id = 1")
								.run(identity.nickname);
						}
					} catch {
						// Identity damage falls back to the directory-owned companion id.
					}
				}
				for (const table of options.tables) {
					if (options.companionId && table === "runtime_identity") continue;
					migratedRows += copyTable(source, target, table);
				}
				target.exec("COMMIT");
				target.exec("PRAGMA foreign_keys = ON");
			} catch {
				try {
					target.exec("ROLLBACK");
				} catch {}
			}
		}
		if (target.prepare("PRAGMA foreign_key_check").all().length > 0) {
			throw new Error("recovered database has invalid relationships");
		}
		const integrity = target.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
		if (!Object.values(integrity).includes("ok"))
			throw new Error("recovered database failed integrity check");
	} finally {
		source?.close();
		target.close();
	}
	syncFile(nextPath);
	syncDirectory(repairDirectory);
	moveDatabaseAside(options.path, repairDirectory);
	renameSync(nextPath, options.path);
	syncDirectory(parent);
	const backupDirectory = join(parent, `.${basename(options.path)}.corrupt-${id}`);
	renameSync(repairDirectory, backupDirectory);
	syncDirectory(parent);
	return { migratedRows, backupDirectory };
}

function moveDatabaseAside(path: string, destination: string): void {
	for (const [source, name] of [
		[path, "original.db"],
		[`${path}-wal`, "original.db-wal"],
		[`${path}-shm`, "original.db-shm"],
	] as const) {
		if (existsSync(source)) renameSync(source, join(destination, name));
	}
	syncDirectory(dirname(path));
}

function recoverPendingDatabaseRepairs(
	parent: string,
	fileName: string,
	requiredTables: readonly string[],
): void {
	if (!existsSync(parent)) return;
	const prefix = `.${fileName}.repair-`;
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
		const repairDirectory = join(parent, entry.name);
		const nextPath = join(repairDirectory, "new.db");
		const targetPath = join(parent, fileName);
		const targetValid = existsSync(targetPath) && databaseIntegrity(targetPath, requiredTables);
		const nextValid = existsSync(nextPath) && databaseIntegrity(nextPath, requiredTables);
		if (!targetValid && nextValid) {
			moveDatabaseAside(targetPath, repairDirectory);
			renameSync(nextPath, targetPath);
			syncDirectory(parent);
		}
		if (existsSync(targetPath) && databaseIntegrity(targetPath, requiredTables)) {
			const suffix = entry.name.slice(prefix.length);
			renameSync(repairDirectory, join(parent, `.${fileName}.corrupt-${suffix}`));
			syncDirectory(parent);
		}
	}
}

export function repairSystemDatabase(dataDir: string): {
	migratedRows: number;
	backupDirectory?: string;
} {
	const layout = new RuntimeLayout(dataDir);
	layout.ensureSystemDirectories();
	return createRecoveredDatabase({
		path: layout.systemDatabase,
		schema: SYSTEM_SCHEMA_SQL,
		tables: SYSTEM_TABLES,
	});
}

export function repairCompanionDatabase(
	dataDir: string,
	companionId: string,
): { migratedRows: number; backupDirectory?: string } {
	const layout = new RuntimeLayout(dataDir);
	layout.ensureSystemDirectories();
	const paths = layout.ensureCompanionDirectories(requireCompanionId(companionId));
	return createRecoveredDatabase({
		path: paths.database,
		schema: COMPANION_SCHEMA_SQL,
		tables: COMPANION_TABLES,
		companionId,
	});
}

export function selectDefaultCharacter(options: BootstrapInspectionOptions): void {
	const layout = new RuntimeLayout(options.dataDir);
	const loader = new CharacterLoader(options.characterSeedRoot, layout.charactersRoot);
	loader.bootstrapLibrary(options.defaultCharacterId);
	const character = loader.load(options.defaultCharacterId);
	if (!character) throw new Error("default character package is missing");
	const database = new SystemDatabase(layout.systemDatabase);
	try {
		database.initialize(SYSTEM_SCHEMA_SQL);
		loader.activate(database.orm, character);
	} finally {
		database.close();
	}
}

export function restoreDefaultCharacterPackage(
	options: BootstrapInspectionOptions,
): string | undefined {
	const layout = new RuntimeLayout(options.dataDir);
	layout.ensureSystemDirectories();
	const target = layout.characterPackage(options.defaultCharacterId);
	let backup: string | undefined;
	const transactionEntries = readdirSync(layout.charactersRoot, { withFileTypes: true }).filter(
		(entry) => entry.name.startsWith(`.${options.defaultCharacterId}.`),
	);
	if (existsSync(target) || transactionEntries.length > 0) {
		backup = join(layout.charactersRoot, `.recovery-${options.defaultCharacterId}-${randomUUID()}`);
		mkdirSync(backup, { mode: 0o700 });
		if (existsSync(target)) renameSync(target, join(backup, "package"));
		for (const entry of transactionEntries) {
			renameSync(join(layout.charactersRoot, entry.name), join(backup, entry.name));
		}
		syncDirectory(layout.charactersRoot);
	}
	const loader = new CharacterLoader(options.characterSeedRoot, layout.charactersRoot);
	loader.bootstrapLibrary(options.defaultCharacterId);
	if (!loader.load(options.defaultCharacterId)) throw new Error("default character repair failed");
	return backup;
}
