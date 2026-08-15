/**
 * Crashpad smoke: launches Electron with a test-only entry that configures the
 * PRODUCTION configureCrashpad against a temp diagnostics root, then calls
 * process.crash(). Requires a non-zero child exit and a non-empty .dmp within
 * 30 s. The temp root (including the dump) is deleted afterwards; dumps never
 * become CI artifacts.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crashpadModule = resolve(desktop, "../../packages/host-runtime/dist/diagnostics/crashpad.js");

if (!existsSync(crashpadModule)) {
	process.stderr.write(
		"crash smoke: host-runtime Crashpad module missing; run npm run build first\n",
	);
	process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "bear-crash-smoke-"));
const launchId = randomUUID();
const entry = join(root, "entry.mjs");
writeFileSync(
	entry,
	[
		'import { app, crashReporter } from "electron";',
		`import { configureCrashpad } from ${JSON.stringify(pathToFileURL(crashpadModule).href)};`,
		`configureCrashpad({ app, reporter: crashReporter, root: ${JSON.stringify(root)}, launchId: ${JSON.stringify(launchId)} });`,
		"app.whenReady().then(() => { setTimeout(() => process.crash(), 200); });",
		"",
	].join("\n"),
	"utf8",
);

const child = spawn("npx", ["--no-install", "electron", entry], {
	cwd: desktop,
	stdio: ["ignore", "inherit", "inherit"],
});

const deadline = Date.now() + 30_000;
const exitPromise = new Promise((resolveExit) => {
	child.on("exit", (code, signal) => resolveExit({ code, signal }));
});

async function waitForDump() {
	const dumpDir = join(root, "crashes", launchId);
	while (Date.now() < deadline) {
		if (findNonEmptyDmp(dumpDir)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

function findNonEmptyDmp(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		try {
			if (entry.isDirectory()) {
				if (findNonEmptyDmp(path)) return true;
			} else if (entry.name.endsWith(".dmp") && statSync(path).size > 0) {
				return true;
			}
		} catch {
			// skip
		}
	}
	return false;
}

const [exit, dump] = await Promise.all([exitPromise, waitForDump()]);
const exitedNonZero = exit.code !== 0 || exit.signal !== null;

if (!dump) {
	process.stderr.write("crash smoke: no non-empty .dmp within 30 s\n");
	rmSync(root, { recursive: true, force: true });
	process.exit(1);
}
if (!exitedNonZero) {
	process.stderr.write(`crash smoke: process exited cleanly (${JSON.stringify(exit)})\n`);
	rmSync(root, { recursive: true, force: true });
	process.exit(1);
}

process.stdout.write(`crash smoke: ok (${JSON.stringify(exit)}, dump present)\n`);
rmSync(root, { recursive: true, force: true });
