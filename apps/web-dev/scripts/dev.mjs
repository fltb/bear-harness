import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repoEnv = resolve(repoRoot, ".env");
if (existsSync(repoEnv)) process.loadEnvFile(repoEnv);
for (const workspace of [
	"@bear-harness/product-config",
	"@bear-harness/protocol",
	"@bear-harness/companion-client",
	"@bear-harness/host-runtime",
	"@bear-harness/companion-ui",
]) {
	const result = spawnSync("npm", ["run", "build", "--workspace", workspace], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}
const children = [];
let shuttingDown = false;

function run(command, args, env = {}) {
	const child = spawn(command, args, {
		stdio: "inherit",
		env: {
			...process.env,
			...env,
			BEAR_WEB_DEV_DEBUG: process.env.BEAR_WEB_DEV_DEBUG ?? "1",
		},
	});
	children.push(child);
	child.once("exit", (code) => {
		if (!shuttingDown) stop(code ?? 1);
	});
	return child;
}

function stop(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) child.kill("SIGTERM");
	process.exitCode = code;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function start() {
	const hostPort = await availablePort(Number(process.env.BEAR_WEB_DEV_HOST_PORT ?? "3201"));
	const webPort = await availablePort(
		Number(process.env.BEAR_WEB_DEV_PORT ?? "3200"),
		new Set([hostPort]),
	);
	const dataScope = process.env.BEAR_WEB_DEV_DATA_DIR ? String(process.pid) : undefined;
	const runtimeEnv = {
		BEAR_WEB_DEV_HOST_PORT: String(hostPort),
		BEAR_WEB_DEV_PORT: String(webPort),
		...(dataScope ? { BEAR_WEB_DEV_DATA_SCOPE: dataScope } : {}),
	};
	run(process.execPath, ["server/index.ts"], runtimeEnv);
	const deadline = Date.now() + 30_000;
	if (!(await waitForJsonBootstrap(`http://127.0.0.1:${hostPort}/bootstrap`, deadline))) {
		process.stderr.write("web-dev: timed out waiting for the loopback Host\n");
		stop(1);
		return;
	}
	run("npx", ["--no-install", "rsbuild", "dev"], runtimeEnv);
	if (!(await waitForJsonBootstrap(`http://127.0.0.1:${webPort}/bootstrap`, deadline))) {
		process.stderr.write("web-dev: timed out waiting for the UI proxy\n");
		stop(1);
		return;
	}
	process.stdout.write(`web-dev UI ready: http://127.0.0.1:${webPort}\n`);
}

async function waitForJsonBootstrap(url, deadline) {
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { cache: "no-store" });
			if (
				response.ok &&
				(response.headers.get("content-type") ?? "").includes("application/json")
			) {
				const payload = await response.json();
				if (
					payload &&
					typeof payload === "object" &&
					typeof payload.token === "string" &&
					payload.product &&
					typeof payload.product === "object"
				) {
					return true;
				}
			}
		} catch {
			// The target has not bound its port or has not finished proxying yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

async function availablePort(start, reserved = new Set()) {
	for (let port = start; port < start + 20; port += 1) {
		if (reserved.has(port)) continue;
		const available = await new Promise((resolveAvailable, reject) => {
			const probe = createServer();
			probe.once("error", (error) => {
				if (error.code === "EADDRINUSE") resolveAvailable(false);
				else reject(error);
			});
			probe.listen(port, "127.0.0.1", () => probe.close(() => resolveAvailable(true)));
		});
		if (available) return port;
	}
	throw new Error(`no available loopback port starting at ${start}`);
}

void start();
