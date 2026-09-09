import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateReleaseTag, verifyReleaseDownload } from "./verify-release-download.mjs";

const COMMIT = "a".repeat(40);
const TARGETS = ["mac-x64", "mac-arm64", "win-x64", "linux-x64"];
const STAGES = ["quality", "recovery", "electron-e2e", "web-e2e"];

test("release tags must match the package version and a canonical RC number", () => {
	assert.equal(validateReleaseTag("v1.0.0-rc.29", "1.0.0"), 29);
	for (const tag of ["v1.0.1-rc.29", "v1.0.0-rc.0", "v1.0.0-rc.029", "v1.0.0-rc.next"]) {
		assert.throws(() => validateReleaseTag(tag, "1.0.0"));
	}
});

test("download verification binds all four packages to the final green attestation", async () => {
	const fixture = createFixture();
	const result = await verifyReleaseDownload({
		repoRoot: fixture.root,
		downloadRoot: fixture.downloadRoot,
		tag: "v1.0.0-rc.29",
		commit: COMMIT,
	});
	assert.equal(result.assets.length, 4);
	const manifest = readFileSync(result.manifestPath, "utf8");
	for (const target of TARGETS) assert.ok(manifest.includes(`Bear-Harness-${target}.bin`));
});

test("download verification rejects a package whose bytes differ from CI evidence", async () => {
	const fixture = createFixture();
	writeFileSync(
		join(fixture.downloadRoot, "bear-harness-win-x64", "Bear-Harness-win-x64.bin"),
		"tampered",
	);
	await assertRejectsMessage(
		() =>
			verifyReleaseDownload({
				repoRoot: fixture.root,
				downloadRoot: fixture.downloadRoot,
				tag: "v1.0.0-rc.29",
				commit: COMMIT,
			}),
		"digest mismatch",
	);
});

test("download verification rejects an incomplete final validation set", async () => {
	const fixture = createFixture({ omittedStage: "web-e2e" });
	await assertRejectsMessage(
		() =>
			verifyReleaseDownload({
				repoRoot: fixture.root,
				downloadRoot: fixture.downloadRoot,
				tag: "v1.0.0-rc.29",
				commit: COMMIT,
			}),
		"all four required validation stages",
	);
});

function createFixture(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "bear-release-download-"));
	const downloadRoot = join(root, "downloads");
	mkdirSync(downloadRoot);
	writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: "1.0.0" })}\n`);
	const stageReferences = STAGES.filter((stage) => stage !== options.omittedStage).map((stage) => {
		const file = `${stage}.json`;
		const path = writeArtifact(downloadRoot, `release-attestation-${stage}`, file, {
			stage,
			status: "passed",
			dirty: false,
			commit: COMMIT,
		});
		return { stage, path: file, ...digest(path) };
	});

	const packageReferences = TARGETS.map((target) => {
		const assetName = `Bear-Harness-${target}.bin`;
		const assetPath = writeArtifact(
			downloadRoot,
			`bear-harness-${target}`,
			assetName,
			`package-${target}`,
			false,
		);
		const artifact = { name: assetName, ...digest(assetPath) };
		const evidenceName = `package-evidence-${target}.json`;
		const evidencePath = writeArtifact(
			downloadRoot,
			`release-attestation-package-${target}`,
			evidenceName,
			{ target, version: "1.0.0", artifacts: [artifact] },
		);
		const packageName = `package-${target}.json`;
		const packagePath = writeArtifact(
			downloadRoot,
			`release-attestation-package-${target}`,
			packageName,
			{
				stage: "package",
				status: "passed",
				dirty: false,
				commit: COMMIT,
				target,
				packageEvidence: { path: evidenceName, ...digest(evidencePath) },
				artifacts: [artifact],
			},
		);
		return { target, path: packageName, ...digest(packagePath) };
	});

	writeArtifact(downloadRoot, "release-attestation-final", "final.json", {
		stage: "final",
		status: "passed",
		dirty: false,
		commit: COMMIT,
		inputs: { stages: stageReferences, packages: packageReferences },
	});
	return { root, downloadRoot };
}

function writeArtifact(root, directory, name, value, json = true) {
	const targetDirectory = join(root, directory);
	mkdirSync(targetDirectory, { recursive: true });
	const path = join(targetDirectory, name);
	writeFileSync(path, json ? `${JSON.stringify(value)}\n` : value);
	return path;
}

function digest(path) {
	const value = readFileSync(path);
	return { size: value.byteLength, sha256: createHash("sha256").update(value).digest("hex") };
}

async function assertRejectsMessage(action, message) {
	try {
		await action();
		assert.fail(`expected rejection containing: ${message}`);
	} catch (error) {
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes(message), error.message);
	}
}
