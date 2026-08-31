import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	COMPANION_MIGRATIONS,
	CompanionDatabase,
	SYSTEM_MIGRATIONS,
	SystemDatabase,
} from "./database.js";
import {
	RUNTIME_LAYOUT_BACKUP_PREFIX,
	RUNTIME_LAYOUT_BACKUP_RETENTION_DAYS,
	RUNTIME_LAYOUT_MARKER,
	RUNTIME_LAYOUT_VERSION,
	RuntimeLayout,
	requireCompanionId,
} from "./layout.js";

const LEGACY_DATABASE = join("storage", "canon.db");
const LEGACY_MANAGED_ROOTS = new Set([
	"artifacts",
	"audit",
	"companion-runtime",
	"diagnostics",
	"explicit-memory",
	"external-agent-runs",
	"memory",
	"security",
	"sessions",
	"storage",
	"updates",
]);
const LEGACY_BACKUP_PREFIXES = ["legacy-data-", "storage.legacy-"] as const;

interface LayoutMarker {
	readonly schemaVersion: typeof RUNTIME_LAYOUT_VERSION;
	readonly state: "complete";
	readonly root: string;
	readonly migratedAt: string;
	readonly backupPath: string | null;
	readonly backupExpiresAt: string | null;
	readonly fileCount: number;
	readonly fileBytes: number;
	readonly treeHash: string;
}

interface TreeSummary {
	fileCount: number;
	fileBytes: number;
	treeHash: string;
}

export type RuntimeLayoutPreparation =
	| { action: "current" | "fresh"; root: string }
	| { action: "migrated" | "recovered"; root: string; backupPath: string };

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function isInside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function safeChild(root: string, name: string): string {
	const path = resolve(root, name);
	if (!isInside(resolve(root), path)) throw new Error("runtime layout migration path escaped root");
	return path;
}

function syncFile(path: string): void {
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function syncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch (error) {
		if (
			process.platform !== "win32" ||
			!["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "")
		) {
			throw error;
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function copyTree(source: string, destination: string): void {
	const sourceStat = lstatSync(source);
	if (sourceStat.isSymbolicLink()) throw new Error("runtime layout migration rejects symlinks");
	if (sourceStat.isFile()) {
		mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
		copyFileSync(source, destination, constants.COPYFILE_EXCL);
		chmodSync(destination, sourceStat.mode & 0o777);
		syncFile(destination);
		return;
	}
	if (!sourceStat.isDirectory())
		throw new Error("runtime layout migration accepts regular files only");
	mkdirSync(destination, { recursive: true, mode: sourceStat.mode & 0o777 });
	for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		copyTree(safeChild(source, entry.name), safeChild(destination, entry.name));
	}
	syncDirectory(destination);
}

function hashFile(path: string): string {
	const digest = createHash("sha256");
	const descriptor = openSync(path, constants.O_RDONLY);
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		for (;;) {
			const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
			if (count === 0) break;
			digest.update(buffer.subarray(0, count));
		}
	} finally {
		closeSync(descriptor);
	}
	return digest.digest("hex");
}

function summarizeTree(root: string): TreeSummary {
	const records: string[] = [];
	let fileCount = 0;
	let fileBytes = 0;
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (entry.name === RUNTIME_LAYOUT_MARKER) continue;
			const path = safeChild(directory, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error("runtime layout migration rejects symlinks");
			if (stat.isDirectory()) {
				visit(path);
				continue;
			}
			if (!stat.isFile()) throw new Error("runtime layout migration accepts regular files only");
			const local = relative(root, path).split(sep).join("/");
			fileCount += 1;
			fileBytes += stat.size;
			records.push(`${local}\0${stat.size}\0${hashFile(path)}`);
		}
	};
	visit(root);
	return {
		fileCount,
		fileBytes,
		treeHash: createHash("sha256").update(records.join("\n"), "utf8").digest("hex"),
	};
}

function parseMarker(root: string, expectedRoot = root): LayoutMarker | null {
	const path = join(root, RUNTIME_LAYOUT_MARKER);
	if (!existsSync(path)) return null;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LayoutMarker>;
		if (
			value.schemaVersion !== RUNTIME_LAYOUT_VERSION ||
			value.state !== "complete" ||
			value.root !== resolve(expectedRoot) ||
			typeof value.migratedAt !== "string" ||
			!(typeof value.backupPath === "string" || value.backupPath === null) ||
			!(typeof value.backupExpiresAt === "string" || value.backupExpiresAt === null) ||
			!Number.isSafeInteger(value.fileCount) ||
			Number(value.fileCount) < 0 ||
			!Number.isSafeInteger(value.fileBytes) ||
			Number(value.fileBytes) < 0 ||
			typeof value.treeHash !== "string" ||
			!/^[0-9a-f]{64}$/.test(value.treeHash)
		) {
			return null;
		}
		return value as LayoutMarker;
	} catch {
		return null;
	}
}

