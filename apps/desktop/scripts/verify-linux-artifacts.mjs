#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productConfig } from "@bear-harness/product-config";

const ELF_HEADER_SIZE = 64;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_MACHINE_X86_64 = 0x3e;

export function assertDebArchitecture(value) {
	const architecture = value.trim();
	if (architecture !== "amd64") {
		throw new Error(`DEB architecture expected amd64, got ${architecture || "empty"}`);
	}
}

export function assertElfX64(header, label) {
	if (
		header.length < 20 ||
		header[0] !== 0x7f ||
		header[1] !== 0x45 ||
		header[2] !== 0x4c ||
		header[3] !== 0x46
	) {
		throw new Error(`${label} is not an ELF executable`);
	}
	if (header[4] !== ELF_CLASS_64 || header[5] !== ELF_DATA_LITTLE_ENDIAN) {
		throw new Error(`${label} expected a 64-bit little-endian ELF executable`);
	}
	const machine = header.readUInt16LE(18);
	if (machine !== ELF_MACHINE_X86_64) {
		throw new Error(`${label} expected x86-64 ELF machine 0x3e, got 0x${machine.toString(16)}`);
	}
}

function readElfHeader(path) {
	const descriptor = openSync(path, "r");
	try {
		const header = Buffer.alloc(ELF_HEADER_SIZE);
		const bytesRead = readSync(descriptor, header, 0, header.length, 0);
		return header.subarray(0, bytesRead);
	} finally {
		closeSync(descriptor);
	}
}

export function verifyLinuxArtifacts(releaseDirectory) {
	const entries = readdirSync(releaseDirectory).sort();
	const debName = entries.find((entry) => entry.endsWith(".deb"));
	const appImageName = entries.find((entry) => entry.endsWith(".AppImage"));
	if (!debName) throw new Error("Linux DEB artifact is missing");
	if (!appImageName) throw new Error("Linux AppImage artifact is missing");

	const debPath = join(releaseDirectory, debName);
	const appImagePath = join(releaseDirectory, appImageName);
	const unpackedExecutable = join(releaseDirectory, "linux-unpacked", productConfig.executableName);
	const debArchitecture = execFileSync("dpkg-deb", ["--field", debPath, "Architecture"], {
		encoding: "utf8",
	});
	assertDebArchitecture(debArchitecture);
	assertElfX64(readElfHeader(appImagePath), "AppImage runtime");
	assertElfX64(readElfHeader(unpackedExecutable), "unpacked application");
	process.stdout.write("Linux artifacts verified: amd64 DEB and x86-64 ELF executables\n");
}

const here = dirname(fileURLToPath(import.meta.url));
const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) verifyLinuxArtifacts(resolve(here, "../release"));
