import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifests } from "./upstream-versions.mjs";

if (!process.env.npm_execpath) throw new Error("Run through npm run upstream:lock");
const temporary = await mkdtemp(join(tmpdir(), "bear-upstream-resolve-"));
try {
	// A fresh graph avoids retaining old transitives or workspace-local installs.
	// Only metadata is copied; no candidate lifecycle scripts execute here.
	for (const { path, data } of await manifests()) {
		await mkdir(dirname(join(temporary, path)), { recursive: true });
		await writeFile(join(temporary, path), `${JSON.stringify(data, null, "\t")}\n`);
	}
	await copyFile(".npmrc", join(temporary, ".npmrc"));
	const result = spawnSync(
		process.execPath,
		[process.env.npm_execpath, "install", "--package-lock-only", "--ignore-scripts"],
		{ cwd: temporary, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`Candidate dependency resolution failed (${result.status})`);
	await copyFile(join(temporary, "package-lock.json"), "package-lock.json");
} finally {
	await rm(temporary, { recursive: true, force: true });
}