function markerMatchesTree(root: string, marker: LayoutMarker): boolean {
	const summary = summarizeTree(root);
	return (
		summary.fileCount === marker.fileCount &&
		summary.fileBytes === marker.fileBytes &&
		summary.treeHash === marker.treeHash
	);
}

function writeMarker(root: string, marker: LayoutMarker): void {
	const target = join(root, RUNTIME_LAYOUT_MARKER);
	const temporary = `${target}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	syncFile(temporary);
	renameSync(temporary, target);
	syncDirectory(root);
}

function quoteSqlitePath(path: string): string {
	return `'${path.replaceAll("'", "''")}'`;
}

function assertHealthy(database: DatabaseSync, label: string): void {
	const integrity = database.prepare("PRAGMA integrity_check").all();
	if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
		throw new Error(`${label} failed SQLite integrity validation`);
	}
	if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
		throw new Error(`${label} failed SQLite foreign-key validation`);
	}
}

function tableExists(database: DatabaseSync, table: string): boolean {
	return Boolean(
		database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
	);
}

function snapshotLegacyDatabase(sourcePath: string, targetPath: string): void {
	const source = new DatabaseSync(sourcePath);
	try {
		assertHealthy(source, "legacy database");
		for (const table of [
			"installation_identity",
			"app_settings",
			"companion_packages",
			"companion_identity",
			"conversations",
		]) {
			if (!tableExists(source, table)) throw new Error(`legacy database is missing ${table}`);
		}
		source.exec(`VACUUM INTO ${quoteSqlitePath(targetPath)}`);
	} finally {
		source.close();
	}
	const snapshot = new DatabaseSync(targetPath, { readOnly: true });
	try {
		assertHealthy(snapshot, "legacy database snapshot");
	} finally {
		snapshot.close();
	}
}

function attach(database: DatabaseSync, snapshotPath: string): void {
	database.exec(`ATTACH DATABASE ${quoteSqlitePath(snapshotPath)} AS legacy`);
}

function detach(database: DatabaseSync): void {
	database.exec("DETACH DATABASE legacy");
}

