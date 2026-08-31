import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	assertContainedFile,
	PACKAGE_TARGETS,
	RELEASE_ATTESTATION_SCHEMA,
	readJson,
	requireSha256,
	sha256File,
	validateCycloneDx,
	validatePackageEvidence,
	writeJsonAtomic,
} from "./release-evidence.mjs";

const ALLOWED_STAGES = new Set([
	"quality",
	"recovery",
	"electron-e2e",
	"web-e2e",
	"live-model",
	"package",
	"final",
]);
const REQUIRED_STAGE_ATTESTATIONS = [
	"quality",
	"recovery",
	"electron-e2e",
	"web-e2e",
	"live-model",
];

export async function createReleaseAttestation(options = {}) {
	const stage = options.stage ?? process.argv[2];
	if (!ALLOWED_STAGES.has(stage)) {
		throw new Error(`unknown release attestation stage: ${stage ?? "<missing>"}`);
	}
	const repoRoot = resolve(options.repoRoot ?? ".");
	const evidenceRoot = join(repoRoot, "release-attestations");
	mkdirSync(evidenceRoot, { recursive: true });
	assertCleanWorkingTree(repoRoot);
	const commit = git(repoRoot, ["rev-parse", "HEAD"]).trim();
	const target =
		options.target ?? process.env.RELEASE_TARGET ?? `${process.platform}-${process.arch}`;
	const common = {
		schema: RELEASE_ATTESTATION_SCHEMA,
		stage,
		status: "passed",
		commit,
		target,
		dirty: false,
		createdAt: new Date().toISOString(),
	};

	let record;
	if (stage === "package") {
		record = {
			...common,
			...(await attestPackage({ repoRoot, evidenceRoot, target, commit })),
		};
	} else if (stage === "final") {
		record = {
			...common,
			inputs: await verifyFinalInputs({ repoRoot, evidenceRoot, commit }),
		};
	} else {
		record = common;
	}

	const suffix = stage === "package" ? `-${target}` : "";
	const file = `${stage}${suffix}.json`;
	const written = writeJsonAtomic(join(evidenceRoot, file), record);
	return { record, file, sha256: written.sha256 };
}

export function workingTreeChanges(repoRoot) {
	const output = git(repoRoot, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"--",
		".",
		":(exclude)release-attestations",
		":(exclude)release-attestations/**",
	]);
	return output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean);
}

export function assertCleanWorkingTree(repoRoot) {
	const changes = workingTreeChanges(repoRoot);
	if (changes.length === 0) return;
	const shown = changes.slice(0, 100);
	const suffix =
		changes.length > shown.length ? `\n... and ${changes.length - shown.length} more` : "";
	throw new Error(
		`repository is dirty; release evidence was not written:\n${shown.join("\n")}${suffix}`,
	);
}

async function attestPackage({ repoRoot, evidenceRoot, target }) {
	if (!(target in PACKAGE_TARGETS))
		throw new Error(`unsupported package attestation target: ${target}`);
	const evidenceName = `package-evidence-${target}.json`;
	const evidencePath = join(evidenceRoot, evidenceName);
	const evidenceFile = assertContainedFile(evidenceRoot, evidencePath, "package evidence");
	const rootPackage = readJson(join(repoRoot, "package.json"), "root package");
	const evidence = validatePackageEvidence(readJson(evidencePath, evidenceName), {
		target,
		version: rootPackage.version,
	});
	await verifyPackageEvidenceFiles({ repoRoot, evidenceRoot, evidence, verifyArtifacts: true });
	return {
		packageEvidence: {
			path: evidenceName,
			size: evidenceFile.size,
			sha256: await sha256File(evidencePath),
		},
		artifacts: evidence.artifacts,
		packageLock: evidence.packageLock,
		sbom: evidence.sbom,
	};
}

async function verifyFinalInputs({ repoRoot, evidenceRoot, commit }) {
	const stages = [];
	for (const stage of REQUIRED_STAGE_ATTESTATIONS) {
		const file = `${stage}.json`;
		const path = join(evidenceRoot, file);
		const source = assertContainedFile(evidenceRoot, path, `${stage} attestation`);
		const record = readJson(path, `${stage} attestation`);
		validateStageRecord(record, { stage, commit });
		stages.push({ stage, path: file, size: source.size, sha256: await sha256File(path) });
	}

	const packages = [];
	for (const target of Object.keys(PACKAGE_TARGETS)) {
		const file = `package-${target}.json`;
		const path = join(evidenceRoot, file);
		const source = assertContainedFile(evidenceRoot, path, `${target} package attestation`);
		const record = readJson(path, `${target} package attestation`);
		validateStageRecord(record, { stage: "package", commit, target });
		validatePackageAttestationShape(record);

		const evidencePath = join(evidenceRoot, record.packageEvidence.path);
		const evidenceFile = assertContainedFile(
			evidenceRoot,
			evidencePath,
			`${target} package evidence`,
		);
		if (
			evidenceFile.size !== record.packageEvidence.size ||
			(await sha256File(evidencePath)) !== record.packageEvidence.sha256
		) {
			throw new Error(`${target} package evidence digest mismatch`);
		}
		const evidence = validatePackageEvidence(readJson(evidencePath), {
			target,
			version: readJson(join(repoRoot, "package.json"), "root package").version,
		});
		await verifyPackageEvidenceFiles({ repoRoot, evidenceRoot, evidence, verifyArtifacts: false });
		if (JSON.stringify(record.artifacts) !== JSON.stringify(evidence.artifacts)) {
			throw new Error(`${target} artifact digests do not match package evidence`);
		}
		if (
			JSON.stringify(record.packageLock) !== JSON.stringify(evidence.packageLock) ||
			JSON.stringify(record.sbom) !== JSON.stringify(evidence.sbom)
		) {
			throw new Error(`${target} dependency evidence does not match package evidence`);
		}
		packages.push({
			target,
			path: file,
			size: source.size,
			sha256: await sha256File(path),
			artifacts: record.artifacts,
			sbom: record.sbom,
		});
	}
	return { stages, packages };
}

