import { readFileSync } from "node:fs";

const database = readFileSync("packages/host-runtime/src/storage/database.ts", "utf8");
const schemas = readFileSync("packages/host-runtime/src/storage/schema-sql.ts", "utf8");
const registry = readFileSync("packages/host-runtime/src/storage/companion-storage.ts", "utf8");

if (/\bschema_migrations\b|\bMigration\b|\.migrate\(/.test(database))
	throw new Error("database.ts must not contain an internal migration ladder");

function exportedSql(name) {
	const match = schemas.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
	if (!match) throw new Error(`missing checked-in schema ${name}`);
	return match[1];
}

function tableNames(sql) {
	return new Set(
		[...sql.matchAll(/\bCREATE TABLE(?: IF NOT EXISTS)?\s+["`]?([a-z0-9_]+)/gi)].map((match) =>
			match[1].toLowerCase(),
		),
	);
}

const systemSql = exportedSql("SYSTEM_SCHEMA_SQL");
const companionSql = exportedSql("COMPANION_SCHEMA_SQL");
for (const [name, sql] of [
	["system", systemSql],
	["companion", companionSql],
]) {
	if (/\bALTER TABLE\b|\bDROP TABLE\b|\bDROP COLUMN\b/i.test(sql))
		throw new Error(`${name} schema must describe the current structure, not upgrade history`);
}

const systemTables = tableNames(systemSql);
const companionTables = tableNames(companionSql);
for (const required of ["installation_identity", "app_settings", "companion_packages"])
	if (!systemTables.has(required)) throw new Error(`system schema is missing ${required}`);
for (const required of ["runtime_identity", "conversations", "companion_state_documents"])
	if (!companionTables.has(required)) throw new Error(`companion schema is missing ${required}`);

const sharedTables = [...systemTables].filter((table) => companionTables.has(table));
if (sharedTables.length > 0)
	throw new Error(`system and companion schemas overlap: ${sharedTables.join(", ")}`);

for (const schema of ["SYSTEM_SCHEMA_SQL", "COMPANION_SCHEMA_SQL"])
	if (!new RegExp(`\\.initialize\\(${schema}\\)`).test(registry))
		throw new Error(`CompanionStorageRegistry does not initialize ${schema}`);

console.log(
	`Release baseline gate passed: one system schema (${systemTables.size} tables) and one companion schema (${companionTables.size} tables); no migration ladder`,
);
