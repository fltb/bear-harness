import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILD_DIRECTORIES, createSharedBuild, restoreSharedBuild } from "./shared-build.mjs";

const identity = {
	commit: "a".repeat(40),
	lockSha256: "b".repeat(64),
	node: "26.11.1",
	npm: "12.2.0",
};
function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "bear-shared-build-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const directory of BUILD_DIRECTORIES) {
		mkdirSync(join(root, directory), { recursive: true });
		writeFileSync(
			join(root, directory, "index.js"),
			`export const source = ${JSON.stringify(directory)};`,
		);
	}
	return root;
}

test("shared output round trip replaces stale output and preserves executable bits", (t) => {
	const root = fixture(t);
	const executable = join(root, "apps/desktop/dist/index.js");
	chmodSync(executable, 0o755);
	createSharedBuild(root, identity);
	writeFileSync(executable, "stale");
	writeFileSync(join(root, "apps/desktop/dist/stale.js"), "stale");
	restoreSharedBuild(root, identity);
	assert.match(readFileSync(executable, "utf8"), /export const source/);
	assert.throws(() => statSync(join(root, "apps/desktop/dist/stale.js")), /ENOENT/);
	if (process.platform !== "win32") assert.equal(statSync(executable).mode & 0o777, 0o755);
});

test("shared output rejects another checkout or dependency/toolchain identity before replacing files", (t) => {
	const root = fixture(t);
	createSharedBuild(root, identity);
	for (const key of Object.keys(identity)) {
		assert.throws(
			() => restoreSharedBuild(root, { ...identity, [key]: "different" }),
			/does not match/,
		);
	}
	assert.match(
		readFileSync(join(root, "apps/desktop/dist/index.js"), "utf8"),
		/export const source/,
	);
});

test("shared output rejects changed archive bytes and file manifests", (t) => {
	const root = fixture(t);
	createSharedBuild(root, identity);
	const manifestPath = join(root, ".cache/ci/shared-build/manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.files[0].sha256 = "0".repeat(64);
	writeFileSync(manifestPath, JSON.stringify(manifest));
	assert.throws(() => restoreSharedBuild(root, identity), /differs from manifest/);
	writeFileSync(join(root, ".cache/ci/shared-build/payload.tar"), "corrupted");
	assert.throws(() => restoreSharedBuild(root, identity), /checksum mismatch/);
});

test("shared output never exports native binaries or node_modules", (t) => {
	const root = fixture(t);
	const native = join(root, "apps/desktop/dist/binding.node");
	writeFileSync(native, "native");
	assert.throws(() => createSharedBuild(root, identity), /platform dependencies/);
	rmSync(native);
	mkdirSync(join(root, "apps/desktop/dist/node_modules"));
	assert.throws(() => createSharedBuild(root, identity), /platform dependencies/);
});
