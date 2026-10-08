import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.npm_execpath) throw new Error("Run through npm run test:upstream");
const manifest = JSON.parse(readFileSync("config/upstream-contracts.json", "utf8"));
const groups = new Map();
for (const file of new Set(manifest.groups.flatMap((group) => group.evidence))) {
	if (!/^packages\/[^/]+\/tests\/.*\.spec\.tsx?$/.test(file)) continue;
	const [root, name, ...rest] = file.split("/");
	const workspace = `${root}/${name}`;
	if (!groups.has(workspace)) groups.set(workspace, []);
	groups.get(workspace).push(rest.join("/"));
}
function run(args) {
	const result = spawnSync(process.execPath, args, {
		stdio: "inherit",
		env: {
			...process.env,
			BEAR_COVERAGE: "0",
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --expose-gc`,
		},
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["scripts/check-upstream-contracts.mjs"]);
run(["--test", "scripts/upstream-versions.test.mjs", "scripts/upstream-merge.test.mjs"]);
const reports = mkdtempSync(join(tmpdir(), "bear-contract-reports-"));
try {
	for (const [workspace, files] of groups) {
		const output = join(reports, `${workspace.split("/")[1]}.json`);
		run([
			process.env.npm_execpath,
			"exec",
			"--workspace",
			workspace,
			"--",
			"vitest",
			"run",
			...files,
			"--reporter=default",
			"--reporter=json",
			`--outputFile.json=${output}`,
		]);
		const report = JSON.parse(readFileSync(output, "utf8"));
		assert(report.numTotalTests > 0, `${workspace}: no contracts discovered`);
		assert.equal(
			report.numPassedTests,
			report.numTotalTests,
			`${workspace}: required contracts cannot skip or remain pending`,
		);
	}
} finally {
	rmSync(reports, { recursive: true, force: true });
}
