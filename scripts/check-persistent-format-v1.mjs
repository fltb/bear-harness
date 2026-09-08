import { readFileSync } from "node:fs";
import { parse } from "yaml";

function source(path) {
	return readFileSync(path, "utf8");
}

function requireText(path, expected) {
	const text = source(path);
	if (!text.includes(expected)) throw new Error(`${path} is missing v1 contract: ${expected}`);
}

function forbidText(path, forbidden) {
	const text = source(path);
	if (text.includes(forbidden))
		throw new Error(`${path} still contains pre-release persistence: ${forbidden}`);
}

const character = parse(source("config/characters/jizhou/character.yaml"));
if (character.format_version !== 1) throw new Error("character package format must be v1");
if (character.state_schema?.$id !== "urn:bear-harness:character:jizhou:state:v1") {
	throw new Error("character state schema identifier must be v1");
}
const canon = parse(source("config/characters/jizhou/canon/manifest.yaml"));
if (canon.format_version !== 1) throw new Error("canon package format must be v1");

const contracts = [
	["packages/host-runtime/src/storage/database.ts", "const DATABASE_SCHEMA_VERSION = 1"],
	["apps/desktop/src/main/recovery-state.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/storage/durable-file-transaction.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/security/audit-store.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/diagnostics/contracts.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/diagnostics/query.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/diagnostics/retention.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/memory/local-embedding-acquisition.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/executors/pi-adapter.ts", "schemaVersion: 1"],
	["packages/host-runtime/src/executors/codex-adapter.ts", "schemaVersion: 1"],
	["packages/tdai-core/src/utils/manifest.ts", "version: 1"],
	["packages/tdai-core/src/utils/checkpoint.ts", "schemaVersion: 1"],
	["packages/tdai-core/src/core/scene/scene-index.ts", "schemaVersion: 1"],
	["packages/tdai-core/src/core/conversation/l0-recorder.ts", "schemaVersion: 1"],
	["packages/tdai-core/src/core/record/l1-writer.ts", "schemaVersion: 1"],
	["packages/tdai-core/src/core/store/sqlite.ts", "PRAGMA user_version = 1"],
	["packages/tdai-core/src/core/store/tcvdb.ts", "schema_version: 1"],
	["scripts/release-evidence.mjs", "RELEASE_ATTESTATION_SCHEMA = 1"],
	["scripts/release-evidence.mjs", "PACKAGE_EVIDENCE_SCHEMA = 1"],
];
for (const [path, expected] of contracts) requireText(path, expected);

for (const forbidden of ["upgradeSystemSchema", "upgradeCompanionSchema", "ALTER TABLE"]) {
	forbidText("packages/host-runtime/src/storage/database.ts", forbidden);
}
for (const forbidden of [
	"session_states",
	"migrateFtsTablesIfNeeded",
	"ALTER TABLE l0_conversations",
])
	forbidText("packages/tdai-core/src/utils/checkpoint.ts", forbidden);
forbidText("packages/tdai-core/src/core/store/sqlite.ts", "migrateFtsTablesIfNeeded");
forbidText("packages/tdai-core/src/core/store/sqlite.ts", "ALTER TABLE l0_conversations");

console.log(
	`Persistent format v1 gate passed: ${contracts.length} contracts, no pre-release migration ladder`,
);
