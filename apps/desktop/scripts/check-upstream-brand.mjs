/**
 * Upstream release identity gate.
 *
 * Requires the repository's current product config to EXACTLY equal the
 * official brand snapshot (including brandLicense) with modified: false.
 * Any divergence fails with `Upstream brand mismatch: <field>`.
 *
 * Only the upstream release pipeline runs this script. Forks must remove or
 * replace this job in their own CI; the generic validator already enforces
 * independent fork identity.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OFFICIAL_BRAND } from "./official-brand.mjs";
import { validateProductConfig } from "./validate-product-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const explicitPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const configPath = explicitPath
	? resolve(explicitPath)
	: resolve(here, "../../../packages/product-config/src/index.ts");

function deepEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

const ALL_FIELDS = [
	"productName",
	"appId",
	"dataDirectoryName",
	"artifactName",
	"executableName",
	"defaultCharacterId",
	"brandLicense",
	"icon",
];

export function checkUpstreamBrand(config) {
	for (const field of ALL_FIELDS) {
		if (!deepEqual(config[field], OFFICIAL_BRAND[field])) return field;
	}
	if (config.brandLicense.modified !== false) return "brandLicense.modified";
	const genericErrors = validateProductConfig(config);
	return genericErrors[0] ? `${genericErrors[0].field}: ${genericErrors[0].reason}` : null;
}

async function main() {
	let config;
	try {
		config = (await import(configPath)).productConfig;
	} catch (error) {
		process.stderr.write(`Upstream brand mismatch: <module>: ${String(error?.message ?? error)}\n`);
		process.exit(1);
	}

	// Exact-equality snapshot comparison first so identity changes report the
	// upstream gate message rather than being masked by generic validation.
	const mismatch = checkUpstreamBrand(config);
	if (mismatch) {
		process.stderr.write(`Upstream brand mismatch: ${mismatch}\n`);
		process.exit(1);
	}

	process.stdout.write(`Upstream brand match: ${configPath}\n`);
}

// Run only when this file is the entry point.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
