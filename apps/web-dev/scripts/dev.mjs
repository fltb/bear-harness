import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repoEnv = resolve(repoRoot, ".env");
if (existsSync(repoEnv)) process.loadEnvFile(repoEnv);
const defaultDataDir = resolve(repoRoot, ".dev-data/web-dev");
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
			BEAR_WEB_DEV_DATA_DIR: process.env.BEAR_WEB_DEV_DATA_DIR ?? defaultDataDir,
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
	const runtimeEnv = {
		BEAR_WEB_DEV_HOST_PORT: String(hostPort),
		BEAR_WEB_DEV_PORT: String(webPort),
	};
	run(process.execPath, ["server/index.ts"], runtimeEnv);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${hostPort}/bootstrap`);
			if (response.ok) {
				run("npx", ["--no-install", "rsbuild", "dev"], runtimeEnv);
				process.stdout.write(`web-dev UI ready: http://127.0.0.1:${webPort}\n`);
				return;
			}
		} catch {
			// The loopback Host has not bound its port yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	process.stderr.write("web-dev: timed out waiting for the loopback Host\n");
	stop(1);
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