function copySystemDatabase(snapshotPath: string, targetPath: string): void {
	const database = new SystemDatabase(targetPath);
	try {
		database.migrate(SYSTEM_MIGRATIONS);
		attach(database.connection, snapshotPath);
		try {
			database.connection.exec("BEGIN IMMEDIATE");
			try {
				const legacyDefault = database.connection
					.prepare(`
						SELECT
							m.text_provider_id AS reply_provider_id,
							m.text_model_id AS reply_model_id,
							m.vision_mode AS vision_mode,
							m.multimodal_provider_id AS vision_provider_id,
							m.multimodal_model_id AS vision_model_id,
							vm.supports_images AS vision_supports_images
						FROM legacy.active_character a
						JOIN legacy.model_route_settings m ON m.companion_id = a.character_id
						JOIN legacy.configured_models rm
							ON rm.provider_id = m.text_provider_id AND rm.model_id = m.text_model_id
						LEFT JOIN legacy.configured_models vm
							ON vm.provider_id = m.multimodal_provider_id
							AND vm.model_id = m.multimodal_model_id
						WHERE a.singleton = 1
					`)
					.get() as
					| {
							reply_provider_id: string;
							reply_model_id: string;
							vision_mode: string;
							vision_provider_id: string | null;
							vision_model_id: string | null;
							vision_supports_images: number | null;
					  }
					| undefined;
				const legacySystemDefaults = legacyDefault
					? {
							reply: {
								providerId: legacyDefault.reply_provider_id,
								modelId: legacyDefault.reply_model_id,
							},
							vision:
								legacyDefault.vision_mode === "manual" &&
								legacyDefault.vision_provider_id &&
								legacyDefault.vision_model_id &&
								legacyDefault.vision_supports_images === 1
									? {
											mode: "manual" as const,
											route: {
												providerId: legacyDefault.vision_provider_id,
												modelId: legacyDefault.vision_model_id,
											},
										}
									: { mode: "auto" as const },
						}
					: { vision: { mode: "auto" as const } };
				for (const table of [
					"active_character",
					"character_draft_revisions",
					"character_drafts",
					"companion_identity",
					"companion_packages",
					"configured_models",
					"executor_profiles",
					"provider_accounts",
					"runtime_assets",
					"user_decisions",
				] as const) {
					database.connection.exec(`DELETE FROM "${table}"`);
				}
				database.connection.exec("DELETE FROM app_settings; DELETE FROM installation_identity");
				const invalidEmbeddingSettings = database.connection
					.prepare(
						"SELECT id FROM legacy.app_settings WHERE json_valid(memory_vector_service) = 0 OR json_type(memory_vector_service) != 'object' LIMIT 1",
					)
					.get();
				if (invalidEmbeddingSettings)
					throw new Error("legacy embedding settings are not valid JSON");
				database.connection
					.prepare(`
					INSERT INTO app_settings(
						id, first_run_stage, network_proxy, memory_vector_service,
						system_model_defaults, model_download_mirror, updated_at
					)
					SELECT
						id, CASE WHEN ? = 1 THEN first_run_stage ELSE 'model' END, network_proxy,
						memory_vector_service,
						?, model_download_mirror, updated_at
					FROM legacy.app_settings
				`)
					.run(legacyDefault ? 1 : 0, JSON.stringify(legacySystemDefaults));
				const copies = [
					["installation_identity", "id,installation_id,created_at"],
					[
						"companion_packages",
						"id,name,origin,plugin_hash,plugin_trusted_hash,signed_at,created_at",
					],
					["companion_identity", "id,package_id,name,created_at"],
					["active_character", "singleton,character_id,updated_at"],
					[
						"provider_accounts",
						"id,provider_id,credential_blob,credential_status,created_at,updated_at",
					],
					["configured_models", "provider_id,model_id,label,supports_images,created_at"],
					["executor_profiles", "id,profile_type,capability_json,created_at"],
					["runtime_assets", "id,asset_type,version,path,hash,created_at"],
					["user_decisions", "id,kind,decision_data,created_at"],
					[
						"character_drafts",
						"id,base_package_id,status,locale,current_revision,created_at,updated_at",
					],
					["character_draft_revisions", "draft_id,revision,files_json,created_at"],
				] as const;
				for (const [table, columns] of copies) {
					if (!tableExistsInAttached(database.connection, table)) continue;
					database.connection.exec(
						`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM legacy."${table}"`,
					);
				}
				database.connection.exec("COMMIT");
			} catch (error) {
				database.connection.exec("ROLLBACK");
				throw error;
			}
		} finally {
			detach(database.connection);
		}
		database.assertSchemaContract();
		assertHealthy(database.connection, "system database");
	} finally {
		database.close();
	}
}

function tableExistsInAttached(database: DatabaseSync, table: string): boolean {
	return Boolean(
		database.prepare("SELECT 1 FROM legacy.sqlite_master WHERE type='table' AND name=?").get(table),
	);
}

