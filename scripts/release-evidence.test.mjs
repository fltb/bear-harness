import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReleaseAttestation } from "./release-attestation.mjs";
import { PACKAGE_TARGETS, sha256Text, validateCycloneDx } from "./release-evidence.mjs";
import { verifyPackage } from "./verify-package.mjs";

const roots = [];
const PRODUCT_CONFIG = {
	productName: "Test Product",
	executableName: "test-product",
	dataDirectoryName: "test-product",
	appId: "example.test-product",
	artifactName: ["$", "{productName}-$", "{version}-$", "{os}-$", "{arch}.$", "{ext}"].join(""),
};

test.afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("quality and final refuse tracked or untracked dirty state but ignore generated evidence", async () => {
	const root = gitFixture();
	const first = await createReleaseAttestation({
		repoRoot: root,
		stage: "quality",
		target: "test-x64",
	});
	assert.equal(first.record.schema, 1);
	assert.equal(first.record.dirty, false);
	assert.match(
		readFileSync(join(root, "release-attestations/quality.json"), "utf8"),
		/"dirty": false/,
	);

	// The evidence output itself is intentionally outside the source cleanliness decision.
	await assert.doesNotReject(
		createReleaseAttestation({ repoRoot: root, stage: "quality", target: "test-x64" }),
	);

	writeFileSync(join(root, "README.md"), "changed\n");
	await assert.rejects(
		createReleaseAttestation({ repoRoot: root, stage: "quality", target: "test-x64" }),
		/repository is dirty[\s\S]*README\.md/,
	);
	await assert.rejects(
		createReleaseAttestation({ repoRoot: root, stage: "final", target: "test-x64" }),
		/repository is dirty[\s\S]*README\.md/,
	);

	git(root, ["checkout", "--", "README.md"]);
	writeFileSync(join(root, "UNTRACKED.txt"), "not committed\n");
	await assert.rejects(
		createReleaseAttestation({ repoRoot: root, stage: "quality", target: "test-x64" }),
		/repository is dirty[\s\S]*UNTRACKED\.txt/,
	);
});

test("package attestation re-hashes every artifact, SBOM, and package lock", async () => {
	const root = packageFixture();
	const result = await verifyPackage({
		repoRoot: root,
		osName: "win",
		arch: "x64",
		extensions: ["exe", "zip"],
		productConfig: PRODUCT_CONFIG,
		generateSbom: async () => JSON.stringify(cycloneDx()),
	});
	assert.equal(result.evidence.artifacts.length, 2);
	assert.ok(result.evidence.artifacts.every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256)));
	assert.equal(result.evidence.sbom.format, "CycloneDX");
	assert.equal(result.evidence.sbom.componentCount, 2);

	const attestation = await createReleaseAttestation({
		repoRoot: root,
		stage: "package",
		target: "win-x64",
	});
	assert.deepEqual(attestation.record.artifacts, result.evidence.artifacts);
	assert.equal(attestation.record.sbom.sha256, result.evidence.sbom.sha256);
	assert.equal(attestation.record.packageLock.sha256, result.evidence.packageLock.sha256);

	const executable = join(root, result.evidence.artifacts[0].path);
	writeFileSync(executable, "tampered executable\n");
	await assert.rejects(
		createReleaseAttestation({ repoRoot: root, stage: "package", target: "win-x64" }),
		/artifact digest mismatch/,
	);

	writeFileSync(executable, "exe bytes\n");
	const sbomPath = join(root, "release-attestations", result.evidence.sbom.path);
	writeFileSync(sbomPath, `${JSON.stringify(cycloneDx({ extra: true }), null, 2)}\n`);
	await assert.rejects(
		createReleaseAttestation({ repoRoot: root, stage: "package", target: "win-x64" }),
		/SBOM digest mismatch/,
	);
});

test("final attestation validates and binds every stage and platform evidence file", async () => {
	const root = packageFixture({ allTargets: true });
	for (const [target, extensions] of Object.entries(PACKAGE_TARGETS)) {
		const separator = target.lastIndexOf("-");
		const osName = target.slice(0, separator);
		const arch = target.slice(separator + 1);
		await verifyPackage({
			repoRoot: root,
			osName,
			arch,
			extensions,
			productConfig: PRODUCT_CONFIG,
			generateSbom: async () => JSON.stringify(cycloneDx()),
		});
		await createReleaseAttestation({ repoRoot: root, stage: "package", target });
	}
	writePassingSoakReport(root);
	for (const stage of ["quality", "recovery", "electron-e2e", "web-e2e", "soak"]) {
		await createReleaseAttestation({ repoRoot: root, stage, target: "test-x64" });
	}

	const final = await createReleaseAttestation({
		repoRoot: root,
		stage: "final",
		target: "test-x64",
	});
	assert.equal(final.record.inputs.stages.length, 5);
	assert.equal(final.record.inputs.packages.length, 4);
	assert.deepEqual(
		new Set(final.record.inputs.packages.map(({ target }) => target)),
		new Set(Object.keys(PACKAGE_TARGETS)),
	);
	assert.ok(
		final.record.inputs.packages.every(({ artifacts }) =>
			artifacts.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256)),
		),
	);

	const evidencePath = join(root, "release-attestations/package-evidence-mac-x64.json");
	writeFileSync(evidencePath, `${readFileSync(evidencePath, "utf8")} `);
	await assert.rejects(
		createReleaseAttestation({ repoRoot: root, stage: "final", target: "test-x64" }),
		/mac-x64 package evidence digest mismatch/,
	);
});

