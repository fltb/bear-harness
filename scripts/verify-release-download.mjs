import { createHash } from "node:crypto";
import {
	createReadStream,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TARGETS = ["mac-x64", "mac-arm64", "win-x64", "linux-x64"];

export function validateReleaseTag(tag, version) {
	const prefix = `v${version}-rc.`;
	if (!tag.startsWith(prefix)) throw new Error(`release tag must start with ${prefix}`);
	const suffix = tag.slice(prefix.length);
	if (
		suffix.length === 0 ||
		(suffix.length > 1 && suffix.startsWith("0")) ||
		![...suffix].every((character) => character >= "0" && character <= "9") ||
		Number(suffix) < 1
	) {
		throw new Error("release tag must end with a positive decimal RC number");
	}
	return Number(suffix);
}

export async function verifyReleaseDownload(options) {
	const repoRoot = resolve(options.repoRoot ?? ".");
	const downloadRoot = resolve(options.downloadRoot);
	const commit = options.commit;
	const rootPackage = readJson(join(repoRoot, "package.json"), "root package");
	validateReleaseTag(options.tag, rootPackage.version);
	const evidenceFiles = indexEvidenceFiles(downloadRoot);
	const finalPath = requiredEvidence(evidenceFiles, "final.json");
	const final = readJson(finalPath, "final attestation");
	validateAttestation(final, { stage: "final", commit });
	if (!plainObject(final.inputs)) throw new Error("final attestation is missing inputs");

	const stages = final.inputs.stages;
	if (!Array.isArray(stages) || stages.length !== 4) {
		throw new Error("final attestation must reference all four required validation stages");
	}
	const actualStages = new Set(stages.map((record) => record.stage));
	for (const stage of ["quality", "recovery", "electron-e2e", "web-e2e"]) {
		if (!actualStages.has(stage)) throw new Error(`final attestation is missing ${stage}`);
	}
	for (const stage of stages) {
		validateReference(stage, "stage attestation");
		await verifyReference(requiredEvidence(evidenceFiles, stage.path), stage, "stage attestation");
		const record = readJson(requiredEvidence(evidenceFiles, stage.path), stage.path);
		validateAttestation(record, { stage: stage.stage, commit });
	}

	const assets = [];
	const packages = final.inputs.packages;
	if (!Array.isArray(packages) || packages.length !== TARGETS.length) {
		throw new Error("final attestation must reference all four package targets");
	}
	const actualTargets = new Set(packages.map((record) => record.target));
	for (const target of TARGETS) {
		if (!actualTargets.has(target)) throw new Error(`final attestation is missing ${target}`);
	}

	for (const packageReference of packages) {
		validateReference(packageReference, "package attestation");
		const packagePath = requiredEvidence(evidenceFiles, packageReference.path);
		await verifyReference(packagePath, packageReference, "package attestation");
		const packageRecord = readJson(packagePath, packageReference.path);
		validateAttestation(packageRecord, {
			stage: "package",
			commit,
			target: packageReference.target,
		});
		if (!plainObject(packageRecord.packageEvidence)) {
			throw new Error(`${packageReference.target} is missing package evidence`);
		}
		validateReference(packageRecord.packageEvidence, "package evidence");
		const packageEvidencePath = requiredEvidence(evidenceFiles, packageRecord.packageEvidence.path);
		await verifyReference(packageEvidencePath, packageRecord.packageEvidence, "package evidence");
		const packageEvidence = readJson(packageEvidencePath, packageRecord.packageEvidence.path);
		if (
			packageEvidence.target !== packageReference.target ||
			packageEvidence.version !== rootPackage.version ||
			JSON.stringify(packageEvidence.artifacts) !== JSON.stringify(packageRecord.artifacts)
		) {
			throw new Error(`${packageReference.target} package evidence does not match its attestation`);
		}

		const assetDirectory = containedPath(
			downloadRoot,
			join(downloadRoot, `bear-harness-${packageReference.target}`),
			`${packageReference.target} asset directory`,
		);
		const expectedNames = new Set();
		for (const artifact of packageRecord.artifacts ?? []) {
			validateReference(artifact, `${packageReference.target} artifact`, "name");
			const assetPath = containedPath(
				assetDirectory,
				join(assetDirectory, artifact.name),
				artifact.name,
			);
			await verifyReference(assetPath, artifact, `${packageReference.target} artifact`, "name");
			expectedNames.add(artifact.name);
			assets.push({ name: artifact.name, path: assetPath, sha256: artifact.sha256 });
		}
		const actualNames = regularFiles(assetDirectory).map((path) => basename(path));
		if (
			actualNames.length !== expectedNames.size ||
			actualNames.some((name) => !expectedNames.has(name))
		) {
			throw new Error(`${packageReference.target} contains an unverified or missing release asset`);
		}
	}

	const names = new Set();
	for (const asset of assets) {
		if (names.has(asset.name)) throw new Error(`duplicate release asset name: ${asset.name}`);
		names.add(asset.name);
	}
	assets.sort((left, right) => left.name.localeCompare(right.name));
	const manifestPath = join(downloadRoot, "SHA256SUMS.txt");
	writeFileSync(
		manifestPath,
		`${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`,
		{ encoding: "utf8", flag: "wx" },
	);
	return { assets, finalPath, manifestPath };
}

function indexEvidenceFiles(downloadRoot) {
	const index = new Map();
	for (const path of regularFiles(downloadRoot)) {
		const topLevel = relative(downloadRoot, path).split(sep)[0];
		if (!topLevel?.startsWith("release-attestation-")) continue;
		const name = basename(path);
		if (index.has(name)) throw new Error(`duplicate evidence filename: ${name}`);
		index.set(name, path);
	}
	return index;
}

function requiredEvidence(index, name) {
	if (basename(name) !== name) throw new Error(`unsafe evidence filename: ${name}`);
	const path = index.get(name);
	if (!path) throw new Error(`downloaded evidence is missing ${name}`);
	return path;
}

function validateAttestation(record, expected) {
	if (!plainObject(record) || record.status !== "passed" || record.dirty !== false) {
		throw new Error(`${expected.stage} attestation did not pass cleanly`);
	}
	if (record.stage !== expected.stage || record.commit !== expected.commit) {
		throw new Error(`${expected.stage} attestation belongs to another source revision`);
	}
	if (expected.target !== undefined && record.target !== expected.target) {
		throw new Error(`${expected.stage} attestation belongs to another target`);
	}
}

function validateReference(reference, label, pathField = "path") {
	if (!plainObject(reference)) throw new Error(`${label} reference is invalid`);
	const name = reference[pathField];
	if (typeof name !== "string" || basename(name) !== name) {
		throw new Error(`${label} filename is invalid`);
	}
	if (!Number.isSafeInteger(reference.size) || reference.size <= 0) {
		throw new Error(`${label} size is invalid`);
	}
	if (!isSha256(reference.sha256)) throw new Error(`${label} digest is invalid`);
}

async function verifyReference(path, reference, label, pathField = "path") {
	validateReference(reference, label, pathField);
	const source = lstatSync(path);
	if (!source.isFile() || source.isSymbolicLink())
		throw new Error(`${label} is not a regular file`);
	if (source.size !== reference.size || (await sha256File(path)) !== reference.sha256) {
		throw new Error(`${label} digest mismatch`);
	}
}

function regularFiles(root) {
	if (!existsSync(root) || !lstatSync(root).isDirectory()) {
		throw new Error(`expected download directory is missing: ${root}`);
	}
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = containedPath(root, join(directory, entry.name), "download entry");
			if (entry.isSymbolicLink()) throw new Error(`download entry may not be a symlink: ${path}`);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(path);
			else throw new Error(`download entry must be a regular file: ${path}`);
		}
	};
	visit(root);
	return files;
}

