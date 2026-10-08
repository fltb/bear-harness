import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const cwd = resolve(import.meta.dirname, "..");
const count = Number(process.env.BEAR_E2E_SHARDS ?? "1");
if (![1, 2].includes(count)) throw new Error("BEAR_E2E_SHARDS must be 1 or 2");
if (count > 1 && process.env.BEAR_SHARED_BUILT !== "1")
	throw new Error("Build shared packages before starting isolated Web shards");
const output = resolve(cwd, "../../test-results/web-dev");
mkdirSync(output, { recursive: true });
const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		for (const child of children) child.kill(signal);
		process.exitCode = 1;
	});
const started = performance.now();
const results = await Promise.all(
	Array.from(
		{ length: count },
		(_, index) =>
			new Promise((resolveResult) => {
				const directory = resolve(output, `shard-${index + 1}`);
				const report = resolve(output, `shard-${index + 1}.json`);
				rmSync(report, { force: true });
				const offset = index * 100;
				const env = {
					...process.env,
					BEAR_E2E_OUTPUT_DIR: directory,
					PLAYWRIGHT_JSON_OUTPUT_FILE: report,
					BEAR_E2E_WEB_PORT: String(Number(process.env.BEAR_E2E_WEB_PORT ?? 3200) + offset),
					BEAR_E2E_HOST_PORT: String(Number(process.env.BEAR_E2E_HOST_PORT ?? 3201) + offset),
					BEAR_E2E_PROVIDER_PORT: String(
						Number(process.env.BEAR_E2E_PROVIDER_PORT ?? 3211) + offset,
					),
				};
				const child = spawn(
					process.execPath,
					[
						resolve(require.resolve("playwright/package.json"), "../cli.js"),
						"test",
						"--grep-invert",
						"configured live model answers",
						`--shard=${index + 1}/${count}`,
						...process.argv.slice(2),
					],
					{ cwd, env, stdio: "inherit" },
				);
				children.add(child);
				child.once("error", (error) => {
					console.error(error);
				});
				child.once("close", (code) => {
					children.delete(child);
					resolveResult({ shard: index + 1, code: code ?? 1, report });
				});
			}),
	),
);
const timings = [];
function visit(suites) {
	for (const suite of suites) {
		for (const spec of suite.specs ?? [])
			for (const test of spec.tests ?? []) {
				timings.push({
					file: spec.file,
					title: spec.title,
					milliseconds: test.results.reduce((sum, result) => sum + result.duration, 0),
					status: test.status,
				});
			}
		visit(suite.suites ?? []);
	}
}
for (const result of results) {
	try {
		visit(JSON.parse(readFileSync(result.report, "utf8")).suites);
	} catch (error) {
		console.error(`Missing or invalid shard ${result.shard} report`, error);
		result.code = 1;
	}
}
timings.sort((a, b) => b.milliseconds - a.milliseconds);
const elapsedSeconds = (performance.now() - started) / 1000;
writeFileSync(
	resolve(output, "timings.json"),
	JSON.stringify({ elapsedSeconds, results, tests: timings }, null, 2),
);
const summary = `Web E2E: ${count} isolated shard(s), ${elapsedSeconds.toFixed(1)}s elapsed\n\n| Test | Seconds | Result |\n| --- | ---: | --- |\n${timings.map((test) => `| ${test.file}: ${test.title.replaceAll("|", "/")} | ${(test.milliseconds / 1000).toFixed(2)} | ${test.status} |`).join("\n")}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (results.some((result) => result.code !== 0)) process.exitCode = 1;
