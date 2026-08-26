/**
 * Package artifact gate: reads the dynamic release identity from the shared
 * product-config package (never hardcoding Bear Harness), expands the artifactName
 * macro template for the requested os/arch/extensions, and verifies each
 * artifact exists with non-zero size under apps/desktop/release. Prints a
 * JSON manifest (paths + sizes) that CI uses for uploads and arch proofs.
 *
 * Usage: node scripts/verify-package.mjs <os|mac|win|linux> <arch> <ext>...
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const desktopRoot = join(repoRoot, "apps/desktop");
const releaseDir = join(desktopRoot, "release");

const { productConfig } = await import(join(repoRoot, "packages/product-config/src/index.ts"));
const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;

const [osName, arch, ...extensions] = process.argv.slice(2);
if (!osName || !arch || extensions.length === 0) {
	process.stderr.write("usage: verify-package.mjs <mac|win|linux> <arch> <ext>...\n");
	process.exit(2);
}

function expand(ext) {
	const targetArch =
		osName === "linux" && arch === "x64" ? (ext === "deb" ? "amd64" : "x86_64") : arch;
	return productConfig.artifactName
		.replaceAll("${productName}", productConfig.productName)
		.replaceAll("${version}", String(version))
		.replaceAll("${os}", osName)
		.replaceAll("${arch}", targetArch)
		.replaceAll("${ext}", ext);
}

const artifacts = [];
for (const ext of extensions) {
	const name = expand(ext);
	const path = join(releaseDir, name);
	if (!existsSync(path)) {
		process.stderr.write(`Package artifact missing: ${path}\n`);
		process.exit(1);
	}
	const size = statSync(path).size;
	if (size === 0) {
		process.stderr.write(`Package artifact is empty: ${path}\n`);
		process.exit(1);
	}
	artifacts.push({ ext, name, path, size });
}

const manifest = {
	productName: productConfig.productName,
	executableName: productConfig.executableName,
	dataDirectoryName: productConfig.dataDirectoryName,
	appId: productConfig.appId,
	os: osName,
	arch,
	artifacts,
};

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
