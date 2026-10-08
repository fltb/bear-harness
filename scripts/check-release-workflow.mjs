import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { CI_JOB_STAGES, REQUIRED_CI_JOBS } from "./ci-contract.mjs";
import { PACKAGE_TARGETS } from "./release-evidence.mjs";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const jobs = workflow?.jobs ?? {};
const triggers = workflow?.on ?? {};
const approvedActionRefs = new Map(
	Object.entries(JSON.parse(readFileSync("config/upstream-binaries.json", "utf8")).actions),
);
for (const job of Object.values(jobs)) {
	for (const step of job?.steps ?? []) {
		if (typeof step?.uses !== "string") continue;
		const separator = step.uses.lastIndexOf("@");
		const action = step.uses.slice(0, separator);
		const ref = step.uses.slice(separator + 1);
		const approvedRef = approvedActionRefs.get(action);
		if (approvedRef && ref !== approvedRef) {
			throw new Error(`${action} must use the verified ${approvedRef} ref, received ${ref}`);
		}
	}
}
if (!Object.hasOwn(triggers, "pull_request")) throw new Error("CI must validate pull requests");
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
const requiredJobs = REQUIRED_CI_JOBS;
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

for (const name of ["quality", "recovery", "e2e", "web-e2e", "package"]) {
	if (JSON.stringify(jobs[name].needs) !== JSON.stringify(["preflight"])) {
		throw new Error(`${name} must start after preflight without waiting for other test jobs`);
	}
}
for (const [name, stage] of Object.entries(CI_JOB_STAGES)) {
	if (!stage) continue;
	const steps = jobs[name].steps ?? [];
	if (
		!steps.some((step) => step.run === `node scripts/release-attestation.mjs ${stage}`) ||
		!steps.some((step) => step.with?.name === `release-attestation-${stage}`)
	) {
		throw new Error(`${name} must produce and upload its ${stage} attestation`);
	}
}

const matrix = jobs.package?.strategy?.matrix?.include;
if (!Array.isArray(matrix)) throw new Error("package job must use an explicit release matrix");
const actualTargets = new Set(matrix.map((entry) => `${entry["os-name"]}:${entry.arch}`));
const requiredTargets = Object.keys(PACKAGE_TARGETS).map((target) =>
	target.replace(/-([^-]+)$/, ":$1"),
);
for (const target of requiredTargets) {
	if (!actualTargets.has(target)) throw new Error(`package matrix is missing ${target}`);
}
if (actualTargets.size !== requiredTargets.length) {
	throw new Error(`package matrix contains unreviewed targets: ${[...actualTargets].join(", ")}`);
}
if (matrix.length !== requiredTargets.length)
	throw new Error("package matrix must not duplicate targets");
