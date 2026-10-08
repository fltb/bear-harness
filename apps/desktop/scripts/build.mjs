/**
 * Production build: clean dist, validate product config (writes
 * dist/brand/BRAND-ATTRIBUTION.txt), compile main, flatten the main emit
 * layout, compile preload, then run the Rsbuild renderer build.
 *
 * The app's main TypeScript project emits `dist/main/src/main/*`; this
 * script promotes that entry to `dist/main/index.js` after building the
 * shared runtime packages. The desktop shell only imports those packages
 * through their public exports.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenMainEmit } from "./flatten-main.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repoRoot = resolve(desktop, "..", "..");
const npmCli = process.env.npm_execpath;
// CI builds these packages in the same checkout before native dependency tests.
const sharedBuilt =
	process.argv.includes("--shared-built") || process.env.BEAR_SHARED_BUILT === "1";

function run(cmd, args, cwd = desktop) {
	const started = performance.now();
	const result = spawnSync(cmd, args, {
		cwd,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
	process.stdout.write(
		`build timing: ${args.join(" ")} ${((performance.now() - started) / 1000).toFixed(2)}s\n`,
	);
}

rmSync(resolve(desktop, "dist"), { recursive: true, force: true });
// Release staging starts with a validated, deterministic attribution file.
// Every later build step preserves this resource for electron-builder.
run(process.execPath, ["scripts/validate-product-config.mjs"]);
run(process.execPath, ["scripts/stage-character-seeds.mjs"]);
if (!sharedBuilt) run(process.execPath, ["scripts/build-workspaces.mjs", "--force"], repoRoot);
run(
	process.execPath,
	[npmCli, "run", "--ignore-scripts", "build", "--workspace", "@bear-harness/companion-ui"],
	repoRoot,
);
run(process.execPath, [npmCli, "exec", "--no", "--", "tsc", "-p", "tsconfig.main.json"]);
flattenMainEmit(desktop);
run(process.execPath, [npmCli, "exec", "--no", "--", "tsc", "-p", "tsconfig.preload.json"]);
run(process.execPath, [npmCli, "exec", "--no", "--", "rsbuild", "build"]);
process.stdout.write("build: ok\n");
