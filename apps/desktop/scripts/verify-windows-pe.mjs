#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productConfig } from "@bear-harness/product-config";

const X64_MACHINE = 0x8664;

export function assertWindowsX64Executable(path) {
	const bytes = readFileSync(path);
	if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
		throw new Error(`invalid PE executable: ${path}`);
	}
	const peOffset = bytes.readUInt32LE(60);
	if (
		peOffset < 64 ||
		peOffset + 6 > bytes.length ||
		bytes[peOffset] !== 0x50 ||
		bytes[peOffset + 1] !== 0x45 ||
		bytes[peOffset + 2] !== 0 ||
		bytes[peOffset + 3] !== 0
	) {
		throw new Error(`invalid PE executable: ${path}`);
	}
	const machine = bytes.readUInt16LE(peOffset + 4);
	if (machine !== X64_MACHINE) {
		throw new Error(`expected x64 (0x8664), got 0x${machine.toString(16)}`);
	}
}

function isMainModule() {
	return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
	const here = dirname(fileURLToPath(import.meta.url));
	const executable = join(
		here,
		"..",
		"release",
		"win-unpacked",
		`${productConfig.executableName}.exe`,
	);
	assertWindowsX64Executable(executable);
	process.stdout.write(`Windows x64 PE verified: ${executable}\n`);
}
