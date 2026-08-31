import { createHash } from "node:crypto";
import {
	createReadStream,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const RELEASE_ATTESTATION_SCHEMA = 2;
export const PACKAGE_EVIDENCE_SCHEMA = 1;
export const PACKAGE_TARGETS = Object.freeze({
	"mac-x64": Object.freeze(["dmg", "zip"]),
	"mac-arm64": Object.freeze(["dmg", "zip"]),
	"win-x64": Object.freeze(["exe", "zip"]),
	"linux-x64": Object.freeze(["AppImage", "deb"]),
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function packageTarget(osName, arch) {
	const target = `${osName}-${arch}`;
	if (!(target in PACKAGE_TARGETS)) throw new Error(`unsupported release target: ${target}`);
	return target;
}

export function requireExpectedExtensions(target, extensions) {
	const expected = PACKAGE_TARGETS[target];
	if (!expected) throw new Error(`unsupported release target: ${target}`);
	const actual = [...extensions];
	if (
		actual.length !== expected.length ||
		[...actual].sort().some((extension, index) => extension !== [...expected].sort()[index])
	) {
		throw new Error(
			`release target ${target} requires extensions ${expected.join(", ")}; received ${actual.join(", ") || "none"}`,
		);
	}
	return expected;
}

export function assertContainedFile(root, path, label) {
	const canonicalRoot = resolve(root);
	const candidate = resolve(path);
	const child = relative(canonicalRoot, candidate);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error(`${label} must be a file below ${canonicalRoot}`);
	}
	const stat = lstatSync(candidate);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
	return { path: candidate, size: stat.size };
}

export async function sha256File(path) {
	const hash = createHash("sha256");
	await new Promise((resolvePromise, reject) => {
		const input = createReadStream(path);
		input.on("data", (chunk) => hash.update(chunk));
		input.once("error", reject);
		input.once("end", resolvePromise);
	});
	return hash.digest("hex");
}

export function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function readJson(path, label = basename(path)) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parsed;
}

export function writeJsonAtomic(path, value) {
	const body = `${JSON.stringify(value, null, 2)}\n`;
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, body, { encoding: "utf8", flush: true, mode: 0o600 });
	renameSync(temporary, path);
	return { body, bytes: Buffer.byteLength(body), sha256: sha256Text(body) };
}

export function validateCycloneDx(document, expected = {}) {
	if (!isRecord(document) || document.bomFormat !== "CycloneDX") {
		throw new Error("SBOM must be a CycloneDX document");
	}
	if (typeof document.specVersion !== "string" || !/^1\.[4-9]$/.test(document.specVersion)) {
		throw new Error(`unsupported CycloneDX specVersion: ${String(document.specVersion)}`);
	}
	if (typeof document.serialNumber !== "string" || !document.serialNumber.startsWith("urn:uuid:")) {
		throw new Error("CycloneDX SBOM is missing a UUID serialNumber");
	}
	if (!isRecord(document.metadata) || !isRecord(document.metadata.component)) {
		throw new Error("CycloneDX SBOM is missing metadata.component");
	}
	const component = document.metadata.component;
	if (expected.packageName && component.name !== expected.packageName) {
		throw new Error(
			`CycloneDX root component mismatch: expected ${expected.packageName}, received ${String(component.name)}`,
		);
	}
	if (expected.version && component.version !== expected.version) {
		throw new Error(
			`CycloneDX root version mismatch: expected ${expected.version}, received ${String(component.version)}`,
		);
	}
	if (!Array.isArray(document.components) || document.components.length === 0) {
		throw new Error("CycloneDX SBOM must contain dependency components");
	}
	if (!Array.isArray(document.dependencies)) {
		throw new Error("CycloneDX SBOM must contain a dependencies graph");
	}
	return {
		format: "CycloneDX",
		specVersion: document.specVersion,
		serialNumber: document.serialNumber,
		componentCount: document.components.length + 1,
		rootComponent: {
			name: String(component.name),
			version: String(component.version),
		},
	};
}

