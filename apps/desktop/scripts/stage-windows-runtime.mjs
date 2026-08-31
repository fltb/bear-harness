#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const RELEASE_TAG = "v2.55.0.windows.5";
const ASSET = "PortableGit-2.55.0.5-64-bit.7z.exe";
const ARCHIVE_SHA256 = "5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290";
const RELEASE_URL = `https://github.com/git-for-windows/git/releases/download/${RELEASE_TAG}/${ASSET}`;
const RELEASE_PAGE = `https://github.com/git-for-windows/git/releases/tag/${RELEASE_TAG}`;
const SOURCE_URLS = [
	`https://github.com/git-for-windows/git/tree/${RELEASE_TAG}`,
	"https://github.com/git-for-windows/build-extra",
	"https://github.com/git-for-windows/MSYS2-packages",
	"https://github.com/git-for-windows/MINGW-packages",
];

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const staging = resolve(desktopRoot, "dist/.windows-runtime");
const archive = join(staging, ASSET);
const gitRoot = join(staging, "git");
const noticesRoot = join(staging, "notices");

if (process.platform !== "win32") process.exit(0);
mkdirSync(staging, { recursive: true });
if (!existsSync(archive)) await downloadArchive();
const actualArchiveDigest = sha256File(archive);
if (actualArchiveDigest !== ARCHIVE_SHA256) {
	rmSync(archive, { force: true });
	throw new Error(
		`PortableGit SHA-256 mismatch: expected ${ARCHIVE_SHA256}, got ${actualArchiveDigest}`,
	);
}

rmSync(gitRoot, { recursive: true, force: true });
const extraction = spawnSync(archive, ["-y", `-o${gitRoot}`], {
	stdio: "inherit",
	shell: false,
	windowsHide: true,
});
if (extraction.error) throw extraction.error;
if (extraction.status !== 0)
	throw new Error(`PortableGit extraction failed with status ${String(extraction.status)}`);

const executables = {
	bash: "usr/bin/bash.exe",
	git: "cmd/git.exe",
};
for (const executable of Object.values(executables)) {
	if (!existsSync(join(gitRoot, executable))) {
		throw new Error(`PortableGit extraction missing ${executable}`);
	}
}

const runtimeFiles = inventory(gitRoot);
const packageVersionsRelative = "etc/package-versions.txt";
if (!runtimeFiles.some((file) => file.path === packageVersionsRelative)) {
	throw new Error(`PortableGit extraction missing ${packageVersionsRelative}`);
}
const componentNotices = runtimeFiles.filter((file) => isComponentNotice(file.path));
if (componentNotices.length === 0)
	throw new Error("PortableGit extraction contains no component notices");
const gplSource = [
	"usr/share/licenses/git/COPYING",
	"mingw64/share/licenses/git/COPYING",
	"COPYING",
].find((candidate) => runtimeFiles.some((file) => file.path === candidate));
if (!gplSource) throw new Error("PortableGit extraction is missing Git's GPLv2 text");

rmSync(noticesRoot, { recursive: true, force: true });
mkdirSync(noticesRoot, { recursive: true });
writeFileSync(join(noticesRoot, "THIRD-PARTY-NOTICES.txt"), productNotice(), "utf8");
await copyFile(join(gitRoot, gplSource), join(noticesRoot, "GPL-2.0.txt"));
await copyFile(join(gitRoot, packageVersionsRelative), join(noticesRoot, "package-versions.txt"));
writeFileSync(
	join(noticesRoot, "component-notices.json"),
	`${JSON.stringify({ files: componentNotices.map((file) => ({ ...file, path: `git/${file.path}` })) }, null, 2)}\n`,
	"utf8",
);

const noticeFiles = inventory(noticesRoot).map((file) => ({
	...file,
	path: `third-party/git-for-windows/${file.path}`,
}));
const manifest = {
	release: {
		tag: RELEASE_TAG,
		asset: ASSET,
		url: RELEASE_URL,
		sha256: ARCHIVE_SHA256,
		architecture: "x64",
		releasePage: RELEASE_PAGE,
		sourceUrls: SOURCE_URLS,
		correspondingSource: RELEASE_PAGE,
	},
	executables,
	notices: {
		product: "third-party/git-for-windows/THIRD-PARTY-NOTICES.txt",
		gplV2: "third-party/git-for-windows/GPL-2.0.txt",
		packageVersions: "third-party/git-for-windows/package-versions.txt",
		componentIndex: "third-party/git-for-windows/component-notices.json",
		componentPaths: componentNotices.map((file) => `git/${file.path}`),
	},
	runtimeFiles,
	noticeFiles,
};
writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

async function downloadArchive() {
	const partial = `${archive}.download`;
	rmSync(partial, { force: true });
	const response = await fetch(RELEASE_URL, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`PortableGit download failed: ${response.status} ${response.statusText}`);
	}
	try {
		await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
		renameSync(partial, archive);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	}
}

function inventory(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name, "en"),
		)) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (!entry.isFile())
				throw new Error(`PortableGit contains unsupported filesystem entry: ${absolute}`);
			const path = relative(root, absolute).split(sep).join("/");
			files.push({ path, bytes: statSync(absolute).size, sha256: sha256File(absolute) });
		}
	};
	visit(root);
	return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function isComponentNotice(path) {
	const lower = path.toLowerCase();
	if (lower.startsWith("usr/share/licenses/") || lower.startsWith("mingw64/share/licenses/"))
		return true;
	if (lower === "releasenotes.html" || lower === "copying" || lower === "license.txt") return true;
	return /(^|\/)(copying|copyright|license|notice)(\.[^/]*)?$/.test(lower);
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

function productNotice() {
	return `Bear Harness for Windows includes the unmodified PortableGit aggregation from Git for Windows.\n\nRelease: Git for Windows ${RELEASE_TAG}\nAsset: ${ASSET}\nRelease asset: ${RELEASE_URL}\nArchive SHA-256: ${ARCHIVE_SHA256}\nRelease and corresponding-source distribution: ${RELEASE_PAGE}\n\nSource and packaging locations:\n${SOURCE_URLS.map((url) => `- ${url}`).join("\n")}\n\nGit is licensed under GNU GPL version 2. The complete GPLv2 text is distributed as GPL-2.0.txt. PortableGit contains separately licensed components; package-versions.txt identifies their exact packaged versions, component-notices.json indexes every license/notice shipped by the extracted distribution, and the indexed originals remain under resources/git. Bear Harness does not modify the PortableGit aggregation. Bear Harness's GPL-3.0 license does not replace any component license or corresponding-source obligation.\n`;
}
