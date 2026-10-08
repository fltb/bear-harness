import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_DIRECTORIES = [
	...[
		"product-config",
		"i18n",
		"schema",
		"protocol",
		"companion-client",
		"tdai-core",
		"host-runtime",
	].map((name) => `packages/${name}/dist`),
	"apps/desktop/dist",
];
const transport = ".cache/ci/shared-build";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function filesIn(root, relative) {
	const stat = lstatSync(join(root, relative));
	if (stat.isSymbolicLink()) throw new Error(`Shared build cannot contain symlinks: ${relative}`);
	if (
		relative.split("/").includes("node_modules") ||
		/\.(node|dll|dylib|so|exe)$/i.test(relative)
	) {
		throw new Error(`Shared build cannot contain platform dependencies: ${relative}`);
	}
	if (stat.isDirectory()) {
		return readdirSync(join(root, relative))
			.sort()
			.flatMap((name) => filesIn(root, `${relative}/${name}`));
	}
	if (!stat.isFile()) throw new Error(`Unsupported shared build file: ${relative}`);
	return [
		{ path: relative, sha256: hash(readFileSync(join(root, relative))), mode: stat.mode & 0o777 },
	];
}

function inventory(root) {
	return BUILD_DIRECTORIES.flatMap((directory) => filesIn(root, directory));
}

export function buildIdentity(root) {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(process.versions.node, manifest.engines.node, "Shared build Node version mismatch");
	return {
		commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
		lockSha256: hash(readFileSync(join(root, "package-lock.json"))),
		node: process.versions.node,
		npm: manifest.engines.npm,
	};
}

export function createSharedBuild(root, identity = buildIdentity(root)) {
	const directory = join(root, transport);
	mkdirSync(directory, { recursive: true });
	const files = inventory(root);
	const payload = join(directory, "payload.tar");
	execFileSync("tar", ["-cf", payload, ...BUILD_DIRECTORIES], { cwd: root, stdio: "inherit" });
	writeFileSync(
		join(directory, "manifest.json"),
		`${JSON.stringify(
			{
				schema: 1,
				identity,
				payloadSha256: hash(readFileSync(payload)),
				files,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`shared build exported: ${files.length} files from ${identity.commit}`);
}

export function restoreSharedBuild(root, identity = buildIdentity(root)) {
	const directory = join(root, transport);
	const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
	assert.equal(manifest.schema, 1, "Unsupported shared build manifest");
	assert.deepEqual(
		manifest.identity,
		identity,
		"Shared build does not match this checkout/toolchain",
	);
	const payload = join(directory, "payload.tar");
	assert.equal(
		hash(readFileSync(payload)),
		manifest.payloadSha256,
		"Shared build archive checksum mismatch",
	);
	const entries = execFileSync("tar", ["-tf", payload], { encoding: "utf8" }).trim().split(/\r?\n/);
	for (const entry of entries) {
		const normalized = entry.replace(/\/$/, "");
		if (
			normalized.includes("\\") ||
			normalized.split("/").includes("..") ||
			!BUILD_DIRECTORIES.some((base) => normalized === base || normalized.startsWith(`${base}/`))
		) {
			throw new Error(`Unexpected shared build archive entry: ${entry}`);
		}
	}
	for (const path of BUILD_DIRECTORIES) rmSync(join(root, path), { recursive: true, force: true });
	execFileSync("tar", ["-xf", payload, "-C", root], { stdio: "inherit" });
	// Windows does not preserve POSIX permission bits. File identity is checked on
	// every platform; executable bits are additionally checked on Unix consumers.
	const comparable = (files) =>
		process.platform === "win32" ? files.map(({ path, sha256 }) => ({ path, sha256 })) : files;
	assert.deepEqual(
		comparable(inventory(root)),
		comparable(manifest.files),
		"Restored shared build differs from manifest",
	);
	console.log(`shared build restored: ${manifest.files.length} files from ${identity.commit}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const action = process.argv[2];
	if (action === "create") createSharedBuild(resolve("."));
	else if (action === "restore") restoreSharedBuild(resolve("."));
	else throw new Error("Expected shared-build.mjs create|restore");
}
