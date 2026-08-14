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
const configPath = explicitPath ? resolve(explicitPath) : resolve(here, "../product.config.ts");

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
	for (const field of ALL_FIELDS) {
		if (!deepEqual(config[field], OFFICIAL_BRAND[field])) {
			process.stderr.write(`Upstream brand mismatch: ${field}\n`);
			process.exit(1);
		}
	}
	if (config.brandLicense.modified !== false) {
		process.stderr.write("Upstream brand mismatch: brandLicense.modified\n");
		process.exit(1);
	}

	// Belt and suspenders: the official snapshot must also satisfy the generic rules.
	const genericErrors = validateProductConfig(config);
	if (genericErrors.length > 0) {
		for (const { field, reason } of genericErrors) {
			process.stderr.write(`Invalid product config: ${field}: ${reason}\n`);
		}
		process.exit(1);
	}

	process.stdout.write(`Upstream brand match: ${configPath}\n`);
}

// Run only when this file is the entry point.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
