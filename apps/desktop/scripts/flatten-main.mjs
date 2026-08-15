/**
 * Promote the nested TypeScript main-process emit to Electron's stable entry
 * location. The application imports all shared code through workspace package
 * exports, so no relative-import rewriting is needed.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export function flattenMainEmit(desktop) {
	const nested = resolve(desktop, "dist/main/src/main");
	if (!existsSync(nested)) {
		throw new Error("dist/main/src/main missing after main tsc emit");
	}
	cpSync(nested, resolve(desktop, "dist/main"), { recursive: true });
	rmSync(resolve(desktop, "dist/main/src"), { recursive: true, force: true });
}
