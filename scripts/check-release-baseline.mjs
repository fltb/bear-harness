import { readFileSync } from "node:fs";

const database = readFileSync("packages/host-runtime/src/storage/database.ts", "utf8");
const baselines = readFileSync("packages/host-runtime/src/storage/split-baselines.ts", "utf8");
const registry = readFileSync("packages/host-runtime/src/storage/companion-storage.ts", "utf8");
const layoutMigration = readFileSync(
	"packages/host-runtime/src/storage/layout-migration.ts",
	"utf8",
);

if (/\bexport const MIGRATIONS\b|baseline-v1/.test(database))
	throw new Error("database.ts must expose only the split system and character baselines");

function exportedArray(name) {
	const match = database.match(
		new RegExp(`export const ${name}: Migration\\[\\] = \\[([\\s\\S]*?)\\n\\];`),
	);
	if (!match) throw new Error(`missing canonical migration array ${name}`);
	return match[1];
}

function canonicalMigration(name, baselineName) {
	const source = exportedArray(name);
	const ids = [...source.matchAll(/\bid:\s*(\d+)\s*,\s*description:/g)].map((match) =>
		Number(match[1]),
	);
	if (ids.length !== 1 || ids[0] !== 1)
		throw new Error(`${name} must contain exactly canonical migration id 1; found ${ids}`);
	if (!new RegExp(`\\bup:\\s*${baselineName}\\b`).test(source))
		throw new Error(`${name} must reference ${baselineName}`);
}

function exportedSql(name) {
	const match = baselines.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
	if (!match) throw new Error(`missing checked-in schema baseline ${name}`);
	return match[1];
}

function tableNames(sql) {
	return new Set(
		[...sql.matchAll(/\bCREATE TABLE(?: IF NOT EXISTS)?\s+["`]?([a-z0-9_]+)/gi)].map((match) =>
			match[1].toLowerCase(),
		),
	);
}

canonicalMigration("SYSTEM_MIGRATIONS", "SYSTEM_BASELINE_V1_SQL");
canonicalMigration("COMPANION_MIGRATIONS", "COMPANION_BASELINE_V1_SQL");

const systemSql = exportedSql("SYSTEM_BASELINE_V1_SQL");
const companionSql = exportedSql("COMPANION_BASELINE_V1_SQL");
for (const [name, sql] of [
	["system", systemSql],
	["companion", companionSql],
]) {
	if (/\bALTER TABLE\b|\bDROP TABLE\b|\bDROP COLUMN\b/i.test(sql))
		throw new Error(`${name} v1 baseline must describe final schema, not upgrade history`);
}

const systemTables = tableNames(systemSql);
const companionTables = tableNames(companionSql);
for (const required of ["installation_identity", "app_settings", "companion_packages"])
	if (!systemTables.has(required)) throw new Error(`system baseline is missing ${required}`);
for (const required of ["runtime_identity", "conversations", "companion_state_documents"])
	if (!companionTables.has(required)) throw new Error(`companion baseline is missing ${required}`);

const sharedTables = [...systemTables].filter(
	(table) => companionTables.has(table) && table !== "sync_changes",
);
if (sharedTables.length > 0)
	throw new Error(`system and companion baselines overlap: ${sharedTables.join(", ")}`);

for (const [sourceName, source] of [
	["CompanionStorageRegistry", registry],
	["legacy layout migration", layoutMigration],
]) {
	for (const migration of ["SYSTEM_MIGRATIONS", "COMPANION_MIGRATIONS"])
		if (!new RegExp(`\\.migrate\\(${migration}\\)`).test(source))
			throw new Error(`${sourceName} does not apply ${migration}`);
}

console.log(
	`Release baseline gate passed: system v1 (${systemTables.size} tables) + companion v1 (${companionTables.size} tables); no monolithic migration is exported`,
);
