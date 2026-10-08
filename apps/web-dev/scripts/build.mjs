import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
function run(args, cwd) {
	const started = performance.now();
	const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	console.log(`web build: ${args.join(" ")} ${((performance.now() - started) / 1000).toFixed(2)}s`);
}
run(["scripts/build-workspaces.mjs"], root);
run(
	[process.env.npm_execpath, "exec", "--no", "--", "rsbuild", "build"],
	resolve(root, "apps/web-dev"),
);