if (jobs.package.name !== "package (${{ matrix.os-name }}-${{ matrix.arch }})") {
	throw new Error("package jobs must expose their exact platform target for automatic merging");
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
	["preflight", ["npm ci", "npm run lint", "npm run typecheck"]],
	[
		"quality",
		[
			...linuxConfinementCommands,
			"tee linux-confinement.log",
			"::error title=Linux confinement setup failure::",
			"npm ci",
			"node scripts/shared-build.mjs restore",
			"npm run test:unit:remaining",
			"npm run test:upstream",
			"npm run test:coverage --workspace @bear-harness/host-runtime",
			"tee host-coverage.log",
			"tail -n 200 host-coverage.log",
			"::error title=Host coverage failure::",
			'lastIndexOf("Failed Tests")',
			"npm run test:coverage --workspace @bear-harness/companion-ui",
			"npm run test:coverage --workspace @bear-harness/desktop",
			"npm run build --workspace @bear-harness/web-dev",
		],
	],
	["security", ["npm audit --audit-level=high", "npm audit signatures"]],
	["recovery", ["node scripts/shared-build.mjs restore", "npm run test:release:recovery"]],
	["e2e", ["node scripts/shared-build.mjs restore", "npm run test:e2e:electron:built"]],
	[
		"web-e2e",
		[
			...linuxConfinementCommands,
			"node scripts/shared-build.mjs restore",
			"npx --no-install playwright install chromium",
			"npm run test:e2e:web:required",
			"tee web-e2e.log",
			"::error title=Web E2E failure::",
		],
	],
	[
		"package",
		[
			"node scripts/shared-build.mjs restore",
			"npm run test:upstream:native",
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
			"tee package-attestation.log",
			"::error title=Package attestation failure::",
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

const packageAttestationStep = jobs.package.steps.find(
	(step) => step?.name === "Attest packaged target",
);
if (packageAttestationStep?.id !== "package_attestation") {
	throw new Error("Package attestation must expose a step outcome for focused diagnostics");
}
const packageAttestationFailure = jobs.package.steps.find(
	(step) => step?.name === "Publish package attestation failure",
);
if (
	packageAttestationFailure?.if !== "failure() && steps.package_attestation.outcome == 'failure'"
) {
	throw new Error("Package attestation diagnostics must report only their own failure");
}

const finalAttestationStep = jobs["release-gate"].steps.find(
	(step) => step?.name === "Attest complete release",
);
if (finalAttestationStep?.id !== "final_attestation") {
	throw new Error("Final attestation must expose a step outcome for focused diagnostics");
}
if (!String(finalAttestationStep.run ?? "").includes("tee final-attestation.log")) {
	throw new Error("Final attestation must preserve its complete failure output");
}
const finalAttestationFailure = jobs["release-gate"].steps.find(
	(step) => step?.name === "Publish final attestation failure",
);
if (finalAttestationFailure?.if !== "failure() && steps.final_attestation.outcome == 'failure'") {
	throw new Error("Final attestation diagnostics must report only their own failure");
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

const publishWorkflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const publishTriggers = publishWorkflow?.on ?? {};
const publishTags = publishTriggers.push?.tags;
if (!Array.isArray(publishTags) || !publishTags.includes("v*.*.*")) {
	throw new Error("publish workflow must support stable and RC release tags");
}
if (publishTriggers.push?.branches !== undefined) {
	throw new Error("publish workflow must not run for branch pushes");
}
if (publishWorkflow?.permissions?.actions !== "read") {
	throw new Error("publish workflow needs read-only Actions access to validated artifacts");
}
if (publishWorkflow?.permissions?.contents !== "write") {
	throw new Error("publish workflow needs contents write access to create the GitHub prerelease");
}
const publishJob = publishWorkflow?.jobs?.publish;
if (!publishJob) throw new Error("publish workflow is missing the publish job");
const publishSource = commands(publishJob);
for (const command of [
	"git rev-parse HEAD",
	"actions/workflows/ci.yml/runs",
	'conclusion == "success"',
	'head_branch == "main"',
	"gh run download",
	...Object.values(CI_JOB_STAGES)
		.filter(Boolean)
		.map((stage) => `release-attestation-${stage}`),
	"release-attestation-final",
	"node scripts/verify-release-download.mjs",
	"gh release create",
	"--verify-tag",
	"--prerelease",
	"--draft",
	"bash scripts/sign-release.sh release-downloads/SHA256SUMS.txt",
	"release-downloads/SHA256SUMS.txt.asc",
	"config/release-public.asc",
	"gh release edit",
	"--draft=false",
	'echo "latest=true"',
	'echo "prerelease=false"',
	"steps.source.outputs.latest",
	"steps.source.outputs.prerelease",
]) {
	if (!publishSource.includes(command)) {
		throw new Error(`publish workflow is missing required command: ${command}`);
	}
}
for (const forbidden of [
	"npm ci",
	"npm run test",
	"playwright",
	"live-model",
	"soak",
	"electron-builder",
]) {
	if (publishSource.includes(forbidden)) {
		throw new Error(`publish workflow must not rebuild or rerun validation: ${forbidden}`);
	}
}
const publishUses = (publishJob.steps ?? [])
	.map((step) => (typeof step?.uses === "string" ? step.uses : ""))
	.filter(Boolean);
if (
	publishUses.length !== 1 ||
	publishUses[0] !== `actions/checkout@${approvedActionRefs.get("actions/checkout")}`
) {
	throw new Error("publish workflow may only use the pinned checkout action");
}

console.log(
	"Publish workflow contract passed: green-run artifact reuse and stable/RC publication present",
);

// All consumers use the producer's exact same-run, same-commit output.
for (const name of ["preflight", "quality", "recovery", "e2e", "web-e2e", "package"]) {
	const job = jobs[name];
	if (job.env?.BEAR_SHARED_BUILT !== "1") throw new Error(`${name} must reuse its shared build`);
	const producer = name === "preflight";
	const build = job.steps.findIndex(
		(step) =>
			step.run === (producer ? "npm run build:packages" : "node scripts/shared-build.mjs restore"),
	);
	const firstCheck = job.steps.findIndex((step) =>
		/npm run (lint|typecheck|test:|build(?: |\n|$))/.test(step.run ?? ""),
	);
	if (build < 0 || (firstCheck >= 0 && build >= firstCheck))
		throw new Error(`${name} must prepare shared outputs before consuming them`);
	if (!producer) {
		const download = job.steps.findIndex(
			(step) =>
				step.uses?.startsWith("actions/download-artifact@") &&
				step.with?.name === "shared-build-${{ github.sha }}" &&
				step.with?.path === ".cache/ci/shared-build",
		);
		if (download < 0 || download >= build)
			throw new Error(`${name} must download this commit's build`);
		if (
			/npm run build:packages|npm run build --workspace @bear-harness\/desktop/.test(commands(job))
		)
			throw new Error(`${name} must not rebuild shared desktop outputs`);
	}
}
const producerCommands = commands(jobs.preflight);
if (
	!producerCommands.includes("npm run build --workspace @bear-harness/desktop -- --shared-built") ||
	!producerCommands.includes("node scripts/shared-build.mjs create") ||
	!jobs.preflight.steps.some(
		(step) =>
			step.uses?.startsWith("actions/upload-artifact@") &&
			step.with?.name === "shared-build-${{ github.sha }}" &&
			step.with?.path === ".cache/ci/shared-build/",
	)
) {
	throw new Error("preflight must build and export the common desktop payload");
}
for (const name of ["release-gate", "upstream-brand"]) {
	const setup = jobs[name].steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
	if (setup?.with?.cache || setup?.with?.["package-manager-cache"] !== false)
		throw new Error(`${name} does not install dependencies and must not restore npm cache`);
	if (/npm (ci|install)/.test(commands(jobs[name])))
		throw new Error(`${name} must remain dependency-free`);
}
if (jobs["web-e2e"].env.BEAR_E2E_SHARDS !== "2")
	throw new Error("Web CI must run two isolated shards");
if (!commands(jobs["web-e2e"]).includes("playwright install chromium --no-shell"))
	throw new Error("Do not download unused headless shell");
if (
	!jobs.package.steps.some((step) => step.name === "Cache packaging downloads") ||
	!jobs.package.steps.some((step) => step.name === "Cache verified embedding fixture")
)
	throw new Error("Package jobs must cache their verified upstream downloads");