test("soak attestation rejects missing evidence and binds a valid release report", async () => {
	const root = gitFixture();
	await assert.rejects(
		createReleaseAttestation({ repoRoot: root, stage: "soak", target: "test-x64" }),
	);
	writePassingSoakReport(root);
	const result = await createReleaseAttestation({
		repoRoot: root,
		stage: "soak",
		target: "test-x64",
	});
	assert.equal(result.record.soakReport.path, "soak-report.json");
	assert.equal(result.record.soakReport.mode, "release");
	assert.equal(result.record.soakReport.durationMs, 7_200_000);
});

test("CycloneDX validation rejects a mislabeled or dependency-free document", () => {
	assert.throws(
		() => validateCycloneDx({ bomFormat: "SPDX" }),
		/SBOM must be a CycloneDX document/,
	);
	assert.throws(
		() =>
			validateCycloneDx(
				{
					...cycloneDx(),
					components: [],
				},
				{ packageName: "bear-harness", version: "1.2.3" },
			),
		/must contain dependency components/,
	);
	assert.equal(
		sha256Text("known"),
		"7117fff2d0fd294462b3c802b7cb8753579f23f3946b99cf55f38e873f013f10",
	);
});

function gitFixture() {
	const root = mkdtempSync(join(tmpdir(), "bear-release-evidence-"));
	roots.push(root);
	writeFileSync(join(root, "README.md"), "clean\n");
	writeFileSync(join(root, ".gitignore"), "apps/*/release/\n");
	git(root, ["init"]);
	git(root, ["config", "user.email", "release-test@example.invalid"]);
	git(root, ["config", "user.name", "Release Test"]);
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "fixture"]);
	return root;
}

function packageFixture(options = {}) {
	const root = gitFixture();
	mkdirSync(join(root, "apps/desktop/release"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name: "bear-harness", version: "1.2.3" })}\n`,
	);
	writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3 })}\n`);
	writeFileSync(
		join(root, "apps/desktop/package.json"),
		`${JSON.stringify({ version: "1.2.3" })}\n`,
	);
	writeArtifact(root, "win", "x64", "exe");
	writeArtifact(root, "win", "x64", "zip");
	if (options.allTargets) {
		writeArtifact(root, "mac", "x64", "dmg");
		writeArtifact(root, "mac", "x64", "zip");
		writeArtifact(root, "mac", "arm64", "dmg");
		writeArtifact(root, "mac", "arm64", "zip");
		writeArtifact(root, "linux", "x86_64", "AppImage");
		writeArtifact(root, "linux", "amd64", "deb");
	}
	git(root, ["add", "package.json", "package-lock.json", "apps/desktop/package.json"]);
	git(root, ["commit", "-m", "package fixture"]);
	return root;
}

function writeArtifact(root, osName, arch, extension) {
	const name = `Test Product-1.2.3-${osName}-${arch}.${extension}`;
	writeFileSync(join(root, "apps/desktop/release", name), `${extension} bytes\n`);
}

function cycloneDx(options = {}) {
	return {
		$schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
		version: 1,
		metadata: {
			component: { type: "application", name: "bear-harness", version: "1.2.3" },
		},
		components: [
			{ type: "library", name: options.extra ? "dependency-b" : "dependency-a", version: "1.0.0" },
		],
		dependencies: [],
	};
}

function writePassingSoakReport(root) {
	const evidenceRoot = join(root, "release-attestations");
	mkdirSync(evidenceRoot, { recursive: true });
	const commit = git(root, ["rev-parse", "HEAD"]).trim();
	const resourceTrace = "[]\n";
	writeFileSync(join(evidenceRoot, "soak-resource-samples.json"), resourceTrace);
	writeFileSync(
		join(evidenceRoot, "soak-report.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			mode: "release",
			commit,
			durationMs: 7_200_000,
			counts: {
				cycles: 5_000,
				switches: 1_000,
				stops: 500,
				authoritativeEntries: 10_000,
				historyLoads: 100,
				runArtifactInteractions: 50,
				mediaChoiceInteractions: 50,
			},
			correctness: {
				crossConversationEvents: 0,
				duplicateEntries: 0,
				missingEntries: 0,
				postStopTokens: 0,
				stuckStreams: 0,
				pageErrors: 0,
				unhandledRejections: 0,
				processCrashes: 0,
				ownershipErrors: 0,
				persistenceErrors: 0,
				orphanedResources: 0,
			},
			metrics: {
				rendererHeapSlopeBytesPerTenMinutes: 0,
				rendererHeapNetGrowthBytes: 0,
				hostHeapSlopeBytesPerTenMinutes: 0,
				hostHeapNetGrowthBytes: 0,
				residentSetNetGrowthBytes: 0,
				residentSetMonotonicFinalSamples: 0,
				maxRenderedTimelineRows: 1,
				interactionP95Ms: 1,
				conversationSwitchP95Ms: 1,
				stopFeedbackP95Ms: 1,
				streamExitP95Ms: 1,
				cancelConfirmationP95Ms: 1,
				maxNonGcLongTaskMs: 0,
				maxNoProgressMs: 1,
			},
			samples: {
				resource: 121,
				interaction: 5_000,
				resourceCoverageMs: 7_200_000,
				postWarmupCoverageMs: 6_540_000,
				maxResourceGapMs: 60_000,
			},
			resourceTrace: {
				path: "soak-resource-samples.json",
				size: Buffer.byteLength(resourceTrace),
				sha256: sha256Text(resourceTrace),
			},
		})}\n`,
	);
}

function git(root, args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}
