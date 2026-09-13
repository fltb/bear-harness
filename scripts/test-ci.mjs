import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const platformName = { linux: "linux", win32: "win", darwin: "mac" }[process.platform];
const matrixTarget = workflow.jobs.package.strategy.matrix.include.find(
	(entry) => entry["os-name"] === platformName && entry.arch === process.arch,
);
const target = matrixTarget && {
	name: matrixTarget["os-name"],
	arch: matrixTarget.arch,
	script: matrixTarget["package-cmd"],
	extensions: matrixTarget.exts.split(/\s+/),
};
const npm = (...args) => ({ executable: process.execPath, args: [npmCli, ...args] });
const run = (script, ...args) => npm("run", script, ...args);
const node = (script, ...args) => ({ executable: process.execPath, args: [script, ...args] });
const graphical = (command) =>
	process.platform === "linux"
		? { executable: "xvfb-run", args: ["-a", command.executable, ...command.args] }
		: command;

// Check commands mirror .github/workflows/ci.yml. Runner installation, artifact
// upload/download, and clean-commit release attestations belong to GitHub Actions.
const jobs = {
	quality: [
		...(process.platform === "linux"
			? [
					{
						executable: "bwrap",
						args: [
							"--die-with-parent",
							"--new-session",
							"--unshare-all",
							"--share-net",
							"--ro-bind",
							"/",
							"/",
							"--",
							"/bin/true",
						],
					},
				]
			: []),
		run("lint"),
		run("typecheck"),
		run("test:coverage", "--workspace", "@bear-harness/host-runtime"),
		run("test:coverage", "--workspace", "@bear-harness/companion-ui"),
		run("test:coverage", "--workspace", "@bear-harness/desktop"),
		run("build"),
	],
	"upstream-brand": [node("apps/desktop/scripts/check-upstream-brand.mjs")],
	security: [npm("audit", "--audit-level=high"), npm("audit", "signatures")],
	recovery: [run("build:packages"), run("test:release:recovery")],
	e2e: [run("build:packages"), run("build"), graphical(run("test:e2e:electron"))],
	"web-e2e": [
		run("build:packages"),
		npm("exec", "--no", "--", "playwright", "install", "chromium"),
		run("test:e2e:web:required"),
	],
	package: target
		? [
				run("build:packages"),
				run("build"),
				graphical(run("test:diagnostics:crash")),
				run(target.script),
				node("scripts/verify-package.mjs", target.name, target.arch, ...target.extensions),
				...(process.platform === "darwin" ? [{ verifyMacArchitecture: true }] : []),
				node("apps/desktop/scripts/verify-native-bindings.mjs", target.name, target.arch),
				...(process.platform === "linux"
					? [node("apps/desktop/scripts/verify-linux-artifacts.mjs")]
					: []),
				...(process.platform === "win32"
					? [
							node("apps/desktop/scripts/verify-windows-pe.mjs"),
							node(
								"apps/desktop/scripts/verify-windows-runtime.mjs",
								"apps/desktop/release/win-unpacked/resources",
							),
							{
								executable: "apps/desktop/release/win-unpacked/resources/git/usr/bin/bash.exe",
								args: ["--version"],
							},
							{
								executable: "apps/desktop/release/win-unpacked/resources/git/cmd/git.exe",
								args: ["--version"],
							},
						]
					: []),
				graphical(run("test:e2e:packaged")),
			]
		: [],
};
const args = process.argv.slice(2);
const list = args.includes("--list");
const selected = args.filter((arg) => arg !== "--list");
if (!target) throw new Error("This platform/architecture is not in the online CI package matrix");
for (const name of selected)
	if (!Object.hasOwn(jobs, name)) throw new Error(`Unknown CI job: ${name}`);
