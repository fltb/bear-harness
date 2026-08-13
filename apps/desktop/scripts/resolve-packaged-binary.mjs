/**
 * Locates the unpacked packaged binary for the current platform (from
 * product.config.ts) and runs the packaged smoke spec with
 * BEAR_PACKAGED_BINARY set. Fails loudly when the release is missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productConfig } from "../product.config.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(desktop, "release");

function findDir(prefixes) {
	if (!existsSync(releaseDir)) return null;
	const entries = readdirSync(releaseDir);
	for (const prefix of prefixes) {
		const match = entries.find((name) => name.startsWith(prefix));
		if (match) return join(releaseDir, match);
	}
	return null;
}

function resolveBinary() {
	if (process.platform === "darwin") {
		const appDir = findDir(["mac"]);
		if (!appDir) throw new Error(`macOS release missing under ${releaseDir}`);
		const appEntry = readdirSync(appDir).find((name) => name.endsWith(".app"));
		if (!appEntry) throw new Error(`no .app bundle under ${appDir}`);
		const binary = join(appDir, appEntry, "Contents", "MacOS", productConfig.executableName);
		if (!existsSync(binary)) throw new Error(`macOS binary missing at ${binary}`);
		return binary;
	}
	if (process.platform === "win32") {
		const unpacked = findDir(["win"]);
		if (!unpacked) throw new Error(`Windows release missing under ${releaseDir}`);
		const binary = join(unpacked, `${productConfig.executableName}.exe`);
		if (!existsSync(binary)) throw new Error(`Windows binary missing at ${binary}`);
		return binary;
	}
	const unpacked = findDir(["linux"]);
	if (!unpacked) throw new Error(`Linux release missing under ${releaseDir}`);
	const binary = join(unpacked, productConfig.executableName);
	if (!existsSync(binary)) throw new Error(`Linux binary missing at ${binary}`);
	return binary;
}

const binary = resolveBinary();
const stat = statSync(binary);
if (stat.size === 0) {
	throw new Error(`Packaged binary is empty: ${binary}`);
}

process.stderr.write(`packaged binary: ${binary}\n`);
const result = spawnSync(
	"npx",
	[
		"--no-install",
		"playwright",
		"test",
		"packaged.spec.ts",
		"--config=playwright.packaged.config.ts",
	],
	{
		cwd: desktop,
		env: { ...process.env, BEAR_PACKAGED_BINARY: binary },
		stdio: "inherit",
	},
);
process.exit(result.status ?? 1);
