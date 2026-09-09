import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const jobs = workflow?.jobs ?? {};
const triggers = workflow?.on ?? {};
if (!Object.hasOwn(triggers, "workflow_dispatch")) {
	throw new Error("release workflow must remain manually dispatchable");
}
const releaseBranches = triggers.push?.branches;
if (!Array.isArray(releaseBranches) || !releaseBranches.includes("main")) {
	throw new Error("release workflow must validate main before an RC tag is created");
}
if (triggers.push?.tags !== undefined) {
	throw new Error("release workflow must not duplicate a validated main run for RC tags");
}
const concurrencyGroup = ["bear-harness-ci-$", "{{ github.ref }}"].join("");
if (workflow?.concurrency?.group !== concurrencyGroup) {
	throw new Error("release workflow must deduplicate concurrent runs for the same ref");
}
if (workflow?.concurrency?.["cancel-in-progress"] !== true) {
	throw new Error("release workflow must cancel an older run for the same ref");
}
const requiredJobs = [
	"quality",
	"upstream-brand",
	"security",
	"recovery",
	"e2e",
	"web-e2e",
	"package",
	"release-gate",
];
for (const name of requiredJobs) {
	if (!jobs[name]) throw new Error(`release workflow is missing required job: ${name}`);
}
if (jobs["live-model"]) throw new Error("release workflow must not run live-model in GitHub CI");
if (jobs.soak) throw new Error("release workflow must not run endurance tests in GitHub CI");
if (jobs["web-e2e"]?.env?.BEAR_E2E_PROFILE !== "hosted") {
	throw new Error("web-e2e must select the deterministic hosted-runner profile");
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
const macIntel = matrix.find((entry) => entry["os-name"] === "mac" && entry.arch === "x64");
if (macIntel?.os !== "macos-15-intel") {
	throw new Error("macOS x64 packaging must use the supported macos-15-intel runner");
}

function commands(job) {
	return (job?.steps ?? [])
		.map((step) => (typeof step.run === "string" ? step.run : ""))
		.join("\n");
}
const linuxConfinementCommands = [
	"sudo apt-get --option Acquire::Retries=3 --option Dir::Etc::sourcelist=sources.list.d/ubuntu.sources --option Dir::Etc::sourceparts=- update",
	"sudo apt-get --option Acquire::Retries=3 install --yes apparmor bubblewrap",
	"sudo install --owner=root --group=root --mode=0644 .github/apparmor/bear-harness-bwrap",
	"sudo apparmor_parser --replace /etc/apparmor.d/bear-harness-bwrap",
	"bwrap --die-with-parent --new-session --unshare-all --share-net",
];
const requiredCommands = new Map([
	[
		"quality",
		[
			...linuxConfinementCommands,
			"tee linux-confinement.log",
			"::error title=Linux confinement setup failure::",
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
		[
			...linuxConfinementCommands,
			"npm run build:packages",
			"npx --no-install playwright install chromium",
			"npm run test:e2e:web:required",
			"tee web-e2e.log",
			"::error title=Web E2E failure::",
		],
	],
	[
		"package",
		[
			"npm run build:packages",
			"sudo apt-get --option Acquire::Retries=3 --option Dir::Etc::sourcelist=sources.list.d/ubuntu.sources --option Dir::Etc::sourceparts=- update",
			"sudo apt-get --option Acquire::Retries=3 install --yes",
			"xvfb",
			"xvfb-run -a npm run test:diagnostics:crash",
			"tee crashpad-smoke.log",
			"::error title=Crashpad smoke failure::",
			"tee package.log",
			"::error title=Package failure::",
			".slice(-3_000)",
			"node scripts/verify-package.mjs",
			"tee package-evidence.log",
			"::error title=Package evidence failure::",
			"node apps/desktop/scripts/verify-windows-pe.mjs",
			"node apps/desktop/scripts/verify-linux-artifacts.mjs",
			"tee packaged-smoke.log",
			"::error title=Packaged smoke failure::",
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

const hostCoverageStep = jobs.quality.steps.find((step) => step?.name === "Host coverage");
if (hostCoverageStep?.id !== "host_coverage") {
	throw new Error("Host coverage must expose a step outcome for focused failure reporting");
}

const confinementStep = jobs.quality.steps.find(
	(step) => step?.name === "Install Linux confinement runtime",
);
if (confinementStep?.id !== "linux_confinement") {
	throw new Error("Linux confinement setup must expose a step outcome for focused diagnostics");
}
const confinementFailure = jobs.quality.steps.find(
	(step) => step?.name === "Publish Linux confinement setup failure",
);
if (confinementFailure?.if !== "failure() && steps.linux_confinement.outcome == 'failure'") {
	throw new Error("Linux confinement diagnostics must report only its own setup failure");
}
const hostCoverageFailure = jobs.quality.steps.find(
	(step) => step?.name === "Publish Host coverage failure",
);
if (hostCoverageFailure?.if !== "failure() && steps.host_coverage.outcome == 'failure'") {
	throw new Error("Host coverage failure reporting must not react to unrelated setup failures");
}
const hostCoverageLog = jobs.quality.steps.find(
	(step) => step?.name === "Preserve Host coverage log",
);
if (hostCoverageLog?.if !== "always() && steps.host_coverage.outcome != 'skipped'") {
	throw new Error("Host coverage log upload must only run after the coverage step ran");
}

const webE2eStep = jobs["web-e2e"].steps.find((step) => step?.name === "Run required Web E2E");
if (webE2eStep?.id !== "web_e2e") {
	throw new Error("Web E2E must expose a step outcome for focused failure reporting");
}
const webE2eFailure = jobs["web-e2e"].steps.find(
	(step) => step?.name === "Publish Web E2E failure",
);
if (webE2eFailure?.if !== "failure() && steps.web_e2e.outcome == 'failure'") {
	throw new Error("Web E2E failure reporting must not react to unrelated setup failures");
}
const webE2eDiagnostics = jobs["web-e2e"].steps.find(
	(step) => step?.name === "Preserve Web E2E diagnostics",
);
if (webE2eDiagnostics?.if !== "always() && steps.web_e2e.outcome != 'skipped'") {
	throw new Error("Web E2E diagnostics must only upload after the test step ran");
}

const linuxElectronRuntimeStep = jobs.package.steps.find(
	(step) => step?.name === "Install Linux Electron runtime",
);
if (!linuxElectronRuntimeStep) {
	throw new Error("package job must install the Linux Electron runtime");
}
if (linuxElectronRuntimeStep.if !== "matrix.os-name == 'linux'") {
	throw new Error("Linux Electron runtime installation must only run for the Linux package");
}
const crashpadStep = jobs.package.steps.find(
	(step) => step?.name === "Crashpad smoke (production config, temp root)",
);
if (!crashpadStep || crashpadStep.shell !== "bash") {
	throw new Error("package Crashpad smoke must use a cross-platform bash launcher");
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
