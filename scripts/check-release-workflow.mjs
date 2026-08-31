import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const jobs = workflow?.jobs ?? {};
const requiredJobs = [
	"quality",
	"upstream-brand",
	"security",
	"recovery",
	"e2e",
	"web-e2e",
	"live-model",
	"package",
	"release-gate",
];
for (const name of requiredJobs) {
	if (!jobs[name]) throw new Error(`release workflow is missing required job: ${name}`);
}

const finalNeeds = new Set(
	Array.isArray(jobs["release-gate"].needs)
		? jobs["release-gate"].needs
		: [jobs["release-gate"].needs].filter(Boolean),
);
for (const name of requiredJobs.filter((name) => name !== "release-gate")) {
	if (!finalNeeds.has(name)) throw new Error(`release-gate must require successful ${name}`);
}

const matrix = jobs.package?.strategy?.matrix?.include;
if (!Array.isArray(matrix)) throw new Error("package job must use an explicit release matrix");
const actualTargets = new Set(matrix.map((entry) => `${entry["os-name"]}:${entry.arch}`));
const requiredTargets = ["mac:x64", "mac:arm64", "win:x64", "linux:x64"];
for (const target of requiredTargets) {
	if (!actualTargets.has(target)) throw new Error(`package matrix is missing ${target}`);
}
if (actualTargets.size !== requiredTargets.length) {
	throw new Error(`package matrix contains unreviewed targets: ${[...actualTargets].join(", ")}`);
}

function commands(job) {
	return (job?.steps ?? [])
		.map((step) => (typeof step.run === "string" ? step.run : ""))
		.join("\n");
}
const requiredCommands = new Map([
	[
		"quality",
		["npm ci", "npm run lint", "npm run typecheck", "npm run test:coverage", "npm run build"],
	],
	["security", ["npm audit --audit-level=high", "npm audit signatures"]],
	["recovery", ["npm run test:release:recovery"]],
	["e2e", ["npm run test:e2e:electron"]],
	["web-e2e", ["npm run test:e2e:web:required"]],
	["live-model", ["npm run test:e2e:web:live"]],
	[
		"package",
		[
			"npm run test:diagnostics:crash",
			"node scripts/verify-package.mjs",
			"npm run test:e2e:packaged",
			"node scripts/release-attestation.mjs package",
		],
	],
	["release-gate", ["node scripts/release-attestation.mjs final"]],
]);
for (const [job, expected] of requiredCommands) {
	const source = commands(jobs[job]);
	for (const command of expected) {
		if (!source.includes(command))
			throw new Error(`${job} is missing required command: ${command}`);
	}
}

const packageEvidenceUpload = jobs.package.steps.find(
	(step) =>
		typeof step?.uses === "string" &&
		step.uses.startsWith("actions/upload-artifact@") &&
		typeof step?.with?.name === "string" &&
		step.with.name.startsWith("release-attestation-package-"),
);
if (!packageEvidenceUpload) throw new Error("package job must upload release evidence");
const packageEvidencePaths = String(packageEvidenceUpload.with.path ?? "");
const matrixOs = ["$", "{{ matrix.os-name }}"].join("");
const matrixArch = ["$", "{{ matrix.arch }}"].join("");
for (const required of [
	`release-attestations/package-${matrixOs}-${matrixArch}.json`,
	`release-attestations/package-evidence-${matrixOs}-${matrixArch}.json`,
	`release-attestations/sbom-${matrixOs}-${matrixArch}.cdx.json`,
]) {
	if (!packageEvidencePaths.includes(required)) {
		throw new Error(`package evidence upload is missing: ${required}`);
	}
}

const lintCommand = rootPackage.scripts?.lint;
if (typeof lintCommand !== "string") throw new Error("root lint script is missing");
for (const contract of [
	"node scripts/check-release-baseline.mjs",
	"node scripts/check-release-version.mjs",
]) {
	if (!lintCommand.includes(contract))
		throw new Error(`CI quality lint does not execute release contract: ${contract}`);
}

console.log(
	"Release workflow contract passed: required jobs, commands, dependencies, targets and version gates present",
);
