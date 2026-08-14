/**
 * Flatten the main-process emit layout.
 *
 * tsconfig.main.json uses `rootDir: "."`, so tsc emits
 * `dist/main/src/main/**`, `dist/main/src/shared/**`, and
 * `dist/main/product.config.js`. This mirrors `dist/main/src/main/*` up into
 * `dist/main/` (making index.js a top-level entry), moves
 * `dist/main/src/shared/` to `dist/main/shared/`, and patches the emitted
 * `../../product.config.js` and `../shared/` imports to the flat structure.
 *
 * Used by both the production build and the dev mirror loop.
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const NESTED_IMPORT = "../../product.config.js";
const FLAT_IMPORT = "./product.config.js";
const NESTED_SHARED = "../shared/";
const FLAT_SHARED = "./shared/";

export function flattenMainEmit(desktop) {
	const nested = resolve(desktop, "dist/main/src/main");
	if (!existsSync(nested)) {
		throw new Error("dist/main/src/main missing after main tsc emit");
	}
	// Promote src/main/* to dist/main/
	cpSync(nested, resolve(desktop, "dist/main"), { recursive: true });
	// Promote src/shared/ to dist/main/shared/
	const sharedSrc = resolve(desktop, "dist/main/src/shared");
	if (existsSync(sharedSrc)) {
		cpSync(sharedSrc, resolve(desktop, "dist/main/shared"), { recursive: true });
	}
	// Fix product.config and shared import paths in every emitted .js file
	const mainDir = resolve(desktop, "dist/main");
	const files = [resolve(mainDir, "index.js"), ...flatFiles(mainDir)];
	for (const file of files) {
		if (!existsSync(file)) continue;
		let content = readFileSync(file, "utf8");
		if (content.includes(NESTED_IMPORT)) {
			content = content.replaceAll(NESTED_IMPORT, FLAT_IMPORT);
		}
		if (content.includes(NESTED_SHARED)) {
			content = content.replaceAll(NESTED_SHARED, FLAT_SHARED);
		}
		writeFileSync(file, content, "utf8");
	}
	// Remove the now-unnecessary nested src/ tree
	rmSync(resolve(desktop, "dist/main/src"), { recursive: true, force: true });
}

function flatFiles(dir) {
	const result = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = resolve(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.endsWith(".js")) result.push(full);
		}
	}
	return result;
}