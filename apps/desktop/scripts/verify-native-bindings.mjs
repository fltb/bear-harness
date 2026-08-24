#!/usr/bin/env node
/**
 * Proves a packaged Electron application contains exactly the target
 * node-llama-cpp binding outside ASAR, where Node can load native binaries.
 *
 * Usage: node scripts/verify-native-bindings.mjs <mac|win|linux> <arm64|x64>
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const release = resolve(desktop, "release");
const [target, arch] = process.argv.slice(2);
const bindingByTarget = new Map([
	["mac:arm64", "@node-llama-cpp/mac-arm64-metal"],
	["mac:x64", "@node-llama-cpp/mac-x64"],
	["win:x64", "@node-llama-cpp/win-x64"],
	["linux:x64", "@node-llama-cpp/linux-x64"],
]);
const expected = bindingByTarget.get(`${target}:${arch}`);
if (!expected) throw new Error(`Unsupported native llama target: ${target}/${arch}`);

function unpackedRoot() {
	if (target === "mac") {
		const macDir = readdirSync(release).find((entry) => entry.startsWith("mac"));
		if (!macDir) throw new Error("macOS unpacked app directory is missing");
		const app = readdirSync(join(release, macDir)).find((entry) => entry.endsWith(".app"));
		if (!app) throw new Error("macOS app bundle is missing");
		return join(release, macDir, app, "Contents/Resources/app.asar.unpacked");
	}
	const unpacked = target === "win" ? "win-unpacked" : "linux-unpacked";
	return join(release, unpacked, "resources/app.asar.unpacked");
}

const modules = join(unpackedRoot(), "dist/main/node_modules");
const expectedPath = join(modules, ...expected.split("/"));
if (!existsSync(join(expectedPath, "package.json"))) {
	throw new Error(`Packaged target binding is missing: ${expectedPath}`);
}
if (statSync(expectedPath).size === 0)
	throw new Error(`Packaged target binding is empty: ${expectedPath}`);

const bindingRoot = join(modules, "@node-llama-cpp");
const bindings = existsSync(bindingRoot) ? readdirSync(bindingRoot).sort() : [];
if (bindings.length !== 1 || bindings[0] !== expected.split("/")[1]) {
	throw new Error(`Expected only ${expected}; packaged bindings: ${bindings.join(", ") || "none"}`);
}
if (!existsSync(join(modules, "node-llama-cpp/package.json"))) {
	throw new Error("Packaged node-llama-cpp loader is missing");
}

process.stdout.write(`native binding verified: ${target}/${arch} -> ${expected}\n`);
