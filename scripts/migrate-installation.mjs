import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CharacterLoader } from "../packages/host-runtime/dist/companion/character-loader.js";
import { CompanionStateStore } from "../packages/host-runtime/dist/companion/companion-store.js";
import { compileCharacterStateSchema } from "../packages/host-runtime/dist/companion/state-schema.js";
import {
	COMPANION_SCHEMA_SQL,
	Database,
	SYSTEM_SCHEMA_SQL,
} from "../packages/host-runtime/dist/storage/database.js";

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const hash = (data) => createHash("sha256").update(data).digest("hex");
export function inventory(root) {
	const files = {};
	function visit(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			assert(!entry.isSymbolicLink(), "Migration refuses symlinks");
			if (entry.isDirectory()) visit(path);
			else {
				assert(entry.isFile(), "Unsupported file type");
				files[relative(root, path)] = hash(readFileSync(path));
			}
		}
	}
	assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
	visit(root);
	return files;
}

export function convertState(row, character) {
	const old = JSON.parse(row.state_json);
	if (row.domain === "display") {
		assert(
			Object.keys(old).every((key) => ["sceneId", "expressionId", "surfaces"].includes(key)),
			"Unknown Display field",
		);
		assert(old.sceneId == null || character.scenes.some((scene) => scene.id === old.sceneId));
		assert(
			old.expressionId == null ||
				character.visual.expressions.some((item) => item.id === old.expressionId),
		);
		return JSON.stringify({ sceneId: old.sceneId ?? null, expressionId: old.expressionId ?? null });
	}
	assert(
		character.id === "jizhou",
		"State conversion needs an explicit mapping for this character",
	);
	assert(
		Object.keys(old).every((key) => ["relationship", "continuity", "story"].includes(key)),
		"Unknown Character field",
	);
	const defaults = compileCharacterStateSchema(character.state).defaults;
	if (row.scope === "global") {
		const relationship = { ...defaults.relationship, ...old.relationship };
		if (old.continuity) {
			relationship.summary += `\n过去会话中的旧剧情记录：${old.continuity.response ?? ""}（原阶段 ${old.continuity.stage ?? "未记录"}；属于已结束的旧设定。）`;
		}
		return JSON.stringify({ relationship });
	}
	const story = { ...defaults.story, ...old.story };
	if (Object.hasOwn(story, "chapter")) {
		story.summary += `\n原剧情进度：第 ${story.chapter} 章。旧剧情包已退役，保留以上记录，当前暂停。`;
		delete story.chapter;
		story.active = false;
	}
	return JSON.stringify({ story });
}

