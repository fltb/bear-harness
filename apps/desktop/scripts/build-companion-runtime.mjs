/**
 * Build the self-contained Companion SDK runtime into dist/runtime/pi-sdk.
 *
 * The pi-coding-agent SDK is shipped UN-bundled: it resolves its own assets
 * and deps via import.meta.url / node_modules resolution, so a static bundle
 * breaks resource lookup. Instead we materialize a complete --omit=dev
 * install of the pinned SDK into dist/runtime/pi-sdk and copy the Companion
 * entry next to it. The entry imports the SDK with a bare specifier, resolved
 * from inside the tree — pure JS, works from asar (native addons in the TUI
 * paths are never loaded by the Companion).
 *
 * Run from apps/desktop:  node scripts/build-companion-runtime.mjs
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
// Staging lives OUTSIDE dist (os tmpdir) so a partial run can never
// contaminate the packaged file set.
const staging = join(tmpdir(), "bear-companion-runtime-build");
const target = resolve(desktop, "dist/runtime/pi-sdk");
const entrySrc = resolve(here, "m0-spikes/companion-entry.mjs");
const entryDst = join(target, "companion-entry.mjs");

rmSync(target, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const result = spawnSync(
	"npm",
	[
		"install",
		"--prefix",
		staging,
		"--omit=dev",
		"--no-audit",
		"--no-fund",
		"--no-package-lock",
		"--no-save",
		"@earendil-works/pi-coding-agent@0.84.1",
	],
	{ cwd: desktop, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

mkdirSync(target, { recursive: true });
cpSync(join(staging, "node_modules"), join(target, "node_modules"), { recursive: true });
// The staging `npm install` writes node_modules/.package-lock.json with
// staging-absolute package paths and creates ABSOLUTE .bin symlinks into the
// staging dir; both dangle once staging is deleted and poison electron-builder's
// file walker. Strip npm bookkeeping and every symlink from the runtime tree
// (the Companion never spawns .bin CLIs).
{
	const { readdirSync, lstatSync } = await import("node:fs");
	const stack = [join(target, "node_modules")];
	while (stack.length > 0) {
		const dir = stack.pop();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const st = lstatSync(full);
			if (st.isSymbolicLink()) rmSync(full);
			else if (st.isDirectory()) stack.push(full);
		}
	}
}
rmSync(join(target, "node_modules", ".package-lock.json"), { force: true });
// Prune native addons: the Companion never enters the interactive TUI paths
// that load pi-tui / clipboard natives. Keeping them breaks the macOS
// universal merge (arch-specific .node in both slices) and bloats the
// package. Lazy platform guards keep the JS loading fine without them.
{
	const { readdirSync } = await import("node:fs");
	const stack = [join(target, "node_modules")];
	while (stack.length > 0) {
		const dir = stack.pop();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.endsWith(".node")) rmSync(full);
		}
	}
}
cpSync(entrySrc, entryDst);
writeFileSync(
	join(target, "BUILD-INFO.json"),
	JSON.stringify(
		{
			sdk: "0.84.1",
			source: "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.1.tgz",
			builtAt: new Date().toISOString(),
			entry: "companion-entry.mjs",
		},
		null,
		2,
	),
);
rmSync(staging, { recursive: true, force: true });
process.stdout.write(`companion runtime: ${target}\n`);
