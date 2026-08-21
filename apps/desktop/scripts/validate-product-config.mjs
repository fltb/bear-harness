/**
 * Product config validator (desktop packaging entry).
 *
 * Usage:
 *   node scripts/validate-product-config.mjs [configPath] [--no-write]
 *
 * - configPath defaults to the shared product-config package source.
 * - Shape, identity and update-policy validation is delegated to the pure
 *   runtime validator exported by @bear-harness/product-config, so every
 *   consumer shares one shape contract. The official brand snapshot is the
 *   fork-identity reference.
 * - This script adds the repository/filesystem checks that the pure
 *   validator deliberately does not perform: the icon must resolve inside
 *   the repository and exist (PNG 1024x1024 or readable SVG), and the
 *   default character package must exist under config/characters.
 * - On any failure prints `Invalid product config: <field>: <reason>` per
 *   error and exits non-zero. There is no silent fallback.
 * - Unless --no-write is given, deterministically writes
 *   dist/brand/BRAND-ATTRIBUTION.txt for the release artifacts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	OFFICIAL_BRAND,
	validateProductConfig as validateShared,
} from "../../../packages/product-config/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const explicitPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
// Explicit paths resolve against the caller's cwd; the default is the
// shared product-config package source.
const configPath = explicitPath
	? resolve(explicitPath)
	: resolve(here, "../../../packages/product-config/src/index.ts");
const noWrite = process.argv.includes("--no-write");

/**
 * Repository/filesystem checks layered on the pure shared validation.
 *
 * @returns {Array<{field: string, reason: string}>}
 */
function filesystemErrors(config) {
	const errors = [];
	const fail = (field, reason) => errors.push({ field, reason });

	if (config.icon !== null && config.icon !== undefined) {
		const iconPath = resolve(repoRoot, config.icon);
		const relativeFromRoot = relative(repoRoot, iconPath);
		if (
			isAbsolute(config.icon) ||
			relativeFromRoot.startsWith("..") ||
			isAbsolute(relativeFromRoot)
		) {
			fail("icon", `must be a repository-relative path, got ${JSON.stringify(config.icon)}`);
		} else if (!existsSync(iconPath)) {
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

	if (typeof config.defaultCharacterId === "string" && config.defaultCharacterId !== "") {
		const characterManifest = resolve(
			repoRoot,
			"config/characters",
			config.defaultCharacterId,
			"character.yaml",
		);
		if (!existsSync(characterManifest)) {
			fail(
				"defaultCharacterId",
				`character package missing: config/characters/${config.defaultCharacterId}/character.yaml`,
			);
		}
	}

	return errors;
}

/** @returns {Array<{field: string, reason: string}>} */
export function validateProductConfig(config) {
	return [...validateShared(config, OFFICIAL_BRAND), ...filesystemErrors(config)];
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
