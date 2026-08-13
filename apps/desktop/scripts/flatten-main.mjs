/**
 * Flatten the main-process emit layout.
 *
 * tsconfig.main.json uses `rootDir: "."` (the main process imports
 * product.config.ts), so tsc emits `dist/main/src/main/**` plus
 * `dist/main/product.config.js`. This mirrors `dist/main/src/main/*` up into
 * `dist/main/` and patches the emitted `../../product.config.js` import
 * (calibrated for the nested depth) to `./product.config.js` so the flattened
 * `dist/main/index.js` resolves the config next to itself. Used by both the
 * production build and the dev mirror loop.
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const NESTED_IMPORT = "../../product.config.js";
const FLAT_IMPORT = "./product.config.js";

export function flattenMainEmit(desktop) {
	const nested = resolve(desktop, "dist/main/src/main");
	if (!existsSync(nested)) {
		throw new Error("dist/main/src/main missing after main tsc emit");
	}
	cpSync(nested, resolve(desktop, "dist/main"), { recursive: true });
	const indexFile = resolve(desktop, "dist/main/index.js");
	const content = readFileSync(indexFile, "utf8");
	if (!content.includes(NESTED_IMPORT)) {
		throw new Error("product config import not found in dist/main/index.js");
	}
	writeFileSync(indexFile, content.replaceAll(NESTED_IMPORT, FLAT_IMPORT), "utf8");
	rmSync(resolve(desktop, "dist/main/src"), { recursive: true, force: true });
}
