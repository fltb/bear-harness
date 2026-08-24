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

function run(cmd, args, cwd = desktop) {
	const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

rmSync(resolve(desktop, "dist"), { recursive: true, force: true });
// Release staging starts with a validated, deterministic attribution file.
// Every later build step preserves this resource for electron-builder.
run("node", ["scripts/validate-product-config.mjs"]);
run("node", ["scripts/stage-character-seeds.mjs"]);
for (const workspace of [
	"@bear-harness/i18n",
	"@bear-harness/product-config",
	"@bear-harness/protocol",
	"@bear-harness/companion-client",
	"@bear-harness/host-runtime",
	"@bear-harness/companion-ui",
]) {
	run("npm", ["run", "build", "--workspace", workspace], repoRoot);
}
run("npx", ["--no-install", "tsc", "-p", "tsconfig.main.json"]);
flattenMainEmit(desktop);
run("npx", ["--no-install", "tsc", "-p", "tsconfig.preload.json"]);
run("npx", ["--no-install", "rsbuild", "build"]);
process.stdout.write("build: ok\n");