function copyCompanionDatabase(
	snapshotPath: string,
	targetPath: string,
	companionId: string,
): void {
	const database = new CompanionDatabase(targetPath, companionId);
	try {
		database.migrate(COMPANION_MIGRATIONS);
		database.ensureRuntimeIdentity();
		attach(database.connection, snapshotPath);
		try {
			database.connection.exec("BEGIN IMMEDIATE");
			try {
				const id = companionId.replaceAll("'", "''");
				database.connection.exec(
					`UPDATE runtime_identity SET nickname=(SELECT nickname FROM legacy.companion_identity WHERE id='${id}') WHERE id=1`,
				);
				const statements = [
					`INSERT INTO conversations SELECT id,companion_id,created_at,updated_at,archived_at FROM legacy.conversations WHERE companion_id='${id}'`,
					`INSERT INTO model_route_settings(companion_id,text_provider_id,text_model_id,vision_mode,multimodal_provider_id,multimodal_model_id,onboarding_complete,updated_at) SELECT m.companion_id,m.text_provider_id,m.text_model_id,m.vision_mode,m.multimodal_provider_id,m.multimodal_model_id,CASE WHEN EXISTS (SELECT 1 FROM legacy.configured_models c WHERE c.provider_id=m.text_provider_id AND c.model_id=m.text_model_id) THEN 1 ELSE 0 END,m.updated_at FROM legacy.model_route_settings m WHERE m.companion_id='${id}'`,
					`INSERT INTO onboarding_state(companion_id,state,state_json,updated_at) SELECT companion_id,state,json_remove(state_json,'$.schema_version','$.flow_version','$.decisions.conversation_history_read_enabled'),updated_at FROM legacy.onboarding_state WHERE companion_id='${id}'`,
					`INSERT INTO runs SELECT r.id,r.conversation_id,r.trigger_entry_id,r.executor_profile,r.title,r.instruction,r.input_paths,r.status,r.summary,r.result_reported_at,r.started_at,r.completed_at,r.created_at FROM legacy.runs r JOIN conversations c ON c.id=r.conversation_id`,
					`INSERT INTO run_manifests SELECT m.id,m.run_id,m.manifest_json,m.created_at FROM legacy.run_manifests m JOIN runs r ON r.id=m.run_id`,
					`INSERT INTO evidence SELECT e.id,e.run_id,e.kind,e.data,e.created_at FROM legacy.evidence e JOIN runs r ON r.id=e.run_id`,
					`INSERT INTO artifacts SELECT DISTINCT a.id,a.logical_name,a.mime,a.bytes,a.sha256,a.status,a.producer_run_id,a.created_at FROM legacy.artifacts a WHERE EXISTS (SELECT 1 FROM runs r WHERE r.id=a.producer_run_id) OR EXISTS (SELECT 1 FROM legacy.canon_sources s WHERE s.companion_id='${id}' AND s.artifact_id=a.id)`,
					`INSERT INTO artifact_adoptions SELECT d.id,d.artifact_id,d.run_id,d.adopted_at FROM legacy.artifact_adoptions d JOIN artifacts a ON a.id=d.artifact_id JOIN runs r ON r.id=d.run_id`,
					`INSERT INTO canon_sources SELECT id,companion_id,logical_name,mime,sha256,artifact_id,origin,stable_key,language,source_kind,created_at FROM legacy.canon_sources WHERE companion_id='${id}'`,
					`INSERT INTO canon_chunks SELECT c.id,c.source_id,c.ordinal,c.content,c.start_offset,c.end_offset,c.token_count,c.heading,c.embedding FROM legacy.canon_chunks c JOIN canon_sources s ON s.id=c.source_id`,
					`INSERT INTO canon_entities SELECT id,companion_id,kind,name,aliases_json,description,origin,stable_key,created_at FROM legacy.canon_entities WHERE companion_id='${id}'`,
					`INSERT INTO canon_relations SELECT r.id,r.from_entity_id,r.to_entity_id,r.kind,r.description,r.source_chunk_id,r.created_at FROM legacy.canon_relations r JOIN canon_entities f ON f.id=r.from_entity_id JOIN canon_entities t ON t.id=r.to_entity_id`,
					`INSERT INTO canon_package_state SELECT companion_id,manifest_hash,updated_at FROM legacy.canon_package_state WHERE companion_id='${id}'`,
					`INSERT INTO story_modules SELECT id,companion_id,parent_id,kind,name,description,source_refs_json,dependencies_json,origin,stable_key,triggers_json,created_at FROM legacy.story_modules WHERE companion_id='${id}'`,
					`INSERT INTO companion_state_documents(id,companion_id,conversation_id,scope,domain,state_json,revision,updated_at) SELECT id,companion_id,conversation_id,scope,domain,state_json,revision,updated_at FROM legacy.companion_state_documents WHERE companion_id='${id}'`,
				];
				for (const statement of statements) database.connection.exec(statement);
				database.connection.exec("COMMIT");
			} catch (error) {
				database.connection.exec("ROLLBACK");
				throw error;
			}
		} finally {
			detach(database.connection);
		}
		database.assertSchemaContract();
		assertHealthy(database.connection, `character database ${companionId}`);
	} finally {
		database.close();
	}
}