if (!npmCli) throw new Error("Run through npm: fnm exec --using=.nvmrc npm run test:ci");
const names = selected.length ? selected : Object.keys(jobs);
if (
	!list &&
	process.platform === "linux" &&
	names.some((name) => name === "e2e" || name === "package")
) {
	for (const executable of ["xvfb-run", "xauth"]) {
		const probe = spawnSync(executable, executable === "xauth" ? ["-V"] : ["--help"], {
			stdio: "ignore",
		});
		if (probe.error || probe.status !== 0)
			throw new Error(
				`Install working xvfb and xauth before running graphical CI jobs (${executable} unavailable).`,
				{ cause: probe.error },
			);
	}
}
for (const name of Object.keys(workflow.jobs)) {
	if (name !== "release-gate" && !Object.hasOwn(jobs, name))
		throw new Error(`Online CI added an unmapped job: ${name}`);
}
function commandText(command) {
	if (command.verifyMacArchitecture) return "";
	const argv = command.executable === "xvfb-run" ? command.args.slice(2) : command.args;
	return argv[0] === npmCli
		? `npm ${argv.slice(1).join(" ")}`
		: command.executable === process.execPath
			? `node ${argv.join(" ")}`
			: `${command.executable} ${argv.join(" ")}`;
}
for (const name of names) {
	const planned = jobs[name].map(commandText);
	for (const step of workflow.jobs[name].steps) {
		if (!step.run || step.if?.includes("failure()")) continue;
		if (step.if?.startsWith("matrix.os-name") && !step.if.includes(`'${target.name}'`)) continue;
		const body = step.run.replaceAll(/\$\{\{ matrix\.([\w-]+) \}\}/g, (_match, key) => {
			if (typeof matrixTarget[key] !== "string") throw new Error(`Unknown CI matrix value: ${key}`);
			return matrixTarget[key];
		});
		for (const match of body.matchAll(
			/(?:^|\n)\s*(?:xvfb-run -a )?((?:npm (?:run|audit)|node (?:scripts|apps)\/|npx --no-install playwright install)[^\n|]*)/g,
		)) {
			const command = match[1].replace(/\s+2>&1\s*$/, "").trim();
			if (command.startsWith("node scripts/release-attestation.mjs ")) continue;
			const normalized = command.replace("npx --no-install ", "npm exec --no -- ");
			if (!planned.includes(normalized))
				throw new Error(`Online CI check is missing from ${name}: ${command}`);
		}
	}
}
const env = {
	...process.env,
	BEAR_E2E_PROFILE: "hosted",
	BEAR_E2E_WEB_PORT: process.env.BEAR_E2E_WEB_PORT ?? "33200",
	BEAR_E2E_HOST_PORT: process.env.BEAR_E2E_HOST_PORT ?? "33201",
	BEAR_E2E_PROVIDER_PORT: process.env.BEAR_E2E_PROVIDER_PORT ?? "33211",
	BEAR_E2E_LIVE_MODEL: "0",
	BEAR_E2E_SOAK_MINUTES: "0",
	CSC_IDENTITY_AUTO_DISCOVERY: "false",
	APPIMAGE_EXTRACT_AND_RUN: "1",
};
function execute(command) {
	console.log(`> ${command.executable} ${command.args.join(" ")}`);
	if (list) return;
	const result = spawnSync(command.executable, command.args, { cwd: root, env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Online CI checks; native package target: ${target.name}-${target.arch}.`);
console.log(
	"Other platform targets and release attestations must still pass in GitHub Actions. No live-model or soak job exists in this CI workflow.",
);
for (const name of names) {
	console.log(`\n=== ${name} ===`);
	for (const command of jobs[name]) {
		if (!command.verifyMacArchitecture) {
			execute(command);
			continue;
		}
		if (list) {
			console.log("> lipo: verify packaged application and Electron framework target architecture");
			continue;
		}
		const { productConfig } = await import("@bear-harness/product-config");
		const release = join(root, "apps/desktop/release");
		const directory = target.arch === "arm64" ? "mac-arm64" : "mac";
		const apps = readdirSync(join(release, directory)).filter((entry) => entry.endsWith(".app"));
		if (apps.length !== 1) throw new Error("Expected exactly one packaged macOS application");
		for (const relative of [
			`Contents/MacOS/${productConfig.executableName}`,
			"Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
		]) {
			const result = spawnSync("lipo", ["-archs", join(release, directory, apps[0], relative)], {
				encoding: "utf8",
			});
			if (result.error) throw result.error;
			if (
				result.status !== 0 ||
				result.stdout.trim() !== (target.arch === "arm64" ? "arm64" : "x86_64")
			)
				throw new Error(`Incorrect packaged architecture: ${relative}`);
		}
	}
}
console.log(
	list
		? "CI check plan listed; no checks executed."
		: "Selected online CI checks passed for this machine; this is not an all-platform release attestation.",
);
