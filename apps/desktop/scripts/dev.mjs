/**
 * Development launcher: parallel watch builds + Rsbuild dev server + Electron.
 *
 * - tsc --watch for main and preload, Rsbuild dev server on 127.0.0.1:3100.
 * - A mirror loop flattens the nested main emit (dist/main/src/main) into the
 *   final layout (dist/main) so Electron always launches dist/main/index.js.
 * - Waits until dist/main/index.js, dist/preload/index.cjs and TCP 3100 are
 *   ready (or 30 s), then spawns Electron with BEAR_RENDERER_URL set.
 * - Any child exit terminates the rest; SIGINT/SIGTERM are forwarded with
 *   cleanup so Ctrl-C works on macOS/Linux/Windows.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenMainEmit } from "./flatten-main.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repoRoot = resolve(desktop, "..", "..");
const distMain = resolve(desktop, "dist/main");
const nestedMain = resolve(distMain, "src/main");

const children = [];
let shuttingDown = false;

function spawnChild(label, cmd, args, env = {}) {
	const child = spawn(cmd, args, {
		cwd: desktop,
		env: { ...process.env, ...env },
		stdio: "inherit",
	});
	children.push(child);
	child.on("exit", (code, signal) => {
		if (shuttingDown) return;
		process.stderr.write(`dev: ${label} exited (${signal ?? code}); terminating all\n`);
		teardown(1);
	});
	return child;
}

function teardown(exitCode) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) {
		if (!child.killed) child.kill();
	}
	setTimeout(() => process.exit(exitCode), 300);
}

process.on("SIGINT", () => teardown(0));
process.on("SIGTERM", () => teardown(0));

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function portOpen() {
	return new Promise((resolvePort) => {
		const socket = net.connect({ host: "127.0.0.1", port: 3100 });
		socket.once("connect", () => {
			socket.destroy();
			resolvePort(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolvePort(false);
		});
	});
}

async function main() {
	for (const workspace of [
		"@bear-harness/product-config",
		"@bear-harness/protocol",
		"@bear-harness/companion-client",
		"@bear-harness/host-runtime",
	]) {
		const result = spawnSync("npm", ["run", "build", "--workspace", workspace], {
			cwd: repoRoot,
			stdio: "inherit",
		});
		if (result.status !== 0) process.exit(result.status ?? 1);
	}

	// Validate first (writes dist/brand/BRAND-ATTRIBUTION.txt).
	const validator = spawnSync("node", ["scripts/validate-product-config.mjs"], {
		cwd: desktop,
		stdio: "inherit",
	});
	if (validator.status !== 0) process.exit(validator.status ?? 1);

	rmSync(distMain, { recursive: true, force: true });

	spawnChild("main tsc", "npx", ["--no-install", "tsc", "-p", "tsconfig.main.json", "--watch"]);
	spawnChild("preload tsc", "npx", [
		"--no-install",
		"tsc",
		"-p",
		"tsconfig.preload.json",
		"--watch",
	]);
	spawnChild("rsbuild", "npx", ["--no-install", "rsbuild", "dev"]);

	// Mirror loop: keep dist/main/index.js fresh from the nested tsc emit.
	let lastMirror = 0;
	setInterval(() => {
		try {
			const stat = statSync(nestedMain);
			if (stat.mtimeMs !== lastMirror) {
				lastMirror = stat.mtimeMs;
				flattenMainEmit(desktop);
			}
		} catch {
			// nested emit not ready yet
		}
	}, 250);

	// Readiness poll, then launch Electron.
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const filesReady =
			existsSync(resolve(distMain, "index.js")) &&
			existsSync(resolve(desktop, "dist/preload/index.cjs"));
		if (filesReady && (await portOpen())) {
			spawnChild("electron", "npx", ["--no-install", "electron", "dist/main/index.js"], {
				BEAR_RENDERER_URL: "http://127.0.0.1:3100",
			});
			return;
		}
		await sleep(300);
	}
	process.stderr.write("dev: timed out waiting for build outputs and dev server\n");
	teardown(1);
}

void main();