function legacyCompanionIds(snapshotPath: string): string[] {
	const database = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		const ids = database
			.prepare("SELECT id FROM companion_identity ORDER BY id")
			.all()
			.map((row) => requireCompanionId(String(row.id)));
		const known = new Set(ids);
		for (const table of [
			"conversations",
			"model_route_settings",
			"onboarding_state",
			"canon_sources",
			"canon_entities",
			"canon_package_state",
			"story_modules",
			"companion_state_documents",
		]) {
			if (!tableExists(database, table)) continue;
			const owners = database
				.prepare(
					`SELECT DISTINCT companion_id AS id FROM "${table}" WHERE companion_id IS NOT NULL`,
				)
				.all();
			for (const owner of owners) {
				if (!known.has(String(owner.id))) {
					throw new Error(`legacy ${table} contains an unowned character record`);
				}
			}
		}
		if (
			tableExists(database, "evidence") &&
			Number(
				database
					.prepare(
						"SELECT COUNT(*) AS n FROM evidence e LEFT JOIN runs r ON r.id=e.run_id WHERE e.run_id IS NULL OR r.id IS NULL",
					)
					.get()?.n ?? 0,
			) > 0
		) {
			throw new Error("legacy evidence contains a record without a Run owner");
		}
		return ids;
	} finally {
		database.close();
	}
}

function readSessionId(path: string): string {
	const descriptor = openSync(path, constants.O_RDONLY);
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		const bytes = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
		const newline = buffer.subarray(0, bytes).indexOf(10);
		if (newline < 0) throw new Error("Pi Session header exceeds migration limit");
		const header = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as {
			type?: unknown;
			id?: unknown;
		};
		if (header.type !== "session" || typeof header.id !== "string" || !header.id) {
			throw new Error("Pi Session has an invalid header");
		}
		return header.id;
	} finally {
		closeSync(descriptor);
	}
}

function conversationOwners(snapshotPath: string): Map<string, string> {
	const database = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		return new Map(
			(
				database.prepare("SELECT id, companion_id FROM conversations").all() as Array<{
					id: string;
					companion_id: string;
				}>
			).map((row) => [row.id, requireCompanionId(row.companion_id)]),
		);
	} finally {
		database.close();
	}
}

function migrateSessions(
	sourceRoot: string,
	stagingLayout: RuntimeLayout,
	snapshotPath: string,
): void {
	const source = join(sourceRoot, "sessions");
	const owners = conversationOwners(snapshotPath);
	const seen = new Set<string>();
	if (existsSync(source)) {
		for (const entry of readdirSync(source, { withFileTypes: true })) {
			const sourcePath = safeChild(source, entry.name);
			if (!entry.isFile() || entry.isSymbolicLink()) {
				throw new Error("legacy Sessions directory contains an unsupported entry");
			}
			const sessionId = readSessionId(sourcePath);
			const companionId = owners.get(sessionId);
			if (!companionId) throw new Error(`legacy Session ${sessionId} has no Catalog owner`);
			if (seen.has(sessionId)) throw new Error(`legacy Session ${sessionId} is duplicated`);
			seen.add(sessionId);
			const target = stagingLayout.ensureCompanionDirectories(companionId).sessions;
			copyTree(sourcePath, join(target, entry.name));
		}
	}
	for (const sessionId of owners.keys()) {
		if (!seen.has(sessionId))
			throw new Error(`Catalog Session ${sessionId} has no transcript file`);
	}
}

function runOwners(snapshotPath: string): Map<string, string> {
	const database = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		return new Map(
			(
				database
					.prepare(
						"SELECT r.id, c.companion_id FROM runs r JOIN conversations c ON c.id=r.conversation_id",
					)
					.all() as Array<{ id: string; companion_id: string }>
			).map((row) => [row.id, requireCompanionId(row.companion_id)]),
		);
	} finally {
		database.close();
	}
}

function migrateRunDirectories(
	sourceRoot: string,
	stagingLayout: RuntimeLayout,
	snapshotPath: string,
): void {
	const source = join(sourceRoot, "external-agent-runs");
	if (!existsSync(source)) return;
	const owners = runOwners(snapshotPath);
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const runId = entry.name;
		const owner = owners.get(runId);
		if (!owner) throw new Error(`legacy Run directory ${runId} has no database owner`);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error("legacy Run root contains an unsupported entry");
		}
		copyTree(
			safeChild(source, runId),
			join(stagingLayout.ensureCompanionDirectories(owner).runs, runId),
		);
	}
}

