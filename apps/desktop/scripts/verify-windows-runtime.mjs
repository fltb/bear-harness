#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED = {
	tag: "v2.55.0.windows.5",
	asset: "PortableGit-2.55.0.5-64-bit.7z.exe",
	url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/PortableGit-2.55.0.5-64-bit.7z.exe",
	sha256: "5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290",
};
const resourcesArgument = process.argv[2];
if (!resourcesArgument) throw new Error("usage: verify-windows-runtime.mjs <resources-dir>");
const resources = resolve(resourcesArgument);
const manifestPath = join(resources, "git-runtime-manifest.json");
const gitRoot = join(resources, "git");
if (!existsSync(manifestPath) || !existsSync(gitRoot))
	throw new Error("staged Git runtime is missing");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assertManifest(manifest);

const actualRuntimeFiles = inventory(gitRoot);
assertInventory("Git runtime", manifest.runtimeFiles, actualRuntimeFiles);
for (const file of manifest.noticeFiles) verifyHashedResource(file);
for (const path of Object.values(manifest.notices)) {
	if (Array.isArray(path)) continue;
	if (typeof path !== "string" || !existsSync(resourcePath(path)))
		throw new Error(`missing staged notice: ${String(path)}`);
}
for (const path of manifest.notices.componentPaths) {
	if (!existsSync(resourcePath(path)))
		throw new Error(`missing extracted component notice: ${path}`);
}

const componentIndex = JSON.parse(
	readFileSync(resourcePath(manifest.notices.componentIndex), "utf8"),
);
if (componentIndex.schemaVersion !== 1 || !Array.isArray(componentIndex.files)) {
	throw new Error("invalid component notice index");
}
const indexedPaths = componentIndex.files.map((file) => file.path);
if (JSON.stringify(indexedPaths) !== JSON.stringify(manifest.notices.componentPaths)) {
	throw new Error("component notice index does not match runtime manifest");
}
for (const file of componentIndex.files) verifyHashedResource(file);

const productNotice = readFileSync(resourcePath(manifest.notices.product), "utf8");
for (const required of [
	EXPECTED.tag,
	EXPECTED.asset,
	EXPECTED.sha256,
	manifest.release.releasePage,
	...manifest.release.sourceUrls,
]) {
	if (!productNotice.includes(required))
		throw new Error(`product third-party notice omits ${required}`);
}
const gpl = readFileSync(resourcePath(manifest.notices.gplV2), "utf8");
if (!gpl.includes("GNU GENERAL PUBLIC LICENSE") || !gpl.includes("Version 2, June 1991")) {
	throw new Error("staged GPL-2.0 text is not the complete GPLv2 license");
}
if (statSync(resourcePath(manifest.notices.packageVersions)).size === 0) {
	throw new Error("staged package-version manifest is empty");
}

const bash = resourcePath(`git/${manifest.executables.bash}`);
const git = resourcePath(`git/${manifest.executables.git}`);
for (const binary of [bash, git]) assertPeX64(binary);
const bashVersion = run({ binary: bash, args: ["--version"] }, "GNU bash version check");
if (!/^GNU bash, version /m.test(bashVersion))
	throw new Error(`unexpected bash version output: ${bashVersion.trim()}`);
const gitVersion = run({ binary: git, args: ["--version"] }, "Git version check");
if (!/^git version 2\.55\.0\.windows\.5\s*$/m.test(gitVersion)) {
	throw new Error(`unexpected Git version output: ${gitVersion.trim()}`);
}

runPackagedPiBashSmoke({ resources, bash, gitRoot });
process.stdout.write(
	`${JSON.stringify({ verified: true, releaseTag: manifest.release.tag, architecture: "x64" })}\n`,
);

function assertManifest(value) {
	if (value.schemaVersion !== 1) throw new Error("unexpected Git runtime manifest schema");
	for (const [key, expected] of Object.entries(EXPECTED)) {
		if (value.release?.[key] !== expected)
			throw new Error(`unexpected PortableGit manifest ${key}`);
	}
	if (value.release.architecture !== "x64") throw new Error("PortableGit manifest is not x64");
	if (value.release.correspondingSource !== value.release.releasePage)
		throw new Error("missing corresponding-source distribution pointer");
	if (!Array.isArray(value.release.sourceUrls) || value.release.sourceUrls.length < 4)
		throw new Error("missing PortableGit source locations");
	if (value.executables?.bash !== "usr/bin/bash.exe" || value.executables?.git !== "cmd/git.exe") {
		throw new Error("unexpected PortableGit executable paths");
	}
	if (!Array.isArray(value.runtimeFiles) || value.runtimeFiles.length === 0)
		throw new Error("runtime inventory is empty");
	if (!Array.isArray(value.noticeFiles) || value.noticeFiles.length < 4)
		throw new Error("notice inventory is incomplete");
	if (!Array.isArray(value.notices?.componentPaths) || value.notices.componentPaths.length === 0) {
		throw new Error("component notice paths are missing");
	}
}

