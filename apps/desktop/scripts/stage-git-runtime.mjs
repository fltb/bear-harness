import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(desktopRoot, "resources", "runtime", "git-win-x64");
const source = process.env.BEAR_PORTABLE_GIT_DIR;
if (!source)
	throw new Error("BEAR_PORTABLE_GIT_DIR must point to an extracted pinned PortableGit x64 tree");

const manifest = JSON.parse(
	readFileSync(
		resolve(desktopRoot, "ThirdPartyNotices", "Git-for-Windows", "component-manifest.json"),
		"utf8",
	),
);
for (const relativePath of manifest.requiredFiles) {
	if (!existsSync(resolve(source, relativePath)))
		throw new Error(`PortableGit staging input is missing ${relativePath}`);
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
for (const relativePath of manifest.requiredFiles) {
	if (!existsSync(resolve(destination, relativePath)))
		throw new Error(`PortableGit staging failed for ${relativePath}`);
}
console.log(`Staged ${manifest.name} ${manifest.version} into ${destination}`);
