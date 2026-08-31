import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");
const json = (path) => JSON.parse(read(path));
const semver =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const manifestPaths = ["package.json"];
for (const parent of ["apps", "packages"])
	for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true }))
		if (entry.isDirectory()) manifestPaths.push(`${parent}/${entry.name}/package.json`);
manifestPaths.sort();

const manifests = manifestPaths.map((path) => ({ path, manifest: json(path) }));
const rootVersion = manifests.find(({ path }) => path === "package.json")?.manifest.version;
const failures = [];
if (typeof rootVersion !== "string" || !semver.test(rootVersion))
	failures.push(`root package version is not valid SemVer: ${JSON.stringify(rootVersion)}`);
if (rootVersion === "0.0.0")
	failures.push("root package version is the unreleasable 0.0.0 placeholder");

for (const { path, manifest } of manifests) {
	if (manifest.version !== rootVersion)
		failures.push(`${path} version ${JSON.stringify(manifest.version)} != root ${rootVersion}`);
	if (manifest.version === "0.0.0" && path !== "package.json")
		failures.push(`${path} still uses the 0.0.0 placeholder`);
}

const lock = json("package-lock.json");
for (const { path, manifest } of manifests) {
	const key = path === "package.json" ? "" : dirname(path);
	const lockedVersion = lock.packages?.[key]?.version;
	if (lockedVersion !== manifest.version)
		failures.push(
			`package-lock.json packages[${JSON.stringify(key)}].version ${JSON.stringify(lockedVersion)} != ${path} ${manifest.version}`,
		);
}

const builder = read("apps/desktop/electron-builder.config.ts");
if (/^\s*(?:appVersion|buildVersion|version)\s*:/m.test(builder))
	failures.push(
		"electron-builder config overrides the package version; apps/desktop/package.json must remain the single packaging source",
	);
if (/extraMetadata\s*:\s*\{[\s\S]{0,1000}?\bversion\s*:/m.test(builder))
	failures.push(
		"electron-builder extraMetadata overrides version; apps/desktop/package.json must remain the single packaging source",
	);

const verifier = read("scripts/verify-package.mjs");
if (!/join\(desktopRoot,\s*"package\.json"\)/.test(verifier) || !/\)\.version\b/.test(verifier))
	failures.push(
		"package artifact verification no longer derives version from desktop/package.json",
	);
const desktopMain = read("apps/desktop/src/main/index.ts");
if (!/\bapp\.getVersion\(\)/.test(desktopMain))
	failures.push("desktop update checks no longer derive the running version from app.getVersion()");

const runtimeVersionSources = [
	"packages/host-runtime/src/executors/acp-client.ts",
	"packages/host-runtime/src/executors/pi-acp-worker.ts",
];
for (const path of runtimeVersionSources) {
	const source = read(path);
	if (/\bversion\s*:\s*["']0\.0\.0["']/.test(source))
		failures.push(`${path} exposes the 0.0.0 runtime identity placeholder`);
}

if (failures.length > 0) {
	process.stderr.write(`Release version contract failed:\n- ${failures.join("\n- ")}\n`);
	process.exit(1);
}

console.log(
	`Release version contract passed: ${rootVersion} across ${manifests.length} manifests, lockfile, Electron packaging, artifact verification and runtime identity`,
);
