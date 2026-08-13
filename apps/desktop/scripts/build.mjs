/**
 * Production build: clean dist, validate product config (writes
 * dist/brand/BRAND-ATTRIBUTION.txt), compile main, flatten the main emit
 * layout, compile preload, then run the Rsbuild renderer build.
 *
 * The main tsc config uses `rootDir: "."` because the main process imports
 * product.config.ts; tsc emits `dist/main/src/main/*` and
 * `dist/main/product.config.js`. This script flattens `dist/main/src/main/*`
 * up to `dist/main/` so the package `main` field (`dist/main/index.js`) and
 * the `../renderer` / `../preload` relative paths hold in every mode.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenMainEmit } from "./flatten-main.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");

function run(cmd, args, cwd = desktop) {
	const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

rmSync(resolve(desktop, "dist"), { recursive: true, force: true });
run("node", ["scripts/validate-product-config.mjs"]);
run("npx", ["--no-install", "tsc", "-p", "tsconfig.main.json"]);
flattenMainEmit(desktop);
run("npx", ["--no-install", "tsc", "-p", "tsconfig.preload.json"]);
run("npx", ["--no-install", "rsbuild", "build"]);
process.stdout.write("build: ok\n");