async function verifyPackageEvidenceFiles({ repoRoot, evidenceRoot, evidence, verifyArtifacts }) {
	const lock = assertContainedFile(
		repoRoot,
		join(repoRoot, evidence.packageLock.path),
		"package lock",
	);
	if (
		lock.size !== evidence.packageLock.size ||
		(await sha256File(lock.path)) !== evidence.packageLock.sha256
	) {
		throw new Error(`${evidence.target} package-lock.json digest mismatch`);
	}
	const sbomPath = join(evidenceRoot, evidence.sbom.path);
	const sbom = assertContainedFile(evidenceRoot, sbomPath, `${evidence.target} SBOM`);
	if (sbom.size !== evidence.sbom.size || (await sha256File(sbom.path)) !== evidence.sbom.sha256) {
		throw new Error(`${evidence.target} SBOM digest mismatch`);
	}
	const rootPackage = readJson(join(repoRoot, "package.json"), "root package");
	const summary = validateCycloneDx(readJson(sbom.path, `${evidence.target} SBOM`), {
		packageName: rootPackage.name,
		version: rootPackage.version,
	});
	for (const field of ["format", "specVersion", "serialNumber", "componentCount"]) {
		if (evidence.sbom[field] !== summary[field]) {
			throw new Error(`${evidence.target} SBOM ${field} does not match its document`);
		}
	}
	if (JSON.stringify(evidence.sbom.rootComponent) !== JSON.stringify(summary.rootComponent)) {
		throw new Error(`${evidence.target} SBOM root component does not match its document`);
	}
	if (!verifyArtifacts) return;
	const releaseDir = join(repoRoot, "apps/desktop/release");
	for (const artifact of evidence.artifacts) {
		const file = assertContainedFile(
			releaseDir,
			join(repoRoot, artifact.path),
			`${evidence.target} ${artifact.name}`,
		);
		if (file.size !== artifact.size || (await sha256File(file.path)) !== artifact.sha256) {
			throw new Error(`${evidence.target} artifact digest mismatch: ${artifact.name}`);
		}
	}
}

function validateStageRecord(record, expected) {
	if (!record || typeof record !== "object" || Array.isArray(record)) {
		throw new Error(`${expected.stage} attestation must be an object`);
	}
	if (
		record.schema !== RELEASE_ATTESTATION_SCHEMA ||
		record.stage !== expected.stage ||
		record.status !== "passed" ||
		record.commit !== expected.commit ||
		record.dirty !== false
	) {
		throw new Error(`invalid ${expected.stage} attestation for commit ${expected.commit}`);
	}
	if (expected.target && record.target !== expected.target) {
		throw new Error(`${expected.stage} attestation target mismatch: expected ${expected.target}`);
	}
}

function validatePackageAttestationShape(record) {
	if (!record.packageEvidence || typeof record.packageEvidence !== "object") {
		throw new Error(`${record.target} package attestation is missing package evidence`);
	}
	if (
		typeof record.packageEvidence.path !== "string" ||
		basename(record.packageEvidence.path) !== record.packageEvidence.path ||
		!Number.isSafeInteger(record.packageEvidence.size) ||
		record.packageEvidence.size <= 0
	) {
		throw new Error(`${record.target} package evidence reference is invalid`);
	}
	requireSha256(record.packageEvidence.sha256, `${record.target} package evidence`);
	validatePackageEvidence(
		{
			schema: 1,
			target: record.target,
			productName: "attested",
			executableName: "attested",
			dataDirectoryName: "attested",
			appId: "attested",
			version: "attested",
			artifacts: record.artifacts,
			packageLock: record.packageLock,
			sbom: record.sbom,
		},
		{ target: record.target },
	);
}

function git(repoRoot, args) {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`git ${args[0]} failed: ${detail}`);
	}
}

function isMainModule() {
	return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
	try {
		const result = await createReleaseAttestation();
		process.stdout.write(
			`${JSON.stringify({
				schema: result.record.schema,
				stage: result.record.stage,
				status: result.record.status,
				commit: result.record.commit,
				target: result.record.target,
				dirty: result.record.dirty,
				path: result.file,
				sha256: result.sha256,
			})}\n`,
		);
	} catch (error) {
		process.stderr.write(
			`Release attestation failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
