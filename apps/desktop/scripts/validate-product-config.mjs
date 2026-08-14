/**
 * Generic product config validator.
 *
 * Usage:
 *   node scripts/validate-product-config.mjs [configPath] [--no-write]
 *
 * - configPath defaults to ../product.config.ts (relative to this script).
 * - Dynamically imports the config (Node 24 executes erasable TypeScript).
 * - On any failure prints `Invalid product config: <field>: <reason>` per
 *   error and exits non-zero. There is no silent fallback.
 * - Unless --no-write is given, deterministically writes
 *   dist/brand/BRAND-ATTRIBUTION.txt for the release artifacts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OFFICIAL_BRAND } from "./official-brand.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const explicitPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
// Explicit paths resolve against the caller's cwd; the default is the
// workspace product.config.ts relative to this script's location.
const configPath = explicitPath ? resolve(explicitPath) : resolve(here, "../product.config.ts");
const noWrite = process.argv.includes("--no-write");

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/;
const IDENTITY_FIELDS = [
	"productName",
	"appId",
	"dataDirectoryName",
	"artifactName",
	"executableName",
	"defaultCharacterId",
	"icon",
];

function deepEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** @returns {Array<{field: string, reason: string}>} */
export function validateProductConfig(config) {
	const errors = [];
	const fail = (field, reason) => errors.push({ field, reason });

	const requiredStrings = [
		"productName",
		"appId",
		"dataDirectoryName",
		"artifactName",
		"executableName",
	];
	for (const field of requiredStrings) {
		const value = config[field];
		if (typeof value !== "string" || value.trim() === "") {
			fail(field, "must be a non-empty string");
		}
	}

	if (typeof config.appId === "string" && !APP_ID_RE.test(config.appId)) {
		fail(
			"appId",
			`must be reverse-domain (^[a-zA-Z][a-zA-Z0-9]*(\\.[a-zA-Z0-9-]+)+$), got ${JSON.stringify(config.appId)}`,
		);
	}
	for (const field of ["dataDirectoryName", "executableName"]) {
		const value = config[field];
		if (typeof value === "string" && !KEBAB_RE.test(value)) {
			fail(field, `must be ASCII kebab-case, got ${JSON.stringify(value)}`);
		}
	}

	if (typeof config.artifactName === "string") {
		for (const macro of ["${version}", "${os}", "${arch}", "${ext}"]) {
			if (!config.artifactName.includes(macro)) {
				fail("artifactName", `must contain ${macro}`);
			}
		}
	}

	const dci = config.defaultCharacterId;
	if (typeof dci !== "string" || dci.trim() === "") {
		fail("defaultCharacterId", "must be a non-empty string");
	} else if (!KEBAB_RE.test(dci)) {
		fail("defaultCharacterId", "must be ASCII kebab-case, got " + JSON.stringify(dci));
	}

	const bl = config.brandLicense;
	if (!bl || typeof bl !== "object" || Array.isArray(bl)) {
		fail("brandLicense", "must be an object");
	} else {
		if (bl.spdx !== "CC-BY-SA-4.0") {
			fail("brandLicense.spdx", `must be exactly "CC-BY-SA-4.0", got ${JSON.stringify(bl.spdx)}`);
		}
		for (const field of ["workTitle", "creator", "attribution", "sourceUrl"]) {
			const value = bl[field];
			if (typeof value !== "string" || value.trim() === "") {
				fail(`brandLicense.${field}`, "must be a non-empty string");
			}
		}
		if (typeof bl.modified !== "boolean") {
			fail("brandLicense.modified", "must be a boolean");
		}
		if (typeof bl.modificationNotice !== "string") {
			fail("brandLicense.modificationNotice", "must be a string");
		}
	}

	if (config.icon !== null && config.icon !== undefined) {
		if (typeof config.icon !== "string" || config.icon.trim() === "") {
			fail("icon", "must be null or a non-empty repo-relative path");
		} else {
			// icon paths are repo-root-relative; scripts/ sits at apps/desktop/scripts,
			// so the repository root is two levels up.
			const repoRoot = resolve(here, "../..");
			const iconPath = resolve(repoRoot, config.icon);
			if (!existsSync(iconPath)) {
				fail("icon", `file not found at ${config.icon}`);
			} else if (config.icon.toLowerCase().endsWith(".png")) {
				let bytes;
				try {
					bytes = readFileSync(iconPath);
				} catch {
					fail("icon", `unreadable PNG at ${config.icon}`);
					bytes = null;
				}
				if (bytes && bytes.length < 24) {
					fail("icon", "PNG is truncated; must be 1024x1024");
				} else if (bytes && (bytes.readUInt32BE(16) !== 1024 || bytes.readUInt32BE(20) !== 1024)) {
					fail("icon", "PNG must be exactly 1024x1024 pixels");
				}
			} else if (config.icon.toLowerCase().endsWith(".svg")) {
				try {
					readFileSync(iconPath);
				} catch {
					fail("icon", `unreadable SVG at ${config.icon}`);
				}
			} else {
				fail("icon", "must reference a .png (1024x1024) or .svg file");
			}
		}
	}

	const identityChanged = IDENTITY_FIELDS.some(
		(field) => !deepEqual(config[field], OFFICIAL_BRAND[field]),
	);
	if (identityChanged) {
		if (config.appId === OFFICIAL_BRAND.appId) {
			fail("appId", "must differ from the official value when any identity field changes");
		}
		if (config.dataDirectoryName === OFFICIAL_BRAND.dataDirectoryName) {
			fail(
				"dataDirectoryName",
				"must differ from the official value when any identity field changes",
			);
		}
		if (bl && typeof bl === "object") {
			if (bl.modified !== true) {
				fail("brandLicense.modified", "must be true when any identity field changes");
			}
			if (typeof bl.modificationNotice !== "string" || bl.modificationNotice.trim() === "") {
				fail("brandLicense.modificationNotice", "must be non-empty when modified is true");
			}
		}
	} else if (bl && typeof bl === "object" && bl.modified === true) {
		fail(
			"brandLicense.modified",
			"must be false when all identity fields match the official values",
		);
	}

	return errors;
}