export function validatePackageEvidence(evidence, expected = {}) {
	if (!isRecord(evidence) || evidence.schema !== PACKAGE_EVIDENCE_SCHEMA) {
		throw new Error("package evidence has an unsupported schema");
	}
	if (typeof evidence.target !== "string" || !(evidence.target in PACKAGE_TARGETS)) {
		throw new Error(`package evidence has an unsupported target: ${String(evidence.target)}`);
	}
	if (expected.target && evidence.target !== expected.target) {
		throw new Error(`package evidence target mismatch: expected ${expected.target}`);
	}
	for (const field of ["productName", "executableName", "dataDirectoryName", "appId", "version"]) {
		if (typeof evidence[field] !== "string" || evidence[field].length === 0) {
			throw new Error(`package evidence is missing ${field}`);
		}
	}
	if (expected.version && evidence.version !== expected.version) {
		throw new Error(`package evidence version mismatch: expected ${expected.version}`);
	}
	if (!Array.isArray(evidence.artifacts))
		throw new Error("package evidence artifacts must be an array");
	const expectedExtensions = PACKAGE_TARGETS[evidence.target];
	if (evidence.artifacts.length !== expectedExtensions.length) {
		throw new Error(`package evidence for ${evidence.target} has an incomplete artifact set`);
	}
	const extensions = new Set();
	const names = new Set();
	for (const artifact of evidence.artifacts) {
		if (!isRecord(artifact)) throw new Error("package evidence contains an invalid artifact");
		if (typeof artifact.ext !== "string" || !expectedExtensions.includes(artifact.ext)) {
			throw new Error(`package evidence contains an unexpected extension: ${String(artifact.ext)}`);
		}
		if (extensions.has(artifact.ext))
			throw new Error(`duplicate package extension: ${artifact.ext}`);
		extensions.add(artifact.ext);
		if (
			typeof artifact.name !== "string" ||
			artifact.name.length === 0 ||
			basename(artifact.name) !== artifact.name
		) {
			throw new Error("package evidence contains an unsafe artifact name");
		}
		if (names.has(artifact.name)) throw new Error(`duplicate package artifact: ${artifact.name}`);
		names.add(artifact.name);
		if (typeof artifact.path !== "string" || isAbsolute(artifact.path)) {
			throw new Error(`package artifact ${artifact.name} must use a repository-relative path`);
		}
		if (artifact.path !== `apps/desktop/release/${artifact.name}`) {
			throw new Error(`package artifact ${artifact.name} has an unexpected evidence path`);
		}
		if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
			throw new Error(`package artifact ${artifact.name} has an invalid size`);
		}
		requireSha256(artifact.sha256, `package artifact ${artifact.name}`);
	}
	for (const extension of expectedExtensions) {
		if (!extensions.has(extension)) throw new Error(`package evidence is missing .${extension}`);
	}
	validateDigestRecord(evidence.packageLock, "package lock");
	if (evidence.packageLock.path !== "package-lock.json") {
		throw new Error("package evidence must bind the root package-lock.json");
	}
	validateDigestRecord(evidence.sbom, "SBOM");
	if (evidence.sbom.format !== "CycloneDX")
		throw new Error("package evidence SBOM format mismatch");
	if (typeof evidence.sbom.specVersion !== "string") {
		throw new Error("package evidence SBOM is missing specVersion");
	}
	if (!Number.isSafeInteger(evidence.sbom.componentCount) || evidence.sbom.componentCount <= 1) {
		throw new Error("package evidence SBOM has an invalid component count");
	}
	if (
		typeof evidence.sbom.path !== "string" ||
		isAbsolute(evidence.sbom.path) ||
		basename(evidence.sbom.path) !== evidence.sbom.path
	) {
		throw new Error("package evidence SBOM path must be a safe evidence filename");
	}
	return evidence;
}

export function requireSha256(value, label) {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new Error(`${label} is missing a valid SHA-256 digest`);
	}
	return value;
}

export function digestRecord(path, bodyOrSize, digest) {
	const size = typeof bodyOrSize === "string" ? Buffer.byteLength(bodyOrSize) : bodyOrSize;
	const sha256 = digest ?? (typeof bodyOrSize === "string" ? sha256Text(bodyOrSize) : undefined);
	return { path, size, sha256 };
}

function validateDigestRecord(value, label) {
	if (!isRecord(value) || typeof value.path !== "string" || isAbsolute(value.path)) {
		throw new Error(`${label} evidence must use a relative path`);
	}
	if (!Number.isSafeInteger(value.size) || value.size <= 0) {
		throw new Error(`${label} evidence has an invalid size`);
	}
	requireSha256(value.sha256, label);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