function artifactOwners(snapshotPath: string): Map<string, Set<string>> {
	const database = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		const result = new Map<string, Set<string>>();
		const add = (artifactId: string, companionId: string) => {
			const owners = result.get(artifactId) ?? new Set<string>();
			owners.add(requireCompanionId(companionId));
			result.set(artifactId, owners);
		};
		for (const row of database
			.prepare(
				"SELECT a.id, c.companion_id FROM artifacts a JOIN runs r ON r.id=a.producer_run_id JOIN conversations c ON c.id=r.conversation_id",
			)
			.all() as Array<{ id: string; companion_id: string }>) {
			add(row.id, row.companion_id);
		}
		for (const row of database
			.prepare(
				"SELECT a.id, s.companion_id FROM artifacts a JOIN canon_sources s ON s.artifact_id=a.id",
			)
			.all() as Array<{ id: string; companion_id: string }>) {
			add(row.id, row.companion_id);
		}
		const all = database.prepare("SELECT id FROM artifacts").all();
		for (const row of all) {
			if (!result.has(String(row.id))) {
				throw new Error(`legacy Artifact ${String(row.id)} has no character owner`);
			}
		}
		return result;
	} finally {
		database.close();
	}
}

function migrateArtifacts(
	sourceRoot: string,
	stagingLayout: RuntimeLayout,
	snapshotPath: string,
): void {
	const source = join(sourceRoot, "artifacts");
	const owners = artifactOwners(snapshotPath);
	const database = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		for (const [artifactId, companionIds] of owners) {
			const row = database
				.prepare("SELECT sha256, bytes FROM artifacts WHERE id=?")
				.get(artifactId) as { sha256: string; bytes: number } | undefined;
			if (!row || !/^[0-9a-f]{64}$/.test(row.sha256)) {
				throw new Error(`legacy Artifact ${artifactId} has invalid metadata`);
			}
			const blob = join(source, row.sha256);
			if (!existsSync(blob) || statSync(blob).size !== row.bytes || hashFile(blob) !== row.sha256) {
				throw new Error(`legacy Artifact ${artifactId} failed content verification`);
			}
			for (const companionId of companionIds) {
				const target = join(
					stagingLayout.ensureCompanionDirectories(companionId).artifacts,
					row.sha256,
				);
				if (!existsSync(target)) copyTree(blob, target);
				else if (statSync(target).size !== row.bytes || hashFile(target) !== row.sha256) {
					throw new Error(`staged Artifact ${artifactId} conflicts with existing CAS bytes`);
				}
			}
		}
		if (existsSync(source)) {
			const ownedHashes = new Set(
				[...owners.keys()].map((id) =>
					String(database.prepare("SELECT sha256 FROM artifacts WHERE id=?").get(id)?.sha256),
				),
			);
			for (const entry of readdirSync(source, { withFileTypes: true })) {
				if (!entry.isFile() || entry.isSymbolicLink() || !ownedHashes.has(entry.name)) {
					throw new Error(`legacy Artifact blob ${entry.name} has no character owner`);
				}
			}
		}
	} finally {
		database.close();
	}
}

function migrateMemory(
	sourceRoot: string,
	stagingLayout: RuntimeLayout,
	companions: Set<string>,
): void {
	const automatic = join(sourceRoot, "memory");
	if (existsSync(automatic)) {
		for (const entry of readdirSync(automatic, { withFileTypes: true })) {
			const id = requireCompanionId(decodeURIComponent(entry.name));
			if (!companions.has(id)) throw new Error(`legacy memory ${id} has no character owner`);
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw new Error("legacy memory root contains an unsupported entry");
			}
			copyTree(
				safeChild(automatic, entry.name),
				stagingLayout.ensureCompanionDirectories(id).tdaiMemory,
			);
		}
	}
	const explicit = join(sourceRoot, "explicit-memory");
	if (!existsSync(explicit)) return;
	const seen = new Set<string>();
	for (const user of readdirSync(explicit, { withFileTypes: true })) {
		if (!user.isDirectory() || user.isSymbolicLink()) {
			throw new Error("legacy Explicit Memory root contains an unsupported entry");
		}
		const userRoot = safeChild(explicit, user.name);
		for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
			const id = requireCompanionId(entry.name);
			if (!companions.has(id)) throw new Error(`legacy Explicit Memory ${id} has no owner`);
			if (seen.has(id)) throw new Error(`multiple user memories exist for character ${id}`);
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw new Error("legacy Explicit Memory scope contains an unsupported entry");
			}
			const memoryFile = join(userRoot, entry.name, "MEMORY.md");
			if (!existsSync(memoryFile)) continue;
			seen.add(id);
			copyTree(memoryFile, stagingLayout.ensureCompanionDirectories(id).explicitMemory);
		}
	}
}