function writeAttribution(config) {
	const lines = [
		config.brandLicense.workTitle,
		`作品 (Work): ${config.brandLicense.workTitle}`,
		`作者 (Creator): ${config.brandLicense.creator}`,
		`署名 (Attribution): ${config.brandLicense.attribution}`,
		`上游仓库 (Upstream): ${config.brandLicense.sourceUrl}`,
		"许可 (License): CC-BY-SA-4.0 — https://creativecommons.org/licenses/by-sa/4.0/",
		config.brandLicense.modified
			? `修改声明 (Modified): ${config.brandLicense.modificationNotice}`
			: "修改声明 (Modified): 未修改 (none)",
		"",
	];
	const distBrand = resolve(here, "../dist/brand");
	mkdirSync(distBrand, { recursive: true });
	writeFileSync(resolve(distBrand, "BRAND-ATTRIBUTION.txt"), lines.join("\n"), "utf8");
}

async function main() {
	let config;
	try {
		config = (await import(configPath)).productConfig;
	} catch (error) {
		process.stderr.write(
			`Invalid product config: <module>: ${String(error?.message ?? error)} (${configPath})\n`,
		);
		process.exit(1);
	}

	const errors = validateProductConfig(config);
	if (errors.length > 0) {
		for (const { field, reason } of errors) {
			process.stderr.write(`Invalid product config: ${field}: ${reason}\n`);
		}
		process.exit(1);
	}

	if (!noWrite) {
		writeAttribution(config);
	}
	process.stdout.write(`Valid product config: ${configPath}\n`);
}

// Run only when this file is the entry point, not when imported by the
// upstream brand gate (which reuses this module's validation logic).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
