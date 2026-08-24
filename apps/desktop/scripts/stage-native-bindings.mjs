#!/usr/bin/env node
/**
 * Stages the exact production closure required by node-llama-cpp beneath the
 * compiled main-process entry. Electron resolves the dynamic import from this
 * directory; electron-builder then unpacks these native files from ASAR.
 *
 * Usage: node scripts/stage-native-bindings.mjs <darwin|win32|linux> <arm64|x64>
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repoRoot = resolve(desktop, "..", "..");
const [platform, arch] = process.argv.slice(2);

const bindingByTarget = new Map([
	["darwin:arm64", "@node-llama-cpp/mac-arm64-metal"],
	["darwin:x64", "@node-llama-cpp/mac-x64"],
	["win32:x64", "@node-llama-cpp/win-x64"],
	["linux:x64", "@node-llama-cpp/linux-x64"],
]);
const targetBinding = bindingByTarget.get(`${platform}:${arch}`);
if (!targetBinding) {
	throw new Error(`Unsupported native llama target: ${platform}/${arch}`);
}

const sourceModules = resolve(repoRoot, "node_modules");
const stagedModules = resolve(desktop, "dist/main/node_modules");
if (!existsSync(resolve(sourceModules, "node-llama-cpp/package.json"))) {
	throw new Error("node-llama-cpp is not installed at the workspace root; run npm ci first");
}

function packagePath(moduleRoot, name) {
	return resolve(moduleRoot, ...name.split("/"));
}

function packageManifest(path) {
	return JSON.parse(readFileSync(resolve(path, "package.json"), "utf8"));
}

function isCompatible(manifest) {
	for (const key of ["os", "cpu"]) {
		const value = key === "os" ? platform : arch;
		const declared = manifest[key];
		if (!declared) continue;
		const allowed = declared.filter((entry) => !entry.startsWith("!"));
		const denied = declared.some((entry) => entry === `!${value}`);
		if (denied || (allowed.length > 0 && !allowed.includes(value))) return false;
	}
	return true;
}

const copied = new Set();
function copyDependency(name, optional = false) {
	if (name.startsWith("@node-llama-cpp/") && name !== targetBinding) return;
	if (copied.has(name)) return;

	const source = packagePath(sourceModules, name);
	if (!existsSync(resolve(source, "package.json"))) {
		if (optional) return;
		throw new Error(`Required node-llama-cpp dependency is missing: ${name}`);
	}
	const manifest = packageManifest(source);
	if (!isCompatible(manifest)) return;

	copied.add(name);
	const destination = packagePath(stagedModules, name);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: true, dereference: true });

	for (const dependency of Object.keys(manifest.dependencies ?? {})) copyDependency(dependency);
	for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
		copyDependency(dependency, true);
}

rmSync(stagedModules, { recursive: true, force: true });
mkdirSync(stagedModules, { recursive: true });
copyDependency("node-llama-cpp");

if (!existsSync(resolve(packagePath(stagedModules, targetBinding), "package.json"))) {
	throw new Error(`Target binding was not staged: ${targetBinding}`);
}
process.stdout.write(
	`staged node-llama-cpp for ${platform}/${arch}: ${targetBinding} (${copied.size} packages)\n`,
);
