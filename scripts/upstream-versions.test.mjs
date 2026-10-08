import assert from "node:assert/strict";
import test from "node:test";
import {
	externalDependencies,
	newer,
	portableGitRelease,
	selectDependencies,
	updateManifest,
} from "./upstream-versions.mjs";

test("isolates incompatible dependency groups from unrelated upgrades", () => {
	const packages = [{ data: { dependencies: { pi: "1.0.0", katex: "1.0.0" } } }];
	const registry = {
		groups: [
			{ id: "pi", dependencies: ["pi"] },
			{ id: "render", dependencies: ["katex"] },
		],
	};
	assert.deepEqual(selectDependencies(packages, registry, "pi", ["transitive"]), ["pi"]);
	assert.deepEqual(selectDependencies(packages, registry, "infrastructure", ["transitive"]), [
		"transitive",
	]);
	assert.throws(() => selectDependencies(packages, registry, "typo", []));
});

test("accepts patch, minor and major stable upgrades", () => {
	for (const version of ["1.0.1", "1.1.0", "2.0.0"]) assert(newer("^1.0.0", version));
});
test("does not downgrade an existing newer prerelease to the stable tag", () => {
	assert.equal(newer("^1.0.0-rc.4", "0.45.3"), false);
	assert(newer("1.0.0-rc.4", "1.0.0"));
});
test("does not rewrite an identical version", () => {
	assert.equal(newer("1.2.3", "1.2.3"), false);
});
test("rejects moving tags, URLs and unstable candidate versions", () => {
	for (const value of ["latest", "next", "1.0.1-beta.1", "https://example.com"])
		assert.throws(() => newer("1.0.0", value));
});
test("deduplicates workspaces and excludes internal file references", () => {
	assert.deepEqual(
		externalDependencies([
			{ data: { dependencies: { a: "1.0.0", internal: "file:../a" } } },
			{ data: { devDependencies: { a: "1.0.0", b: "2.0.0" } } },
		]),
		["a", "b"],
	);
});
test("updates only dependency versions and preserves scripts and product metadata", () => {
	const original = {
		version: "1.1.0",
		scripts: { test: "verified-test" },
		dependencies: { a: "1.0.0", internal: "file:../a" },
	};
	const updated = updateManifest(original, { a: "2.0.0" });
	assert.equal(updated.dependencies.a, "2.0.0");
	assert.equal(original.dependencies.a, "1.0.0");
	assert.deepEqual(updated.scripts, original.scripts);
	assert.equal(updated.version, original.version);
});
test("retains an explicit denial for an upgraded install script", () => {
	const updated = updateManifest(
		{ allowScripts: { "example@1.0.0": false } },
		{ example: "2.0.0" },
	);
	assert.equal(updated.allowScripts["example@2.0.0"], false);
});
const release = {
	tag_name: "v2.55.0.windows.5",
	draft: false,
	prerelease: false,
	assets: [
		{
			name: "PortableGit-2.55.0.5-64-bit.7z.exe",
			digest: `sha256:${"a".repeat(64)}`,
			browser_download_url:
				"https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/PortableGit-2.55.0.5-64-bit.7z.exe",
		},
	],
};
test("requires the published PortableGit asset digest", () => {
	assert.equal(portableGitRelease(release).sha256, "a".repeat(64));
	const bad = structuredClone(release);
	delete bad.assets[0].digest;
	assert.throws(() => portableGitRelease(bad));
});
test("rejects an unexpected binary host", () => {
	const bad = structuredClone(release);
	bad.assets[0].browser_download_url = "https://example.com/payload";
	assert.throws(() => portableGitRelease(bad));
});
test("rejects a prerelease PortableGit binary", () => {
	assert.throws(() => portableGitRelease({ ...release, prerelease: true }));
});