function runPackagedPiBashSmoke({ resources, bash, gitRoot }) {
	if (process.platform !== "win32")
		throw new Error("Windows runtime verification must run on Windows");
	const unpackedRoot = resolve(resources, "..");
	const appExecutable = readdirSync(unpackedRoot)
		.filter(
			(name) => name.toLowerCase().endsWith(".exe") && !name.toLowerCase().startsWith("uninstall"),
		)
		.map((name) => join(unpackedRoot, name))
		.find((path) => readPeMachine(path) === 0x8664);
	if (!appExecutable) throw new Error("packaged x64 Electron executable is missing");
	const appAsar = join(resources, "app.asar");
	if (!existsSync(appAsar)) throw new Error("packaged app.asar is missing");

	const temporaryRoot = mkdtempSync(join(tmpdir(), "bear-windows-runtime-"));
	const workspace = join(temporaryRoot, "workspace");
	const piDir = join(temporaryRoot, "pi-runtime");
	const helper = join(temporaryRoot, "pi-bash-smoke.mjs");
	const piEntry = pathToFileURL(
		join(appAsar, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
	).href;
	const expectedPathEntries = [
		join(gitRoot, "cmd"),
		join(gitRoot, "mingw64/bin"),
		join(gitRoot, "usr/bin"),
	];
	const helperSource = `
import { mkdirSync, readFileSync } from "node:fs";
import { createBashTool } from ${JSON.stringify(piEntry)};
mkdirSync(${JSON.stringify(workspace)}, { recursive: true });
if (process.env.BEAR_PI_SHELL_PATH !== ${JSON.stringify(bash)}) throw new Error("Pi shell descriptor was not preserved");
if (!process.env.HOME) throw new Error("Pi HOME was not normalized");
const expectedPath = ${JSON.stringify(expectedPathEntries)};
const actualPath = (process.env.PATH ?? "").split(";").slice(0, expectedPath.length);
if (JSON.stringify(actualPath) !== JSON.stringify(expectedPath)) throw new Error("Pi PATH does not begin with bundled Git directories");
const tool = createBashTool(${JSON.stringify(workspace)}, { shellPath: process.env.BEAR_PI_SHELL_PATH });
const result = await tool.execute(${JSON.stringify(randomUUID())}, { command: "printf 'packaged-pi-bash\\n' > pi-bash-smoke.txt && git --version", timeout: 30 });
if (readFileSync(${JSON.stringify(join(workspace, "pi-bash-smoke.txt"))}, "utf8") !== "packaged-pi-bash\\n") throw new Error("Pi bash did not execute in the temp workspace");
const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\\n");
if (!output.includes("git version 2.55.0.windows.5")) throw new Error("Pi bash did not resolve bundled Git");
`;
	try {
		mkdirSync(workspace, { recursive: true });
		writeFileSync(helper, helperSource, "utf8");
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("BEAR_")),
		);
		env.ELECTRON_RUN_AS_NODE = "1";
		env.BEAR_PI_SHELL_PATH = bash;
		env.PI_CODING_AGENT_DIR = piDir;
		env.HOME = env.HOME || env.USERPROFILE;
		if (!env.HOME) throw new Error("Windows environment has neither HOME nor USERPROFILE");
		env.PATH = [...expectedPathEntries, env.PATH].filter(Boolean).join(";");
		const result = spawnSync(appExecutable, [helper], {
			cwd: workspace,
			env,
			encoding: "utf8",
			windowsHide: true,
			timeout: 60_000,
		});
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(
				`packaged Pi bash smoke failed (${String(result.status)}): ${(result.stderr || result.stdout).trim()}`,
			);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

function verifyHashedResource(file) {
	const path = resourcePath(file.path);
	if (!existsSync(path)) throw new Error(`missing manifest file: ${file.path}`);
	if (statSync(path).size !== file.bytes || sha256File(path) !== file.sha256)
		throw new Error(`manifest digest mismatch: ${file.path}`);
}

function inventory(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name, "en"),
		)) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile())
				files.push({
					path: relative(root, absolute).split(sep).join("/"),
					bytes: statSync(absolute).size,
					sha256: sha256File(absolute),
				});
			else throw new Error(`unsupported packaged runtime entry: ${absolute}`);
		}
	};
	visit(root);
	return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function assertInventory(label, expected, actual) {
	if (JSON.stringify(expected) !== JSON.stringify(actual))
		throw new Error(`${label} does not match its deterministic manifest`);
}

function resourcePath(relativePath) {
	if (
		typeof relativePath !== "string" ||
		relativePath.includes("\\") ||
		relativePath.startsWith("/") ||
		relativePath.split("/").includes("..")
	) {
		throw new Error(`unsafe manifest path: ${String(relativePath)}`);
	}
	return join(resources, ...relativePath.split("/"));
}

function sha256File(path) {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	const descriptor = openSync(path, "r");
	try {
		for (;;) {
			const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytes === 0) break;
			hash.update(buffer.subarray(0, bytes));
		}
		return hash.digest("hex");
	} finally {
		closeSync(descriptor);
	}
}

function assertPeX64(path) {
	const machine = readPeMachine(path);
	if (machine !== 0x8664)
		throw new Error(`expected x64 PE executable ${path}, got 0x${machine.toString(16)}`);
}

function readPeMachine(path) {
	let descriptor;
	try {
		descriptor = openSync(path, "r");
		const dosHeader = Buffer.allocUnsafe(0x40);
		if (readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) return -1;
		if (dosHeader.toString("ascii", 0, 2) !== "MZ") return -1;
		const peHeader = Buffer.allocUnsafe(6);
		if (
			readSync(descriptor, peHeader, 0, peHeader.length, dosHeader.readUInt32LE(0x3c)) !==
			peHeader.length
		)
			return -1;
		if (peHeader.toString("ascii", 0, 4) !== "PE\0\0") return -1;
		return peHeader.readUInt16LE(4);
	} catch {
		return -1;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function run({ binary, args }, label) {
	const result = spawnSync(binary, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`${label} failed (${String(result.status)}): ${(result.stderr || result.stdout).trim()}`,
		);
	return `${result.stdout}${result.stderr}`;
}
