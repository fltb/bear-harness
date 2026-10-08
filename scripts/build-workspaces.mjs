import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const all = [
	"product-config",
	"i18n",
	"schema",
	"protocol",
	"companion-client",
	"tdai-core",
	"host-runtime",
];
const args = process.argv.slice(2);
const names = args.filter((name) => name !== "--force");
const selected = names.length ? names : all;
for (const name of selected) {
	if (!all.includes(name)) throw new Error(`Unknown shared workspace: ${name}`);
	if (process.env.BEAR_SHARED_BUILT === "1" && !args.includes("--force")) {
		if (!existsSync(resolve(root, "packages", name, "dist/index.js")))
			throw new Error(`Missing shared build: ${name}`);
		continue;
	}
	const started = performance.now();
	// Dependencies are ordered above; suppress recursive prebuild hooks only here.
	const result = spawnSync(
		process.execPath,
		[
			process.env.npm_execpath,
			"run",
			"--ignore-scripts",
			"build",
			"--workspace",
			`@bear-harness/${name}`,
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	console.log(`shared build: ${name} ${((performance.now() - started) / 1000).toFixed(2)}s`);
}