function containedPath(root, candidate, label) {
	const resolvedRoot = resolve(root);
	const resolvedCandidate = resolve(candidate);
	const local = relative(resolvedRoot, resolvedCandidate);
	if (
		local === ".." ||
		local.startsWith(`..${sep}`) ||
		resolve(resolvedRoot, local) !== resolvedCandidate
	) {
		throw new Error(`${label} escapes its expected directory`);
	}
	return resolvedCandidate;
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${label} is not valid JSON`, { cause: error });
	}
}

function plainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value) {
	return (
		typeof value === "string" &&
		value.length === 64 &&
		[...value].every(
			(character) =>
				(character >= "0" && character <= "9") || (character >= "a" && character <= "f"),
		)
	);
}

function sha256File(path) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

function isMainModule() {
	return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
	const [downloadRoot, tag, commit] = process.argv.slice(2);
	if (!downloadRoot || !tag || !commit) {
		process.stderr.write("usage: verify-release-download.mjs <download-root> <tag> <commit>\n");
		process.exitCode = 2;
	} else {
		try {
			const result = await verifyReleaseDownload({ downloadRoot, tag, commit });
			process.stdout.write(
				`${JSON.stringify({
					assets: result.assets.map((asset) => asset.path),
					finalAttestation: result.finalPath,
					manifest: result.manifestPath,
				})}\n`,
			);
		} catch (error) {
			process.stderr.write(
				`Release download verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		}
	}
}
