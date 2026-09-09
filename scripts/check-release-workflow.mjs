import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const jobs = workflow?.jobs ?? {};
const triggers = workflow?.on ?? {};
const rcTagPattern = "v*.*.*-rc.*";
if (!Object.hasOwn(triggers, "workflow_dispatch")) {
	throw new Error("release workflow must remain manually dispatchable");
}
const rcTags = triggers.push?.tags;
if (!Array.isArray(rcTags) || !rcTags.includes(rcTagPattern)) {
	throw new Error(`release workflow must run for RC tags matching ${rcTagPattern}`);
}
const requiredJobs = [
	"quality",
	"upstream-brand",
	"security",
	"recovery",
	"e2e",
	"web-e2e",
	"soak",
	"package",
	"release-gate",
];
for (const name of requiredJobs) {
	if (!jobs[name]) throw new Error(`release workflow is missing required job: ${name}`);
}
if (jobs["live-model"]) throw new Error("release workflow must not run live-model in GitHub CI");

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
const linuxConfinementCommands = [
	"sudo apt-get install --yes apparmor bubblewrap",
	"sudo install --owner=root --group=root --mode=0644 .github/apparmor/bear-harness-bwrap",
	"sudo apparmor_parser --replace /etc/apparmor.d/bear-harness-bwrap",
	"bwrap --die-with-parent --new-session --unshare-all --share-net",
];
const requiredCommands = new Map([
	[
		"quality",
		[
			...linuxConfinementCommands,
			"npm ci",
			"npm run lint",
			"npm run typecheck",
			"npm run test:coverage --workspace @bear-harness/host-runtime",
			"tee host-coverage.log",
			"tail -n 200 host-coverage.log",
			"::error title=Host coverage failure::",
			'lastIndexOf("Failed Tests")',
			"npm run test:coverage --workspace @bear-harness/companion-ui",
			"npm run test:coverage --workspace @bear-harness/desktop",
			"npm run build",
		],
	],
	["security", ["npm audit --audit-level=high", "npm audit signatures"]],
	["recovery", ["npm run build:packages", "npm run test:release:recovery"]],
	["e2e", ["npm run build:packages", "npm run test:e2e:electron"]],
	[
		"web-e2e",
		[...linuxConfinementCommands, "npm run build:packages", "npm run test:e2e:web:required"],
	],
	[
		"soak",
		[
			...linuxConfinementCommands,
			"npm run build:packages",
			"npm run test:e2e:web:soak",
			"tee soak-run.log",
			"::error title=Soak failure::",
			"node scripts/release-attestation.mjs soak",
		],
	],
	[
		"package",
		[
			"npm run build:packages",
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

const soakEnvironment = jobs.soak?.env ?? {};
if (
	soakEnvironment.CI !== "1" ||
	soakEnvironment.BEAR_E2E_SOAK_MINUTES !== "120" ||
	soakEnvironment.BEAR_E2E_SOAK_MODE !== "release" ||
	jobs.soak?.["timeout-minutes"] !== 135
) {
	throw new Error("soak must run the frozen 120-minute background release profile");
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
