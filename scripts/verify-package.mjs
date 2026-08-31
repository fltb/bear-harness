/**
 * Package artifact evidence gate.
 *
 * Verifies the complete, reviewed artifact set for one platform target, hashes
 * every package, generates an npm-native CycloneDX SBOM from package-lock.json,
 * and writes independently downloadable evidence beneath release-attestations/.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	assertContainedFile,
	digestRecord,
	packageTarget,
	requireExpectedExtensions,
	sha256File,
	validateCycloneDx,
	validatePackageEvidence,
	writeJsonAtomic,
} from "./release-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "..");

export async function verifyPackage(options) {
	const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
	const desktopRoot = join(repoRoot, "apps/desktop");
	const releaseDir = join(desktopRoot, "release");
	const evidenceRoot = join(repoRoot, "release-attestations");
	const target = packageTarget(options.osName, options.arch);
	const extensions = requireExpectedExtensions(target, options.extensions);
	const productConfig =
		options.productConfig ??
		(await import(pathToFileURL(join(repoRoot, "packages/product-config/src/index.ts")).href))
			.productConfig;
	const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const desktopVersion = JSON.parse(
		readFileSync(join(desktopRoot, "package.json"), "utf8"),
	).version;
	if (!rootPackage.name || !rootPackage.version || desktopVersion !== rootPackage.version) {
		throw new Error("root and desktop package versions must exist and match before packaging");
	}

	const artifacts = [];
	for (const extension of extensions) {
		const name = expandArtifactName(
			productConfig.artifactName,
			productConfig.productName,
			rootPackage.version,
			options.osName,
			options.arch,
			extension,
		);
		const file = assertContainedFile(releaseDir, join(releaseDir, name), `.${extension} package`);
		if (file.size === 0) throw new Error(`package artifact is empty: ${file.path}`);
		artifacts.push({
			ext: extension,
			name,
			path: portablePath(relative(repoRoot, file.path)),
			size: file.size,
			sha256: await sha256File(file.path),
		});
	}

	const sbomDocument = JSON.parse(
		options.generateSbom ? await options.generateSbom() : generateNpmSbom(repoRoot),
	);
	const sbomSummary = validateCycloneDx(sbomDocument, {
		packageName: rootPackage.name,
		version: rootPackage.version,
	});
	const sbomName = `sbom-${target}.cdx.json`;
	const sbomWrite = writeJsonAtomic(join(evidenceRoot, sbomName), sbomDocument);
	const packageLockPath = assertContainedFile(
		repoRoot,
		join(repoRoot, "package-lock.json"),
		"package lock",
	);
	const evidence = {
		schema: 1,
		target,
		productName: productConfig.productName,
		executableName: productConfig.executableName,
		dataDirectoryName: productConfig.dataDirectoryName,
		appId: productConfig.appId,
		version: rootPackage.version,
		generatedAt: new Date().toISOString(),
		artifacts,
		packageLock: digestRecord(
			"package-lock.json",
			packageLockPath.size,
			await sha256File(packageLockPath.path),
		),
		sbom: {
			...digestRecord(sbomName, sbomWrite.bytes, sbomWrite.sha256),
			format: sbomSummary.format,
			specVersion: sbomSummary.specVersion,
			serialNumber: sbomSummary.serialNumber,
			componentCount: sbomSummary.componentCount,
			rootComponent: sbomSummary.rootComponent,
		},
	};
	validatePackageEvidence(evidence, { target, version: rootPackage.version });
	const evidenceName = `package-evidence-${target}.json`;
	const evidenceWrite = writeJsonAtomic(join(evidenceRoot, evidenceName), evidence);
	return {
		evidence,
		evidenceFile: evidenceName,
		evidenceSha256: evidenceWrite.sha256,
		sbomFile: sbomName,
	};
}

function expandArtifactName(template, productName, version, osName, arch, extension) {
	const targetArch =
		osName === "linux" && arch === "x64" ? (extension === "deb" ? "amd64" : "x86_64") : arch;
	return template
		.replaceAll(templateVariable("productName"), productName)
		.replaceAll(templateVariable("version"), String(version))
		.replaceAll(templateVariable("os"), osName)
		.replaceAll(templateVariable("arch"), targetArch)
		.replaceAll(templateVariable("ext"), extension);
}

function templateVariable(name) {
	return ["$", "{", name, "}"].join("");
}

function generateNpmSbom(repoRoot) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	return execFileSync(
		npm,
		[
			"sbom",
			"--package-lock-only",
			"--omit=dev",
			"--sbom-format=cyclonedx",
			"--sbom-type=application",
		],
		{ cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
}

function portablePath(path) {
	return path.split("\\").join("/");
}

function isMainModule() {
	return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
	const [osName, arch, ...extensions] = process.argv.slice(2);
	if (!osName || !arch || extensions.length === 0) {
		process.stderr.write("usage: verify-package.mjs <mac|win|linux> <arch> <ext>...\n");
		process.exitCode = 2;
	} else {
		try {
			const result = await verifyPackage({ osName, arch, extensions });
			process.stdout.write(
				`${JSON.stringify({
					target: result.evidence.target,
					artifacts: result.evidence.artifacts,
					packageLock: result.evidence.packageLock,
					sbom: result.evidence.sbom,
					evidence: {
						path: result.evidenceFile,
						sha256: result.evidenceSha256,
					},
				})}\n`,
			);
		} catch (error) {
			process.stderr.write(
				`Package evidence failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		}
	}
}
