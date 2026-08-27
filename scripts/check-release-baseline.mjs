import { readFileSync } from "node:fs";

const database = readFileSync("packages/host-runtime/src/storage/database.ts", "utf8");
const baseline = readFileSync("packages/host-runtime/src/storage/baseline-v1.ts", "utf8");

const migrationIds = [...database.matchAll(/\bid:\s*(\d+)\s*,\s*description:/g)].map((match) =>
	Number(match[1]),
);
if (migrationIds.length !== 1 || migrationIds[0] !== 1) {
	throw new Error(
		`Bear 1.0 must ship one canonical schema baseline; found migrations: ${migrationIds}`,
	);
}
if (!database.includes("up: BASELINE_V1_SQL")) {
	throw new Error("MIGRATIONS must reference the checked-in Bear 1.0 baseline");
}
if (/\bALTER TABLE\b|\bDROP TABLE\b|\bDROP COLUMN\b/i.test(baseline)) {
	throw new Error("Bear 1.0 baseline must describe the final schema, not contain upgrade history");
}
console.log("Release baseline gate passed: one clean v1 schema");