function copyGlobalFiles(sourceRoot: string, stagingLayout: RuntimeLayout): void {
	for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
		if (
			LEGACY_MANAGED_ROOTS.has(entry.name) ||
			entry.name === "system" ||
			entry.name === "companions" ||
			entry.name === RUNTIME_LAYOUT_MARKER ||
			LEGACY_BACKUP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
		) {
			continue;
		}
		copyTree(safeChild(sourceRoot, entry.name), safeChild(stagingLayout.root, entry.name));
	}
	for (const [legacyName, target] of [
		["security", stagingLayout.systemSecurity],
		["companion-runtime", stagingLayout.systemProviders],
		["updates", stagingLayout.systemUpdates],
	] as const) {
		const source = join(sourceRoot, legacyName);
		if (!existsSync(source)) continue;
		for (const entry of readdirSync(source)) {
			copyTree(safeChild(source, entry), safeChild(target, entry));
		}
	}
}

function verifyRowAllocation(snapshotPath: string, companionPaths: readonly string[]): void {
	const source = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		for (const table of ["conversations", "runs", "companion_state_documents"] as const) {
			const expected = Number(source.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0);
			let actual = 0;
			for (const path of companionPaths) {
				const target = new DatabaseSync(path, { readOnly: true });
				try {
					actual += Number(target.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0);
				} finally {
					target.close();
				}
			}
			if (actual !== expected) {
				throw new Error(
					`legacy ${table} allocation mismatch: expected ${expected}, received ${actual}`,
				);
			}
		}
		const expectedArtifacts = [...artifactOwners(snapshotPath).values()].reduce(
			(total, owners) => total + owners.size,
			0,
		);
		let actualArtifacts = 0;
		for (const path of companionPaths) {
			const target = new DatabaseSync(path, { readOnly: true });
			try {
				actualArtifacts += Number(
					target.prepare("SELECT COUNT(*) AS n FROM artifacts").get()?.n ?? 0,
				);
			} finally {
				target.close();
			}
		}
		if (actualArtifacts !== expectedArtifacts) {
			throw new Error(
				`legacy artifacts allocation mismatch: expected ${expectedArtifacts}, received ${actualArtifacts}`,
			);
		}
	} finally {
		source.close();
	}
}

function backupName(root: string, now: Date): string {
	const stamp = now
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 14);
	return join(dirname(root), `.${basename(root)}${RUNTIME_LAYOUT_BACKUP_PREFIX}${stamp}`);
}

function pruneExpiredBackups(layout: RuntimeLayout, now: Date): void {
	const prefix = `.${basename(layout.root)}${RUNTIME_LAYOUT_BACKUP_PREFIX}`;
	for (const entry of readdirSync(layout.backupParent, { withFileTypes: true })) {
		if (!entry.name.startsWith(prefix)) continue;
		const path = safeChild(layout.backupParent, entry.name);
		const stat = lstatSync(path);
		if (!entry.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("runtime layout backup is not a real directory");
		}
		if (now.getTime() - stat.mtimeMs > RUNTIME_LAYOUT_BACKUP_RETENTION_DAYS * 86_400_000) {
			rmSync(path, { recursive: true, force: false });
		}
	}
}