function tables(db) {
	return db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT GLOB '*_fts*'",
		)
		.all()
		.map((row) => row.name);
}
function convertDatabase(path, schema, transform, retired) {
	const old = new DatabaseSync(path, { readOnly: true });
	assert.equal(
		old.prepare("PRAGMA user_version").get().user_version,
		0,
		"Expected pre-release database version 0",
	);
	const temporary = `${path}.converted`;
	assert(!existsSync(temporary));
	const next = new Database(dirname(temporary), { fileName: temporary.split(sep).at(-1) });
	const counts = {};
	try {
		next.initialize(schema);
		const targets = tables(next.connection);
		for (const table of tables(old)) {
			if (targets.includes(table) || table.startsWith("canon_chunk_vectors")) continue;
			const count = old.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n;
			assert(retired.has(table) || count === 0, `Unmapped populated table: ${table}`);
			counts[`retired:${table}`] = count;
		}
		next.connection.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
		for (const table of targets) next.connection.exec(`DELETE FROM ${quote(table)}`);
		for (const table of targets) {
			const present = old
				.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
				.get(table);
			const original = present ? old.prepare(`SELECT * FROM ${quote(table)}`).all() : [];
			const rows = transform(table, original);
			const columns = new Set(
				next.connection
					.prepare(`PRAGMA table_info(${quote(table)})`)
					.all()
					.map((col) => col.name),
			);
			for (const row of rows) {
				const keys = Object.keys(row).filter((key) => columns.has(key));
				assert(keys.length, `No columns to migrate: ${table}`);
				next.connection
					.prepare(
						`INSERT INTO ${quote(table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
					)
					.run(...keys.map((key) => row[key]));
			}
			counts[table] = rows.length;
		}
		assert.deepEqual(next.connection.prepare("PRAGMA foreign_key_check").all(), []);
		next.connection.exec("COMMIT; PRAGMA foreign_keys=ON");
		assert.equal(next.connection.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
		next.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		old.close();
		next.close();
	}
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
	renameSync(temporary, path);
	return counts;
}

export function convertNamespace(value, oldNamespace, newNamespace) {
	if (typeof value === "string") return value === oldNamespace ? newNamespace : value;
	if (Array.isArray(value))
		return value.map((item) => convertNamespace(item, oldNamespace, newNamespace));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key === oldNamespace ? newNamespace : key,
				convertNamespace(item, oldNamespace, newNamespace),
			]),
		);
	return value;
}
function migrateMemory(root, namespace) {
	if (!existsSync(root)) return {};
	const oldNamespace = namespace.replace("memory:", "memory:v1:");
	const counts = { l0: 0, l1: 0 };
	for (const [directory, counter] of [
		["conversations", "l0"],
		["records", "l1"],
	]) {
		if (!existsSync(join(root, directory))) continue;
		for (const file of readdirSync(join(root, directory)).filter((file) =>
			file.endsWith(".jsonl"),
		)) {
			const path = join(root, directory, file);
			const rows = readFileSync(path, "utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => {
					const row = JSON.parse(line);
					assert(row.schemaVersion === undefined || row.schemaVersion === 1);
					counts[counter]++;
					return { ...convertNamespace(row, oldNamespace, namespace), schemaVersion: 1 };
				});
			writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		}
	}
	for (const name of ["recall_checkpoint.json", "scene_index.json"]) {
		const path = join(root, ".metadata", name);
		if (!existsSync(path)) continue;
		const old = JSON.parse(readFileSync(path, "utf8"));
		const value =
			name === "scene_index.json" && Array.isArray(old)
				? { schemaVersion: 1, entries: old }
				: { ...old, schemaVersion: 1 };
		writeFileSync(
			path,
			`${JSON.stringify(convertNamespace(value, oldNamespace, namespace), null, 2)}\n`,
		);
	}
	const path = join(root, "vectors.db");
	if (existsSync(path)) {
		const db = new Database(root, { fileName: "vectors.db" });
		try {
			const version = db.connection.prepare("PRAGMA user_version").get().user_version;
			assert(version === 0 || version === 1);
			for (const table of ["l0_conversations", "l1_records"]) {
				assert(
					db.connection.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table),
					`Missing memory table ${table}`,
				);
				db.connection
					.prepare(`UPDATE ${table} SET session_key=? WHERE session_key=?`)
					.run(namespace, oldNamespace);
			}
			db.connection.exec("PRAGMA user_version=1; PRAGMA wal_checkpoint(TRUNCATE)");
			assert.equal(db.connection.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
		} finally {
			db.close();
		}
	}
	return counts;
}

export function convertAuditRows(rows) {
	let previousOld = hash("");
	let previousNew = hash("");
	return rows.map((row, index) => {
		assert.equal(row.seq, index + 1, "Audit sequence is incomplete");
		assert.equal(row.prevHash, previousOld, "Old audit chain is broken");
		const payload = `${row.seq}|${row.kind}|${row.action}|${row.detail}|${row.createdAt}|${row.prevHash}`;
		assert.equal(
			row.hash,
			hash(row.schemaVersion === 1 ? `1|${payload}` : payload),
			"Old audit hash is invalid",
		);
		previousOld = row.hash;
		const converted = { ...row, schemaVersion: 1, prevHash: previousNew };
		converted.hash = hash(
			`1|${converted.seq}|${converted.kind}|${converted.action}|${converted.detail}|${converted.createdAt}|${converted.prevHash}`,
		);
		previousNew = converted.hash;
		return converted;
	});
}
function migrateAudit(root) {
	if (!existsSync(root)) return 0;
	const names = readdirSync(root)
		.filter((name) => /^segment-\d+\.jsonl$/.test(name))
		.sort();
	const segments = names.map((name) =>
		readFileSync(join(root, name), "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	);
	const converted = convertAuditRows(segments.flat());
	let offset = 0;
	for (const [index, name] of names.entries()) {
		const size = segments[index].length;
		writeFileSync(
			join(root, name),
			`${converted
				.slice(offset, offset + size)
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		offset += size;
	}
	return offset;
}

/** Only Pi resource-location metadata changes; all native entries remain byte-identical. */
export function relocateSessionHeaders(root, targetRoot) {
	for (const id of readdirSync(join(root, "companions"))) {
		const sessions = join(root, "companions", id, "sessions");
		if (!existsSync(sessions)) continue;
		for (const name of readdirSync(sessions).filter((name) => name.endsWith(".jsonl"))) {
			const path = join(sessions, name);
			const raw = readFileSync(path, "utf8");
			const split = raw.indexOf("\n");
			assert(split > 0);
			const header = JSON.parse(raw.slice(0, split));
			assert(
				header.type === "session" && header.version === 3 && name.endsWith(`_${header.id}.jsonl`),
			);
			header.cwd = join(resolve(targetRoot), "companions", id);
			writeFileSync(path, JSON.stringify(header) + raw.slice(split));
		}
	}
}

/** Offline one-way conversion; the source is never modified and runtime has no legacy reads. */
export function migrateInstallation(sourcePath, destinationPath, packageRoot) {
	const source = realpathSync(sourcePath);
	const destination = resolve(destinationPath);
	const rel = relative(source, destination);
	assert(
		rel && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
		"Destination must be outside source",
	);
	assert(!existsSync(destination), "Destination already exists");
	const before = inventory(source);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, {
		recursive: true,
		errorOnExist: true,
		force: false,
		preserveTimestamps: true,
	});
	const receipt = {
		version: 1,
		databaseVersion: 1,
		packageFormat: 2,
		sourceFiles: before,
		characters: {},
	};
	try {
		const characterIds = readdirSync(join(source, "characters"));
		const runtimeIds = readdirSync(join(source, "companions"));
		assert(
			runtimeIds.every((id) => characterIds.includes(id)),
			"Runtime without package requires explicit mapping",
		);
		const loader = new CharacterLoader(resolve(packageRoot));
		const characters = new Map();
		for (const id of characterIds) {
			assert(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id));
			assert.equal(
				id,
				"jizhou",
				"Only the explicitly replaced official Jizhou package is supported",
			);
			const character = loader.load(id);
			assert(character, "Replacement package must load");
			characters.set(id, character);
			rmSync(join(destination, "characters", id), { recursive: true });
			cpSync(join(packageRoot, id), join(destination, "characters", id), { recursive: true });
		}
		const systemPath = join(destination, "system/settings.db");
		let installationId;
		receipt.system = convertDatabase(
			systemPath,
			SYSTEM_SCHEMA_SQL,
			(table, rows) =>
				rows.map((row) => {
					if (table === "installation_identity") installationId = row.installation_id;
					if (table === "app_settings")
						return {
							...row,
							system_model_onboarding_complete: row.first_run_stage !== "model" ? 1 : 0,
							embedding_onboarding_complete:
								row.first_run_stage === "role" || row.first_run_stage === "complete" ? 1 : 0,
							relationship_memory_enabled: 0,
						};
					if (table === "executor_profiles") return { ...row, config_json: row.capability_json };
					return row;
				}),
			new Set(["schema_migrations", "sync_changes", "active_character"]),
		);
		assert(installationId);
		for (const id of runtimeIds) {
			const character = characters.get(id);
			let consent = false;
			const original = new DatabaseSync(join(destination, "companions", id, "runtime.db"), {
				readOnly: true,
			});
			try {
				const state = original
					.prepare("SELECT state_json FROM onboarding_state WHERE companion_id=?")
					.get(id);
				consent =
					JSON.parse(state?.state_json ?? "{}").decisions?.relationship_memory_enabled === true;
			} finally {
				original.close();
			}
			const path = join(destination, "companions", id, "runtime.db");
			const counts = convertDatabase(
				path,
				COMPANION_SCHEMA_SQL,
				(table, rows) => {
					if (table === "character_memory_settings") return [{ id: 1, enabled: consent ? 1 : 0 }];
					if (table === "canon_vector_meta") return [];
					return rows.map((row) => {
						if (table === "artifacts")
							return {
								...row,
								verification:
									row.status === "verified"
										? "verified"
										: row.status === "verification_failed"
											? "failed"
											: "pending",
								saved: row.status === "saved" ? 1 : 0,
							};
						if (table === "onboarding_state")
							return {
								...row,
								state_json: JSON.stringify({ answers: JSON.parse(row.state_json).answers ?? {} }),
							};
						if (table === "companion_state_documents")
							return { ...row, state_json: convertState(row, character) };
						if (table === "canon_chunks") return { ...row, embedding: null };
						return row;
					});
				},
				new Set(["schema_migrations", "events", "sync_changes", "self_canon_versions"]),
			);
			const database = new Database(dirname(path), { fileName: "runtime.db" });
			try {
				new CompanionStateStore(database.orm).reconcileSchema(id, character.state);
			} finally {
				database.close();
			}
			const memory = migrateMemory(
				join(destination, "companions", id, "memory/tdai"),
				`memory:${installationId}:default-user:${id}`,
			);
			const auditRecords = migrateAudit(join(destination, "companions", id, "audit"));
			receipt.characters[id] = { counts, memory, consent, auditRecords };
		}
		const obsoleteModels = join(destination, "system/providers/models-store.json");
		if (existsSync(obsoleteModels)) {
			assert.deepEqual(
				JSON.parse(readFileSync(obsoleteModels, "utf8")),
				{},
				"Legacy custom model definitions require explicit conversion",
			);
			rmSync(obsoleteModels);
		}
		for (const path of [".runtime-layout-v2.json", "system/schema-backups"])
			rmSync(join(destination, path), { recursive: true, force: true });
		for (const id of runtimeIds)
			rmSync(join(destination, "companions", id, "schema-backups"), {
				recursive: true,
				force: true,
			});
		assert.deepEqual(inventory(source), before, "Source changed during migration");
		relocateSessionHeaders(destination, destination);
		const after = inventory(destination);
		for (const [path, sha] of Object.entries(before)) {
			if (/\/sessions\/.+\.jsonl$/.test(path)) {
				const old = readFileSync(join(source, path), "utf8");
				const updated = readFileSync(join(destination, path), "utf8");
				assert.equal(
					updated.slice(updated.indexOf("\n")),
					old.slice(old.indexOf("\n")),
					"Pi entries changed",
				);
			} else if (/\/artifacts\/|\/security\/|\/MEMORY\.md$/.test(path))
				assert.equal(after[path], sha, `Protected file changed: ${path}`);
		}
		receipt.destinationFiles = after;
		return receipt;
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [, , source, destination, packages, ...extra] = process.argv;
	assert(
		source && destination && packages && !extra.length,
		"Usage: migrate-installation.mjs SOURCE NEW_DESTINATION PACKAGE_ROOT",
	);
	const receipt = migrateInstallation(source, destination, resolve(packages));
	writeFileSync(`${destination}.migration.json`, `${JSON.stringify(receipt, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	console.log(
		JSON.stringify({ destination, system: receipt.system, characters: receipt.characters }),
	);
}