function recoverInterruptedActivation(layout: RuntimeLayout): RuntimeLayoutPreparation | null {
	if (existsSync(layout.root)) return null;
	if (existsSync(layout.stagingRoot)) {
		const marker = parseMarker(layout.stagingRoot, layout.root);
		if (
			marker &&
			marker.backupPath &&
			existsSync(marker.backupPath) &&
			markerMatchesTree(layout.stagingRoot, marker)
		) {
			renameSync(layout.stagingRoot, layout.root);
			syncDirectory(layout.backupParent);
			return { action: "recovered", root: layout.root, backupPath: marker.backupPath };
		}
	}

	const prefix = `.${basename(layout.root)}${RUNTIME_LAYOUT_BACKUP_PREFIX}`;
	const backups = readdirSync(layout.backupParent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
		.map((entry) => safeChild(layout.backupParent, entry.name))
		.sort()
		.reverse();
	if (backups.length === 0) {
		if (existsSync(layout.stagingRoot)) {
			throw new Error("runtime layout staging is incomplete and has no recoverable source");
		}
		return null;
	}
	const backupPath = backups[0];
	if (!backupPath) throw new Error("runtime layout backup lookup failed");
	if (existsSync(layout.stagingRoot)) rmSync(layout.stagingRoot, { recursive: true, force: false });
	renameSync(backupPath, layout.root);
	syncDirectory(layout.backupParent);
	return null;
}

export function prepareRuntimeLayout(dataRoot: string, now = new Date()): RuntimeLayoutPreparation {
	if (!isAbsolute(dataRoot)) throw new TypeError("runtime data root must be absolute");
	const layout = new RuntimeLayout(dataRoot);
	const recovered = recoverInterruptedActivation(layout);
	if (recovered) return recovered;
	mkdirSync(layout.root, { recursive: true, mode: 0o700 });
	const existingMarker = parseMarker(layout.root);
	if (existingMarker) {
		layout.ensureSystemDirectories();
		pruneExpiredBackups(layout, now);
		return { action: "current", root: layout.root };
	}
	if (existsSync(layout.systemRoot) || existsSync(layout.companionsRoot)) {
		throw new Error("runtime layout is partially activated and requires recovery");
	}
	const legacyDatabase = join(layout.root, LEGACY_DATABASE);
	if (!existsSync(legacyDatabase)) {
		for (const legacyRoot of LEGACY_MANAGED_ROOTS) {
			const path = join(layout.root, legacyRoot);
			if (existsSync(path) && readdirSync(path).length > 0 && legacyRoot !== "security") {
				throw new Error(`legacy ${legacyRoot} exists without an ownership database`);
			}
		}
		layout.ensureSystemDirectories();
		const summary = summarizeTree(layout.root);
		writeMarker(layout.root, {
			schemaVersion: RUNTIME_LAYOUT_VERSION,
			state: "complete",
			root: layout.root,
			migratedAt: now.toISOString(),
			backupPath: null,
			backupExpiresAt: null,
			...summary,
		});
		return { action: "fresh", root: layout.root };
	}

	if (existsSync(layout.stagingRoot)) rmSync(layout.stagingRoot, { recursive: true, force: true });
	mkdirSync(layout.stagingRoot, { mode: 0o700 });
	const staging = new RuntimeLayout(layout.stagingRoot);
	staging.ensureSystemDirectories();
	const snapshotPath = join(staging.systemRoot, ".legacy-canon.snapshot.db");
	try {
		copyGlobalFiles(layout.root, staging);
		snapshotLegacyDatabase(legacyDatabase, snapshotPath);
		const companionIds = legacyCompanionIds(snapshotPath);
		copySystemDatabase(snapshotPath, staging.systemDatabase);
		for (const companionId of companionIds) {
			const target = staging.ensureCompanionDirectories(companionId);
			copyCompanionDatabase(snapshotPath, target.database, companionId);
		}
		migrateSessions(layout.root, staging, snapshotPath);
		migrateRunDirectories(layout.root, staging, snapshotPath);
		migrateArtifacts(layout.root, staging, snapshotPath);
		migrateMemory(layout.root, staging, new Set(companionIds));
		verifyRowAllocation(
			snapshotPath,
			companionIds.map((id) => staging.companion(id).database),
		);
		rmSync(snapshotPath, { force: false });
		const summary = summarizeTree(staging.root);
		const backupPath = backupName(layout.root, now);
		const expiresAt = new Date(
			now.getTime() + RUNTIME_LAYOUT_BACKUP_RETENTION_DAYS * 86_400_000,
		).toISOString();
		writeMarker(staging.root, {
			schemaVersion: RUNTIME_LAYOUT_VERSION,
			state: "complete",
			root: layout.root,
			migratedAt: now.toISOString(),
			backupPath,
			backupExpiresAt: expiresAt,
			...summary,
		});
		if (existsSync(backupPath)) throw new Error("runtime layout backup target already exists");
		renameSync(layout.root, backupPath);
		try {
			renameSync(layout.stagingRoot, layout.root);
			syncDirectory(layout.backupParent);
		} catch (error) {
			if (!existsSync(layout.root) && existsSync(backupPath)) renameSync(backupPath, layout.root);
			throw error;
		}
		pruneExpiredBackups(layout, now);
		return { action: "migrated", root: layout.root, backupPath };
	} catch (error) {
		if (existsSync(layout.stagingRoot) && existsSync(layout.root)) {
			rmSync(layout.stagingRoot, { recursive: true, force: true });
		}
		throw error;
	}
}
